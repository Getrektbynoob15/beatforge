/* sampleeditor.js: a small audio editor for the project's samples (trim, cut, silence, reverse, fades, normalize, gain).
 * Drag on the waveform to select (nothing selected = the whole sample). Edits change the sample itself, so every clip
 * and Sampler channel that uses it changes too. The editor has its own undo (Ctrl+Z while it is focused, 20 steps). */
(function () {
  'use strict';
  const BF = window.BF;
  const SE = (BF.sampleEditor = { id: null });
  let root, cv, info, sel = null, history = [], dragging = null;

  const buf = () => BF.audio.buffers.get(SE.id);
  const fmt = (s) => `${s.toFixed(3)} s`;

  SE.build = function () {
    root = document.createElement('div');
    root.className = 'se';
    const bar = document.createElement('div');
    bar.className = 'se-bar';
    const btn = (label, title, fn) => { const b = document.createElement('button'); b.className = 'btn small'; b.textContent = label; b.title = title; b.addEventListener('click', fn); bar.append(b); return b; };
    btn('▶ Play', 'Play the selection (or everything)', () => play());
    btn('Trim', 'Keep only the selection', () => edit('trim'));
    btn('Cut', 'Delete the selection', () => edit('cut'));
    btn('Silence', 'Make the selection silent', () => edit('silence'));
    btn('Reverse', 'Play the selection backwards', () => edit('reverse'));
    btn('Fade in', 'Fade the selection in', () => edit('fadein'));
    btn('Fade out', 'Fade the selection out', () => edit('fadeout'));
    btn('Normalize', 'Make the loudest peak 0 dB', () => edit('normalize'));
    btn('+3 dB', 'Louder', () => edit('gain', 3));
    btn('−3 dB', 'Quieter', () => edit('gain', -3));
    btn('Undo', 'Undo the last edit (Ctrl+Z)', () => undo());
    btn('Select all', 'Select everything (Ctrl+A)', () => { sel = null; draw(); });
    cv = document.createElement('canvas');
    cv.className = 'se-wave';
    cv.tabIndex = 0;
    cv.setAttribute('aria-label', 'Waveform. Drag to select. Delete cuts, Ctrl+Z undoes, Space plays.');
    info = document.createElement('p');
    info.className = 'hint se-info';
    root.append(bar, cv, info);
    cv.addEventListener('pointerdown', (e) => {
      if (!buf()) return;
      cv.setPointerCapture(e.pointerId);
      const t = timeAt(e);
      dragging = { t0: t };
      sel = null;
      draw();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const t = timeAt(e);
      sel = Math.abs(t - dragging.t0) < 0.002 ? null : [Math.min(t, dragging.t0), Math.max(t, dragging.t0)];
      draw();
    });
    cv.addEventListener('pointerup', () => { dragging = null; });
    cv.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); undo(); }
      else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); sel = null; draw(); }
      else if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); edit('cut'); }
      else if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); play(); }
    });
    new ResizeObserver(() => draw()).observe(cv);
    return root;
  };

  /** Open the editor on a project sample. */
  SE.open = function (sampleId) {
    if (!BF.audio.buffers.has(sampleId)) { BF.ui.toast('That audio is not loaded.', true); return; }
    if (SE.id !== sampleId) { history = []; sel = null; }
    SE.id = sampleId;
    BF.win.toggle('sampleed', true);
    const w = BF.win.all.get('sampleed');
    if (w) w.title.textContent = `Audio editor · ${BF.project.samples[sampleId]?.name || ''}`;
    draw();
    cv.focus();
  };

  function timeAt(e) {
    const b = buf(), r = cv.getBoundingClientRect();
    return Math.max(0, Math.min(b.duration, ((e.clientX - r.left) / r.width) * b.duration));
  }

  function draw() {
    if (!cv || !BF.win.isOpen('sampleed')) return;
    const b = buf();
    const w = Math.max(1, cv.clientWidth), h = Math.max(1, cv.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0f1115'; g.fillRect(0, 0, w, h);
    if (!b) { info.textContent = 'Open audio from a playlist clip (Edit audio…) or a Sampler channel.'; return; }
    const chs = Math.min(2, b.numberOfChannels), lane = h / chs;
    for (let c = 0; c < chs; c++) {
      const d = b.getChannelData(c), per = d.length / w, mid = lane * c + lane / 2;
      g.fillStyle = '#2fd4ff';
      for (let x = 0; x < w; x++) {
        let mn = 0, mx = 0;
        const s = Math.floor(x * per), e = Math.min(d.length, Math.floor((x + 1) * per));
        for (let i = s; i < e; i += Math.max(1, Math.floor((e - s) / 64))) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        g.fillRect(x, mid - mx * (lane / 2 - 2), 1, Math.max(1, (mx - mn) * (lane / 2 - 2)));
      }
      g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, mid, w, 1);
    }
    if (sel) {
      const x0 = (sel[0] / b.duration) * w, x1 = (sel[1] / b.duration) * w;
      g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(x0, 0, x1 - x0, h);
      g.fillStyle = '#fff'; g.fillRect(x0, 0, 1, h); g.fillRect(x1, 0, 1, h);
    }
    const s = BF.project.samples[SE.id];
    info.textContent = `${s?.name || 'Audio'} · ${fmt(b.duration)} · ${b.sampleRate} Hz · ${b.numberOfChannels === 1 ? 'mono' : 'stereo'}${sel ? ` · selected ${fmt(sel[0])} – ${fmt(sel[1])} (${fmt(sel[1] - sel[0])})` : ' · nothing selected = whole sample'}`;
  }
  SE.draw = draw;

  function range(b) {
    const a = sel ? Math.floor(sel[0] * b.sampleRate) : 0, z = sel ? Math.ceil(sel[1] * b.sampleRate) : b.length;
    return [Math.max(0, a), Math.min(b.length, Math.max(a + 1, z))];
  }

  function makeBuffer(b, length) {
    return new AudioBuffer({ length: Math.max(1, length), numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
  }

  function edit(op, arg) {
    const b = buf();
    if (!b) return;
    const [a, z] = range(b);
    let out;
    if (op === 'trim' || op === 'cut') {
      if (!sel) { BF.ui.toast('Select part of the waveform first (drag on it).'); return; }
      const len = op === 'trim' ? z - a : b.length - (z - a);
      if (len < 64) { BF.ui.toast('That would leave (almost) nothing.'); return; }
      out = makeBuffer(b, len);
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c), o = out.getChannelData(c);
        if (op === 'trim') o.set(d.subarray(a, z));
        else { o.set(d.subarray(0, a)); o.set(d.subarray(z), a); }
      }
    } else {
      out = makeBuffer(b, b.length);
      let peak = 0;
      if (op === 'normalize') for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = a; i < z; i++) peak = Math.max(peak, Math.abs(d[i])); }
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c), o = out.getChannelData(c);
        o.set(d);
        const n = z - a;
        if (op === 'silence') o.fill(0, a, z);
        else if (op === 'reverse') { const part = d.slice(a, z).reverse(); o.set(part, a); }
        else if (op === 'fadein') for (let i = 0; i < n; i++) o[a + i] = d[a + i] * (i / n);
        else if (op === 'fadeout') for (let i = 0; i < n; i++) o[a + i] = d[a + i] * (1 - i / n);
        else if (op === 'normalize') { const k = peak > 1e-6 ? 1 / peak : 1; for (let i = a; i < z; i++) o[i] = d[i] * k; }
        else if (op === 'gain') { const k = Math.pow(10, arg / 20); for (let i = a; i < z; i++) o[i] = Math.max(-1, Math.min(1, d[i] * k)); }
      }
    }
    history.push(b);
    if (history.length > 20) history.shift();
    if (op === 'trim') sel = null;
    else if (op === 'cut') sel = null;
    apply(out);
  }

  function undo() {
    const prev = history.pop();
    if (!prev) { BF.ui.toast('Nothing to undo in the audio editor.'); return; }
    apply(prev);
  }

  /** Put a new buffer in place of the sample: the audio engine, the saved project data and every waveform. */
  function apply(b) {
    const id = SE.id;
    BF.audio.buffers.set(id, b);
    for (const k of [...BF.audio.stretched.keys()]) if (k.startsWith(`${id}@`) || k.startsWith(`${id}:`)) BF.audio.stretched.delete(k);
    BF.audio.reversedCache.delete(id);
    BF.encodeWav(b).arrayBuffer().then((ab) => {
      const s = BF.project.samples[id];
      if (s) { s.base64 = BF.io._b64.bytesToBase64(new Uint8Array(ab)); s.mime = 'audio/wav'; }
      BF.dirty = true;
      BF.emit('clips');
    });
    // audio clips that were sized to the old length: let them follow the new length
    BF.project.clips.forEach((c) => { if (c.kind === 'audio' && c.sampleId === id) c.len = 0; });
    if (BF.playlist.forgetPeaks) BF.playlist.forgetPeaks();
    draw();
  }

  function play() {
    const b = buf();
    if (!b) return;
    const ctx = BF.audio.ensure();
    BF.audio.stopPreview?.();
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(BF.audio.graph.inserts[0].preview);
    const [a, z] = range(b);
    src.start(ctx.currentTime + 0.01, a / b.sampleRate, (z - a) / b.sampleRate);
    SE.playing = src;
  }
})();
