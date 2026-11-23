# BeatForge

A free, open-source music maker that runs in your browser or as a desktop app.
Channel rack, piano roll, playlist with your own audio, time stretch, mixer with effects, and WAV/stem export.
No account, no internet, no tracking.

## Get it

- **Windows:** download `BeatForge-x.y.z-win-x64.zip` from [Releases](../../releases), unzip it, run `BeatForge.exe`.
  Windows SmartScreen may warn because the app is not code-signed: click *More info* → *Run anyway*.
- **Linux:** download `BeatForge-x.y.z-linux-x64.tar.gz`, then
  `tar xzf BeatForge-*-linux-x64.tar.gz && ./BeatForge-linux-x64/beatforge`
- **Browser:** download or clone this repo and open `index.html` (Chrome, Edge or Firefox).

## How to use it

BeatForge works like a classic pattern-based DAW: you make **patterns** in the **channel rack** and **piano roll**,
arrange them in the **playlist**, and mix in the **mixer**. Everything opens as a floating window
(drag the title bar to move, the corner to resize, double-click the title to maximise).

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
- **Mixer (F9):** Master + 16 inserts with meters, faders, pan, mute and solo. Click a strip to see its effect slots
  (up to 10): Forge EQ, Forge Filter, Echo Delay, Room Reverb, Compressor, Drive, Chorus, Limiter, Utility.
- **Pattern / Song (L):** Pattern mode loops the current pattern; Song mode plays the playlist.
- **File menu:** save/open projects (one `.beatforge.json` with all audio inside), export the song, the current pattern,
  or stems (one WAV per mixer insert). BeatForge 1 projects open and are converted automatically.

| Shortcut | Action |
|---|---|
| Space | Play / pause |
| L | Pattern / Song mode |
| F5 · F6 · F7 · F9 | Playlist · Channel rack · Piano roll · Mixer |
| Numpad + / − | Next / previous pattern |
| Ctrl+N · Ctrl+O · Ctrl+S · Ctrl+Shift+S | New · Open · Save · Save as |
| Ctrl+R | Export WAV |
| Ctrl+Z (or Ctrl+Alt+Z) · Ctrl+Shift+Z (or Ctrl+Y) | Undo (100 steps) · Redo |
| P · B · D · E · C | Draw · Paint · Delete · Select · Slice tools |
| Right-click | Delete a note, clip or step |
| Ctrl+A · Ctrl+D · Ctrl+C · Ctrl+X · Ctrl+V | Select all · none · copy · cut · paste (piano roll) |
| ↑ ↓ / Ctrl+↑ ↓ | Transpose a semitone / an octave |
| Ctrl+Q | Quantize notes |
| Ctrl+wheel | Zoom |
| Double-click a knob | Reset it |
| F1 | Shortcut list |

## Plugins

BeatForge has its own small plugin format (`js/plugins/`). An instrument is a `play(ctx, out, params, time, key, vel, dur)`
function; an effect returns Web Audio nodes from `create(ctx)`. Every plugin declares its parameters, so it gets an editor,
presets, saving and validation for free. VST/AU plugins cannot run inside a web app, so they are not supported.

## How it works

- `js/state.js`: the whole project as plain JSON (single source of truth) with 100-step undo/redo. The UI is drawn from it.
- `js/scheduler.js`: look-ahead scheduler. Every 25 ms it books all notes in the next 120 ms at exact `AudioContext` times,
  so timing never drifts. The same code books the whole song into an `OfflineAudioContext` for export.
- `js/audio.js`: the mixer graph (channel → insert → effect chain → fader → master).
- `js/stretch.js`: WSOLA time stretching (overlap-add with a similarity search), so speed changes keep the pitch.
- `desktop/`: a tiny Electron shell for the desktop builds. It blocks all network requests.

Build the desktop apps with `./build.sh` (needs the official Electron 33.2.1 zips; see the script).

## Known limitations

- No VST/AU plugins (see above), no audio recording, no automation clips and no MIDI keyboard input yet.
- Desktop builds are not code-signed, so Windows may warn on first start. No macOS build yet.
- Slicing works on pattern clips only; audio clips can be trimmed from the right edge.
- Time stretch is a simple WSOLA: great for loops and vocals, it can smear sharp drum hits at extreme speeds.
- Projects with lots of audio get big, since the audio is stored inside the file.

## Licence

MIT, see [LICENSE](LICENSE). All code, sounds and design are original.
