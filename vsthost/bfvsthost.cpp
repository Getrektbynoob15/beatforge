// BeatForge Plugin Host: loads VST3 and VST2 plugins for BeatForge in a separate process (a crashing plugin can't
// take the app down). VST3 through the Steinberg VST3 SDK (MIT licence); VST2 through BeatForge's own description of
// the VST2 binary interface (vst2abi.h). Talks to BeatForge's desktop part over stdin/stdout.
//
// Frame (both directions): u32 headerLen, u32 binLen, header (UTF-8 text), bin (raw bytes). Little endian.
// Requests: header = tab-separated fields, first = request id, second = command. Replies: header = JSON with "id".
// Unsolicited events: JSON with "ev" (param changed in the plugin's own window, window closed, log).
//
//   scan [extra paths...]                      -> {plugins:[{path,cid,name,vendor,kind,sub,fmt}]}
//   load inst path cid sampleRate maxBlock      -> {kind,params:[{id,title,units,def,steps,ro}],editor,ins,outs,latency}
//   unload inst
//   render inst frames nEv nPar tempo playing pos   bin = events (i32 offset,i32 type,i32 key,f32 vel) x nEv,
//                                                   params (u32 id, f64 value) x nPar, input L then R (f32, effects)
//                                                -> bin = output L then R (f32 x frames each)
//   getstate inst                               -> bin = u32 compLen, comp, u32 ctrlLen, ctrl
//   setstate inst                               bin as above
//   setparam inst id value                      (normalized 0..1, from BeatForge's own knobs)
//   edit inst title / closeedit inst            the plugin's own window (Windows and Mac)
//   quit
//
// VST2 files are opened once in a child process ("bfvsthost --probe2 <file>") during a scan, so a plugin that
// crashes or hangs while loading only takes that child down. Results are cached in $BF_VST_CACHE.

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
#include "vst2abi.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
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
#include <shellapi.h>
#include <ole2.h>
#include <fcntl.h>
#include <io.h>
#else
#include <dlfcn.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#endif
#ifdef __APPLE__
#include <mach-o/dyld.h>
extern "C" {
// macui.mm: plugin windows and the Cocoa main loop
void* bfMacOpenWindow(const char* title, int w, int h, int resizable, void (*onClose)(void*), void (*onResize)(void*, int, int), void* user);
void bfMacResizeWindow(void* view, int w, int h);
void bfMacCloseWindow(void* view);
void bfMacFront(void* view);
void bfMacRun(int (*tick)(void));
}
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;
namespace fs = std::filesystem;

// ---------------------------------------------------------------- framing
// Frames go to a private copy of stdout; the real stdout is pointed elsewhere so a plugin that prints text can't
// break the protocol.
static std::mutex gOutMx;
static FILE* gOut = stdout;
static void writeFrame(const std::string& head, const void* bin = nullptr, uint32_t binLen = 0) {
  std::lock_guard<std::mutex> lk(gOutMx);
  uint32_t h[2] = {(uint32_t)head.size(), binLen};
  fwrite(h, 4, 2, gOut);
  fwrite(head.data(), 1, head.size(), gOut);
  if (binLen) fwrite(bin, 1, binLen, gOut);
  fflush(gOut);
}
static bool readExact(void* p, size_t n) { return fread(p, 1, n, stdin) == n; }
static void privateStdout() {
#ifdef _WIN32
  int fd = _dup(_fileno(stdout));
  if (fd < 0) return;
  FILE* f = _fdopen(fd, "wb");
  if (!f) return;
  _setmode(fd, _O_BINARY);
  gOut = f;
  int nul = _open("NUL", _O_WRONLY);
  if (nul >= 0) { _dup2(nul, _fileno(stdout)); _close(nul); }
  SetStdHandle(STD_OUTPUT_HANDLE, (HANDLE)_get_osfhandle(_fileno(stdout)));
#else
  int fd = dup(1);
  if (fd < 0) return;
  fcntl(fd, F_SETFD, FD_CLOEXEC);
  FILE* f = fdopen(fd, "wb");
  if (!f) return;
  gOut = f;
  int nul = open("/dev/null", O_WRONLY);
  if (nul >= 0) { dup2(nul, 1); close(nul); }
#endif
}

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
static std::string trimmed(const char* s, size_t max) { // plugin strings: stop at NUL, drop control chars, trim
  std::string o;
  for (size_t i = 0; i < max && s[i]; i++) if ((unsigned char)s[i] >= 0x20) o += s[i];
  while (!o.empty() && o.back() == ' ') o.pop_back();
  size_t a = o.find_first_not_of(' ');
  return a == std::string::npos ? "" : o.substr(a);
}

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
    if (q.empty() && waitMs > 0) cv.wait_for(l, std::chrono::milliseconds(waitMs));
    if (q.empty()) return false;
    f = std::move(q.front()); q.pop_front(); return true;
  }
};
static Queue gUi, gAudio;
static std::atomic<bool> gQuit{false};
static thread_local bool tAudio = false;
#ifdef _WIN32
static DWORD gUiThread = 0;
#endif
static void wakeUi() {
#ifdef _WIN32
  if (gUiThread) PostThreadMessage(gUiThread, WM_NULL, 0, 0);
#endif
}

// ---------------------------------------------------------------- dynamic libraries (VST2)
struct Lib {
  void* h = nullptr;
  bool open(const std::string& path, std::string& err) {
#ifdef _WIN32
    int n = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? n : 1, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, &w[0], n);
    h = (void*)LoadLibraryW(w.c_str());
    if (!h) { err = "LoadLibrary failed (" + std::to_string(GetLastError()) + ")"; return false; }
#else
    std::string file = path;
#ifdef __APPLE__
    std::error_code ec;
    if (fs::is_directory(fs::u8path(path), ec)) { // a .vst bundle: the binary is the one file in Contents/MacOS
      file.clear();
      for (auto& e : fs::directory_iterator(fs::u8path(path) / "Contents" / "MacOS", ec)) if (e.is_regular_file(ec)) { file = e.path().u8string(); break; }
      if (file.empty()) { err = "no binary in the bundle"; return false; }
    }
#endif
    h = dlopen(file.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!h) { const char* e = dlerror(); err = e ? e : "dlopen failed"; return false; }
#endif
    return true;
  }
  void* sym(const char* name) {
#ifdef _WIN32
    return (void*)GetProcAddress((HMODULE)h, name);
#else
    return dlsym(h, name);
#endif
  }
  ~Lib() {
    if (!h) return;
#ifdef _WIN32
    FreeLibrary((HMODULE)h);
#else
    dlclose(h);
#endif
  }
};

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

class Frame;

struct Inst {
  std::string id, kind;
  int fmt = 3;                        // 3 = VST3, 2 = VST2
  int maxBlock = 512, ins = 0, outs = 0, latency = 0;
  double rate = 44100;
  std::mutex procMx;                  // held while processing / (de)activating / loading state
  std::mutex parMx; std::vector<std::pair<uint32_t, double>> pending; // edits waiting for the processor
  // VST3
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
  IPtr<IPlugView> view;
  Frame* frame = nullptr;
  // VST2
  std::unique_ptr<Lib> lib;
  bf2::Effect* fx = nullptr;
  bf2::TimeInfo ti{};
  std::vector<std::vector<float>> bIn, bOut;
  std::vector<float*> pIn, pOut;
  std::vector<bf2::MidiEvent> mev;
  std::vector<uint8_t> evBuf;
  bool editing2 = false;
  // the plugin's own window: HWND on Windows, NSView* on Mac
  void* win = nullptr;
  void queueParam(uint32_t id, double v) { std::lock_guard<std::mutex> l(parMx); pending.push_back({id, v}); }
};

static void paramEvent(Inst* in, uint32_t id, double v) {
  char b[200]; snprintf(b, sizeof b, "{\"ev\":\"param\",\"inst\":%s,\"pid\":%u,\"value\":%.9g}", jstr(in->id).c_str(), (unsigned)id, v);
  writeFrame(b);
}

tresult PLUGIN_API Handler::performEdit(ParamID id, ParamValue v) {
  if (!inst) return kResultFalse;
  inst->queueParam(id, v);
  paramEvent(inst, id, v);
  return kResultOk;
}

static std::shared_ptr<Inst> findInst(const std::string& id) {
  std::lock_guard<std::mutex> l(gInstMx);
  auto it = gInst.find(id);
  return it == gInst.end() ? nullptr : it->second;
}

static void winResize(Inst& in, int w, int h);

// ---------------------------------------------------------------- VST2 host side
static int32_t gShellId = 0; // which plugin of a shell file to create (asked for by the plugin while it starts)
static intptr_t BF2_CALL hostCallback(bf2::Effect* fx, int32_t op, int32_t index, intptr_t value, void* ptr, float opt) {
  Inst* in = fx ? (Inst*)fx->hostData1 : nullptr;
  auto copy = [&](const char* s) { if (ptr) { strncpy((char*)ptr, s, 63); ((char*)ptr)[63] = 0; } return (intptr_t)1; };
  switch (op) {
    case bf2::HVersion: return 2400;
    case bf2::HCurrentId: return gShellId;
    case bf2::HIdle: return 0;
    case bf2::HAutomate: if (in && index >= 0) paramEvent(in, (uint32_t)index, opt); return 0;
    case bf2::HGetTime: return in ? (intptr_t)&in->ti : 0;
    case bf2::HSizeWindow: if (in && in->win) { winResize(*in, index, (int)value); return 1; } return 0;
    case bf2::HGetSampleRate: return in ? (intptr_t)in->rate : 44100;
    case bf2::HGetBlockSize: return in ? in->maxBlock : 512;
    case bf2::HGetInputLatency: case bf2::HGetOutputLatency: return 0;
    case bf2::HGetCurrentProcessLevel: return tAudio ? 2 : 1;
    case bf2::HGetAutomationState: return 1;
    case bf2::HGetVendorString: return copy("BeatForge");
    case bf2::HGetProductString: return copy("BeatForge");
    case bf2::HGetVendorVersion: return 1;
    case bf2::HGetLanguage: return 1;
    case bf2::HUpdateDisplay: case bf2::HBeginEdit: case bf2::HEndEdit: case bf2::HIOChanged: return 1;
    case bf2::HCanDo: {
      if (!ptr) return 0;
      std::string s((const char*)ptr);
      static const char* yes[] = {"sendVstEvents", "sendVstMidiEvent", "sendVstTimeInfo", "receiveVstEvents", "receiveVstMidiEvent", "sizeWindow", "supplyIdle", "startStopProcess"};
      for (auto y : yes) if (s == y) return 1;
      return 0;
    }
    default: return 0;
  }
}

static bf2::Effect* createEffect(Lib& lib, std::string& err) {
  auto entry = (bf2::EntryProc)lib.sym("VSTPluginMain");
  if (!entry) entry = (bf2::EntryProc)lib.sym("main_macho");
  if (!entry) entry = (bf2::EntryProc)lib.sym("main");
  if (!entry) { err = "not a VST2 plugin"; return nullptr; }
  bf2::Effect* fx = entry(hostCallback);
  if (!fx || fx->magic != bf2::kMagic) { err = "the plugin did not start"; return nullptr; }
  return fx;
}
static std::string str2(bf2::Effect* fx, int32_t op, int32_t index = 0) {
  char b[512]; memset(b, 0, sizeof b);
  fx->dispatcher(fx, op, index, 0, b, 0);
  return trimmed(b, 256);
}
static std::string name2(bf2::Effect* fx, const std::string& path) {
  std::string n = str2(fx, bf2::GetEffectName);
  if (n.empty()) n = str2(fx, bf2::GetProductString);
  return n.empty() ? fs::u8path(path).stem().u8string() : n;
}
static uint32_t fnv(const std::string& s) { uint32_t h = 2166136261u; for (unsigned char c : s) { h ^= c; h *= 16777619u; } return h; }
// a VST2 plugin's id in BeatForge: "VST2" (hex) + its 4-byte id + a hash of its name + shell flag, 32 hex digits
static std::string cid2(int32_t uid, const std::string& name, bool shell) {
  char b[40]; snprintf(b, sizeof b, "56535432%08X%08X%08X", (uint32_t)uid, fnv(name), shell ? 1u : 0u);
  return b;
}
static bool isVst2Cid(const std::string& c) { return c.size() == 32 && c.compare(0, 8, "56535432") == 0; }

// probe child: describe the plugins in one VST2 file, then exit (runs in its own process)
static int probe2(const std::string& path) {
  std::ostringstream o; o << "[";
  Lib lib; std::string err;
  if (lib.open(path, err)) {
    std::string base = fs::u8path(path).stem().u8string();
    if (bf2::Effect* fx = createEffect(lib, err)) {
      int32_t cat = (int32_t)fx->dispatcher(fx, bf2::GetPlugCategory, 0, 0, nullptr, 0);
      bool first = true;
      auto add = [&](const std::string& name, const std::string& vendor, int32_t uid, bool synth, bool shell) {
        if (!first) o << ","; first = false;
        o << "{\"path\":" << jstr(path) << ",\"cid\":" << jstr(cid2(uid, name, shell)) << ",\"name\":" << jstr(name) << ",\"vendor\":" << jstr(vendor)
          << ",\"kind\":" << jstr(synth ? "instrument" : "effect") << ",\"sub\":" << jstr(synth ? "Instrument" : "Fx") << ",\"fmt\":\"VST2\"}";
      };
      std::string vendor = str2(fx, bf2::GetVendorString);
      if (cat == bf2::CatShell) {
        for (int i = 0; i < 2000; i++) {
          char nm[512] = {0};
          int32_t id = (int32_t)fx->dispatcher(fx, bf2::ShellGetNextPlugin, 0, 0, nm, 0);
          if (!id) break;
          std::string n = trimmed(nm, 256);
          add(n.empty() ? base : n, vendor, id, false, true); // a shell does not say which are instruments
        }
      } else {
        fx->dispatcher(fx, bf2::Open, 0, 0, nullptr, 0);
        std::string name = name2(fx, path);
        bool synth = (fx->flags & bf2::IsSynth) || cat == bf2::CatSynth;
        if (fx->numOutputs > 0) add(name, vendor, fx->uniqueID, synth, false);
        fx->dispatcher(fx, bf2::Close, 0, 0, nullptr, 0);
      }
    }
  }
  o << "]";
  std::string s = "\nBFPROBE " + o.str() + "\n";
  fwrite(s.data(), 1, s.size(), gOut); fflush(gOut);
  std::_Exit(0);
}

static std::string selfPath() {
#ifdef _WIN32
  wchar_t b[4096]; DWORD n = GetModuleFileNameW(nullptr, b, 4096);
  int m = WideCharToMultiByte(CP_UTF8, 0, b, (int)n, nullptr, 0, nullptr, nullptr);
  std::string s(m, '\0'); WideCharToMultiByte(CP_UTF8, 0, b, (int)n, &s[0], m, nullptr, nullptr); return s;
#elif defined(__APPLE__)
  char b[4096]; uint32_t n = sizeof b; return _NSGetExecutablePath(b, &n) == 0 ? std::string(b) : std::string();
#else
  char b[4096]; ssize_t n = readlink("/proc/self/exe", b, sizeof b - 1); return n > 0 ? std::string(b, n) : std::string();
#endif
}

// run the probe child with a time limit; returns its JSON list ("" if it crashed or hung)
static std::string runProbe(const std::string& path, int ms) {
  std::string self = selfPath(), out;
  if (self.empty()) return "";
  auto t0 = std::chrono::steady_clock::now();
  auto left = [&] { return ms - (int)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count(); };
#ifdef _WIN32
  SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
  HANDLE r = nullptr, w = nullptr;
  if (!CreatePipe(&r, &w, &sa, 0)) return "";
  SetHandleInformation(r, HANDLE_FLAG_INHERIT, 0);
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
  STARTUPINFOW si{}; si.cb = sizeof si; si.dwFlags = STARTF_USESTDHANDLES; si.hStdInput = nul; si.hStdOutput = w; si.hStdError = nul;
  PROCESS_INFORMATION pi{};
  auto wide = [](const std::string& s) { int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0); std::wstring o(n > 0 ? n : 1, L'\0'); MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &o[0], n); o.resize(n > 0 ? n - 1 : 0); return o; };
  std::wstring cmd = L"\"" + wide(self) + L"\" --probe2 \"" + wide(path) + L"\"";
  BOOL ok = CreateProcessW(nullptr, &cmd[0], nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
  CloseHandle(w); CloseHandle(nul);
  if (!ok) { CloseHandle(r); return ""; }
  for (;;) {
    DWORD avail = 0, n = 0; char b[4096];
    while (PeekNamedPipe(r, nullptr, 0, nullptr, &avail, nullptr) && avail && ReadFile(r, b, std::min<DWORD>(avail, sizeof b), &n, nullptr) && n) out.append(b, n);
    if (WaitForSingleObject(pi.hProcess, 20) == WAIT_OBJECT_0) {
      while (PeekNamedPipe(r, nullptr, 0, nullptr, &avail, nullptr) && avail && ReadFile(r, b, std::min<DWORD>(avail, sizeof b), &n, nullptr) && n) out.append(b, n);
      break;
    }
    if (left() <= 0) { TerminateProcess(pi.hProcess, 1); WaitForSingleObject(pi.hProcess, 2000); out.clear(); break; }
  }
  CloseHandle(r); CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
#else
  int pfd[2];
  if (pipe(pfd)) return "";
  pid_t pid = fork();
  if (pid == 0) {
    int nul = open("/dev/null", O_RDWR);
    dup2(nul, 0); dup2(pfd[1], 1); dup2(nul, 2);
    close(pfd[0]); close(pfd[1]);
    execl(self.c_str(), self.c_str(), "--probe2", path.c_str(), (char*)nullptr);
    _exit(127);
  }
  close(pfd[1]);
  if (pid < 0) { close(pfd[0]); return ""; }
  bool killed = false;
  for (;;) {
    int l = left();
    if (l <= 0) { kill(pid, SIGKILL); killed = true; break; }
    pollfd p{pfd[0], POLLIN, 0};
    int rr = poll(&p, 1, l);
    if (rr > 0) { char b[4096]; ssize_t n = read(pfd[0], b, sizeof b); if (n <= 0) break; out.append(b, (size_t)n); }
    else if (rr == 0) { kill(pid, SIGKILL); killed = true; break; }
    else if (errno != EINTR) break;
  }
  close(pfd[0]);
  waitpid(pid, nullptr, 0);
  if (killed) out.clear();
#endif
  size_t m = out.rfind("\nBFPROBE ");
  if (m == std::string::npos) return "";
  size_t e = out.find('\n', m + 9);
  return out.substr(m + 9, e == std::string::npos ? std::string::npos : e - m - 9);
}

// ---------------------------------------------------------------- the plugin's own window
class Frame : public IPlugFrame { // VST3: the plugin asks for a new size
 public:
  Inst* in = nullptr;
  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* r) override;
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, IPlugFrame::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) { *obj = this; return kResultOk; }
    *obj = nullptr; return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
};

static void closeEditor(Inst& in, bool notify);
static void winResize(Inst& in, int w, int h) {
  if (!in.win || w <= 0 || h <= 0) return;
#ifdef _WIN32
  RECT rc{0, 0, w, h};
  AdjustWindowRect(&rc, (DWORD)GetWindowLongPtrW((HWND)in.win, GWL_STYLE), FALSE);
  SetWindowPos((HWND)in.win, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top, SWP_NOMOVE | SWP_NOZORDER);
#elif defined(__APPLE__)
  bfMacResizeWindow(in.win, w, h);
#endif
}
tresult PLUGIN_API Frame::resizeView(IPlugView* view, ViewRect* r) {
  if (!in || !in->win || !r) return kInvalidArgument;
  winResize(*in, r->getWidth(), r->getHeight());
  view->onSize(r);
  return kResultOk;
}
static void userResized(Inst* in, int w, int h) { // the user dragged the window edge
  if (in && in->fmt == 3 && in->view && in->view->canResize() == kResultTrue) { ViewRect r{0, 0, w, h}; in->view->onSize(&r); }
}

#ifdef _WIN32
static LRESULT CALLBACK wndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  auto* in = (Inst*)GetWindowLongPtrW(h, GWLP_USERDATA);
  if (m == WM_CLOSE) { if (in) closeEditor(*in, true); else DestroyWindow(h); return 0; }
  if (m == WM_SIZE) userResized(in, LOWORD(l), HIWORD(l));
  return DefWindowProcW(h, m, w, l);
}
#endif
#ifdef __APPLE__
static void macClosed(void* u) { closeEditor(*(Inst*)u, true); }
static void macResized(void* u, int w, int h) { userResized((Inst*)u, w, h); }
#endif

// a window for the plugin to draw in; returns the native handle the plugin attaches to
static void* winOpen(Inst& in, const std::string& title, int w, int h, bool resizable) {
#ifdef _WIN32
  static bool reg = false;
  if (!reg) { WNDCLASSW wc{}; wc.lpfnWndProc = wndProc; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"BeatForgePlugin"; wc.hCursor = LoadCursor(nullptr, IDC_ARROW); RegisterClassW(&wc); reg = true; }
  DWORD style = WS_OVERLAPPEDWINDOW & ~(resizable ? 0 : (WS_THICKFRAME | WS_MAXIMIZEBOX));
  RECT rc{0, 0, w, h}; AdjustWindowRect(&rc, style, FALSE);
  std::wstring wt;
  int n = MultiByteToWideChar(CP_UTF8, 0, title.c_str(), -1, nullptr, 0);
  if (n > 0) { wt.resize(n); MultiByteToWideChar(CP_UTF8, 0, title.c_str(), -1, &wt[0], n); wt.resize(n - 1); }
  HWND hw = CreateWindowExW(WS_EX_APPWINDOW, L"BeatForgePlugin", wt.c_str(), style, CW_USEDEFAULT, CW_USEDEFAULT, rc.right - rc.left, rc.bottom - rc.top, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (hw) SetWindowLongPtrW(hw, GWLP_USERDATA, (LONG_PTR)&in);
  return hw;
#elif defined(__APPLE__)
  return bfMacOpenWindow(title.c_str(), w, h, resizable ? 1 : 0, macClosed, macResized, &in);
#else
  (void)in; (void)title; (void)w; (void)h; (void)resizable; return nullptr;
#endif
}
static void winShow(void* win) {
#ifdef _WIN32
  ShowWindow((HWND)win, SW_SHOWNORMAL); SetForegroundWindow((HWND)win);
#elif defined(__APPLE__)
  bfMacFront(win);
#else
  (void)win;
#endif
}
static void winDestroy(void* win) {
#ifdef _WIN32
  DestroyWindow((HWND)win);
#elif defined(__APPLE__)
  bfMacCloseWindow(win);
#else
  (void)win;
#endif
}

static void closeEditor(Inst& in, bool notify) {
  bool had = in.win || in.view || in.editing2;
  if (in.fmt == 3 && in.view) { in.view->setFrame(nullptr); in.view->removed(); in.view = nullptr; }
  if (in.fmt == 2 && in.editing2 && in.fx) { in.editing2 = false; in.fx->dispatcher(in.fx, bf2::EditClose, 0, 0, nullptr, 0); }
  if (in.win) { void* w = in.win; in.win = nullptr; winDestroy(w); }
  delete in.frame; in.frame = nullptr;
  if (notify && had) writeFrame("{\"ev\":\"editorClosed\",\"inst\":" + jstr(in.id) + "}");
}

#if defined(_WIN32)
static const FIDString kNativeView = kPlatformTypeHWND;
#elif defined(__APPLE__)
static const FIDString kNativeView = kPlatformTypeNSView;
#else
static const FIDString kNativeView = nullptr;
#endif

static std::string openEditor(Inst& in, const std::string& title) {
  if (!kNativeView) return "Plugin windows open on Windows and Mac. Use the knobs in BeatForge here.";
  if (in.win) { winShow(in.win); return ""; }
  if (in.fmt == 2) {
    if (!in.fx || !(in.fx->flags & bf2::HasEditor)) return "This plugin has no window of its own. Use the knobs in BeatForge.";
    bf2::Rect* r = nullptr;
    in.fx->dispatcher(in.fx, bf2::EditGetRect, 0, 0, &r, 0);
    int w = r ? r->right - r->left : 0, h = r ? r->bottom - r->top : 0;
    if (w <= 0 || h <= 0) { w = 640; h = 400; }
    in.win = winOpen(in, title, w, h, false);
    if (!in.win) return "Could not open a window.";
    in.editing2 = true;
    in.fx->dispatcher(in.fx, bf2::EditOpen, 0, 0, in.win, 0);
    r = nullptr; in.fx->dispatcher(in.fx, bf2::EditGetRect, 0, 0, &r, 0); // many plugins know their size only now
    if (r && r->right - r->left > 0 && r->bottom - r->top > 0) winResize(in, r->right - r->left, r->bottom - r->top);
    winShow(in.win);
    return "";
  }
  if (!in.ctrl) return "This plugin has no controller.";
  IPtr<IPlugView> v = owned(in.ctrl->createView(ViewType::kEditor));
  if (!v) return "This plugin has no window of its own. Use the knobs in BeatForge.";
  if (v->isPlatformTypeSupported(kNativeView) != kResultTrue) return "This plugin's window is not supported here.";
  ViewRect r{}; if (v->getSize(&r) != kResultOk || r.getWidth() <= 0) r = ViewRect(0, 0, 640, 400);
  void* win = winOpen(in, title, r.getWidth(), r.getHeight(), v->canResize() == kResultTrue);
  if (!win) return "Could not open a window.";
  in.frame = new Frame(); in.frame->in = &in;
  v->setFrame(in.frame);
  if (v->attached(win, kNativeView) != kResultOk) { v->setFrame(nullptr); winDestroy(win); delete in.frame; in.frame = nullptr; return "The plugin could not open its window."; }
  in.view = v; in.win = win;
  winShow(win);
  return "";
}

// ---------------------------------------------------------------- scan
static HostApplication* gHost = nullptr;

static std::string kindOf(const VST3::Hosting::ClassInfo& ci) {
  return ci.subCategoriesString().find("Instrument") != std::string::npos ? "instrument" : "effect";
}

static std::vector<std::string> vst2Folders() {
  std::vector<std::string> d;
  auto env = [](const char* n) { const char* v = getenv(n); return std::string(v ? v : ""); };
#ifdef _WIN32
  for (HKEY root : {HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER}) {
    wchar_t b[2048]; DWORD sz = sizeof b;
    if (RegGetValueW(root, L"SOFTWARE\\VST", L"VSTPluginsPath", RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ, nullptr, b, &sz) == ERROR_SUCCESS) {
      int m = WideCharToMultiByte(CP_UTF8, 0, b, -1, nullptr, 0, nullptr, nullptr);
      std::string s(m > 0 ? m - 1 : 0, '\0'); if (m > 1) WideCharToMultiByte(CP_UTF8, 0, b, -1, &s[0], m, nullptr, nullptr);
      if (!s.empty()) d.push_back(s);
    }
  }
  std::string pf = env("ProgramFiles"), cf = env("CommonProgramFiles");
  if (pf.empty()) pf = "C:\\Program Files";
  if (cf.empty()) cf = pf + "\\Common Files";
  for (auto s : {pf + "\\VSTPlugins", pf + "\\Steinberg\\VSTPlugins", cf + "\\VST2", cf + "\\Steinberg\\VST2"}) d.push_back(s);
#elif defined(__APPLE__)
  d.push_back("/Library/Audio/Plug-Ins/VST");
  if (!env("HOME").empty()) d.push_back(env("HOME") + "/Library/Audio/Plug-Ins/VST");
#else
  std::string vp = env("VST_PATH");
  for (size_t a = 0; !vp.empty();) { size_t b = vp.find(':', a); d.push_back(vp.substr(a, b == std::string::npos ? std::string::npos : b - a)); if (b == std::string::npos) break; a = b + 1; }
  if (!env("HOME").empty()) d.push_back(env("HOME") + "/.vst");
  for (auto s : {"/usr/lib/vst", "/usr/local/lib/vst", "/usr/lib64/vst"}) d.push_back(s);
#endif
  return d;
}
static std::string lower(std::string s) { std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)tolower(c); }); return s; }
static bool vst2File(const fs::path& p, bool isDir) {
  std::string e = lower(p.extension().u8string());
#ifdef _WIN32
  return !isDir && e == ".dll";
#elif defined(__APPLE__)
  return isDir && e == ".vst";
#else
  return !isDir && e == ".so";
#endif
}
static void findVst2(const std::string& root, std::vector<std::string>& out) {
  std::error_code ec;
  fs::path r = fs::u8path(root);
  if (!fs::exists(r, ec)) return;
  if (vst2File(r, fs::is_directory(r, ec))) { out.push_back(root); return; }
  auto it = fs::recursive_directory_iterator(r, fs::directory_options::skip_permission_denied, ec);
  int n = 0;
  for (; !ec && it != fs::recursive_directory_iterator() && n < 20000; it.increment(ec), n++) {
    const auto& p = it->path();
    std::string ext = lower(p.extension().u8string());
    bool dir = it->is_directory(ec);
    if (ext == ".vst3" || ext == ".component" || ext == ".clap") { if (dir) it.disable_recursion_pending(); continue; } // other formats
    if (vst2File(p, dir)) { out.push_back(p.u8string()); if (dir) it.disable_recursion_pending(); }
  }
}

// scan cache: one line per VST2 file: path \t stamp \t json
typedef std::map<std::string, std::pair<std::string, std::string>> Cache;
static Cache readCache() {
  Cache m;
  const char* f = getenv("BF_VST_CACHE");
  if (!f || !*f) return m;
  std::ifstream in(fs::u8path(f));
  std::string line;
  while (std::getline(in, line)) {
    auto a = line.find('\t'), b = a == std::string::npos ? a : line.find('\t', a + 1);
    if (b == std::string::npos) continue;
    m[line.substr(0, a)] = {line.substr(a + 1, b - a - 1), line.substr(b + 1)};
  }
  return m;
}
static void writeCache(const Cache& m) {
  const char* f = getenv("BF_VST_CACHE");
  if (!f || !*f) return;
  std::ofstream o(fs::u8path(f), std::ios::trunc);
  for (auto& kv : m) o << kv.first << '\t' << kv.second.first << '\t' << kv.second.second << '\n';
}
static std::string stampOf(const std::string& p) {
  std::error_code ec;
  auto t = fs::last_write_time(fs::u8path(p), ec);
  uintmax_t sz = fs::is_directory(fs::u8path(p), ec) ? 0 : fs::file_size(fs::u8path(p), ec);
  return std::to_string((long long)t.time_since_epoch().count()) + ":" + std::to_string((unsigned long long)sz);
}

static void cmdScan(const std::string& rid, const std::vector<std::string>& f) {
  auto paths = VST3::Hosting::Module::getModulePaths();
  std::vector<std::string> v2roots = vst2Folders(), v2;
  // extra folders from BeatForge's settings: every .vst3 inside (a .vst3 is a folder or, on Windows, sometimes a
  // file), and every VST2 plugin file
  for (size_t i = 2; i < f.size(); i++) {
    if (f[i].empty()) continue;
    std::error_code ec;
    fs::path root = fs::u8path(f[i]);
    v2roots.push_back(f[i]);
    if (root.extension() == ".vst3") { paths.push_back(f[i]); continue; }
    auto it = fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied, ec);
    for (; !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) {
      if (it->path().extension() == ".vst3") { paths.push_back(it->path().u8string()); if (it->is_directory(ec)) it.disable_recursion_pending(); }
    }
  }
  for (auto& r : v2roots) findVst2(r, v2);
  std::sort(paths.begin(), paths.end()); paths.erase(std::unique(paths.begin(), paths.end()), paths.end());
  std::sort(v2.begin(), v2.end()); v2.erase(std::unique(v2.begin(), v2.end()), v2.end());
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
        << ",\"vendor\":" << jstr(ci.vendor()) << ",\"kind\":" << jstr(kindOf(ci)) << ",\"sub\":" << jstr(ci.subCategoriesString()) << ",\"fmt\":\"VST3\"}";
    }
  }
  Cache cache = readCache(), next;
  for (auto& p : v2) {
    std::string st = stampOf(p), list;
    auto c = cache.find(p);
    if (c != cache.end() && c->second.first == st) list = c->second.second;
    else { list = runProbe(p, 15000); if (list.empty()) { logEv("skip " + p + ": crashed, hung or not a 64-bit plugin"); list = "[]"; } }
    next[p] = {st, list};
    if (list.size() > 2) { if (!first) o << ","; first = false; o << list.substr(1, list.size() - 2); }
  }
  writeCache(next);
  o << "]}";
  writeFrame(o.str());
}

// ---------------------------------------------------------------- load / unload
static void activate(Inst& in, bool on) {
  std::lock_guard<std::mutex> l(in.procMx);
  if (in.fmt == 2) {
    if (!in.fx) return;
    if (on) { in.fx->dispatcher(in.fx, bf2::MainsChanged, 0, 1, nullptr, 0); in.fx->dispatcher(in.fx, bf2::StartProcess, 0, 0, nullptr, 0); }
    else { in.fx->dispatcher(in.fx, bf2::StopProcess, 0, 0, nullptr, 0); in.fx->dispatcher(in.fx, bf2::MainsChanged, 0, 0, nullptr, 0); }
    return;
  }
  if (!in.proc || !in.comp) return;
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

static std::string load2(Inst& in, const std::string& path, const std::string& cid, std::ostringstream& o) {
  in.fmt = 2;
  in.lib.reset(new Lib());
  std::string err;
  if (!in.lib->open(path, err)) return "Could not load " + path + ": " + err;
  bool shell = cid.substr(24) == "00000001";
  gShellId = shell ? (int32_t)strtoul(cid.substr(8, 8).c_str(), nullptr, 16) : 0;
  in.fx = createEffect(*in.lib, err);
  gShellId = 0;
  if (!in.fx) return err;
  in.fx->hostData1 = (intptr_t)&in;
  in.fx->dispatcher(in.fx, bf2::Open, 0, 0, nullptr, 0);
  if (!shell && cid != cid2(in.fx->uniqueID, name2(in.fx, path), false)) logEv("VST2 id changed for " + path); // a newer version: load it anyway
  if (in.fx->numOutputs <= 0) return "This plugin has no audio output.";
  if (!(in.fx->flags & bf2::CanReplacing) && !in.fx->processOld) return "This plugin can't process audio in this host.";
  in.fx->dispatcher(in.fx, bf2::SetSampleRate, 0, 0, nullptr, (float)in.rate);
  in.fx->dispatcher(in.fx, bf2::SetBlockSize, 0, in.maxBlock, nullptr, 0);
  int32_t cat = (int32_t)in.fx->dispatcher(in.fx, bf2::GetPlugCategory, 0, 0, nullptr, 0);
  in.kind = ((in.fx->flags & bf2::IsSynth) || cat == bf2::CatSynth) ? "instrument" : "effect";
  in.bIn.assign(std::max(0, in.fx->numInputs), std::vector<float>(in.maxBlock, 0.f));
  in.bOut.assign(in.fx->numOutputs, std::vector<float>(in.maxBlock, 0.f));
  in.pIn.clear(); for (auto& b : in.bIn) in.pIn.push_back(b.data());
  in.pOut.clear(); for (auto& b : in.bOut) in.pOut.push_back(b.data());
  if (in.pIn.empty()) in.pIn.push_back(nullptr);
  in.ins = in.fx->numInputs > 0 ? 1 : 0; in.outs = 1; in.latency = std::max(0, in.fx->initialDelay);
  in.ti.sampleRate = in.rate; in.ti.tempo = 120; in.ti.timeSigNumerator = 4; in.ti.timeSigDenominator = 4;
  activate(in, true);
  o << "\"kind\":" << jstr(in.kind) << ",\"ins\":" << in.ins << ",\"outs\":" << in.outs << ",\"latency\":" << in.latency << ",\"params\":[";
  for (int i = 0; i < in.fx->numParams && i < 4000; i++) {
    std::string t = str2(in.fx, bf2::GetParamName, i), u = str2(in.fx, bf2::GetParamLabel, i);
    float v = in.fx->getParameter ? in.fx->getParameter(in.fx, i) : 0.f;
    if (!(v >= 0.f && v <= 1.f)) v = 0.f;
    o << (i ? "," : "") << "{\"id\":" << i << ",\"title\":" << jstr(t.empty() ? "Param " + std::to_string(i + 1) : t) << ",\"units\":" << jstr(u)
      << ",\"def\":" << v << ",\"value\":" << v << ",\"steps\":0,\"ro\":false,\"auto\":true}";
  }
  o << "],\"editor\":" << ((kNativeView && (in.fx->flags & bf2::HasEditor)) ? "true" : "false");
  return "";
}

static std::string load3(Inst& in, const std::string& path, const std::string& cid, std::ostringstream& o) {
  std::string err;
  in.module = VST3::Hosting::Module::create(path, err);
  if (!in.module) return "Could not load " + path + ": " + err;
  auto factory = in.module->getFactory();
  for (auto& ci : factory.classInfos()) {
    if (ci.category() != kVstAudioEffectClass || ci.ID().toString() != cid) continue;
    in.kind = kindOf(ci);
    in.provider = owned(new PlugProvider(factory, ci, true));
    break;
  }
  if (!in.provider) return "That plugin is not in " + path;
  if (!in.provider->initialize()) return "The plugin did not start.";
  in.comp = in.provider->getComponentPtr();
  in.ctrl = in.provider->getControllerPtr();
  in.proc = U::cast<IAudioProcessor>(in.comp);
  if (!in.comp || !in.proc) return "Not an audio plugin.";
  in.handler.inst = &in;
  if (in.ctrl) in.ctrl->setComponentHandler(&in.handler);
  // stereo main buses where possible, everything else off
  SpeakerArrangement st = SpeakerArr::kStereo;
  in.ins = in.comp->getBusCount(kAudio, kInput); in.outs = in.comp->getBusCount(kAudio, kOutput);
  std::vector<SpeakerArrangement> ia(in.ins, st), oa(in.outs, st);
  in.proc->setBusArrangements(ia.empty() ? nullptr : ia.data(), (int32)ia.size(), oa.empty() ? nullptr : oa.data(), (int32)oa.size());
  for (int i = 0; i < in.ins; i++) in.comp->activateBus(kAudio, kInput, i, i == 0);
  for (int i = 0; i < in.outs; i++) in.comp->activateBus(kAudio, kOutput, i, i == 0);
  for (int i = 0; i < in.comp->getBusCount(kEvent, kInput); i++) in.comp->activateBus(kEvent, kInput, i, i == 0);
  if (in.outs == 0) return "This plugin has no audio output.";
  in.data.inputEvents = &in.events;
  in.data.inputParameterChanges = &in.pchanges;
  in.data.processContext = &in.pctx;
  activate(in, true);
  in.latency = (int)in.proc->getLatencySamples();
  o << "\"kind\":" << jstr(in.kind) << ",\"ins\":" << in.ins << ",\"outs\":" << in.outs << ",\"latency\":" << in.latency << ",\"params\":[";
  if (in.ctrl) {
    int n = in.ctrl->getParameterCount(); bool first = true;
    for (int i = 0; i < n && i < 4000; i++) {
      ParameterInfo pi{};
      if (in.ctrl->getParameterInfo(i, pi) != kResultOk) continue;
      if (pi.flags & ParameterInfo::kIsHidden) continue;
      if (!first) o << ","; first = false;
      o << "{\"id\":" << pi.id << ",\"title\":" << jstr(u16(pi.title)) << ",\"units\":" << jstr(u16(pi.units)) << ",\"def\":" << pi.defaultNormalizedValue
        << ",\"value\":" << in.ctrl->getParamNormalized(pi.id) << ",\"steps\":" << pi.stepCount << ",\"ro\":" << ((pi.flags & ParameterInfo::kIsReadOnly) ? "true" : "false")
        << ",\"auto\":" << ((pi.flags & ParameterInfo::kCanAutomate) ? "true" : "false") << "}";
    }
  }
  bool editor = false;
  if (in.ctrl && kNativeView) { IPtr<IPlugView> v = owned(in.ctrl->createView(ViewType::kEditor)); editor = v && v->isPlatformTypeSupported(kNativeView) == kResultTrue; }
  o << "],\"editor\":" << (editor ? "true" : "false");
  return "";
}

static void cmdLoad(const std::string& rid, const std::vector<std::string>& f) {
  auto fail = [&](const std::string& e) { writeFrame("{\"id\":" + jstr(rid) + ",\"error\":" + jstr(e) + "}"); };
  if (f.size() < 7) return fail("bad load");
  auto in = std::make_shared<Inst>();
  in->id = f[2]; in->rate = atof(f[5].c_str()); in->maxBlock = std::max(64, std::min(8192, atoi(f[6].c_str())));
  if (!(in->rate >= 8000 && in->rate <= 384000)) in->rate = 44100;
  std::ostringstream o;
  o << "{\"id\":" << jstr(rid) << ",";
  std::string e = isVst2Cid(f[4]) ? load2(*in, f[3], f[4], o) : load3(*in, f[3], f[4], o);
  if (!e.empty()) {
    if (in->fmt == 2 && in->fx) { in->fx->dispatcher(in->fx, bf2::Close, 0, 0, nullptr, 0); in->fx = nullptr; }
    return fail(e);
  }
  o << "}";
  { std::lock_guard<std::mutex> l(gInstMx); gInst[in->id] = in; }
  writeFrame(o.str());
}

static void cmdUnload(const std::string& rid, const std::string& id) {
  std::shared_ptr<Inst> in;
  { std::lock_guard<std::mutex> l(gInstMx); auto it = gInst.find(id); if (it != gInst.end()) { in = it->second; gInst.erase(it); } }
  if (in) {
    closeEditor(*in, false);
    activate(*in, false);
    if (in->fmt == 2) {
      std::lock_guard<std::mutex> l(in->procMx);
      if (in->fx) { in->fx->dispatcher(in->fx, bf2::Close, 0, 0, nullptr, 0); in->fx = nullptr; }
    } else {
      if (in->ctrl) in->ctrl->setComponentHandler(nullptr);
      in->proc = nullptr; in->comp = nullptr; in->ctrl = nullptr; in->provider = nullptr;
    }
  }
  writeFrame("{\"id\":" + jstr(rid) + ",\"ok\":true}");
}

// ---------------------------------------------------------------- render (audio thread)
struct Ev { int32_t off, type, key; float vel; };

static void render2(Inst& in, const std::vector<Ev>& evs, int frames, double tempo, bool playing, int64_t pos, const float* inL, const float* inR, std::vector<float>& out) {
  bf2::Effect* fx = in.fx;
  int done = 0;
  while (done < frames) {
    int n = std::min(in.maxBlock, frames - done);
    { std::lock_guard<std::mutex> pl(in.parMx);
      for (auto& pv : in.pending) if (fx->setParameter && pv.first < (uint32_t)fx->numParams) fx->setParameter(fx, (int32_t)pv.first, (float)pv.second);
      in.pending.clear(); }
    in.mev.clear();
    auto midi = [&](int off, int a, int b, int c) {
      bf2::MidiEvent m{}; m.type = 1; m.byteSize = sizeof(bf2::MidiEvent); m.deltaFrames = std::max(0, off - done); m.flags = 1;
      m.midiData[0] = (char)a; m.midiData[1] = (char)b; m.midiData[2] = (char)c; in.mev.push_back(m);
    };
    for (auto& e : evs) {
      if (e.off < done || e.off >= done + n) { if (!(done == 0 && e.off < 0)) continue; }
      int key = std::max(0, std::min(127, e.key));
      if (e.type == 0) midi(e.off, 0x90, key, std::max(1, std::min(127, (int)(e.vel * 127.f + 0.5f))));
      else if (e.type == 1) midi(e.off, 0x80, key, 0);
      else if (e.type == 2) { midi(e.off, 0xB0, 123, 0); for (int k = 0; k < 128; k++) midi(e.off, 0x80, k, 0); }
    }
    std::stable_sort(in.mev.begin(), in.mev.end(), [](const bf2::MidiEvent& a, const bf2::MidiEvent& b) { return a.deltaFrames < b.deltaFrames; });
    if (!in.mev.empty()) {
      in.evBuf.assign(sizeof(bf2::Events) + in.mev.size() * sizeof(void*), 0);
      auto* list = (bf2::Events*)in.evBuf.data();
      list->numEvents = (int32_t)in.mev.size();
      for (size_t i = 0; i < in.mev.size(); i++) list->events[i] = (bf2::Event*)&in.mev[i];
      fx->dispatcher(fx, bf2::ProcessEvents, 0, 0, list, 0);
    }
    in.ti.samplePos = (double)(pos + done); in.ti.sampleRate = in.rate; in.ti.tempo = tempo > 0 ? tempo : 120;
    in.ti.ppqPos = in.ti.samplePos / in.rate * in.ti.tempo / 60.0; in.ti.barStartPos = std::floor(in.ti.ppqPos / 4) * 4;
    in.ti.nanoSeconds = (double)std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    in.ti.timeSigNumerator = 4; in.ti.timeSigDenominator = 4;
    in.ti.flags = bf2::NanosValid | bf2::PpqValid | bf2::TempoValid | bf2::BarsValid | bf2::TimeSigValid | (playing ? bf2::TransportPlaying : 0);
    for (size_t c = 0; c < in.bIn.size(); c++) {
      float* d = in.bIn[c].data();
      if (!inL) { memset(d, 0, n * 4); continue; }
      if (in.bIn.size() == 1) for (int i = 0; i < n; i++) d[i] = 0.5f * (inL[done + i] + inR[done + i]);
      else if (c < 2) memcpy(d, (c == 0 ? inL : inR) + done, n * 4);
      else memset(d, 0, n * 4);
    }
    for (auto& b : in.bOut) memset(b.data(), 0, n * 4);
    if (fx->flags & bf2::CanReplacing) fx->processReplacing(fx, in.pIn.data(), in.pOut.data(), n);
    else fx->processOld(fx, in.pIn.data(), in.pOut.data(), n);
    for (int c = 0; c < 2; c++) {
      const float* src = in.bOut[std::min(c, (int)in.bOut.size() - 1)].data();
      float* dst = out.data() + (size_t)c * frames + done;
      for (int i = 0; i < n; i++) { float v = src[i]; dst[i] = (v == v && v < 8.f && v > -8.f) ? v : 0.f; } // NaN/blow-up guard
    }
    done += n;
  }
}

static void render3(Inst& in, const std::vector<Ev>& evs, int frames, double tempo, bool playing, int64_t pos, const float* inL, const float* inR, std::vector<float>& out) {
  int done = 0;
  std::vector<float> zero(in.maxBlock, 0.f);
  while (done < frames) {
    int n = std::min(in.maxBlock, frames - done);
    in.events.clear(); in.pchanges.clearQueue();
    for (auto& e : evs) {
      if (e.off < done || e.off >= done + n) { if (!(done == 0 && e.off < 0)) continue; }
      Event ve{}; ve.busIndex = 0; ve.sampleOffset = std::max(0, e.off - done);
      if (e.type == 0) { ve.type = Event::kNoteOnEvent; ve.noteOn.channel = 0; ve.noteOn.pitch = (int16)e.key; ve.noteOn.velocity = e.vel; ve.noteOn.noteId = -1; }
      else if (e.type == 1) { ve.type = Event::kNoteOffEvent; ve.noteOff.channel = 0; ve.noteOff.pitch = (int16)e.key; ve.noteOff.velocity = 0; ve.noteOff.noteId = -1; }
      else continue;
      in.events.addEvent(ve);
    }
    { std::lock_guard<std::mutex> pl(in.parMx);
      for (auto& pv : in.pending) { int32 idx = 0; if (auto* q = in.pchanges.addParameterData(pv.first, idx)) { int32 qi = 0; q->addPoint(0, pv.second, qi); } }
      in.pending.clear(); }
    for (auto& e : evs) if (e.type == 2 && e.off >= done && e.off < done + n) { // all notes off
      for (int k = 0; k < 128; k++) { Event ve{}; ve.type = Event::kNoteOffEvent; ve.sampleOffset = std::max(0, e.off - done); ve.noteOff.pitch = (int16)k; ve.noteOff.noteId = -1; in.events.addEvent(ve); }
    }
    in.pctx.state = ProcessContext::kTempoValid | ProcessContext::kProjectTimeMusicValid | (playing ? ProcessContext::kPlaying : 0);
    in.pctx.sampleRate = in.rate; in.pctx.tempo = tempo > 0 ? tempo : 120;
    in.pctx.projectTimeSamples = pos + done;
    in.pctx.projectTimeMusic = (double)(pos + done) / in.rate * in.pctx.tempo / 60.0;
    in.pctx.timeSigNumerator = 4; in.pctx.timeSigDenominator = 4; in.pctx.state |= ProcessContext::kTimeSigValid;
    in.data.numSamples = n;
    if (in.data.numInputs > 0 && in.data.inputs[0].numChannels > 0) {
      auto& b = in.data.inputs[0];
      for (int c = 0; c < b.numChannels; c++) {
        const float* src = inL ? (c == 0 ? inL : inR) + done : zero.data();
        memcpy(b.channelBuffers32[c], src, n * 4);
      }
      b.silenceFlags = 0;
    }
    in.proc->process(in.data);
    if (in.data.numOutputs > 0) {
      auto& b = in.data.outputs[0];
      for (int c = 0; c < 2; c++) {
        float* src = b.numChannels > 0 ? b.channelBuffers32[std::min(c, (int)b.numChannels - 1)] : nullptr;
        float* dst = out.data() + (size_t)c * frames + done;
        if (src) for (int i = 0; i < n; i++) { float v = src[i]; dst[i] = (v == v && v < 8.f && v > -8.f) ? v : 0.f; }
      }
    }
    done += n;
  }
}

static void cmdRender(const std::string& rid, const std::vector<std::string>& f, const std::vector<uint8_t>& bin) {
  auto in = f.size() >= 9 ? findInst(f[2]) : nullptr;
  int frames = f.size() >= 9 ? std::max(0, std::min(1 << 20, atoi(f[3].c_str()))) : 0;
  std::vector<float> out((size_t)frames * 2, 0.f);
  if (!in || !frames) { writeFrame("{\"id\":" + jstr(rid) + ",\"error\":\"not loaded\"}", out.data(), (uint32_t)(out.size() * 4)); return; }
  int nEv = atoi(f[4].c_str()), nPar = atoi(f[5].c_str());
  double tempo = atof(f[6].c_str()); bool playing = f[7] == "1"; int64_t pos = atoll(f[8].c_str());
  const uint8_t* p = bin.data(); const uint8_t* end = p + bin.size();
  std::vector<Ev> evs;
  for (int i = 0; i < nEv && p + 16 <= end; i++, p += 16) { Ev e; memcpy(&e, p, 16); evs.push_back(e); }
  std::map<uint32_t, double> shown; // automation: the processor gets every change, the plugin's window the latest (on the UI thread)
  for (int i = 0; i < nPar && p + 12 <= end; i++, p += 12) { uint32_t id; double v; memcpy(&id, p, 4); memcpy(&v, p + 4, 8); in->queueParam(id, v); shown[id] = v; }
  if (!shown.empty() && in->fmt == 3 && in->ctrl) { auto keep = in; gUi.push([keep, shown] { if (keep->ctrl) for (auto& kv : shown) keep->ctrl->setParamNormalized(kv.first, kv.second); }); wakeUi(); }
  const float* inL = nullptr; const float* inR = nullptr;
  if ((size_t)(end - p) >= (size_t)frames * 8) { inL = (const float*)p; inR = inL + frames; }
  {
    std::lock_guard<std::mutex> l(in->procMx);
    if (in->fmt == 2) { if (in->fx) render2(*in, evs, frames, tempo, playing, pos, inL, inR, out); }
    else if (in->proc) render3(*in, evs, frames, tempo, playing, pos, inL, inR, out);
  }
  writeFrame("{\"id\":" + jstr(rid) + "}", out.data(), (uint32_t)(out.size() * 4));
}

// ---------------------------------------------------------------- state
// VST2 state inside the "component" part: 'C' + the plugin's own chunk, or 'P' + u32 count + f32 values
static void cmdGetState(const std::string& rid, const std::string& id) {
  auto in = findInst(id);
  if (!in) { writeFrame("{\"id\":" + jstr(rid) + ",\"error\":\"not loaded\"}"); return; }
  std::vector<uint8_t> out;
  auto putBytes = [&](const void* d, uint32_t n) { out.insert(out.end(), (uint8_t*)&n, (uint8_t*)&n + 4); if (n) out.insert(out.end(), (const uint8_t*)d, (const uint8_t*)d + n); };
  if (in->fmt == 2) {
    std::vector<uint8_t> c;
    { std::lock_guard<std::mutex> l(in->procMx);
      bf2::Effect* fx = in->fx;
      void* data = nullptr; intptr_t n = 0;
      if (fx->flags & bf2::ProgramChunks) n = fx->dispatcher(fx, bf2::GetChunk, 0, 0, &data, 0);
      if (n > 0 && data && n < (256 << 20)) { c.push_back('C'); c.insert(c.end(), (uint8_t*)data, (uint8_t*)data + n); }
      else {
        c.push_back('P'); uint32_t k = (uint32_t)std::max(0, fx->numParams); c.insert(c.end(), (uint8_t*)&k, (uint8_t*)&k + 4);
        for (uint32_t i = 0; i < k; i++) { float v = fx->getParameter ? fx->getParameter(fx, (int32_t)i) : 0.f; c.insert(c.end(), (uint8_t*)&v, (uint8_t*)&v + 4); }
      } }
    putBytes(c.data(), (uint32_t)c.size()); putBytes(nullptr, 0);
  } else {
    MemoryStream cs, ks;
    { std::lock_guard<std::mutex> l(in->procMx); in->comp->getState(&cs); }
    if (in->ctrl) in->ctrl->getState(&ks);
    auto put = [&](MemoryStream& s) { int64 sz = 0; s.seek(0, IBStream::kIBSeekEnd, &sz); putBytes(s.getData(), (uint32_t)sz); };
    put(cs); put(ks);
  }
  writeFrame("{\"id\":" + jstr(rid) + "}", out.data(), (uint32_t)out.size());
}

static void cmdSetState(const std::string& rid, const std::string& id, const std::vector<uint8_t>& bin) {
  auto in = findInst(id);
  auto bad = [&] { writeFrame("{\"id\":" + jstr(rid) + ",\"error\":\"bad state\"}"); };
  if (!in || bin.size() < 8) return bad();
  uint32_t cn = 0; memcpy(&cn, bin.data(), 4);
  if (4 + (size_t)cn + 4 > bin.size()) return bad();
  uint32_t kn = 0; memcpy(&kn, bin.data() + 4 + cn, 4);
  if (8 + (size_t)cn + kn > bin.size()) return bad();
  std::ostringstream o; o << "{\"id\":" << jstr(rid) << ",\"values\":[";
  if (in->fmt == 2) {
    const uint8_t* c = bin.data() + 4;
    bf2::Effect* fx = in->fx;
    { std::lock_guard<std::mutex> l(in->procMx);
      if (cn > 1 && c[0] == 'C') fx->dispatcher(fx, bf2::SetChunk, 0, (intptr_t)(cn - 1), (void*)(c + 1), 0);
      else if (cn >= 5 && c[0] == 'P') {
        uint32_t k = 0; memcpy(&k, c + 1, 4);
        for (uint32_t i = 0; i < k && 5 + (size_t)(i + 1) * 4 <= cn && (int32_t)i < fx->numParams; i++) { float v; memcpy(&v, c + 5 + i * 4, 4); if (fx->setParameter) fx->setParameter(fx, (int32_t)i, v); }
      }
      for (int i = 0; i < fx->numParams && i < 4000; i++) o << (i ? "," : "") << "[" << i << "," << (fx->getParameter ? fx->getParameter(fx, i) : 0.f) << "]";
    }
  } else {
    MemoryStream cs; int32 w = 0; cs.write((void*)(bin.data() + 4), (int32)cn, &w); cs.seek(0, IBStream::kIBSeekSet, nullptr);
    { std::lock_guard<std::mutex> l(in->procMx); in->comp->setState(&cs); }
    if (in->ctrl) { cs.seek(0, IBStream::kIBSeekSet, nullptr); in->ctrl->setComponentState(&cs); }
    if (in->ctrl && kn) { MemoryStream ks; int32 w2 = 0; ks.write((void*)(bin.data() + 8 + cn), (int32)kn, &w2); ks.seek(0, IBStream::kIBSeekSet, nullptr); in->ctrl->setState(&ks); }
    // report the new knob values so BeatForge's own knobs follow
    if (in->ctrl) { int n = in->ctrl->getParameterCount(); bool first = true; for (int i = 0; i < n && i < 4000; i++) { ParameterInfo pi{}; if (in->ctrl->getParameterInfo(i, pi) == kResultOk) { o << (first ? "" : ",") << "[" << pi.id << "," << in->ctrl->getParamNormalized(pi.id) << "]"; first = false; } } }
  }
  o << "]}";
  writeFrame(o.str());
}

// ---------------------------------------------------------------- UI-thread commands
static void handleUi(const Msg& m) {
  const auto& f = m.f; const std::string& rid = f[0]; const std::string& cmd = f.size() > 1 ? f[1] : "";
  if (cmd == "scan") cmdScan(rid, f);
  else if (cmd == "load") cmdLoad(rid, f);
  else if (cmd == "unload" && f.size() > 2) cmdUnload(rid, f[2]);
  else if (cmd == "getstate" && f.size() > 2) cmdGetState(rid, f[2]);
  else if (cmd == "setstate" && f.size() > 2) cmdSetState(rid, f[2], m.bin);
  else if (cmd == "setparam" && f.size() > 4) {
    auto in = findInst(f[2]);
    if (in) {
      uint32_t id = (uint32_t)strtoul(f[3].c_str(), nullptr, 10); double v = atof(f[4].c_str());
      if (in->fmt == 3 && in->ctrl) in->ctrl->setParamNormalized(id, v);
      if (in->fmt == 2 && in->fx && in->fx->setParameter && id < (uint32_t)in->fx->numParams) { std::lock_guard<std::mutex> l(in->procMx); in->fx->setParameter(in->fx, (int32_t)id, (float)v); }
      else in->queueParam(id, v);
    }
    writeFrame("{\"id\":" + jstr(rid) + ",\"ok\":true}");
  } else if (cmd == "edit" && f.size() > 2) {
    auto in = findInst(f[2]);
    std::string e = in ? openEditor(*in, f.size() > 3 ? f[3] : "Plugin") : "not loaded";
    writeFrame("{\"id\":" + jstr(rid) + (e.empty() ? ",\"ok\":true}" : ",\"error\":" + jstr(e) + "}"));
  } else if (cmd == "closeedit" && f.size() > 2) {
    if (auto in = findInst(f[2])) closeEditor(*in, false);
    writeFrame("{\"id\":" + jstr(rid) + ",\"ok\":true}");
  } else if (cmd == "ping") writeFrame("{\"id\":" + jstr(rid) + ",\"ok\":true,\"version\":2}");
  else writeFrame("{\"id\":" + jstr(rid) + ",\"error\":" + jstr("unknown command " + cmd) + "}");
}

// VST2 windows want a regular "idle" call
static void idle2() {
  std::vector<std::shared_ptr<Inst>> list;
  { std::lock_guard<std::mutex> l(gInstMx); for (auto& kv : gInst) if (kv.second->editing2) list.push_back(kv.second); }
  for (auto& in : list) if (in->fx && in->editing2) in->fx->dispatcher(in->fx, bf2::EditIdle, 0, 0, nullptr, 0);
}

static void shutdownAll() {
  std::lock_guard<std::mutex> l(gInstMx);
  for (auto& kv : gInst) {
    auto& in = *kv.second;
    closeEditor(in, false);
    activate(in, false);
    if (in.fmt == 2 && in.fx) { in.fx->dispatcher(in.fx, bf2::Close, 0, 0, nullptr, 0); in.fx = nullptr; }
  }
  gInst.clear();
}

#ifdef __APPLE__
static int macTick() {
  std::function<void()> f;
  for (int i = 0; i < 64 && gUi.pop(f, 0); i++) f();
  idle2();
  return gQuit ? 0 : 1;
}
#endif

int main(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
#endif
  privateStdout();
  if (argc >= 3 && std::string(argv[1]) == "--probe2") {
#ifdef _WIN32
    // the path in UTF-16 (non-Latin letters)
    int wn = 0; LPWSTR* wa = CommandLineToArgvW(GetCommandLineW(), &wn);
    if (wa && wn >= 3) { int m = WideCharToMultiByte(CP_UTF8, 0, wa[2], -1, nullptr, 0, nullptr, nullptr); std::string s(m > 0 ? m - 1 : 0, '\0'); if (m > 1) WideCharToMultiByte(CP_UTF8, 0, wa[2], -1, &s[0], m, nullptr, nullptr); return probe2(s); }
#endif
    return probe2(argv[2]);
  }
#ifdef _WIN32
  gUiThread = GetCurrentThreadId();
  { // sharp plugin windows on scaled screens (Windows 10 1703+; older: system DPI aware)
    using SetCtx = BOOL(WINAPI*)(HANDLE);
    auto fdpi = (SetCtx)(void*)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext");
    if (!fdpi || !fdpi((HANDLE)-4 /* PER_MONITOR_AWARE_V2 */)) SetProcessDPIAware();
  }
  OleInitialize(nullptr);
  MSG wm; PeekMessageW(&wm, nullptr, WM_USER, WM_USER, PM_NOREMOVE); // create the thread's message queue
#else
  signal(SIGPIPE, SIG_IGN);
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
    tAudio = true;
#ifdef _WIN32
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
#endif
    std::function<void()> f;
    while (!gQuit) if (gAudio.pop(f, 200)) f();
  });

#if defined(__APPLE__)
  bfMacRun(macTick); // Cocoa wants windows on the main thread: run its loop, do our UI work from a timer
#else
  std::function<void()> f;
  while (!gQuit) {
#ifdef _WIN32
    MsgWaitForMultipleObjects(0, nullptr, FALSE, 15, QS_ALLINPUT);
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
    while (gUi.pop(f, 0)) f();
    idle2();
#else
    if (gUi.pop(f, 200)) f();
#endif
  }
#endif
  audio.join();
  shutdownAll();
  reader.detach();
  fflush(gOut);
  std::_Exit(0);
}
