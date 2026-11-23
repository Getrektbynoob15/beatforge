/* instruments2.js: more instrument plugins (all original): FM Keys, String Pluck, Organ. Plus drum kit presets. */
(function () {
  'use strict';
  const BF = window.BF;
  const U = BF.plugins.util;

  // ---------- FM Keys: 2-operator FM (modulator -> carrier frequency) ----------
  BF.plugins.register({
    id: 'fm', name: 'FM Keys', kind: 'instrument',
    params: [
      { id: 'ratio', name: 'Mod ratio', type: 'knob', min: 0.5, max: 8, default: 1, step: 0.5, fmt: (v) => `${v}×` },
      { id: 'index', name: 'Mod amount', type: 'knob', min: 0, max: 12, default: 3 },
      { id: 'idecay', name: 'Mod decay', type: 'knob', min: 0.02, max: 4, default: 0.6, curve: 'log', fmt: U.sec },
      { id: 'detune', name: 'Detune', type: 'knob', min: 0, max: 20, default: 4, unit: ' ct' },
      { id: 'attack', name: 'Attack', type: 'knob', min: 0.001, max: 2, default: 0.003, curve: 'log', fmt: U.sec },
      { id: 'decay', name: 'Decay', type: 'knob', min: 0.05, max: 6, default: 1.5, curve: 'log', fmt: U.sec },
      { id: 'sustain', name: 'Sustain', type: 'knob', min: 0, max: 1, default: 0.3, fmt: U.pct },
      { id: 'release', name: 'Release', type: 'knob', min: 0.01, max: 4, default: 0.4, curve: 'log', fmt: U.sec },
      { id: 'level', name: 'Level', type: 'knob', min: 0, max: 1, default: 0.5, fmt: U.pct },
    ],
    presets: {
      'E-piano': {},
      'Glass bell': { ratio: 3.5, index: 5, idecay: 1.8, decay: 3, sustain: 0, release: 1.5, detune: 2 },
      'FM bass': { ratio: 1, index: 6, idecay: 0.25, decay: 0.5, sustain: 0.6, release: 0.1, level: 0.6, detune: 0 },
      'Marimba': { ratio: 4, index: 2.5, idecay: 0.08, decay: 0.5, sustain: 0, release: 0.2, detune: 0 },
      'Digital pad': { ratio: 2, index: 1.5, idecay: 3, attack: 0.5, decay: 2, sustain: 0.8, release: 1.5, detune: 10, level: 0.35 },
    },
    play(ctx, out, p, t, key, vel, dur) {
      const f = U.midiHz(key);
      const amp = ctx.createGain();
      const end = U.adsr(amp.gain, t, dur, vel * p.level, p.attack, p.decay, p.sustain, p.release);
      amp.connect(out);
      [-1, 1].forEach((side) => {
        const car = ctx.createOscillator(), mod = ctx.createOscillator(), idx = ctx.createGain(), half = ctx.createGain();
        car.frequency.value = f; car.detune.value = side * p.detune / 2;
        mod.frequency.value = f * p.ratio; mod.detune.value = side * p.detune / 2;
        const peak = f * p.index * (0.5 + vel * 0.5);
        idx.gain.setValueAtTime(peak, t);
        idx.gain.setTargetAtTime(peak * 0.05, t, Math.max(0.005, p.idecay / 3));
        half.gain.value = 0.5;
        mod.connect(idx).connect(car.frequency);
        car.connect(half).connect(amp);
        car.start(t); mod.start(t); car.stop(end); mod.stop(end);
      });
    },
  });

  // ---------- String Pluck: Karplus-Strong, rendered per note into a cached buffer ----------
  const pluckCache = new Map();
  function pluckBuffer(ctx, key, p) {
    const sr = ctx.sampleRate;
    const k = `${sr}:${key}:${p.bright.toFixed(2)}:${p.damp.toFixed(2)}:${p.length.toFixed(2)}`;
    if (pluckCache.has(k)) return pluckCache.get(k);
    const f = U.midiHz(key);
    const len = Math.floor(sr * p.length);
    const b = ctx.createBuffer(1, len, sr);
    const y = b.getChannelData(0);
    const period = sr / f;
    const N = Math.floor(period), frac = period - N;
    // excitation: one period of noise, smoothed by `bright`
    let seed = 1234567 + key * 7919, last = 0;
    const lp = 1 - p.bright * 0.9;
    for (let i = 0; i < N + 2 && i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const w = seed / 2147483648 - 1;
      last = last * lp + w * (1 - lp);
      y[i] = last;
    }
    // per-sample loss so the note lasts about `length` seconds, plus `damp` high-frequency loss
    const loss = Math.pow(0.001, 1 / (p.length * f));
    const d = 0.5 - p.damp * 0.45;
    for (let i = N + 2; i < len; i++) {
      const a = y[i - N] * (1 - frac) + y[i - N - 1] * frac; // fractional delay for exact tuning
      const bb = y[i - N - 1] * (1 - frac) + y[i - N - 2] * frac;
      y[i] = loss * ((0.5 + d) * a + (0.5 - d) * bb);
    }
    let pk = 0;
    for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(y[i]));
    if (pk > 0) for (let i = 0; i < len; i++) y[i] /= pk;
    if (pluckCache.size > 300) pluckCache.clear();
    pluckCache.set(k, b);
    return b;
  }
  BF.plugins.register({
    id: 'pluck', name: 'String Pluck', kind: 'instrument',
    params: [
      { id: 'bright', name: 'Brightness', type: 'knob', min: 0, max: 1, default: 0.6, fmt: U.pct },
      { id: 'damp', name: 'Damping', type: 'knob', min: 0, max: 1, default: 0.3, fmt: U.pct },
      { id: 'length', name: 'Ring time', type: 'knob', min: 0.2, max: 6, default: 1.6, curve: 'log', fmt: U.sec },
      { id: 'body', name: 'Body', type: 'knob', min: 300, max: 12000, default: 5000, curve: 'log', fmt: U.hz },
      { id: 'release', name: 'Release', type: 'knob', min: 0.01, max: 2, default: 0.2, curve: 'log', fmt: U.sec },
      { id: 'level', name: 'Level', type: 'knob', min: 0, max: 1, default: 0.6, fmt: U.pct },
    ],
    presets: { 'Nylon': { bright: 0.45, damp: 0.5, length: 2, body: 3500 }, 'Steel': { bright: 0.8, damp: 0.15, length: 3 }, 'Harp': { bright: 0.55, damp: 0.25, length: 4, body: 7000 }, 'Koto': { bright: 0.9, damp: 0.1, length: 1.2, body: 9000 }, 'Muted': { bright: 0.3, damp: 0.85, length: 0.4, body: 2000 } },
    play(ctx, out, p, t, key, vel, dur) {
      const buf = pluckBuffer(ctx, key, p);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const body = ctx.createBiquadFilter(); body.type = 'lowpass'; body.frequency.value = p.body;
      const g = ctx.createGain();
      const stop = Math.min(t + buf.duration, t + dur + p.release);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel * p.level, t + 0.002);
      g.gain.setValueAtTime(vel * p.level, Math.max(t + 0.003, t + dur));
      g.gain.setTargetAtTime(0, Math.max(t + 0.003, t + dur), Math.max(0.003, p.release / 4));
      g.gain.linearRampToValueAtTime(0, stop + 0.005);
      src.connect(body).connect(g).connect(out);
      src.start(t);
      src.stop(stop + 0.01);
    },
  });

  // ---------- Organ: 9 drawbars (additive sines), key click, vibrato ----------
  const BARS = [['b16', "16'", 0.5], ['b513', "5⅓'", 1.5], ['b8', "8'", 1], ['b4', "4'", 2], ['b223', "2⅔'", 3], ['b2', "2'", 4], ['b135', "1⅗'", 5], ['b113', "1⅓'", 6], ['b1', "1'", 8]];
  BF.plugins.register({
    id: 'organ', name: 'Organ', kind: 'instrument',
    params: [
      ...BARS.map(([id, name], i) => ({ id, name: `Bar ${name}`, type: 'knob', min: 0, max: 1, default: [0.8, 0.8, 0.8, 0, 0, 0, 0, 0, 0][i], step: 0.125, fmt: (v) => String(Math.round(v * 8)) })),
      { id: 'click', name: 'Key click', type: 'knob', min: 0, max: 1, default: 0.3, fmt: U.pct },
      { id: 'vib', name: 'Vibrato', type: 'knob', min: 0, max: 1, default: 0.3, fmt: U.pct },
      { id: 'level', name: 'Level', type: 'knob', min: 0, max: 1, default: 0.35, fmt: U.pct },
    ],
    presets: {
      'Full': Object.fromEntries(BARS.map(([id]) => [id, 1])),
      'Jazz': { b16: 0.875, b513: 0.875, b8: 1, b4: 0, b223: 0, b2: 0, b135: 0, b113: 0, b1: 0, click: 0.5 },
      'Gospel': { b16: 1, b513: 1, b8: 1, b4: 0.75, b223: 0, b2: 0, b135: 0, b113: 0, b1: 0.5, vib: 0.5 },
      'Flute': { b16: 0, b513: 0, b8: 1, b4: 0.5, b223: 0, b2: 0, b135: 0, b113: 0, b1: 0, click: 0, vib: 0.2 },
    },
    play(ctx, out, p, t, key, vel, dur) {
      const f = U.midiHz(key);
      const amp = ctx.createGain();
      const end = t + dur + 0.06;
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(vel * p.level, t + 0.006);
      amp.gain.setValueAtTime(vel * p.level, t + dur);
      amp.gain.linearRampToValueAtTime(0, end);
      amp.connect(out);
      const vib = ctx.createOscillator(), vibAmt = ctx.createGain();
      vib.frequency.value = 6.4; vibAmt.gain.value = p.vib * 14;
      vib.connect(vibAmt); vib.start(t); vib.stop(end);
      const total = BARS.reduce((a, [id]) => a + p[id], 0) || 1;
      BARS.forEach(([id, , mult]) => {
        if (p[id] <= 0.01 || f * mult > 16000) return;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f * mult;
        vibAmt.connect(o.detune);
        g.gain.value = p[id] / Math.max(1, total / 2);
        o.connect(g).connect(amp); o.start(t); o.stop(end);
      });
      if (p.click > 0.01) {
        const c = ctx.createOscillator(), cg = ctx.createGain();
        c.type = 'square'; c.frequency.value = f * 12 > 8000 ? 4000 : f * 12;
        cg.gain.setValueAtTime(0, t); cg.gain.linearRampToValueAtTime(p.click * 0.15 * vel, t + 0.001); cg.gain.linearRampToValueAtTime(0, t + 0.012);
        c.connect(cg).connect(out); c.start(t); c.stop(t + 0.02);
      }
    },
  });

  // ---------- Drum kits: preset sets for the Drum Kit plugin (shown as packs in the browser) ----------
  BF.KITS = {
    'Trap kit': { kick: { tune: -2, decay: 1.3 }, bass808: { tune: 0, decay: 2.4 }, snare: { tune: 3, decay: 0.8, tone: 12000 }, clap: { decay: 1.2 }, hihat: { tune: 4, decay: 0.7 }, openhat: { tune: 3, decay: 0.8 }, rim: { tune: 2 }, perc: { tune: 5 } },
    'House kit': { kick: { tune: -1, decay: 1.1 }, clap: { decay: 1.4, tone: 9000 }, hihat: { tune: 1, decay: 1 }, openhat: { decay: 1.3 }, snare: { decay: 1 }, cowbell: {}, rim: {}, tom: { tune: -3 } },
    'Lo-fi kit': { kick: { tone: 2500, decay: 0.9 }, snare: { tone: 3500, decay: 1.2 }, hihat: { tone: 4500, decay: 1.4 }, openhat: { tone: 4500 }, clap: { tone: 3000 }, rim: { tone: 4000 }, perc: { tone: 3000, tune: -5 } },
    'Rock kit': { kick: { tune: 1, decay: 0.8 }, snare: { tune: -2, decay: 1.6 }, hihat: { decay: 1.2 }, openhat: { decay: 1.1 }, crash: { decay: 1.4 }, tom: { tune: 0, decay: 1.4 } },
  };
})();
