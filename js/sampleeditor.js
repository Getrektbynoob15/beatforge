/* sampleeditor.js: the audio editor for the project's samples: trim, cut, silence, reverse, fades, normalize, gain,
 * pitch correction (vocals), pitch shift, time stretch, detect note, trim silence, DC fix; zoom with the mouse wheel.
 * Drag on the waveform to select (nothing selected = the whole sample). Edits change the sample itself, so every clip
 * and Sampler channel that uses it changes too. The editor has its own undo (Ctrl+Z while it is focused, 20 steps). */
(function () {
  'use strict';
  const BF = window.BF;
  const SE = (BF.sampleEditor = { id: null });
  let root, cv, info, sel = null, history = [], dragging = null, playBtn = null, view = null; // view = [from, to] seconds (zoom)

  const buf = () => BF.audio.buffers.get(SE.id);
  const fmt = (s) => `${s.toFixed(3)} s`;

  SE.build = function () {
    root = document.createElement('div');
    root.className = 'se';
    const bar = document.createElement('div');
    bar.className = 'se-bar';
    const btn = (label, title, fn) => { const b = document.createElement('button'); b.className = 'btn small'; b.textContent = label; b.title = title; b.addEventListener('click', fn); bar.append(b); return b; };
    playBtn = btn('▶ Play', 'Play the selection (or everything). Press again (or Space) to stop.', () => play());
    btn('Trim', 'Keep only the selection', () => edit('trim'));
    btn('Cut', 'Delete the selection', () => edit('cut'));
    btn('Silence', 'Make the selection silent', () => edit('silence'));
    btn('Reverse', 'Play the selection backwards', () => edit('reverse'));
    btn('Fade in', 'Fade the selection in', () => edit('fadein'));
    btn('Fade out', 'Fade the selection out', () => edit('fadeout'));
    btn('Normalize', 'Make the loudest peak 0 dB', () => edit('normalize'));
    btn('+3 dB', 'Louder', () => edit('gain', 3));
    btn('−3 dB', 'Quieter', () => edit('gain', -3));
    btn('🎤 Tune…', 'Pitch correction: pull sung notes to the nearest note of a key (like auto-tune)', () => tuneDialog());
    btn('Pitch…', 'Shift the pitch up or down, same length', async () => { const v = await BF.ui.prompt('Shift pitch by how many semitones? (-24 to 24, decimals allowed)', '2'); const n = parseFloat(v); if (Number.isFinite(n) && n && Math.abs(n) <= 24) process(`Shifting pitch ${n > 0 ? '+' : ''}${n} st…`, (b, a, z) => BF.pitch.shift(b, n, a, z)); });
    btn('Stretch…', 'Make it longer or shorter, same pitch', async () => { const v = await BF.ui.prompt('New length in % (50 = twice as fast, 200 = twice as slow)', '100'); const n = parseFloat(v); if (Number.isFinite(n) && n >= 25 && n <= 400 && n !== 100) process('Stretching…', (b, a, z) => stretchPart(b, a, z, n / 100), true); });
    btn('Detect note', 'Which note is this sound? (for a Sampler: sets its root key)', () => detectNote());
    btn('Trim silence', 'Remove silence at the start and end', () => edit('trimsilence'));
    btn('DC fix', 'Remove a DC offset (the wave sitting above or below the middle line)', () => edit('dc'));
    btn('Undo', 'Undo the last edit (Ctrl+Z)', () => undo());
    btn('Select all', 'Select everything (Ctrl+A)', () => { sel = null; draw(); });
    btn('Zoom to selection', 'Zoom in on the selection (mouse wheel zooms too, Shift+wheel scrolls)', () => { if (sel) { view = [sel[0], sel[1]]; draw(); } });
    btn('Show all', 'Zoom all the way out', () => { view = null; draw(); });
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
    // zoom around the mouse with the wheel, Shift+wheel (or a sideways wheel) scrolls
    cv.addEventListener('wheel', (e) => {
      const b = buf();
      if (!b) return;
      e.preventDefault();
      const [v0, v1] = view || [0, b.duration], span = v1 - v0;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = ((e.shiftKey ? e.deltaY : e.deltaX) / 400) * span;
        const n0 = Math.max(0, Math.min(b.duration - span, v0 + d));
        view = [n0, n0 + span];
      } else {
        const t = timeAt(e), k = e.deltaY > 0 ? 1.25 : 0.8;
        const ns = Math.max(Math.min(b.duration, 64 / b.sampleRate * 10), Math.min(b.duration, span * k));
        let n0 = t - (t - v0) * (ns / span);
        n0 = Math.max(0, Math.min(b.duration - ns, n0));
        view = ns >= b.duration - 1e-9 ? null : [n0, n0 + ns];
      }
      draw();
    }, { passive: false });
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
    if (SE.id !== sampleId) { history = []; sel = null; view = null; }
    SE.id = sampleId;
    BF.win.toggle('sampleed', true);
    const w = BF.win.all.get('sampleed');
    if (w) w.title.textContent = `Audio editor · ${BF.project.samples[sampleId]?.name || ''}`;
    draw();
    cv.focus();
  };

  function timeAt(e) {
    const b = buf(), r = cv.getBoundingClientRect();
    const [v0, v1] = view || [0, b.duration];
    return Math.max(0, Math.min(b.duration, v0 + ((e.clientX - r.left) / r.width) * (v1 - v0)));
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
    if (view && (view[1] > b.duration || view[0] < 0)) view = null; // the audio got shorter
    const [v0, v1] = view || [0, b.duration];
    const f0 = v0 * b.sampleRate, fspan = (v1 - v0) * b.sampleRate;
    for (let c = 0; c < chs; c++) {
      const d = b.getChannelData(c), per = fspan / w, mid = lane * c + lane / 2;
      g.fillStyle = '#2fd4ff';
      for (let x = 0; x < w; x++) {
        let mn = 0, mx = 0;
        const s = Math.floor(f0 + x * per), e = Math.min(d.length, Math.max(s + 1, Math.floor(f0 + (x + 1) * per)));
        for (let i = s; i < e; i += Math.max(1, Math.floor((e - s) / 64))) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        g.fillRect(x, mid - mx * (lane / 2 - 2), 1, Math.max(1, (mx - mn) * (lane / 2 - 2)));
      }
      g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, mid, w, 1);
    }
    if (sel) {
      const x0 = ((sel[0] - v0) / (v1 - v0)) * w, x1 = ((sel[1] - v0) / (v1 - v0)) * w;
      g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(x0, 0, x1 - x0, h);
      g.fillStyle = '#fff'; g.fillRect(x0, 0, 1, h); g.fillRect(x1, 0, 1, h);
    }
    const s = BF.project.samples[SE.id];
    info.textContent = `${s?.name || 'Audio'} · ${fmt(b.duration)} · ${b.sampleRate} Hz · ${b.numberOfChannels === 1 ? 'mono' : 'stereo'}${sel ? ` · selected ${fmt(sel[0])} – ${fmt(sel[1])} (${fmt(sel[1] - sel[0])})` : ' · nothing selected = whole sample'}${view ? ` · zoom ${fmt(v0)} – ${fmt(v1)}` : ''}`;
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
    if (op === 'trimsilence') {
      let s0 = b.length, s1 = 0;
      for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.0025) { s0 = Math.min(s0, i); break; } for (let i = d.length - 1; i >= 0; i--) if (Math.abs(d[i]) > 0.0025) { s1 = Math.max(s1, i + 1); break; } }
      if (s1 - s0 < 64) { BF.ui.toast('It is all silence.'); return; }
      if (s0 === 0 && s1 === b.length) { BF.ui.toast('No silence at the start or end.'); return; }
      out = makeBuffer(b, s1 - s0);
      for (let c = 0; c < b.numberOfChannels; c++) out.getChannelData(c).set(b.getChannelData(c).subarray(s0, s1));
      sel = null;
    } else if (op === 'trim' || op === 'cut') {
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
        else if (op === 'dc') { let m = 0; for (let i = a; i < z; i++) m += d[i]; m /= Math.max(1, z - a); for (let i = a; i < z; i++) o[i] = d[i] - m; }
      }
    }
    history.push(b);
    if (history.length > 20) history.shift();
    if (op === 'trim') sel = null;
    else if (op === 'cut') sel = null;
    apply(out);
  }

  /** Run a slow edit (pitch, stretch) with a busy message; fn(buffer, from, to) returns the new buffer. */
  function process(msg, fn, resets) {
    const b = buf();
    if (!b) return;
    const [a, z] = range(b);
    BF.ui.busy(msg);
    setTimeout(() => {
      try {
        const out = fn(b, a, z);
        history.push(b); if (history.length > 20) history.shift();
        if (resets) sel = null;
        apply(out);
      } catch (e) { BF.ui.toast(e.message || String(e), true); } finally { BF.ui.busy(null); }
    }, 30);
  }
  /** Time-stretch the range [a, z) to `factor` times its length (pitch kept). */
  function stretchPart(b, a, z, factor) {
    const part = new AudioBuffer({ length: z - a, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
    for (let c = 0; c < b.numberOfChannels; c++) part.getChannelData(c).set(b.getChannelData(c).subarray(a, z));
    const st = BF.timeStretch(part, 1 / factor);
    const out = makeBuffer(b, b.length - (z - a) + st.length);
    for (let c = 0; c < b.numberOfChannels; c++) { const o = out.getChannelData(c), d = b.getChannelData(c); o.set(d.subarray(0, a)); o.set(st.getChannelData(c), a); o.set(d.subarray(z), a + st.length); }
    return out;
  }
  function detectNote() {
    const b = buf();
    if (!b) return;
    const [a, z] = range(b);
    const hz = BF.pitch.mainPitch(b, a, Math.min(z, a + b.sampleRate * 8));
    if (!hz) { BF.ui.toast('No clear note found (noise, drums or chords).'); return; }
    const users = BF.project.channels.filter((c) => c.plugin === 'sampler' && c.params.sample === SE.id);
    const midi = Math.round(BF.pitch.midiOf(hz));
    if (users.length) {
      BF.commit((q) => q.channels.forEach((c) => { if (c.plugin === 'sampler' && c.params.sample === SE.id) c.params.root = Math.max(0, Math.min(127, midi)); }));
      BF.ui.toast(`This sounds like ${BF.pitch.noteName(hz)} (${hz.toFixed(1)} Hz). Root key of ${users.map((c) => c.name).join(', ')} set to ${BF.noteName(midi)}.`);
    } else BF.ui.toast(`This sounds like ${BF.pitch.noteName(hz)} (${hz.toFixed(1)} Hz).`);
  }
  function tuneDialog() {
    if (!buf()) return;
    const d = document.createElement('dialog'); d.className = 'dlg';
    const h = document.createElement('h2'); h.textContent = 'Pitch correction';
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = `Pulls sung notes to the nearest note of the key. Works on ${sel ? 'the selection' : 'the whole audio'} (a single voice, not chords or drums).`;
    const row = (label, el) => { const l = document.createElement('label'); l.className = 'field'; l.textContent = `${label} `; l.append(el); return l; };
    const key = document.createElement('select'); BF.pitch.NAMES.forEach((n, i) => key.add(new Option(n, i)));
    const sc = document.createElement('select'); Object.keys(BF.pitch.SCALES).forEach((n) => sc.add(new Option(n[0].toUpperCase() + n.slice(1), n)));
    const st = document.createElement('input'); st.type = 'range'; st.min = 0; st.max = 100; st.value = 100;
    const sp = document.createElement('input'); sp.type = 'range'; sp.min = 0; sp.max = 100; sp.value = 15;
    const box = document.createElement('div'); box.className = 'se-tune';
    box.append(row('Key', key), row('Scale', sc), row('Strength', st), row('Speed (left = robotic, right = natural)', sp));
    const act = document.createElement('div'); act.className = 'dlg-actions';
    const b1 = document.createElement('button'); b1.className = 'btn'; b1.textContent = 'Cancel'; b1.addEventListener('click', () => d.close());
    const b2 = document.createElement('button'); b2.className = 'btn accent'; b2.textContent = 'Correct';
    b2.addEventListener('click', () => {
      d.close();
      const opts = { root: +key.value, scale: sc.value, strength: st.value / 100, speed: sp.value / 100 };
      process('Correcting pitch…', (bb, a, z) => {
        const r = BF.pitch.correct(bb, a, z, opts);
        setTimeout(() => BF.ui.toast(r.voiced < 0.05 ? 'Hardly any clear notes found: is this a single voice?' : `Done: notes moved ${r.moved.toFixed(2)} semitones on average. Ctrl+Z undoes it.`), 50);
        return r.buffer;
      });
    });
    act.append(b1, b2);
    d.append(h, p, box, act);
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
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

  /** Stop the editor's playback (also when the song plays, another preview starts or the editor closes). */
  SE.stop = function () {
    if (SE.playing) { try { SE.playing.stop(); } catch { /* ended */ } SE.playing = null; }
    if (playBtn) playBtn.textContent = '▶ Play';
  };
  function play() {
    const b = buf();
    if (!b) return;
    if (SE.playing) { SE.stop(); return; } // Play again = stop
    const ctx = BF.audio.ensure();
    BF.audio.stopPreview?.();
    BF.transport.stop();
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(BF.audio.graph.inserts[0].preview);
    const [a, z] = range(b);
    src.start(ctx.currentTime + 0.01, a / b.sampleRate, (z - a) / b.sampleRate);
    SE.playing = src;
    if (playBtn) playBtn.textContent = '■ Stop';
    src.onended = () => { if (SE.playing === src) { SE.playing = null; if (playBtn) playBtn.textContent = '▶ Play'; } };
  }
  // anything that stops previews (pressing Play in the transport, a browser preview) stops the editor too
  const baseStop = BF.audio.stopPreview;
  BF.audio.stopPreview = function () { SE.stop(); return baseStop.apply(this, arguments); };
})();
