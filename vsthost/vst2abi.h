// vst2abi.h: the binary interface of VST 2.x plugins, written for BeatForge from public documentation of the format.
// This is not Steinberg's SDK (which is no longer licensed to new hosts); it only declares the struct layout and the
// numbers a host needs to talk to an existing VST2 plugin (.dll / .so / .vst). Names are BeatForge's own.
#pragma once
#include <cstdint>

#if defined(_WIN32)
#define BF2_CALL __cdecl
#else
#define BF2_CALL
#endif

namespace bf2 {
struct Effect;
typedef intptr_t(BF2_CALL* HostCallback)(Effect*, int32_t opcode, int32_t index, intptr_t value, void* ptr, float opt);
typedef intptr_t(BF2_CALL* DispatcherProc)(Effect*, int32_t opcode, int32_t index, intptr_t value, void* ptr, float opt);
typedef void(BF2_CALL* ProcessProc)(Effect*, float** inputs, float** outputs, int32_t frames);
typedef void(BF2_CALL* ProcessDoubleProc)(Effect*, double** inputs, double** outputs, int32_t frames);
typedef void(BF2_CALL* SetParamProc)(Effect*, int32_t index, float value);
typedef float(BF2_CALL* GetParamProc)(Effect*, int32_t index);
typedef Effect*(BF2_CALL* EntryProc)(HostCallback);

const int32_t kMagic = ('V' << 24) | ('s' << 16) | ('t' << 8) | 'P';

// the plugin object every VST2 plugin returns from its entry point
struct Effect {
  int32_t magic;
  DispatcherProc dispatcher;
  ProcessProc processOld;      // deprecated accumulating process
  SetParamProc setParameter;
  GetParamProc getParameter;
  int32_t numPrograms, numParams, numInputs, numOutputs;
  int32_t flags;
  intptr_t hostData1, hostData2; // reserved for the host (BeatForge keeps its instance pointer in hostData1)
  int32_t initialDelay;        // latency in samples
  int32_t oldRealQualities, oldOffQualities;
  float oldIoRatio;
  void* object;
  void* user;
  int32_t uniqueID, version;
  ProcessProc processReplacing;
  ProcessDoubleProc processDoubleReplacing;
  char future[56];
};

enum Flags : int32_t {
  HasEditor = 1 << 0,
  CanReplacing = 1 << 4,
  ProgramChunks = 1 << 5,
  IsSynth = 1 << 8,
  NoSoundInStop = 1 << 9,
  CanDoubleReplacing = 1 << 12,
};

// host -> plugin (dispatcher opcodes)
enum Op : int32_t {
  Open = 0, Close = 1, SetProgram = 2, GetProgram = 3, GetProgramName = 5, GetParamLabel = 6, GetParamDisplay = 7,
  GetParamName = 8, SetSampleRate = 10, SetBlockSize = 11, MainsChanged = 12, EditGetRect = 13, EditOpen = 14,
  EditClose = 15, EditIdle = 19, GetChunk = 23, SetChunk = 24, ProcessEvents = 25, CanBeAutomated = 26,
  GetPlugCategory = 35, GetEffectName = 45, GetVendorString = 47, GetProductString = 48, CanDo = 51,
  GetTailSize = 52, GetVstVersion = 58, ShellGetNextPlugin = 70, StartProcess = 71, StopProcess = 72,
};

// plugin -> host (callback opcodes)
enum HostOp : int32_t {
  HAutomate = 0, HVersion = 1, HCurrentId = 2, HIdle = 3, HGetTime = 7, HProcessEvents = 8, HIOChanged = 13,
  HSizeWindow = 15, HGetSampleRate = 16, HGetBlockSize = 17, HGetInputLatency = 18, HGetOutputLatency = 19,
  HGetCurrentProcessLevel = 23, HGetAutomationState = 24, HGetVendorString = 32, HGetProductString = 33,
  HGetVendorVersion = 34, HCanDo = 37, HGetLanguage = 38, HGetDirectory = 41, HUpdateDisplay = 42,
  HBeginEdit = 43, HEndEdit = 44,
};

enum Category : int32_t { CatUnknown = 0, CatEffect = 1, CatSynth = 2, CatShell = 10, CatGenerator = 11 };

struct Event { int32_t type, byteSize, deltaFrames, flags; char data[16]; };
struct MidiEvent {
  int32_t type;        // 1 = MIDI
  int32_t byteSize;    // sizeof(MidiEvent) = 32
  int32_t deltaFrames; // sample offset in this block
  int32_t flags;       // 1 = realtime (played live)
  int32_t noteLength, noteOffset;
  char midiData[4];
  char detune, noteOffVelocity, reserved1, reserved2;
};
static_assert(sizeof(MidiEvent) == 32, "MidiEvent must be 32 bytes");

struct Events {            // variable length: numEvents pointers follow
  int32_t numEvents;
  intptr_t reserved;
  Event* events[2];
};

struct TimeInfo {
  double samplePos, sampleRate, nanoSeconds, ppqPos, tempo, barStartPos, cycleStartPos, cycleEndPos;
  int32_t timeSigNumerator, timeSigDenominator, smpteOffset, smpteFrameRate, samplesToNextClock, flags;
};
enum TimeFlags : int32_t {
  TransportChanged = 1, TransportPlaying = 1 << 1, NanosValid = 1 << 8, PpqValid = 1 << 9, TempoValid = 1 << 10,
  BarsValid = 1 << 11, TimeSigValid = 1 << 13,
};

struct Rect { int16_t top, left, bottom, right; };
}  // namespace bf2
