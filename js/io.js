/* io.js: import audio (to the playlist or as Sampler channels), save/open projects (.json, audio inside as base64),
 * export WAV (song, pattern, or one file per mixer insert). */
(function () {
  'use strict';
  const BF = window.BF;
  const IO = (BF.io = {});
  const MAX_AUDIO = 50 * 1024 * 1024;
  const MAX_PROJECT = 600 * 1024 * 1024;
  const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;

  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  IO._b64 = { bytesToBase64, base64ToBytes };

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
  IO.download = download;
  const safeName = (s) => (s || 'project').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'project';

  /** Open the system file picker for audio. */
  IO.pickFiles = function (cb, multiple = true) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aif,.aiff';
    inp.multiple = multiple;
    inp.addEventListener('change', () => { const f = [...inp.files]; if (f.length) cb(f); });
    inp.click();
  };

  /** Decode one file and store it as a project sample (not an undo step on its own). Returns the sample id or null. */
  IO.addSample = async function (f) {
    try {
      if (f.size > MAX_AUDIO) throw new Error(`"${f.name}" is ${fmtMB(f.size)}. The limit is 50 MB per file.`);
      if (f.size === 0) throw new Error(`"${f.name}" is empty.`);
      BF.ui.busy(`Decoding ${f.name}…`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      let buf;
      try { buf = await BF.audio.decode(bytes.buffer); } catch (e) { throw new Error(`"${f.name}": ${e.message}`); }
      const id = BF.uid('s');
      BF.audio.buffers.set(id, buf);
      BF.project.samples[id] = { name: f.name.replace(/\.[^.]+$/, '').slice(0, 120), mime: f.type || 'audio/wav', base64: bytesToBase64(bytes) };
      return id;
    } catch (e) {
      BF.ui.toast(e.message || String(e), true);
      return null;
    } finally {
      BF.ui.busy(null);
    }
  };

  /** Files dropped on the playlist: one audio clip each, placed one after another. */
  IO.importToPlaylist = async function (files, track = 0, beat = 0) {
    let at = beat, added = 0;
    for (const f of files) {
      if (/\.(json|bfp|midi?|flp|fst)$/i.test(f.name)) { IO.open(f); return; }
      const id = await IO.addSample(f);
      if (!id) continue;
      const bpm = BF.project.bpm;
      const clip = { id: BF.uid('c'), kind: 'audio', track, start: at, len: 0, sampleId: id, mode: 'stretch', speed: 1, pitch: 0, srcBpm: bpm, gain: 1 };
      BF.commit((p) => p.clips.push(clip));
      BF.playlist.pick = { kind: 'audio', sampleId: id };
      at += Math.ceil(BF.audio.clipBeats(clip) / (BF.playlist.snap || 0.25) - 1e-6) * (BF.playlist.snap || 0.25);
      added++;
    }
    if (added) {
      BF.ui.toast(`Added ${added} audio clip${added > 1 ? 's' : ''}. Press L for Song mode to hear the playlist. Select a clip to change speed/pitch.`);
      if (BF.transport.mode !== 'song') BF.transport.setMode('song');
    }
  };

  /** Files dropped on the channel rack: one Sampler channel each. */
  IO.importToRack = async function (files) {
    for (const f of files) {
      const id = await IO.addSample(f);
      if (!id) continue;
      BF.commit((p) => {
        const ch = BF.newChannel('sampler', BF.project.samples[id].name, { preset: { sample: id } });
        ch.insert = BF.rack.freeInsert(p);
        if (ch.insert) p.mixer[ch.insert].name = ch.name;
        p.channels.push(ch);
        p.selectedChannel = ch.id;
      });
    }
  };

  function usedSamples(p) {
    const used = new Set(p.clips.filter((c) => c.kind === 'audio').map((c) => c.sampleId));
    p.channels.forEach((c) => { if (c.plugin === 'sampler' && c.params.sample) used.add(c.params.sample); });
    const out = {};
    for (const id of used) if (p.samples[id]) out[id] = p.samples[id];
    return out;
  }

  /** The project as saved in a .bfp file (only the audio it uses). */
  IO.serialize = function (p = BF.project) { return { ...p, samples: usedSamples(p), savedAt: new Date().toISOString() }; };

  IO.save = function () {
    const p = BF.project;
    const data = IO.serialize(p);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    // .bfp = BeatForge Project (JSON inside, all audio included). Older .beatforge.json files still open.
    download(blob, `${safeName(p.name)}.bfp`);
    BF.dirty = false;
    BF.ui.toast(`Saved ${safeName(p.name)}.bfp (${fmtMB(blob.size)})`);
  };

  IO.saveAs = async function () {
    const n = await BF.ui.prompt('Project name', BF.project.name);
    if (!n) return;
    BF.commit((p) => { p.name = n; });
    IO.save();
  };

  IO.open = async function (file) {
    if (/\.midi?$/i.test(file.name)) return BF.midiImport(file);
    if (/\.flp$/i.test(file.name)) return BF.flp.importFile(file);
    if (/\.fst$/i.test(file.name)) return BF.flp.importState(file);
    try {
      if (file.size > MAX_PROJECT) throw new Error(`This project is ${fmtMB(file.size)}, too large to open.`);
      BF.ui.busy('Opening project…');
      let raw;
      try { raw = JSON.parse(await file.text()); } catch { throw new Error('This file is not valid JSON, so it is not a BeatForge project.'); }
      await IO.load(raw, file.name.replace(/(\.beatforge)?\.(json|bfp)$/i, ''));
    } catch (e) {
      BF.ui.toast(e.message || String(e), true);
    } finally {
      BF.ui.busy(null);
    }
  };

  /** Load a parsed project (from a file or a template). `fallbackName` names an untitled project. */
  IO.load = async function (raw, fallbackName, { keepName = true } = {}) {
    try {
      const p = BF.normalizeProject(raw);
      const decoded = new Map();
      for (const [id, s] of Object.entries(p.samples)) {
        let bytes;
        try { bytes = base64ToBytes(s.base64); } catch { throw new Error(`The audio "${s.name}" in this project is damaged.`); }
        BF.ui.busy(`Decoding ${s.name}…`);
        decoded.set(id, await BF.audio.decode(bytes.buffer).catch(() => { throw new Error(`The audio "${s.name}" in this project could not be decoded.`); }));
      }
      if (!keepName || !p.name || p.name === 'Untitled') p.name = fallbackName || 'Untitled';
      BF.transport.stop();
      BF.audio.buffers.clear();
      BF.audio.stretched.clear();
      BF.audio.reversedCache.clear();
      decoded.forEach((b, id) => BF.audio.buffers.set(id, b));
      BF.playlist.sel.clear();
      BF.piano.sel.clear();
      BF.transport.startBeat = 0;
      BF.editor.target = null;
      BF.replaceProject(p);
      BF.ui.toast(`Opened "${p.name}"${raw.version === 1 || !raw.version ? ' (converted from BeatForge 1)' : ''}`);
    } finally {
      BF.ui.busy(null);
    }
  };

  IO.exportWav = async function (mode = 'song') {
    try {
      BF.transport.stop();
      BF.ui.busy(mode === 'song' ? 'Rendering song…' : 'Rendering pattern…');
      const buf = await BF.renderSong(mode);
      const blob = BF.encodeWav(buf);
      const name = `${safeName(BF.project.name)}${mode === 'pattern' ? `-${safeName(BF.pattern().name)}` : ''}.wav`;
      download(blob, name);
      BF.ui.toast(`Exported ${name} (${buf.duration.toFixed(1)} s, ${fmtMB(blob.size)})`);
    } catch (e) {
      BF.ui.toast(`Export failed: ${e.message || e}`, true);
    } finally {
      BF.ui.busy(null);
    }
  };

  /** One WAV per used mixer insert (stems): solo each insert in turn and render. */
  IO.exportStems = async function () {
    const p = BF.project;
    const used = [...new Set([...p.channels.map((c) => c.insert), ...p.clips.filter((c) => c.kind === 'audio').map((c) => p.tracks[c.track].insert || 0)])].filter((i) => i > 0).sort((a, b) => a - b);
    if (!used.length) { BF.ui.toast('Route channels to mixer inserts (1–32) first; each insert becomes one stem.', true); return; }
    BF.transport.stop();
    const saved = JSON.stringify(p.mixer.map((m) => [m.mute, m.solo]));
    try {
      for (const i of used) {
        BF.ui.busy(`Rendering stem ${p.mixer[i].name}…`);
        p.mixer.forEach((m, j) => { m.solo = j === i; m.mute = false; });
        const buf = await BF.renderSong('song');
        download(BF.encodeWav(buf), `${safeName(p.name)}-${String(i).padStart(2, '0')}-${safeName(p.mixer[i].name)}.wav`);
        await new Promise((r) => setTimeout(r, 400));
      }
      BF.ui.toast(`Exported ${used.length} stems.`);
    } catch (e) {
      BF.ui.toast(`Export failed: ${e.message || e}`, true);
    } finally {
      JSON.parse(saved).forEach(([mu, so], j) => { p.mixer[j].mute = mu; p.mixer[j].solo = so; });
      BF.emit('mix');
      BF.ui.busy(null);
    }
  };
})();
