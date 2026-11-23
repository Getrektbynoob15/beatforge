#!/usr/bin/env bash
# Build the desktop apps: dist/BeatForge-<ver>-win-x64.zip, -linux-x64.tar.gz, -mac-x64.zip and -mac-arm64.zip
# Needs the official Electron zips (checked against SHASUMS256.txt) in $ELECTRON_DIR.
set -euo pipefail
cd "$(dirname "$0")"
VER=$(node -p "require('./desktop/package.json').version")
EV=33.2.1
ELECTRON_DIR=${ELECTRON_DIR:-$HOME/.cache/beatforge-electron}
rm -rf dist && mkdir -p dist/stage
printf "window.BF_VERSION = '%s';\n" "$VER" > js/version.js
app() { # copy the web app + desktop shell into $1
  mkdir -p "$1"
  cp -r index.html style.css app.js js LICENSE "$1/"
  cp desktop/main.js desktop/preload.js desktop/package.json desktop/icon.png "$1/"
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
    # Setup.exe (NSIS, used from ~/.cache/beatforge-nsis: the Ubuntu nsis packages unpacked there, no install needed)
    NSIS=${NSIS_DIR:-$HOME/.cache/beatforge-nsis/root}
    if [ -x "$NSIS/usr/bin/makensis" ]; then
      NSISDIR="$NSIS/usr/share/nsis" "$NSIS/usr/bin/makensis" -V2 -DVERSION="$VER" -DSRCDIR="$PWD/$out" \
        -DOUTFILE="$PWD/dist/BeatForge-$VER-Setup.exe" -DICON="$PWD/desktop/icon.ico" desktop/installer.nsi
    else echo "NOTE: no NSIS found, skipping Setup.exe"; fi
  else
    mv "$out/electron" "$out/beatforge"
    cp desktop/icon.png "$out/beatforge.png"
    cp README.md "$out/README.md"
    tar -C dist/stage -czf "dist/BeatForge-$VER-linux-x64.tar.gz" "BeatForge-$plat"
    # Debian/Ubuntu/Mint package: double-click to install, shows up in the app menu
    deb=dist/stage/deb
    mkdir -p "$deb/DEBIAN" "$deb/opt" "$deb/usr/bin" "$deb/usr/share/applications" "$deb/usr/share/icons/hicolor/512x512/apps"
    cp -r "$out" "$deb/opt/beatforge"
    ln -s /opt/beatforge/beatforge "$deb/usr/bin/beatforge"
    cp desktop/icon.png "$deb/usr/share/icons/hicolor/512x512/apps/beatforge.png"
    printf '[Desktop Entry]\nName=BeatForge\nComment=Make beats: channel rack, piano roll, playlist and mixer\nExec=/opt/beatforge/beatforge %%U\nIcon=beatforge\nType=Application\nCategories=AudioVideo;Audio;Music;\nStartupWMClass=BeatForge\nTerminal=false\n' > "$deb/usr/share/applications/beatforge.desktop"
    cat > "$deb/DEBIAN/control" <<CTRL
Package: beatforge
Version: $VER
Architecture: amd64
Maintainer: GRBN Studios <noreply@grbnstudios.com>
Homepage: https://grbnstudios.com/beatforge
Section: sound
Priority: optional
Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libasound2 | libasound2t64, libxss1, libxtst6, libgbm1, xdg-utils
Description: Free music maker (channel rack, piano roll, playlist, mixer)
 BeatForge is a free, open-source music maker by GRBN Studios. It updates itself.
CTRL
    printf '#!/bin/sh\nset -e\nchmod 4755 /opt/beatforge/chrome-sandbox || true\nupdate-desktop-database -q /usr/share/applications 2>/dev/null || true\n' > "$deb/DEBIAN/postinst"
    chmod 755 "$deb/DEBIAN/postinst"
    fakeroot dpkg-deb --build --root-owner-group -Zxz "$deb" "dist/BeatForge-$VER-linux-amd64.deb" >/dev/null
  fi
done
# macOS (Intel and Apple Silicon). NOT code-signed (needs a paid Apple developer account): the user clears the
# download quarantine and ad-hoc signs it once (see README / website), then it opens normally.
for arch in x64 arm64; do
  plat=darwin-$arch
  zip="$ELECTRON_DIR/electron-v$EV-$plat.zip"
  (cd "$ELECTRON_DIR" && grep " \*electron-v$EV-$plat.zip$" SHASUMS256.txt | sed 's/ \*/  /' | sha256sum -c --quiet)
  out=dist/stage/BeatForge-$plat
  mkdir -p "$out" && unzip -q "$zip" -d "$out"
  mv "$out/Electron.app" "$out/BeatForge.app"
  res="$out/BeatForge.app/Contents/Resources"
  rm -f "$res/default_app.asar"
  app "$res/app"
  cp desktop/icon.icns "$res/electron.icns"
  python3 - "$out/BeatForge.app/Contents/Info.plist" "$VER" <<'PY'
import plistlib, sys
p, ver = sys.argv[1], sys.argv[2]
d = plistlib.load(open(p, 'rb'))
d.update({'CFBundleName': 'BeatForge', 'CFBundleDisplayName': 'BeatForge', 'CFBundleIdentifier': 'com.grbnstudios.beatforge',
          'CFBundleShortVersionString': ver, 'CFBundleVersion': ver, 'NSMicrophoneUsageDescription': 'BeatForge records audio from your microphone or line input when you record audio.'})
d.pop('NSCameraUsageDescription', None)
plistlib.dump(d, open(p, 'wb'))
PY
  cp README.md "$out/README.md"
  (cd dist/stage && zip -qry9 "../BeatForge-$VER-mac-$arch.zip" "BeatForge-$plat")
done
node tools/make-update.js
(cd dist && sha256sum BeatForge-* beatforge-app-* > SHA256SUMS.txt && ls -la)
