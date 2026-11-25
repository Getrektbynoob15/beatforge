/* instruments3.js: three bigger instruments (all original designs):
 *   Additive Synth  builds every sound from up to 128 harmonics. Shape, tilt, odd/even, formant, a harmonic filter that
 *                   sweeps over time, a comb, unison, and resynthesis: load a sample and it copies that sound's harmonics
 *                   (at its start and later on, so the timbre moves like the original).
 *   FM Matrix       4 operators (sine/tri/saw/square), 8 routings, own envelope per operator, filter with envelope.
 *   Beat Slicer     cuts a drum loop at its hits (or in equal parts); each slice plays on its own key, from C3 up.
 *                   "Make pattern" in its editor writes the notes that replay the loop, so you can rearrange it. */
(function () {
  'use strict';
  const BF = window.BF;
  const U = BF.plugins.util;
  const WAVES = [['sine', 'Sine'], ['triangle', 'Triangle'], ['sawtooth', 'Saw'], ['square', 'Square']];
  const ctxCache = new WeakMap(); // ctx -> Map(key -> PeriodicWave)
  const cacheOf = (ctx) => { let m = ctxCache.get(ctx); if (!m) { m = new Map(); ctxCache.set(ctx, m); } if (m.size > 600) m.clear(); return m; };

  // ======================================================================= Additive Synth
  const MAXH = 128;
  /** Harmonic amplitudes of a sample at two moments (resynthesis). Cached per sample. */
  const resynthCache = new Map();
  function resynth(id) {
    if (resynthCache.has(id)) return resynthCache.get(id);
    const b = BF.audio.buffers.get(id);
    if (!b) return null;
    const rate = b.sampleRate, n = b.length, x = new Float32Array(n);
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) x[i] += d[i] / b.numberOfChannels; }
    const f0 = BF.pitch ? BF.pitch.mainPitch(b) : 0;
    let res = null;
    if (f0 > 20) {
      let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i]));
      let on = 0; while (on < n && Math.abs(x[on]) < pk * 0.1) on++;
      const win = Math.min(n, Math.max(4096, Math.round((rate / f0) * 12)));
      const at = (sec) => { // Hann window + Goertzel at every harmonic
        const s0 = Math.max(0, Math.min(n - win, on + Math.round(sec * rate)));
        const a = new Float32Array(MAXH);
        for (let h = 1; h <= MAXH; h++) {
          const f = f0 * h;
          if (f > rate * 0.45) break;
          const w = (2 * Math.PI * f) / rate, cw = 2 * Math.cos(w);
          let s1 = 0, s2 = 0;
          for (let i = 0; i < win; i++) { const s = x[s0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1))) + cw * s1 - s2; s2 = s1; s1 = s; }
          a[h - 1] = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - cw * s1 * s2));
        }
        let m = 0; a.forEach((v) => { m = Math.max(m, v); });
        if (m > 0) for (let i = 0; i < MAXH; i++) a[i] /= m;
        return a;
      };
      const late = Math.min(1.2, Math.max(0.05, ((n - on) / rate) * 0.55));
      res = { f0, early: at(0.03), late: at(late) };
    }
    if (resynthCache.size > 40) resynthCache.clear();
    resynthCache.set(id, res);
    return res;
  }

  /** Amplitudes of harmonics 1..N for one moment of a note. stage 0 = attack (filter open), 1 = middle, 2 = sustain. */
  function spectrum(p, f0, stage, rate, src) {
    const N = Math.round(p.partials), a = new Float32Array(N), ph = new Float32Array(N);
    const open = Math.pow(2, p.fenv * 7 * (stage === 0 ? 1 : stage === 1 ? 0.35 : 0)); // harmonic filter sweep
    const cut = Math.min(40000, p.cutoff * open);
    for (let h = 1; h <= N; h++) {
      const f = f0 * h;
      if (f > rate * 0.46) break;
      let v;
      if (src) v = stage === 0 ? src.early[h - 1] : stage === 1 ? 0.5 * (src.early[h - 1] + src.late[h - 1]) : src.late[h - 1];
      else if (p.shape === 'saw') v = 1 / h;
      else if (p.shape === 'square') v = h % 2 ? 1 / h : 0;
      else if (p.shape === 'triangle') { v = h % 2 ? 1 / (h * h) : 0; ph[h - 1] = (h - 1) % 4 ? Math.PI : 0; }
      else if (p.shape === 'soft') v = 1 / (h * h);
      else v = 1 / Math.sqrt(h); // bright
      if (h > 1) v *= h % 2 ? 1 - Math.max(0, -p.oddeven) : 1 - Math.max(0, p.oddeven); // + = odd only (hollow), - = even
      v *= Math.pow(10, (p.tilt / 20) * Math.log2(h));
      if (p.formant > 0) v *= 1 + p.formant * 5 * Math.exp(-Math.pow(Math.log2(f / p.fpos), 2) / 0.18);
      if (cut < 30000) { const r = f / cut; v *= 1 / (1 + Math.pow(r, 6)); if (p.reso > 0) v *= 1 + p.reso * 4 * Math.exp(-Math.pow(Math.log2(r), 2) / 0.04); }
      if (p.comb > 0) v *= 1 - p.comb + p.comb * (0.5 + 0.5 * Math.cos((2 * Math.PI * (h - 1)) / p.spacing));
      a[h - 1] = v;
    }
    return { a, ph };
  }
  const addKey = (p, key, rate) => [rate, key, p.shape, p.sample || '', p.partials, p.tilt, p.oddeven, p.formant, p.fpos, p.cutoff, p.reso, p.fenv, p.comb, p.spacing].join('|');
  function additiveWaves(ctx, p, key, f0) {
    const k = addKey(p, key, ctx.sampleRate), m = cacheOf(ctx);
    if (m.has(k)) return m.get(k);
    const src = p.sample ? resynth(p.sample) : null;
    const stages = [0, 1, 2].map((s) => spectrum(p, f0, s, ctx.sampleRate, src));
    const energy = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const scale = 0.35 / Math.max(1e-6, ...stages.map((s) => energy(s.a))); // one scale for all stages: the sweep keeps its loudness change
    const waves = stages.map(({ a, ph }) => {
      const re = new Float32Array(a.length + 1), im = new Float32Array(a.length + 1);
      for (let i = 0; i < a.length; i++) { re[i + 1] = a[i] * scale * Math.sin(ph[i]); im[i + 1] = a[i] * scale * Math.cos(ph[i]); }
      return ctx.createPeriodicWave(re, im, { disableNormalization: true });
    });
    const moving = p.fenv > 0.001 || !!src;
    const r = { waves, moving };
    m.set(k, r);
    return r;
  }

  BF.plugins.register({
    id: 'additive', name: 'Additive Synth', kind: 'instrument',
    params: [
      { id: 'shape', name: 'Shape', type: 'select', default: 'saw', options: [['saw', 'Saw'], ['square', 'Square'], ['triangle', 'Triangle'], ['soft', 'Soft'], ['bright', 'Bright']] },
      { id: 'sample', name: 'Resynth from', type: 'sample', default: null },
      { id: 'partials', name: 'Harmonics', type: 'knob', min: 2, max: MAXH, default: 64, step: 1 },
      { id: 'tilt', name: 'Tilt', type: 'knob', min: -12, max: 6, default: 0, step: 0.5, unit: ' dB/oct' },
      { id: 'oddeven', name: 'Odd / even', type: 'knob', min: -1, max: 1, default: 0, fmt: (v) => (Math.abs(v) < 0.02 ? 'Both' : v > 0 ? `Odd ${Math.round(v * 100)}%` : `Even ${Math.round(-v * 100)}%`) },
      { id: 'formant', name: 'Formant', type: 'knob', min: 0, max: 1, default: 0, fmt: U.pct },
      { id: 'fpos', name: 'Formant pos', type: 'knob', min: 200, max: 6000, default: 1200, curve: 'log', fmt: U.hz },
      { id: 'cutoff', name: 'Harm. filter', type: 'knob', min: 60, max: 30000, default: 30000, curve: 'log', fmt: (v) => (v >= 29000 ? 'Open' : U.hz(v)) },
      { id: 'reso', name: 'Filter peak', type: 'knob', min: 0, max: 1, default: 0, fmt: U.pct },
      { id: 'fenv', name: 'Filter env', type: 'knob', min: 0, max: 1, default: 0, fmt: U.pct },
      { id: 'fdecay', name: 'Env time', type: 'knob', min: 0.02, max: 6, default: 0.6, curve: 'log', fmt: U.sec },
      { id: 'comb', name: 'Comb', type: 'knob', min: 0, max: 1, default: 0, fmt: U.pct },
      { id: 'spacing', name: 'Comb spacing', type: 'knob', min: 2, max: 16, default: 4, step: 0.5 },
      { id: 'unison', name: 'Unison', type: 'knob', min: 1, max: 5, default: 1, step: 1, fmt: (v) => `${v} voice${v > 1 ? 's' : ''}` },
      { id: 'detune', name: 'Detune', type: 'knob', min: 0, max: 50, default: 12, unit: ' ct' },
      { id: 'attack', name: 'Attack', type: 'knob', min: 0.001, max: 4, default: 0.005, curve: 'log', fmt: U.sec },
      { id: 'decay', name: 'Decay', type: 'knob', min: 0.01, max: 6, default: 0.4, curve: 'log', fmt: U.sec },
      { id: 'sustain', name: 'Sustain', type: 'knob', min: 0, max: 1, default: 0.8, fmt: U.pct },
      { id: 'release', name: 'Release', type: 'knob', min: 0.005, max: 8, default: 0.3, curve: 'log', fmt: U.sec },
      { id: 'level', name: 'Level', type: 'knob', min: 0, max: 1, default: 0.6, fmt: U.pct },
    ],
    presets: {
      'Init saw': {},
      'Hollow pad': { shape: 'square', oddeven: 0.6, tilt: -3, unison: 3, detune: 18, attack: 0.6, decay: 1.5, sustain: 0.85, release: 1.8, comb: 0.25, spacing: 6 },
      'Vocal choir': { shape: 'bright', tilt: -4, formant: 0.8, fpos: 900, unison: 4, detune: 14, attack: 0.35, release: 1.2, level: 0.5 },
      'Pluck sweep': { shape: 'saw', cutoff: 300, fenv: 0.8, fdecay: 0.35, decay: 0.6, sustain: 0.2, release: 0.3, reso: 0.4 },
      'Glass keys': { shape: 'soft', tilt: 3, comb: 0.7, spacing: 3, cutoff: 6000, fenv: 0.5, fdecay: 1.2, decay: 1.8, sustain: 0.1, release: 0.8 },
      'Sub organ': { shape: 'bright', partials: 12, oddeven: 0.4, tilt: -6, attack: 0.01, sustain: 1, release: 0.08 },
      'Supersaw': { shape: 'saw', unison: 5, detune: 28, tilt: -1, release: 0.5, level: 0.45 },
    },
    play(ctx, out, p, t, key, vel, dur) {
      const f0 = U.midiHz(key);
      const { waves, moving } = additiveWaves(ctx, p, key, f0);
      const amp = ctx.createGain();
      const end = U.adsr(amp.gain, t, dur, vel * p.level, p.attack, p.decay, p.sustain, p.release);
      amp.connect(out);
      const T = Math.max(0.01, p.fdecay);
      const stages = moving ? [0, 1, 2] : [2];
      const fades = stages.map((s) => {
        const g = ctx.createGain(), a = g.gain;
        if (!moving) a.value = 1;
        else if (s === 0) { a.setValueAtTime(1, t); a.linearRampToValueAtTime(0, t + T / 2); }
        else if (s === 1) { a.setValueAtTime(0, t); a.linearRampToValueAtTime(1, t + T / 2); a.linearRampToValueAtTime(0, t + T); }
        else { a.setValueAtTime(0, t); a.setValueAtTime(0, t + T / 2); a.linearRampToValueAtTime(1, t + T); }
        g.connect(amp);
        return g;
      });
      const n = Math.round(p.unison);
      for (let v = 0; v < n; v++) {
        const spread = n > 1 ? (v / (n - 1)) * 2 - 1 : 0;
        stages.forEach((s, i) => {
          const o = ctx.createOscillator();
          o.setPeriodicWave(waves[s]);
          o.frequency.value = f0;
          o.detune.value = spread * p.detune;
          const vg = ctx.createGain(); vg.gain.value = 1 / Math.sqrt(n);
          o.connect(vg);
          if (n > 1 && ctx.createStereoPanner) { const pan = ctx.createStereoPanner(); pan.pan.value = spread * 0.7; vg.connect(pan).connect(fades[i]); }
          else vg.connect(fades[i]);
          o.start(t); o.stop(end);
        });
      }
    },
  });

  // ======================================================================= FM Matrix
  // routings: [modulator -> carrier pairs], carriers. Operators 1..4.
  const ALGOS = [
    ['stack', 'Stack 4→3→2→1', [[4, 3], [3, 2], [2, 1]], [1]],
    ['twostack', 'Two pairs 2→1, 4→3', [[2, 1], [4, 3]], [1, 3]],
    ['y', 'Y: 3+4 → 2 → 1', [[3, 2], [4, 2], [2, 1]], [1]],
    ['three', 'Three into one', [[2, 1], [3, 1], [4, 1]], [1]],
    ['fan', 'One into three', [[4, 1], [4, 2], [4, 3]], [1, 2, 3]],
    ['stackplus', 'Stack 3→2→1 + 4', [[3, 2], [2, 1]], [1, 4]],
    ['pair', 'Pair 2→1 + 3 + 4', [[2, 1]], [1, 3, 4]],
    ['organ', 'All carriers', [], [1, 2, 3, 4]],
  ];
  const opParams = (i, d) => [
    { id: `r${i}`, name: `Op ${i} ratio`, type: 'knob', min: 0.25, max: 16, default: d.r, step: 0.25, fmt: (v) => `${v}×` },
    { id: `w${i}`, name: `Op ${i} wave`, type: 'select', default: 'sine', options: WAVES },
    { id: `l${i}`, name: `Op ${i} level`, type: 'knob', min: 0, max: 1, default: d.l, fmt: U.pct },
    { id: `a${i}`, name: `Op ${i} attack`, type: 'knob', min: 0.001, max: 4, default: 0.002, curve: 'log', fmt: U.sec },
    { id: `d${i}`, name: `Op ${i} decay`, type: 'knob', min: 0.01, max: 8, default: d.d, curve: 'log', fmt: U.sec },
    { id: `s${i}`, name: `Op ${i} sustain`, type: 'knob', min: 0, max: 1, default: d.s, fmt: U.pct },
    { id: `e${i}`, name: `Op ${i} release`, type: 'knob', min: 0.005, max: 8, default: 0.3, curve: 'log', fmt: U.sec },
  ];
  BF.plugins.register({
    id: 'fm4', name: 'FM Matrix', kind: 'instrument',
    params: [
      { id: 'algo', name: 'Routing', type: 'select', default: 'stack', options: ALGOS.map(([id, n]) => [id, n]) },
      ...opParams(1, { r: 1, l: 0.9, d: 1.2, s: 0.6 }), ...opParams(2, { r: 2, l: 0.45, d: 0.6, s: 0.3 }),
      ...opParams(3, { r: 3, l: 0.25, d: 0.4, s: 0.2 }), ...opParams(4, { r: 1, l: 0.15, d: 0.3, s: 0.1 }),
      { id: 'depth', name: 'FM depth', type: 'knob', min: 0, max: 12, default: 5 },
      { id: 'detune', name: 'Detune', type: 'knob', min: 0, max: 30, default: 0, unit: ' ct' },
      { id: 'ftype', name: 'Filter', type: 'select', default: 'off', options: [['off', 'Off'], ['lowpass', 'Low pass'], ['bandpass', 'Band pass'], ['highpass', 'High pass']] },
      { id: 'cutoff', name: 'Cutoff', type: 'knob', min: 40, max: 18000, default: 4000, curve: 'log', fmt: U.hz },
      { id: 'reso', name: 'Resonance', type: 'knob', min: 0, max: 20, default: 1 },
      { id: 'fenv', name: 'Filter env', type: 'knob', min: 0, max: 1, default: 0, fmt: U.pct },
      { id: 'fdecay', name: 'Filter decay', type: 'knob', min: 0.01, max: 4, default: 0.4, curve: 'log', fmt: U.sec },
      { id: 'velsens', name: 'Velocity → FM', type: 'knob', min: 0, max: 1, default: 0.5, fmt: U.pct },
      { id: 'level', name: 'Level', type: 'knob', min: 0, max: 1, default: 0.5, fmt: U.pct },
    ],
    presets: {
      'Init': {},
      'Electric piano': { algo: 'twostack', r1: 1, l1: 0.9, d1: 2.5, s1: 0.2, r2: 1, l2: 0.35, d2: 1, s2: 0.1, r3: 1, l3: 0.6, d3: 1.5, s3: 0.1, r4: 14, l4: 0.12, d4: 0.15, s4: 0, depth: 4 },
      'Tubular bell': { algo: 'twostack', r1: 1, d1: 5, s1: 0, e1: 3, r2: 3.5, l2: 0.6, d2: 3, s2: 0, r3: 2, l3: 0.5, d3: 4, s3: 0, e3: 3, r4: 5.5, l4: 0.4, d4: 2, s4: 0, depth: 6 },
      'Punch bass': { algo: 'stack', r1: 0.5, l1: 1, d1: 0.6, s1: 0.7, e1: 0.08, r2: 0.5, l2: 0.6, d2: 0.25, s2: 0.2, r3: 1, l3: 0.3, d3: 0.1, s3: 0, r4: 1, l4: 0, depth: 6, ftype: 'lowpass', cutoff: 900, fenv: 0.5, fdecay: 0.2, level: 0.6 },
      'Brass': { algo: 'y', r1: 1, a1: 0.05, d1: 1, s1: 0.8, r2: 1, a2: 0.08, l2: 0.55, d2: 0.8, s2: 0.6, r3: 1, l3: 0.2, r4: 2, l4: 0.15, depth: 5, detune: 8 },
      'Wood pluck': { algo: 'three', r1: 1, d1: 0.5, s1: 0, e1: 0.2, r2: 3, l2: 0.5, d2: 0.1, s2: 0, r3: 5, l3: 0.3, d3: 0.06, s3: 0, r4: 7, l4: 0.2, d4: 0.04, s4: 0, depth: 7 },
      'Digital pad': { algo: 'fan', r1: 1, a1: 0.8, d1: 2, s1: 0.8, e1: 2, r2: 2, a2: 0.9, l2: 0.5, d2: 2, s2: 0.8, e2: 2, r3: 3, a3: 1, l3: 0.35, d3: 2, s3: 0.8, e3: 2, r4: 0.5, l4: 0.4, d4: 3, s4: 0.6, depth: 2.5, detune: 14, level: 0.4 },
      'Drawbar organ': { algo: 'organ', r1: 0.5, l1: 0.7, s1: 1, r2: 1, l2: 0.7, s2: 1, r3: 2, l3: 0.5, s3: 1, r4: 4, l4: 0.3, s4: 1, d1: 1, d2: 1, d3: 1, d4: 1, e1: 0.05, e2: 0.05, e3: 0.05, e4: 0.05, level: 0.4 },
    },
    play(ctx, out, p, t, key, vel, dur) {
      const f = U.midiHz(key);
      const algo = ALGOS.find((a) => a[0] === p.algo) || ALGOS[0];
      const [, , mods, carriers] = algo;
      const amp = ctx.createGain(); amp.gain.value = vel * p.level;
      let head = amp;
      if (p.ftype !== 'off') {
        const flt = ctx.createBiquadFilter(); flt.type = p.ftype; flt.Q.value = p.reso;
        const top = Math.min(ctx.sampleRate * 0.45, p.cutoff * Math.pow(2, p.fenv * 6));
        flt.frequency.setValueAtTime(top, t);
        flt.frequency.setTargetAtTime(p.cutoff, t + 0.002, Math.max(0.005, p.fdecay / 3));
        flt.connect(amp); head = flt;
      }
      amp.connect(out);
      const fmScale = p.depth * (1 - p.velsens + p.velsens * vel);
      const relMax = Math.max(...carriers.map((i) => p[`e${i}`]));
      const end = t + Math.max(dur, 0.005) + relMax + 0.02;
      const voices = p.detune > 0.5 ? [-1, 1] : [0];
      voices.forEach((side) => {
        const op = {};
        [1, 2, 3, 4].forEach((i) => {
          const used = carriers.includes(i) || mods.some(([s]) => s === i);
          if (!used || p[`l${i}`] <= 0.0005) return;
          const o = ctx.createOscillator(); o.type = p[`w${i}`];
          o.frequency.value = f * p[`r${i}`]; o.detune.value = (side * p.detune) / 2;
          const env = ctx.createGain();
          U.adsr(env.gain, t, dur, p[`l${i}`], p[`a${i}`], p[`d${i}`], p[`s${i}`], p[`e${i}`]);
          o.connect(env);
          o.start(t); o.stop(end);
          op[i] = { o, env };
        });
        mods.forEach(([s, d]) => { // modulator envelope -> Hz deviation of the carrier's frequency
          if (!op[s] || !op[d]) return;
          const dev = ctx.createGain(); dev.gain.value = f * p[`r${d}`] * fmScale;
          op[s].env.connect(dev).connect(op[d].o.frequency);
        });
        const mix = ctx.createGain(); mix.gain.value = 1 / Math.max(1, carriers.length) / voices.length;
        mix.connect(head);
        carriers.forEach((i) => { if (op[i]) op[i].env.connect(mix); });
      });
    },
  });

  // ======================================================================= Beat Slicer
  const sliceCache = new Map();
  /** Slice start times (seconds) for a sample: at its hits, or in equal parts. */
  function slicesOf(id, mode, sens) {
    const k = `${id}|${mode}|${sens.toFixed(2)}`;
    if (sliceCache.has(k)) return sliceCache.get(k);
    const b = BF.audio.buffers.get(id);
    if (!b) return [];
    const rate = b.sampleRate, n = b.length;
    let out = [0];
    if (mode !== 'auto') {
      const parts = Number(mode);
      out = Array.from({ length: parts }, (_, i) => (i * n) / parts / rate);
    } else {
      // onset detection: energy of the signal's change (rough high-pass), in 5 ms frames
      const hop = Math.round(rate * 0.005), frames = Math.floor(n / hop);
      const e = new Float32Array(frames);
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        for (let f = 0; f < frames; f++) { let s = 0; for (let i = f * hop + 1; i < (f + 1) * hop; i++) { const v = d[i] - d[i - 1]; s += v * v; } e[f] += s; }
      }
      for (let f = 0; f < frames; f++) e[f] = Math.log10(1e-9 + e[f]);
      const d0 = b.getChannelData(0);
      const exact = (a0, z0) => { // the first sample of the hit inside two frames, minus 1 ms so its start is kept
        let m = 0; for (let i = a0; i < Math.min(n, z0); i++) m = Math.max(m, Math.abs(d0[i]));
        let i = a0; while (i < z0 && Math.abs(d0[i]) < m * 0.15) i++;
        return Math.max(0, i - Math.round(rate * 0.001));
      };
      // a hit = the energy jumps well above the last 20 ms; sensitivity sets how big the jump must be (log10 steps)
      let pk = -9; for (let f = 0; f < frames; f++) pk = Math.max(pk, e[f]);
      const gap = Math.round((0.06 * rate) / hop), jump = 1.6 - sens * 1.3, floor = pk - 3.5 - sens * 1.5;
      let last = -gap;
      for (let f = 1; f < frames; f++) {
        let base = -9; for (let j = Math.max(0, f - 4); j < f; j++) base = Math.max(base, e[j]);
        if (e[f] - base > jump && e[f] > floor && f - last >= gap) { if (f > 1) out.push(exact((f - 1) * hop, (f + 1) * hop) / rate); last = f; }
      }
      out = out.filter((v, i) => i === 0 || v - out[i - 1] > 0.03).slice(0, 128);
    }
    if (sliceCache.size > 60) sliceCache.clear();
    sliceCache.set(k, out);
    return out;
  }
  BF.slicer = { slicesOf };
  /** The loop's tempo: the BPM knob, or a guess from its length (a whole number of 4/4 bars near the project tempo). */
  BF.slicer.bpmOf = function (p, sampleSec, projBpm = 120) {
    if (p.bpm >= 40) return p.bpm;
    let best = 120, bd = 1e9;
    [0.25, 0.5, 1, 2, 4, 8, 16].forEach((bars) => { const b = (240 * bars) / sampleSec; if (b >= 60 && b <= 200 && Math.abs(b - projBpm) < bd) { bd = Math.abs(b - projBpm); best = b; } });
    return best;
  };
  const chokes = new WeakMap(); // output node -> the voice that is playing (one slice at a time, like a real drum loop)
  BF.plugins.register({
    id: 'slicer', name: 'Beat Slicer', kind: 'instrument',
    params: [
      { id: 'sample', name: 'Loop', type: 'sample', default: null },
      { id: 'mode', name: 'Slice by', type: 'select', default: 'auto', options: [['auto', 'Hits (auto)'], ['4', '4 equal'], ['8', '8 equal'], ['16', '16 equal'], ['32', '32 equal']] },
      { id: 'sens', name: 'Sensitivity', type: 'knob', min: 0, max: 1, default: 0.5, fmt: U.pct },
      { id: 'root', name: 'First key', type: 'knob', min: 24, max: 96, default: 48, step: 1, fmt: (v) => BF.noteName(v) },
      { id: 'bpm', name: 'Loop BPM', type: 'knob', min: 0, max: 220, default: 0, step: 0.5, fmt: (v) => (v < 40 ? 'Auto' : `${v} BPM`) },
      { id: 'tune', name: 'Tune', type: 'knob', min: -24, max: 24, default: 0, step: 1, unit: ' st' },
      { id: 'gate', name: 'Stop at note end', type: 'toggle', default: true },
      { id: 'choke', name: 'One at a time', type: 'toggle', default: true },
      { id: 'reverse', name: 'Reverse slices', type: 'toggle', default: false },
      { id: 'attack', name: 'Attack', type: 'knob', min: 0.0005, max: 0.2, default: 0.001, curve: 'log', fmt: U.sec },
      { id: 'release', name: 'Release', type: 'knob', min: 0.002, max: 1, default: 0.02, curve: 'log', fmt: U.sec },
      { id: 'level', name: 'Level', type: 'knob', min: 0, max: 1.5, default: 1, fmt: U.pct },
    ],
    play(ctx, out, p, t, key, vel, dur) {
      if (!p.sample) return;
      const buf = BF.audio.buffers.get(p.sample);
      if (!buf) return;
      const sl = slicesOf(p.sample, p.mode, p.sens);
      const i = Math.round(key - p.root);
      if (i < 0 || i >= sl.length) return;
      const a = sl[i], z = i + 1 < sl.length ? sl[i + 1] : buf.duration;
      const rate = U.semis(p.tune);
      let len = (z - a) / rate;
      if (p.gate) len = Math.min(len, Math.max(dur, 0.01) + p.release);
      if (len <= 0.003) return;
      const src = ctx.createBufferSource();
      src.playbackRate.value = rate;
      let off = a;
      if (p.reverse) { src.buffer = BF.audio.reversed(p.sample); off = buf.duration - z; } else src.buffer = buf;
      const g = ctx.createGain(), peak = vel * p.level;
      const at = Math.min(p.attack, len / 3), rl = Math.min(p.release, len / 2);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + at);
      g.gain.setValueAtTime(peak, t + len - rl);
      g.gain.linearRampToValueAtTime(0, t + len);
      src.connect(g).connect(out);
      src.start(t, off);
      src.stop(t + len + 0.01);
      if (p.choke) { // a new slice cuts the one before (quick fade, no click)
        const prev = chokes.get(out);
        if (prev && prev.end > t) { try { prev.g.gain.cancelScheduledValues(t); prev.g.gain.setValueAtTime(prev.g.gain.value, t); prev.g.gain.setTargetAtTime(0, t, 0.003); prev.src.stop(t + 0.03); } catch { /* already stopped */ } }
        chokes.set(out, { g, src, end: t + len });
      }
    },
  });
})();
