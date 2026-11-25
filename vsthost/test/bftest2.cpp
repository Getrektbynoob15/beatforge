// A tiny VST2 test plugin for BeatForge's own tests (not shipped). -DSYNTH: a sine synth with a "Level" knob and its
// own state chunk. Without: a gain effect with a "Gain" knob (state = knob values).
#include "../vst2abi.h"
#include <cmath>
#include <cstring>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#if defined(_WIN32)
#define EXPORT extern "C" __declspec(dllexport)
#else
#define EXPORT extern "C" __attribute__((visibility("default")))
#endif
using namespace bf2;
struct Plug {
  Effect fx{};
  HostCallback host = nullptr;
  float param = 0.5f, rate = 44100;
  double phase[128] = {0}; bool on[128] = {false}; float vel[128] = {0};
  char chunk[64];
};
static Plug* P(Effect* e) { return (Plug*)e->object; }
static intptr_t BF2_CALL disp(Effect* e, int32_t op, int32_t idx, intptr_t val, void* ptr, float opt) {
  Plug* p = P(e);
  switch (op) {
    case Open: printf("noise on stdout from a plugin\n"); fflush(stdout); return 0; // the host must not break on this
    case Close: delete p; return 1;
    case SetSampleRate: p->rate = opt; return 1;
    case GetParamName: strcpy((char*)ptr, idx == 0 ?
#ifdef SYNTH
      "Level"
#else
      "Gain"
#endif
      : "?"); return 1;
    case GetParamLabel: strcpy((char*)ptr, "%"); return 1;
    case GetEffectName: strcpy((char*)ptr,
#ifdef SYNTH
      "BF Test Synth 2"
#else
      "BF Test Gain 2"
#endif
      ); return 1;
    case GetVendorString: strcpy((char*)ptr, "BeatForge tests"); return 1;
    case GetPlugCategory:
#ifdef SYNTH
      return CatSynth;
#else
      return CatEffect;
#endif
    case GetVstVersion: return 2400;
    case ProcessEvents: {
      auto* ev = (Events*)ptr;
      for (int i = 0; i < ev->numEvents; i++) {
        auto* m = (MidiEvent*)ev->events[i];
        if (m->type != 1) continue;
        int st = m->midiData[0] & 0xF0, k = m->midiData[1] & 127, v = m->midiData[2] & 127;
        if (st == 0x90 && v) { p->on[k] = true; p->vel[k] = v / 127.f; p->phase[k] = 0; }
        else if (st == 0x80 || st == 0x90) p->on[k] = false;
      }
      return 1;
    }
#ifdef SYNTH
    case GetChunk: { snprintf(p->chunk, sizeof p->chunk, "BFTEST level=%.6f", p->param); *(void**)ptr = p->chunk; return (intptr_t)strlen(p->chunk); }
    case SetChunk: { float v; char tmp[64] = {0}; memcpy(tmp, ptr, val < 63 ? val : 63); if (sscanf(tmp, "BFTEST level=%f", &v) == 1) p->param = v; return 1; }
#endif
#ifndef SYNTH
    case EditGetRect: { static Rect r{0, 0, 200, 300}; *(Rect**)ptr = &r; return 1; } // an empty window: tests the host's windows
    case EditOpen: return 1;
    case EditClose: return 1;
#endif
    case CanDo: return strcmp((const char*)ptr, "receiveVstMidiEvent") == 0 ? 1 : 0;
    default: return 0;
  }
}
static void BF2_CALL proc(Effect* e, float** in, float** out, int32_t n) {
  Plug* p = P(e);
#ifdef SYNTH
  // host time must be readable: put tempo into nothing, just call it
  if (p->host) p->host(e, HGetTime, 0, 0, nullptr, 0);
  for (int i = 0; i < n; i++) {
    double s = 0;
    for (int k = 0; k < 128; k++) if (p->on[k]) { double f = 440.0 * pow(2.0, (k - 69) / 12.0); s += sin(p->phase[k]) * p->vel[k]; p->phase[k] += 6.283185307179586 * f / p->rate; }
    out[0][i] = out[1][i] = (float)(s * p->param);
  }
#else
  for (int i = 0; i < n; i++) { out[0][i] = in[0][i] * p->param * 2; out[1][i] = in[1][i] * p->param * 2; }
#endif
}
static void BF2_CALL setp(Effect* e, int32_t i, float v) { if (i == 0) P(e)->param = v; }
static float BF2_CALL getp(Effect* e, int32_t i) { return i == 0 ? P(e)->param : 0; }
EXPORT Effect* VSTPluginMain(HostCallback host) {
#ifdef CRASH
  *(volatile int*)nullptr = 1; // crashes while loading: the scan must survive this
#endif
  if (!host(nullptr, HVersion, 0, 0, nullptr, 0)) return nullptr;
  Plug* p = new Plug();
  p->host = host;
  Effect& f = p->fx;
  f.magic = kMagic; f.dispatcher = disp; f.setParameter = setp; f.getParameter = getp; f.processReplacing = proc;
  f.numPrograms = 1; f.numParams = 1;
#ifdef SYNTH
  f.numInputs = 0; f.numOutputs = 2; f.flags = CanReplacing | IsSynth | ProgramChunks; f.uniqueID = ('B' << 24) | ('F' << 16) | ('S' << 8) | '2';
#else
  f.numInputs = 2; f.numOutputs = 2; f.flags = CanReplacing | HasEditor; f.uniqueID = ('B' << 24) | ('F' << 16) | ('G' << 8) | '2';
#endif
  f.object = p; f.version = 1;
  return &f;
}
