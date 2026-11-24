// BeatForge Plugin Host: loads VST3 plugins for BeatForge in a separate process (a crashing plugin can't take the
// app down). Built on the Steinberg VST3 SDK (MIT licence). Talks to BeatForge's desktop part over stdin/stdout.
//
// Frame (both directions): u32 headerLen, u32 binLen, header (UTF-8 text), bin (raw bytes). Little endian.
// Requests: header = tab-separated fields, first = request id, second = command. Replies: header = JSON with "id".
// Unsolicited events: JSON with "ev" (param changed in the plugin's own window, window closed, log).
//
//   scan [extra paths...]                      -> {plugins:[{path,cid,name,vendor,kind,sub}]}
//   load inst path cid sampleRate maxBlock      -> {name,kind,params:[{id,title,units,def,steps,ro}],editor,ins,outs}
//   unload inst
//   render inst frames nEv nPar tempo playing pos   bin = events (i32 offset,i32 type,i32 key,f32 vel) x nEv,
//                                                   params (u32 id, f64 value) x nPar, input L then R (f32, effects)
//                                                -> bin = output L then R (f32 x frames each)
//   getstate inst                               -> bin = u32 compLen, comp, u32 ctrlLen, ctrl
//   setstate inst                               bin as above
//   setparam inst id value                      (normalized 0..1, from BeatForge's own knobs)
//   edit inst / closeedit inst                  the plugin's own window (Windows)
//   quit

#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "public.sdk/source/common/memorystream.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/funknownimpl.h"

#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <algorithm>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <ole2.h>
#include <fcntl.h>
#include <io.h>
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;

// ---------------------------------------------------------------- framing
static std::mutex gOutMx;
static void writeFrame(const std::string& head, const void* bin = nullptr, uint32_t binLen = 0) {
  std::lock_guard<std::mutex> lk(gOutMx);
  uint32_t h[2] = {(uint32_t)head.size(), binLen};
  fwrite(h, 4, 2, stdout);
  fwrite(head.data(), 1, head.size(), stdout);
  if (binLen) fwrite(bin, 1, binLen, stdout);
  fflush(stdout);
}
static bool readExact(void* p, size_t n) { return fread(p, 1, n, stdin) == n; }

static std::string jstr(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}
static std::string u16(const TChar* s) { return StringConvert::convert(s); }
static void logEv(const std::string& m) { writeFrame("{\"ev\":\"log\",\"msg\":" + jstr(m) + "}"); }

struct Msg { std::vector<std::string> f; std::vector<uint8_t> bin; };
static std::vector<std::string> split(const std::string& s) {
  std::vector<std::string> out; size_t a = 0;
  for (;;) { size_t b = s.find('\t', a); out.push_back(s.substr(a, b == std::string::npos ? std::string::npos : b - a)); if (b == std::string::npos) break; a = b + 1; }
  return out;
}

// a thread-safe queue of work for the UI (main) thread and the audio thread
struct Queue {
  std::mutex mx; std::condition_variable cv; std::deque<std::function<void()>> q;
  void push(std::function<void()> f) { { std::lock_guard<std::mutex> l(mx); q.push_back(std::move(f)); } cv.notify_one(); }
  bool pop(std::function<void()>& f, int waitMs) {
    std::unique_lock<std::mutex> l(mx);
    if (q.empty()) cv.wait_for(l, std::chrono::milliseconds(waitMs));
    if (q.empty()) return false;
    f = std::move(q.front()); q.pop_front(); return true;
  }
};
static Queue gUi, gAudio;
static std::atomic<bool> gQuit{false};
#ifdef _WIN32
static DWORD gUiThread = 0;
#endif
static void wakeUi() {
#ifdef _WIN32
  if (gUiThread) PostThreadMessage(gUiThread, WM_NULL, 0, 0);
#endif
}

// ---------------------------------------------------------------- one loaded plugin
struct Inst;
static std::mutex gInstMx;
static std::map<std::string, std::shared_ptr<Inst>> gInst;

class Handler : public IComponentHandler {
 public:
  Inst* inst = nullptr;
  tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(ParamID id, ParamValue v) override;
  tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API restartComponent(int32) override { return kResultOk; }
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, IComponentHandler::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) { *obj = this; return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
};

#ifdef _WIN32
class Frame;
#endif

struct Inst {
  std::string id, kind;
  VST3::Hosting::Module::Ptr module;
  IPtr<PlugProvider> provider;
  IPtr<IComponent> comp;
  IPtr<IAudioProcessor> proc;
  IPtr<IEditController> ctrl;
  Handler handler;
  HostProcessData data;
  EventList events;
  ParameterChanges pchanges;
  ProcessContext pctx{};
  int maxBlock = 512, ins = 0, outs = 0;
  double rate = 44100;
  std::mutex procMx;                  // held while processing / (de)activating
  std::mutex parMx; std::vector<std::pair<ParamID, ParamValue>> pending; // edits waiting for the processor
  IPtr<IPlugView> view;
#ifdef _WIN32
  HWND hwnd = nullptr;
  Frame* frame = nullptr;
#endif
  void queueParam(ParamID id, ParamValue v) { std::lock_guard<std::mutex> l(parMx); pending.push_back({id, v}); }
};

tresult PLUGIN_API Handler::performEdit(ParamID id, ParamValue v) {
  if (!inst) return kResultFalse;
  inst->queueParam(id, v);
  char b[160]; snprintf(b, sizeof b, "{\"ev\":\"param\",\"inst\":%s,\"pid\":%u,\"value\":%.9g}", jstr(inst->id).c_str(), (unsigned)id, v);
  writeFrame(b);
  return kResultOk;
}

static std::shared_ptr<Inst> findInst(const std::string& id) {
  std::lock_guard<std::mutex> l(gInstMx);
  auto it = gInst.find(id);
  return it == gInst.end() ? nullptr : it->second;
}

// ---------------------------------------------------------------- editor windows (Windows)
#ifdef _WIN32
class Frame : public IPlugFrame {
 public:
  HWND hwnd = nullptr;
  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* r) override {
    if (!hwnd || !r) return kInvalidArgument;
    RECT rc{0, 0, r->getWidth(), r->getHeight()};
    AdjustWindowRect(&rc, (DWORD)GetWindowLongPtrW(hwnd, GWL_STYLE), FALSE);
    SetWindowPos(hwnd, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top, SWP_NOMOVE | SWP_NOZORDER);
    view->onSize(r);
    return kResultOk;
  }
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, IPlugFrame::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) { *obj = this; return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
};

static void closeEditor(Inst& in, bool notify) {
  if (in.view) { in.view->setFrame(nullptr); in.view->removed(); in.view = nullptr; }
  if (in.hwnd) { HWND h = in.hwnd; in.hwnd = nullptr; DestroyWindow(h); }
  delete in.frame; in.frame = nullptr;
  if (notify) writeFrame("{\"ev\":\"editorClosed\",\"inst\":" + jstr(in.id) + "}");
}

static LRESULT CALLBACK wndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_CLOSE) {
    auto* in = (Inst*)GetWindowLongPtrW(h, GWLP_USERDATA);
    if (in) closeEditor(*in, true); else DestroyWindow(h);
    return 0;
  }
  if (m == WM_SIZE) {
    auto* in = (Inst*)GetWindowLongPtrW(h, GWLP_USERDATA);
    if (in && in->view && in->view->canResize() == kResultTrue) { ViewRect r{0, 0, LOWORD(l), HIWORD(l)}; in->view->onSize(&r); }
  }
  return DefWindowProcW(h, m, w, l);
}

static std::string openEditor(Inst& in, const std::string& title) {
  if (in.hwnd) { ShowWindow(in.hwnd, SW_SHOWNORMAL); SetForegroundWindow(in.hwnd); return ""; }
  if (!in.ctrl) return "This plugin has no controller.";
  IPtr<IPlugView> v = owned(in.ctrl->createView(ViewType::kEditor));
  if (!v) return "This plugin has no window of its own. Use the knobs in BeatForge.";
  if (v->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) return "This plugin's window is not supported here.";
  static bool reg = false;
  if (!reg) { WNDCLASSW wc{}; wc.lpfnWndProc = wndProc; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"BeatForgePlugin"; wc.hCursor = LoadCursor(nullptr, IDC_ARROW); RegisterClassW(&wc); reg = true; }
  ViewRect r{}; if (v->getSize(&r) != kResultOk || r.getWidth() <= 0) r = ViewRect(0, 0, 640, 400);
  DWORD style = WS_OVERLAPPEDWINDOW & ~(v->canResize() == kResultTrue ? 0 : (WS_THICKFRAME | WS_MAXIMIZEBOX));
  RECT rc{0, 0, r.getWidth(), r.getHeight()}; AdjustWindowRect(&rc, style, FALSE);
  std::wstring wt(title.begin(), title.end());
  int n = MultiByteToWideChar(CP_UTF8, 0, title.c_str(), -1, nullptr, 0);
  if (n > 0) { wt.resize(n); MultiByteToWideChar(CP_UTF8, 0, title.c_str(), -1, &wt[0], n); wt.resize(n - 1); }
  HWND h = CreateWindowExW(WS_EX_APPWINDOW, L"BeatForgePlugin", wt.c_str(), style, CW_USEDEFAULT, CW_USEDEFAULT, rc.right - rc.left, rc.bottom - rc.top, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!h) return "Could not open a window.";
  SetWindowLongPtrW(h, GWLP_USERDATA, (LONG_PTR)&in);
  in.frame = new Frame(); in.frame->hwnd = h;
  v->setFrame(in.frame);
  if (v->attached(h, kPlatformTypeHWND) != kResultOk) { v->setFrame(nullptr); DestroyWindow(h); delete in.frame; in.frame = nullptr; return "The plugin could not open its window."; }
  in.view = v; in.hwnd = h;
  ShowWindow(h, SW_SHOWNORMAL); SetForegroundWindow(h);
  return "";
}
#endif

// ---------------------------------------------------------------- commands
static HostApplication* gHost = nullptr;

static std::string kindOf(const VST3::Hosting::ClassInfo& ci) {
  return ci.subCategoriesString().find("Instrument") != std::string::npos ? "instrument" : "effect";
}

static void cmdScan(const std::string& rid, const std::vector<std::string>& f) {
  auto paths = VST3::Hosting::Module::getModulePaths();
  // extra folders from BeatForge's settings: every .vst3 inside (a .vst3 is a folder or, on Windows, sometimes a file)
  for (size_t i = 2; i < f.size(); i++) {
    if (f[i].empty()) continue;
    std::error_code ec;
    std::filesystem::path root = std::filesystem::u8path(f[i]);
    if (root.extension() == ".vst3") { paths.push_back(f[i]); continue; }
    auto it = std::filesystem::recursive_directory_iterator(root, std::filesystem::directory_options::skip_permission_denied, ec);
    for (; !ec && it != std::filesystem::recursive_directory_iterator(); it.increment(ec)) {
      if (it->path().extension() == ".vst3") { paths.push_back(it->path().u8string()); if (it->is_directory(ec)) it.disable_recursion_pending(); }
    }
  }
  std::sort(paths.begin(), paths.end()); paths.erase(std::unique(paths.begin(), paths.end()), paths.end());
  std::ostringstream o; o << "{\"id\":" << jstr(rid) << ",\"plugins\":[";
  bool first = true;
  for (auto& p : paths) {
    std::string err;
    auto m = VST3::Hosting::Module::create(p, err);
    if (!m) { logEv("skip " + p + ": " + err); continue; }
    for (auto& ci : m->getFactory().classInfos()) {
      if (ci.category() != kVstAudioEffectClass) continue;
      if (!first) o << ","; first = false;
      o << "{\"path\":" << jstr(p) << ",\"cid\":" << jstr(ci.ID().toString()) << ",\"name\":" << jstr(ci.name())
        << ",\"vendor\":" << jstr(ci.vendor()) << ",\"kind\":" << jstr(kindOf(ci)) << ",\"sub\":" << jstr(ci.subCategoriesString()) << "}";
    }
  }
  o << "]}";
  writeFrame(o.str());
}

static void activate(Inst& in, bool on) {
  std::lock_guard<std::mutex> l(in.procMx);
  if (on) {
    ProcessSetup setup{kRealtime, kSample32, in.maxBlock, in.rate};
    in.proc->setupProcessing(setup);
    in.data.prepare(*in.comp, in.maxBlock, kSample32);
    in.comp->setActive(true);
    in.proc->setProcessing(true);
  } else {
    in.proc->setProcessing(false);
    in.comp->setActive(false);
    in.data.unprepare();
  }
}

static void cmdLoad(const std::string& rid, const std::vector<std::string>& f) {
  auto fail = [&](const std::string& e) { writeFrame("{\"id\":" + jstr(rid) + ",\"error\":" + jstr(e) + "}"); };
  if (f.size() < 7) return fail("bad load");
  auto in = std::make_shared<Inst>();
  in->id = f[2]; in->rate = atof(f[5].c_str()); in->maxBlock = std::max(64, std::min(8192, atoi(f[6].c_str())));
  std::string err;
  in->module = VST3::Hosting::Module::create(f[3], err);
  if (!in->module) return fail("Could not load " + f[3] + ": " + err);
  auto factory = in->module->getFactory();
  for (auto& ci : factory.classInfos()) {
    if (ci.category() != kVstAudioEffectClass || ci.ID().toString() != f[4]) continue;
    in->kind = kindOf(ci);
    in->provider = owned(new PlugProvider(factory, ci, true));
    break;
  }
  if (!in->provider) return fail("That plugin is not in " + f[3]);
  if (!in->provider->initialize()) return fail("The plugin did not start.");
  in->comp = in->provider->getComponentPtr();
  in->ctrl = in->provider->getControllerPtr();
  in->proc = U::cast<IAudioProcessor>(in->comp);
  if (!in->comp || !in->proc) return fail("Not an audio plugin.");
  in->handler.inst = in.get();
  if (in->ctrl) in->ctrl->setComponentHandler(&in->handler);
  // stereo main buses where possible, everything else off
  SpeakerArrangement st = SpeakerArr::kStereo;
  in->ins = in->comp->getBusCount(kAudio, kInput); in->outs = in->comp->getBusCount(kAudio, kOutput);
  std::vector<SpeakerArrangement> ia(in->ins, st), oa(in->outs, st);
  in->proc->setBusArrangements(ia.empty() ? nullptr : ia.data(), (int32)ia.size(), oa.empty() ? nullptr : oa.data(), (int32)oa.size());
  for (int i = 0; i < in->ins; i++) in->comp->activateBus(kAudio, kInput, i, i == 0);
  for (int i = 0; i < in->outs; i++) in->comp->activateBus(kAudio, kOutput, i, i == 0);
  for (int i = 0; i < in->comp->getBusCount(kEvent, kInput); i++) in->comp->activateBus(kEvent, kInput, i, i == 0);
  if (in->outs == 0) return fail("This plugin has no audio output.");
  in->data.inputEvents = &in->events;
  in->data.inputParameterChanges = &in->pchanges;
  in->data.processContext = &in->pctx;
  activate(*in, true);
  std::ostringstream o;
  o << "{\"id\":" << jstr(rid) << ",\"kind\":" << jstr(in->kind) << ",\"ins\":" << in->ins << ",\"outs\":" << in->outs << ",\"params\":[";
  if (in->ctrl) {
    int n = in->ctrl->getParameterCount(); bool first = true;
    for (int i = 0; i < n && i < 4000; i++) {
      ParameterInfo pi{};
      if (in->ctrl->getParameterInfo(i, pi) != kResultOk) continue;
      if (pi.flags & ParameterInfo::kIsHidden) continue;
      if (!first) o << ","; first = false;
      o << "{\"id\":" << pi.id << ",\"title\":" << jstr(u16(pi.title)) << ",\"units\":" << jstr(u16(pi.units)) << ",\"def\":" << pi.defaultNormalizedValue
        << ",\"value\":" << in->ctrl->getParamNormalized(pi.id) << ",\"steps\":" << pi.stepCount << ",\"ro\":" << ((pi.flags & ParameterInfo::kIsReadOnly) ? "true" : "false")
        << ",\"auto\":" << ((pi.flags & ParameterInfo::kCanAutomate) ? "true" : "false") << "}";
    }
  }
  bool editor = false;
#ifdef _WIN32
  if (in->ctrl) { IPtr<IPlugView> v = owned(in->ctrl->createView(ViewType::kEditor)); editor = v && v->isPlatformTypeSupported(kPlatformTypeHWND) == kResultTrue; }
#endif
  o << "],\"editor\":" << (editor ? "true" : "false") << "}";
  { std::lock_guard<std::mutex> l(gInstMx); gInst[in->id] = in; }
  writeFrame(o.str());
}

static void cmdUnload(const std::string& rid, const std::string& id) {
  std::shared_ptr<Inst> in;
  { std::lock_guard<std::mutex> l(gInstMx); auto it = gInst.find(id); if (it != gInst.end()) { in = it->second; gInst.erase(it); } }
  if (in) {
#ifdef _WIN32
    closeEditor(*in, false);
#endif
    activate(*in, false);
    if (in->ctrl) in->ctrl->setComponentHandler(nullptr);
    in->proc = nullptr; in->comp = nullptr; in->ctrl = nullptr; in->provider = nullptr;
  }
  writeFrame("{\"id\":" + jstr(rid) + ",\"ok\":true}");
}

// render: runs on the audio thread
static void cmdRender(const std::string& rid, const std::vector<std::string>& f, const std::vector<uint8_t>& bin) {
  auto in = f.size() >= 9 ? findInst(f[2]) : nullptr;
  int frames = f.size() >= 9 ? std::max(0, std::min(1 << 20, atoi(f[3].c_str()))) : 0;
  std::vector<float> out((size_t)frames * 2, 0.f);
  if (!in || !frames) { writeFrame("{\"id\":" + jstr(rid) + ",\"error\":\"not loaded\"}", out.data(), (uint32_t)(out.size() * 4)); return; }
  int nEv = atoi(f[4].c_str()), nPar = atoi(f[5].c_str());
  double tempo = atof(f[6].c_str()); bool playing = f[7] == "1"; int64_t pos = atoll(f[8].c_str());
  const uint8_t* p = bin.data(); const uint8_t* end = p + bin.size();
  struct Ev { int32_t off, type, key; float vel; };
  std::vector<Ev> evs;
  for (int i = 0; i < nEv && p + 16 <= end; i++, p += 16) { Ev e; memcpy(&e, p, 16); evs.push_back(e); }
  for (int i = 0; i < nPar && p + 12 <= end; i++, p += 12) { uint32_t id; double v; memcpy(&id, p, 4); memcpy(&v, p + 4, 8); in->queueParam(id, v); if (in->ctrl) in->ctrl->setParamNormalized(id, v); }
  const float* inL = nullptr; const float* inR = nullptr;
  if ((size_t)(end - p) >= (size_t)frames * 8) { inL = (const float*)p; inR = inL + frames; }

  std::lock_guard<std::mutex> l(in->procMx);
  int done = 0;
  std::vector<float> zero(in->maxBlock, 0.f);
  while (done < frames) {
    int n = std::min(in->maxBlock, frames - done);
    in->events.clear(); in->pchanges.clearQueue();
    for (auto& e : evs) {
      if (e.off < done || e.off >= done + n) { if (!(done == 0 && e.off < 0)) continue; }
      Event ve{}; ve.busIndex = 0; ve.sampleOffset = std::max(0, e.off - done);
      if (e.type == 0) { ve.type = Event::kNoteOnEvent; ve.noteOn.channel = 0; ve.noteOn.pitch = (int16)e.key; ve.noteOn.velocity = e.vel; ve.noteOn.noteId = -1; }
      else if (e.type == 1) { ve.type = Event::kNoteOffEvent; ve.noteOff.channel = 0; ve.noteOff.pitch = (int16)e.key; ve.noteOff.velocity = 0; ve.noteOff.noteId = -1; }
      else continue;
      in->events.addEvent(ve);
    }
    { std::lock_guard<std::mutex> pl(in->parMx);
      for (auto& pv : in->pending) { int32 idx = 0; if (auto* q = in->pchanges.addParameterData(pv.first, idx)) { int32 qi = 0; q->addPoint(0, pv.second, qi); } }
      in->pending.clear(); }
    if (evs.size()) for (auto& e : evs) if (e.type == 2 && e.off >= done && e.off < done + n) { // all notes off
      for (int k = 0; k < 128; k++) { Event ve{}; ve.type = Event::kNoteOffEvent; ve.sampleOffset = std::max(0, e.off - done); ve.noteOff.pitch = (int16)k; ve.noteOff.noteId = -1; in->events.addEvent(ve); }
    }
    in->pctx.state = ProcessContext::kTempoValid | ProcessContext::kProjectTimeMusicValid | (playing ? ProcessContext::kPlaying : 0);
    in->pctx.sampleRate = in->rate; in->pctx.tempo = tempo > 0 ? tempo : 120;
    in->pctx.projectTimeSamples = pos + done;
    in->pctx.projectTimeMusic = (double)(pos + done) / in->rate * in->pctx.tempo / 60.0;
    in->pctx.timeSigNumerator = 4; in->pctx.timeSigDenominator = 4; in->pctx.state |= ProcessContext::kTimeSigValid;
    in->data.numSamples = n;
    // inputs
    if (in->data.numInputs > 0 && in->data.inputs[0].numChannels > 0) {
      auto& b = in->data.inputs[0];
      for (int c = 0; c < b.numChannels; c++) {
        const float* src = inL ? (c == 0 ? inL : inR) + done : zero.data();
        memcpy(b.channelBuffers32[c], src, n * 4);
      }
      b.silenceFlags = 0;
    }
    in->proc->process(in->data);
    if (in->data.numOutputs > 0) {
      auto& b = in->data.outputs[0];
      for (int c = 0; c < 2; c++) {
        float* src = b.numChannels > 0 ? b.channelBuffers32[std::min(c, (int)b.numChannels - 1)] : nullptr;
        float* dst = out.data() + (size_t)c * frames + done;
        if (src) for (int i = 0; i < n; i++) { float v = src[i]; dst[i] = (v == v && v < 8.f && v > -8.f) ? v : 0.f; } // NaN/blow-up guard
      }
    }
    done += n;
  }
  writeFrame("{\"id\":" + jstr(rid) + "}", out.data(), (uint32_t)(out.size() * 4));
}

static void cmdGetState(const std::string& rid, const std::string& id) {
  auto in = findInst(id);
  if (!in) { writeFrame("{\"id\":" + jstr(rid) + ",\"error\":\"not loaded\"}"); return; }
  MemoryStream cs, ks;
  { std::lock_guard<std::mutex> l(in->procMx); in->comp->getState(&cs); }
  if (in->ctrl) in->ctrl->getState(&ks);
  std::vector<uint8_t> out;
  auto put = [&](MemoryStream& s) { int64 sz = 0; s.seek(0, IBStream::kIBSeekEnd, &sz); uint32_t n = (uint32_t)sz; out.insert(out.end(), (uint8_t*)&n, (uint8_t*)&n + 4); out.insert(out.end(), (uint8_t*)s.getData(), (uint8_t*)s.getData() + n); };
  put(cs); put(ks);
  writeFrame("{\"id\":" + jstr(rid) + "}", out.data(), (uint32_t)out.size());
}

static void cmdSetState(const std::string& rid, const std::string& id, const std::vector<uint8_t>& bin) {
  auto in = findInst(id);
  if (!in || bin.size() < 8) { writeFrame("{\"id\":" + jstr(rid) + ",\"error\":\"bad state\"}"); return; }
  uint32_t cn = 0; memcpy(&cn, bin.data(), 4);
  if (4 + (size_t)cn + 4 > bin.size()) { writeFrame("{\"id\":" + jstr(rid) + ",\"error\":\"bad state\"}"); return; }
  uint32_t kn = 0; memcpy(&kn, bin.data() + 4 + cn, 4);
  if (8 + (size_t)cn + kn > bin.size()) { writeFrame("{\"id\":" + jstr(rid) + ",\"error\":\"bad state\"}"); return; }
  {
    MemoryStream cs; int32 w = 0; cs.write((void*)(bin.data() + 4), (int32)cn, &w); cs.seek(0, IBStream::kIBSeekSet, nullptr);
    { std::lock_guard<std::mutex> l(in->procMx); in->comp->setState(&cs); }
    if (in->ctrl) { cs.seek(0, IBStream::kIBSeekSet, nullptr); in->ctrl->setComponentState(&cs); }
  }
  if (in->ctrl && kn) { MemoryStream ks; int32 w = 0; ks.write((void*)(bin.data() + 8 + cn), (int32)kn, &w); ks.seek(0, IBStream::kIBSeekSet, nullptr); in->ctrl->setState(&ks); }
  // report the new knob values so BeatForge's own knobs follow
  std::ostringstream o; o << "{\"id\":" << jstr(rid) << ",\"values\":[";
  if (in->ctrl) { int n = in->ctrl->getParameterCount(); for (int i = 0; i < n && i < 4000; i++) { ParameterInfo pi{}; if (in->ctrl->getParameterInfo(i, pi) == kResultOk) o << (i ? "," : "") << "[" << pi.id << "," << in->ctrl->getParamNormalized(pi.id) << "]"; } }
  o << "]}";
  writeFrame(o.str());
}

static void handleUi(const Msg& m) {
  const auto& f = m.f; const std::string& rid = f[0]; const std::string& cmd = f.size() > 1 ? f[1] : "";
  if (cmd == "scan") cmdScan(rid, f);
  else if (cmd == "load") cmdLoad(rid, f);
  else if (cmd == "unload" && f.size() > 2) cmdUnload(rid, f[2]);
  else if (cmd == "getstate" && f.size() > 2) cmdGetState(rid, f[2]);
  else if (cmd == "setstate" && f.size() > 2) cmdSetState(rid, f[2], m.bin);
  else if (cmd == "setparam" && f.size() > 4) {
    auto in = findInst(f[2]);
    if (in) { ParamID id = (ParamID)strtoul(f[3].c_str(), nullptr, 10); double v = atof(f[4].c_str()); if (in->ctrl) in->ctrl->setParamNormalized(id, v); in->queueParam(id, v); }
    writeFrame("{\"id\":" + jstr(rid) + ",\"ok\":true}");
  } else if (cmd == "edit" && f.size() > 2) {
    auto in = findInst(f[2]);
#ifdef _WIN32
    std::string e = in ? openEditor(*in, f.size() > 3 ? f[3] : "Plugin") : "not loaded";
#else
    std::string e = in ? "Plugin windows open on Windows. Use the knobs in BeatForge here." : "not loaded";
#endif
    writeFrame("{\"id\":" + jstr(rid) + (e.empty() ? ",\"ok\":true}" : ",\"error\":" + jstr(e) + "}"));
  } else if (cmd == "closeedit" && f.size() > 2) {
#ifdef _WIN32
    if (auto in = findInst(f[2])) closeEditor(*in, false);
#endif
    writeFrame("{\"id\":" + jstr(rid) + ",\"ok\":true}");
  } else if (cmd == "ping") writeFrame("{\"id\":" + jstr(rid) + ",\"ok\":true,\"version\":1}");
  else writeFrame("{\"id\":" + jstr(rid) + ",\"error\":" + jstr("unknown command " + cmd) + "}");
}

int main() {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
  gUiThread = GetCurrentThreadId();
  { // sharp plugin windows on scaled screens (Windows 10 1703+; older: system DPI aware)
    using SetCtx = BOOL(WINAPI*)(HANDLE);
    auto f = (SetCtx)(void*)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext");
    if (!f || !f((HANDLE)-4 /* PER_MONITOR_AWARE_V2 */)) SetProcessDPIAware();
  }
  OleInitialize(nullptr);
  MSG wm; PeekMessageW(&wm, nullptr, WM_USER, WM_USER, PM_NOREMOVE); // create the thread's message queue
#endif
  gHost = new HostApplication();
  PluginContextFactory::instance().setPluginContext(gHost);

  // reader: stdin -> audio queue (render) or UI queue (everything else)
  std::thread reader([] {
    for (;;) {
      uint32_t h[2];
      if (!readExact(h, 8) || h[0] > (1u << 20) || h[1] > (256u << 20)) break;
      auto m = std::make_shared<Msg>();
      std::string head(h[0], '\0');
      if (!readExact(&head[0], h[0])) break;
      m->bin.resize(h[1]);
      if (h[1] && !readExact(m->bin.data(), h[1])) break;
      m->f = split(head);
      if (m->f.size() < 2) continue;
      if (m->f[1] == "quit") break;
      if (m->f[1] == "render") gAudio.push([m] { cmdRender(m->f[0], m->f, m->bin); });
      else { gUi.push([m] { handleUi(*m); }); wakeUi(); }
    }
    gQuit = true; gAudio.push([] {}); gUi.push([] {}); wakeUi();
  });
  std::thread audio([] {
#ifdef _WIN32
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
#endif
    std::function<void()> f;
    while (!gQuit) if (gAudio.pop(f, 200)) f();
  });

  std::function<void()> f;
  while (!gQuit) {
#ifdef _WIN32
    MsgWaitForMultipleObjects(0, nullptr, FALSE, 15, QS_ALLINPUT);
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
    while (gUi.pop(f, 0)) f();
#else
    if (gUi.pop(f, 200)) f();
#endif
  }
  audio.join();
  { std::lock_guard<std::mutex> l(gInstMx); for (auto& kv : gInst) { auto& in = *kv.second;
#ifdef _WIN32
      closeEditor(in, false);
#endif
      activate(in, false); } gInst.clear(); }
  reader.detach();
  fflush(stdout);
  std::_Exit(0);
}
