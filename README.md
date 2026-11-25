# BeatForge

A free, open-source music maker that runs in your browser or as a desktop app.
Channel rack, piano roll, playlist with your own audio, time stretch, mixer with effects, and WAV/stem export.
No account, no internet, no tracking.

## Get it

- **Windows:** download `BeatForge-x.y.z-Setup.exe` from [Releases](../../releases) and run it. It installs for your account
  (no admin rights), with Start menu and desktop shortcuts and an uninstaller in Windows Settings → Apps.
  Windows SmartScreen may warn because the app is not code-signed: click *More info* → *Run anyway*.
  (A portable `win-x64.zip` is there too.)
- **Linux (Ubuntu, Mint, Debian…):** download `BeatForge-x.y.z-linux-amd64.deb` and double-click it to install.
  Other distros: `tar xzf BeatForge-*-linux-x64.tar.gz && ./BeatForge-linux-x64/beatforge`
- **Mac:** download `BeatForge-x.y.z-mac-arm64.zip` (Apple Silicon: M1/M2/M3/M4) or `-mac-x64.zip` (older Intel Macs),
  unzip it and drag `BeatForge.app` into Applications. The app is not signed by Apple (that needs a paid developer account),
  so macOS will say it "is damaged" or "cannot be checked". Open Terminal once and run:
  ```
  xattr -cr /Applications/BeatForge.app
  codesign --force --deep -s - /Applications/BeatForge.app
  ```
  Then open it normally. (The first command removes the "downloaded from the internet" flag, the second gives it a local signature.)
- **Browser:** download or clone this repo and open `index.html` (Chrome, Edge or Firefox).

## New in 2.6

- Piano roll: slide notes (S), portamento (O), per-note pan and fine pitch with an event lane (F), note properties
  (double-click a note), note colours (Alt+C), flam, ghost notes and more classic shortcuts.
- Audio editor: double-click an audio clip (or "Edit audio…") to trim, cut, silence, reverse, fade, normalize.
- Templates: File → New from template (Trap, House, Lo-fi, Rock starters) and File → Save as template.
- Top bar: master volume and master pitch, CPU meter, step edit (Ctrl+E), recording precount (Ctrl+P).
- Mixer: 32 inserts, move inserts with Alt+←/→. Channel rack: groups (Alt+G), zip (Alt+Z).

## How to use it

BeatForge works like a classic pattern-based DAW: you make **patterns** in the **channel rack** and **piano roll**,
arrange them in the **playlist**, and mix in the **mixer**. Everything opens as a floating window
(drag the title bar to move, the corner to resize, double-click the title to maximise).

- **Browser (F8):** docked on the left. Drum sounds, synth presets, effects and your project's patterns, channels and audio.
  Click an item to use it, drag instruments onto the channel rack, effects onto a mixer strip, audio onto a playlist track.
  Right-click an instrument or audio item to hear it. The hint bar in the top bar explains whatever is under the mouse.
- **Channel rack (F6):** one row per instrument. LED = on/off, then pan, volume, mixer insert number and the name
  (click it to open the instrument). Click steps to switch them on, drag to paint, right-click to erase.
  *+ Add channel* adds Drum Kit, Forge Synth (with presets) or a Sampler. Drop audio files on the rack to make Sampler channels.
- **Piano roll (F7):** melodies and chords for the selected channel. Click to add a note, drag to move, drag the right edge
  to make it longer, right-click to delete, Ctrl+drag to box-select, Shift+drag to duplicate. Velocity lane at the bottom.
  *Typing keyboard* lets you play notes on your computer keys.
- **Playlist (F5):** pick a pattern (or audio) on the left, click on a track to place it. Drag clips to move them,
  drag the edge to resize, right-click to delete, Ctrl+B to duplicate. Drop WAV/MP3 files onto a track.
- **Audio clips:** select one to get the clip panel: *Stretch* (tempo changes, pitch stays), *Resample* (pitch follows speed),
  *Fit to tempo* (follows the project BPM; *Guess BPM* works out the loop's tempo), speed, pitch and gain.
  **Shift + drag a clip's edge** to stretch it to any length.
- **Mixer (F9):** Master + 32 inserts with meters, faders, pan, mute and solo. Click a strip to see its effect slots
  (up to 10) and its routing: to Master and/or sends to other inserts (feedback loops are blocked).
  Effects: Forge EQ, Forge Filter, Echo Delay, Room Reverb, Compressor, Drive, Chorus, Limiter, Utility, Sidechain Ducker,
  Phaser, Flanger, Stereo Width, Volume Shaper.
- **Instruments:** Drum Kit (11 sounds, 4 kits), Forge Synth, FM Keys, String Pluck, Organ, Sampler.
- **Automation:** right-click any knob or fader → *Create automation clip*.
- **Recording (R):** notes from a MIDI or typing keyboard, and audio from a microphone (Settings, F10). Metronome: Ctrl+M.
- **Loop region:** drag on the playlist ruler; Song mode loops inside it.
- **Pattern / Song (L):** Pattern mode loops the current pattern; Song mode plays the playlist.
- **Saving:** projects are `.bfp` files (BeatForge Project: one file with all your audio inside). Ctrl+S saves,
  Ctrl+O opens. Older `.beatforge.json` and BeatForge 1 projects still open.
- **Export:** MP3 (Ctrl+Shift+R, small enough for Discord), OGG Opus (smallest), WAV (Ctrl+R, full quality), the current pattern,
  stems (one WAV per mixer insert) and MIDI (Ctrl+Shift+M).
- **Bring songs from other DAWs:** export a MIDI file there (in FL Studio: File → Export → MIDI file) and open the `.mid` here.
  Notes, drums (General MIDI drum map), tempo and the arrangement come in; repeated 4-bar sections share one pattern.
  FL Studio `.flp` projects open directly too (File → Open or drag them in), see Known limitations for what comes over.

### Keyboard shortcuts (press F1 in the app for the full list)

| Shortcut | Action |
|---|---|
| Space · Ctrl+Space | Start/stop · start/pause |
| L · R · Ctrl+M · Ctrl+H | Pattern/Song · record · metronome · stop all sound |
| F5 · F6 · F7 · F8 · Alt+F8 · F9 | Playlist · Channel rack · Piano roll · Plugin picker · Browser · Mixer |
| F10 · F11 · F12 · Tab | Settings · Project info · Close all windows · Next window |
| Numpad + / − · F4 | Next / previous pattern · next empty pattern |
| Ctrl+N · Ctrl+O · Ctrl+S · Ctrl+Shift+S | New · Open · Save · Save as |
| Ctrl+R · Ctrl+Shift+M | Export WAV · Export MIDI |
| Ctrl+Z · Ctrl+Alt+Z · Ctrl+Shift+Z | Undo/redo toggle · undo step · redo step |
| F2 · Ctrl+T · Ctrl+F | Rename · typing keyboard · search the browser |
| Ctrl+L | Channel rack: route channel to a free insert · Piano roll: quick legato |
| P · B · D · T · C · E | Draw · Paint · Delete · Mute · Slice · Select tools |
| Alt+A · Alt+S · Alt+R · Alt+U · Alt+G · Alt+Q · Alt+Y | Arpeggiate · strum · randomize · chop · glue · quantize · flip |
| Ctrl+B · Ctrl+Q | Duplicate selection · quick quantize |
| Ctrl+Insert · Ctrl+Delete | Insert / delete time at the loop region |

## Plugins

**Community plugins:** View → Plugin store… installs instruments and effects made by other people. Every plugin is checked
by GRBN Studios before it appears, the list is signed, and a plugin runs only on the audio thread (no access to your files,
projects or the internet). Make your own: [beatforge-plugins](https://github.com/Getrektbynoob15/beatforge-plugins), and
submit it at [grbnstudios.com/beatforge-plugins](https://grbnstudios.com/beatforge-plugins).

The built-in instruments and effects use a separate internal format (`js/plugins/`).

**VST plugins (desktop app):** VST3 and VST2 (64-bit) instruments and effects run in the BeatForge Plugin Host
(`vsthost/`), a separate process so a crashing plugin can't take BeatForge down. VST3 support is built on the Steinberg
VST3 SDK (MIT). VST2 support uses BeatForge's own description of the VST2 binary interface (`vsthost/vst2abi.h`), not
Steinberg's VST2 SDK. VST2 files are first opened in a throw-away child process during the scan. Plugin windows open on
Windows and Mac. AU and CLAP are not supported. The web version can't run VST plugins.

## How it works

- `js/state.js`: the whole project as plain JSON (single source of truth) with 100-step undo/redo. The UI is drawn from it.
- `js/scheduler.js`: look-ahead scheduler. Every 25 ms it books all notes in the next 120 ms at exact `AudioContext` times,
  so timing never drifts. The same code books the whole song into an `OfflineAudioContext` for export.
- `js/audio.js`: the mixer graph (channel → insert → effect chain → fader → master).
- `js/stretch.js`: WSOLA time stretching (overlap-add with a similarity search), so speed changes keep the pitch.
- `desktop/`: a tiny Electron shell for the desktop builds. It blocks all network requests.

Build the desktop apps with `./build.sh` (needs the official Electron 33.2.1 zips; see the script).

## Known limitations

- No AU/CLAP plugins, no 32-bit VST2 plugins (see above).
- FL Studio `.flp` import (File → Open) brings in tempo, channels, notes, patterns, playlist, track and mixer names and
  matching effects. FL's own plugins and VSTs are replaced by the closest BeatForge sound; settings inside `.fst` files are
  FL's own format, so effects start at default settings. Written from the community's public description of the format.
- Desktop builds are not code-signed: Windows may warn on first start, and macOS needs the two Terminal commands above.
  The Windows and Mac builds are made on Linux and have not been tested on real Windows or Mac machines yet.
- Slicing works on pattern clips only; audio clips can be trimmed from the right edge.
- Time stretch is a simple WSOLA: great for loops and vocals, it can smear sharp drum hits at extreme speeds.
- Projects with lots of audio get big, since the audio is stored inside the file.

## Licence

MIT, see [LICENSE](LICENSE). All code, sounds and design are original, except `js/vendor/lame-min.js`:
the [lamejs](https://github.com/zhuker/lamejs) MP3 encoder (a port of [LAME](https://lame.sourceforge.net)), included unmodified
under the LGPL-3.0, see [js/vendor/LAMEJS-LICENSE.txt](js/vendor/LAMEJS-LICENSE.txt).
