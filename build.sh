#!/usr/bin/env bash
# Build the desktop apps: dist/BeatForge-<ver>-win-x64.zip and dist/BeatForge-<ver>-linux-x64.tar.gz
# Needs the official Electron zips (checked against SHASUMS256.txt) in $ELECTRON_DIR.
set -euo pipefail
cd "$(dirname "$0")"
VER=$(node -p "require('./desktop/package.json').version")
EV=33.2.1
ELECTRON_DIR=${ELECTRON_DIR:-$HOME/.cache/beatforge-electron}
rm -rf dist && mkdir -p dist/stage
app() { # copy the web app + desktop shell into $1
  mkdir -p "$1"
  cp -r index.html style.css app.js js LICENSE "$1/"
  cp desktop/main.js desktop/package.json desktop/icon.png "$1/"
}
for plat in win32-x64 linux-x64; do
  zip="$ELECTRON_DIR/electron-v$EV-$plat.zip"
  (cd "$ELECTRON_DIR" && grep " \*electron-v$EV-$plat.zip$" SHASUMS256.txt | sed 's/ \*/  /' | sha256sum -c --quiet)
  out=dist/stage/BeatForge-$plat
  mkdir -p "$out" && unzip -q "$zip" -d "$out"
  rm -f "$out/resources/default_app.asar"
  app "$out/resources/app"
  if [ "$plat" = win32-x64 ]; then
    mv "$out/electron.exe" "$out/BeatForge.exe"
    cp README.md "$out/README.txt"
    (cd dist/stage && zip -qr9 "../BeatForge-$VER-win-x64.zip" "BeatForge-$plat")
  else
    mv "$out/electron" "$out/beatforge"
    cp desktop/icon.png "$out/beatforge.png"
    cp README.md "$out/README.md"
    tar -C dist/stage -czf "dist/BeatForge-$VER-linux-x64.tar.gz" "BeatForge-$plat"
  fi
done
(cd dist && sha256sum BeatForge-* > SHA256SUMS.txt && ls -la)
