# BeatForge

A small, free music maker that runs in your browser or as a desktop app.
Step sequencer, playlist with your own audio, time stretch, mixer, save/open and WAV export.
No account, no internet, no tracking.

## Get it

- **Windows:** download `BeatForge-x.y.z-win-x64.zip` from [Releases](../../releases), unzip it, run `BeatForge.exe`.
  Windows SmartScreen may warn because the app is not code-signed: click *More info* → *Run anyway*.
- **Linux:** download `BeatForge-x.y.z-linux-x64.tar.gz`, then
  `tar xzf BeatForge-*-linux-x64.tar.gz && ./BeatForge-linux-x64/beatforge`
- **Browser:** download or clone this repo and open `index.html` (Chrome, Edge or Firefox).

## How to use it

1. **Step sequencer:** press **Space** (or ▶ Play) to hear the demo beat. Click squares to switch steps on/off.
   Each row has a sound picker, a pitch box (semitones) and a ♪ button to hear the sound. Arrow keys move around the grid.
2. **Pattern / Song:** *Pattern* loops the 16 steps. *Song* plays the playlist from left to right for the number of **Bars** you set.
   In the playlist's **Pattern** row, choose which bars also play the step pattern.
3. **Playlist:** drag WAV/MP3 files onto a lane (or use *Import audio…*). Drag clips to move them (snaps to 16th steps),
   click a clip to preview it. Selected clip: arrow keys move it, **Delete** removes it.
4. **Time stretch:** select a clip and move the **Speed** slider (50–200%). The tempo changes, the pitch stays the same.
5. **Mixer:** volume, pan (double-click to centre), **M** mute and **S** solo for every track and lane, plus master volume.
6. **Save / Open:** *Save* writes one `.beatforge.json` file with everything in it, including your imported audio.
7. **Export WAV:** renders the song (Song mode, all bars) to a 16-bit 44.1 kHz WAV.

| Shortcut | Action |
|---|---|
| Space | Play / Stop |
| Ctrl+S / Ctrl+O | Save / Open |
| Ctrl+E | Export WAV |
| Ctrl+Z | Undo (50 steps) |
| Ctrl+Shift+Z or Ctrl+Y | Redo |

## How it works

- `js/state.js` holds the whole project as plain JSON (the single source of truth) plus undo/redo snapshots. The UI is redrawn from it.
- `js/scheduler.js` is a look-ahead scheduler: every 25 ms it books all notes in the next 120 ms at exact `AudioContext` times,
  so timing never drifts. The same code books the whole song into an `OfflineAudioContext` for WAV export.
- `js/synth.js` makes every built-in sound from oscillators and noise. Every sound has a short fade in/out, so nothing clicks.
- `js/stretch.js` is a WSOLA time stretcher (overlap-add with a similarity search), so speed changes keep the pitch.
- `desktop/` is a tiny Electron shell for the desktop builds. It blocks all network requests.

Build the desktop apps with `./build.sh` (needs the official Electron 33.2.1 zips; see the script).

## Known limitations

- Desktop builds are not code-signed, so Windows/macOS may warn on first start. No macOS build yet.
- Time stretch is a simple WSOLA: fine for loops and vocals, it can smear sharp drum hits at extreme speeds.
- Changing BPM does not stretch audio clips; clips keep their own speed setting.
- Bass and lead play one fixed note per track (set it with the pitch box); there is no piano roll.
- Saved projects with lots of audio get big, since the audio is stored inside the file (base64).
- Very long clips take a moment to stretch the first time you play them at a new speed.

## Licence

MIT, see [LICENSE](LICENSE). All code, sounds and design are original.
