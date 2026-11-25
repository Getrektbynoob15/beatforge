#!/usr/bin/env bash
# Build the BeatForge Plugin Host for Linux (native) and Windows (mingw-w64). Needs the VST3 SDK (MIT) in $VST3SDK.
set -euo pipefail
cd "$(dirname "$0")"
SDK=${VST3SDK:-$HOME/vendor/vst3sdk}
OUT=${OUT:-build}
mkdir -p "$OUT"
COMMON=(
  pluginterfaces/base/conststringtable.cpp pluginterfaces/base/coreiids.cpp pluginterfaces/base/funknown.cpp pluginterfaces/base/ustring.cpp
  base/source/baseiids.cpp base/source/fbuffer.cpp base/source/fdebug.cpp base/source/fdynlib.cpp base/source/fobject.cpp base/source/fstreamer.cpp
  base/source/fstring.cpp base/source/timer.cpp base/source/updatehandler.cpp base/thread/source/fcondition.cpp base/thread/source/flock.cpp
  public.sdk/source/common/commoniids.cpp public.sdk/source/common/memorystream.cpp public.sdk/source/common/commonstringconvert.cpp
  public.sdk/source/vst/hosting/connectionproxy.cpp public.sdk/source/vst/hosting/eventlist.cpp public.sdk/source/vst/hosting/hostclasses.cpp
  public.sdk/source/vst/hosting/module.cpp public.sdk/source/vst/hosting/parameterchanges.cpp public.sdk/source/vst/hosting/pluginterfacesupport.cpp
  public.sdk/source/vst/hosting/processdata.cpp public.sdk/source/vst/hosting/plugprovider.cpp public.sdk/source/vst/utility/stringconvert.cpp
  public.sdk/source/vst/vstinitiids.cpp
)
SRC=()
for f in "${COMMON[@]}"; do SRC+=("$SDK/$f"); done
FLAGS=(-std=c++17 -O2 -DRELEASE=1 -I"$SDK" -w)
what=${1:-all}
if [[ $what == all || $what == linux ]]; then
  g++ "${FLAGS[@]}" bfvsthost.cpp "${SRC[@]}" "$SDK/public.sdk/source/vst/hosting/module_linux.cpp" "$SDK/public.sdk/source/common/threadchecker_linux.cpp" -o "$OUT/bfvsthost" -ldl -lpthread -lstdc++fs
  strip "$OUT/bfvsthost"; echo "built $OUT/bfvsthost"
fi
if [[ $what == mac ]]; then # on a Mac (or the GitHub Actions macOS runner): universal binary, Apple Silicon + Intel
  clang++ "${FLAGS[@]}" -arch arm64 -arch x86_64 -mmacosx-version-min=10.15 -fobjc-arc bfvsthost.cpp macui.mm "${SRC[@]}" \
    "$SDK/public.sdk/source/vst/hosting/module_mac.mm" "$SDK/public.sdk/source/common/threadchecker_mac.mm" \
    -framework Cocoa -framework CoreFoundation -o "$OUT/bfvsthost"
  strip -x "$OUT/bfvsthost"; codesign -s - -f "$OUT/bfvsthost"; echo "built $OUT/bfvsthost (mac)"
fi
if [[ $what == test ]]; then # the VST2 test plugins (BeatForge's own tests, never shipped)
  mkdir -p "$OUT/test2"
  case "$(uname)" in
    Linux) for v in Synth Gain; do d=; [[ $v == Synth ]] && d=-DSYNTH; g++ -std=c++17 -O2 -shared -fPIC $d test/bftest2.cpp -o "$OUT/test2/BFTest$v.so"; \
             x86_64-w64-mingw32-g++-posix -std=c++17 -O2 -shared $d test/bftest2.cpp -static -o "$OUT/test2/BFTest$v.dll"; done
           g++ -std=c++17 -O2 -shared -fPIC -DCRASH test/bftest2.cpp -o "$OUT/test2/BFTestCrash.so"; echo junk > "$OUT/test2/NotAPlugin.so"
           x86_64-w64-mingw32-g++-posix -std=c++17 -O2 -shared -DCRASH test/bftest2.cpp -static -o "$OUT/test2/BFTestCrash.dll"; echo junk > "$OUT/test2/NotAPlugin.dll" ;;
    Darwin) for v in Synth Gain; do d=; [[ $v == Synth ]] && d=-DSYNTH; b="$OUT/test2/BFTest$v.vst/Contents/MacOS"; mkdir -p "$b"; \
             clang++ -std=c++17 -O2 -arch arm64 -arch x86_64 -bundle $d test/bftest2.cpp -o "$b/BFTest$v"; codesign -s - -f "$OUT/test2/BFTest$v.vst"; done
             b="$OUT/test2/BFTestCrash.vst/Contents/MacOS"; mkdir -p "$b"; clang++ -std=c++17 -O2 -arch arm64 -arch x86_64 -bundle -DCRASH test/bftest2.cpp -o "$b/BFTestCrash"; codesign -s - -f "$OUT/test2/BFTestCrash.vst" ;;
    *) for v in Synth Gain; do d=; [[ $v == Synth ]] && d=-DSYNTH; g++ -std=c++17 -O2 -shared $d test/bftest2.cpp -static -o "$OUT/test2/BFTest$v.dll"; done
       g++ -std=c++17 -O2 -shared -DCRASH test/bftest2.cpp -static -o "$OUT/test2/BFTestCrash.dll"; echo junk > "$OUT/test2/NotAPlugin.dll" ;;
  esac
  echo "built test plugins in $OUT/test2"
fi
if [[ $what == all || $what == win ]]; then
  x86_64-w64-mingw32-g++-posix "${FLAGS[@]}" -DUNICODE -D_UNICODE -DWIN32_LEAN_AND_MEAN bfvsthost.cpp "${SRC[@]}" "$SDK/public.sdk/source/vst/hosting/module_win32.cpp" "$SDK/public.sdk/source/common/threadchecker_win32.cpp" \
    -o "$OUT/bfvsthost.exe" -static -static-libgcc -static-libstdc++ -lole32 -luuid -lshell32 -luser32 -lgdi32 -mwindows 2>&1 | grep -v "^$" || true
  [[ -f $OUT/bfvsthost.exe ]] && x86_64-w64-mingw32-strip "$OUT/bfvsthost.exe" && echo "built $OUT/bfvsthost.exe"
fi
