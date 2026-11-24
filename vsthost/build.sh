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
if [[ $what == all || $what == win ]]; then
  x86_64-w64-mingw32-g++-posix "${FLAGS[@]}" -DUNICODE -D_UNICODE -DWIN32_LEAN_AND_MEAN bfvsthost.cpp "${SRC[@]}" "$SDK/public.sdk/source/vst/hosting/module_win32.cpp" "$SDK/public.sdk/source/common/threadchecker_win32.cpp" \
    -o "$OUT/bfvsthost.exe" -static -static-libgcc -static-libstdc++ -lole32 -luuid -lshell32 -luser32 -lgdi32 -mwindows 2>&1 | grep -v "^$" || true
  [[ -f $OUT/bfvsthost.exe ]] && x86_64-w64-mingw32-strip "$OUT/bfvsthost.exe" && echo "built $OUT/bfvsthost.exe"
fi
