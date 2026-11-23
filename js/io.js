/* io.js: import audio, save/open projects (.json with base64 audio), export WAV. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});
  const IO = (BF.io = {});
  const MAX_AUDIO = 50 * 1024 * 1024;
  const MAX_PROJECT = 600 * 1024 * 1024;

  const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;

  function bytesToBase64(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const safeName = (s) => (s || 'project').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'project';

  /** Import audio files onto a lane, one after another from `beat`. */
  IO.importFiles = async function (files, lane = 0, beat = 0) {
    let at = beat;
    let added = 0;
    for (const f of files) {
      try {
        if (f.size > MAX_AUDIO) throw new Error(`"${f.name}" is ${fmtMB(f.size)}. The limit is 50 MB per file.`);
        if (f.size === 0) throw new Error(`"${f.name}" is empty.`);
        BF.ui.busy(`Decoding ${f.name}…`);
        const bytes = new Uint8Array(await f.arrayBuffer());
        let buf;
        try { buf = await BF.audio.decode(bytes.buffer); } catch (e) { throw new Error(`"${f.name}": ${e.message}`); }
        const id = BF.uid('s');
        BF.audio.buffers.set(id, buf);
        const sample = { name: f.name.replace(/\.[^.]+$/, '').slice(0, 120), mime: f.type || 'audio/wav', base64: bytesToBase64(bytes) };
        const clip = { id: BF.uid('c'), lane, sampleId: id, startBeat: at, speed: 1 };
        BF.commit((p) => { p.samples[id] = sample; p.clips.push(clip); });
        at += Math.ceil(((buf.duration * BF.project.bpm) / 60) / 0.25) * 0.25;
        added++;
      } catch (e) {
        BF.ui.toast(e.message || String(e), true);
      } finally {
        BF.ui.busy(null);
      }
    }
    if (added) BF.ui.toast(`Imported ${added} clip${added > 1 ? 's' : ''} on lane ${lane + 1}. Switch to Song mode to hear it in the playlist.`);
  };

  /** Only keep samples that a clip still uses (undo can leave orphans). */
  function usedSamples(p) {
    const used = new Set(p.clips.map((c) => c.sampleId));
    const out = {};
    for (const id of used) if (p.samples[id]) out[id] = p.samples[id];
    return out;
  }

  IO.save = function () {
    const p = BF.project;
    const data = { ...p, samples: usedSamples(p), savedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    download(blob, `${safeName(p.name)}.beatforge.json`);
    BF.ui.toast(`Saved ${safeName(p.name)}.beatforge.json (${fmtMB(blob.size)})`);
  };

  IO.open = async function (file) {
    try {
      if (file.size > MAX_PROJECT) throw new Error(`This project is ${fmtMB(file.size)}, too large to open.`);
      BF.ui.busy('Opening project…');
      let raw;
      try { raw = JSON.parse(await file.text()); } catch { throw new Error('This file is not valid JSON, so it is not a BeatForge project.'); }
      const p = BF.normalizeProject(raw);
      // decode every embedded sample before switching projects, so a bad file never half-loads
      const decoded = new Map();
      for (const [id, s] of Object.entries(p.samples)) {
        let bytes;
        try { bytes = base64ToBytes(s.base64); } catch { throw new Error(`The audio "${s.name}" in this project is damaged.`); }
        BF.ui.busy(`Decoding ${s.name}…`);
        decoded.set(id, await BF.audio.decode(bytes.buffer).catch(() => { throw new Error(`The audio "${s.name}" in this project could not be decoded.`); }));
      }
      if (!p.name || p.name === 'Untitled') p.name = file.name.replace(/(\.beatforge)?\.json$/i, '');
      BF.transport.stop();
      BF.audio.buffers.clear();
      BF.audio.stretched.clear();
      decoded.forEach((b, id) => BF.audio.buffers.set(id, b));
      BF.playlist.selected = null;
      BF.transport.startBeat = 0;
      BF.replaceProject(p);
      BF.ui.toast(`Opened "${p.name}"`);
    } catch (e) {
      BF.ui.toast(e.message || String(e), true);
    } finally {
      BF.ui.busy(null);
    }
  };

  IO.exportWav = async function () {
    try {
      BF.ui.busy('Rendering song…');
      const buf = await BF.renderSong();
      const blob = BF.encodeWav(buf);
      download(blob, `${safeName(BF.project.name)}.wav`);
      BF.ui.toast(`Exported ${safeName(BF.project.name)}.wav (${buf.duration.toFixed(1)} s, ${fmtMB(blob.size)})`);
    } catch (e) {
      BF.ui.toast(`Export failed: ${e.message || e}`, true);
    } finally {
      BF.ui.busy(null);
    }
  };

  IO._b64 = { bytesToBase64, base64ToBytes }; // for tests
})();
