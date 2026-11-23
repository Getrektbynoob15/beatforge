/* instruments.js: built-in instrument plugins (all original): Drum Kit, Forge Synth, Sampler. */
(function () {
  'use strict';
  const BF = window.BF;
  const U = BF.plugins.util;
  const W = [['sine', 'Sine'], ['triangle', 'Triangle'], ['sawtooth', 'Saw'], ['square', 'Square']];

  // ---------- Drum Kit: wraps the code-made drum voices in synth.js ----------
  BF.plugins.register({
    id: 'drum',
    name: 'Drum Kit',
    kind: 'instrument',
    params: [
      { id: 'sound', name: 'Sound', type: 'select', default: 'kick', options: [['kick', 'Kick'], ['snare', 'Snare'], ['clap', 'Clap'], ['hihat', 'Closed hat'], ['openhat', 'Open hat'], ['tom', 'Tom'], ['rim', 'Rim'], ['cowbell', 'Cowbell'], ['crash', 'Crash'], ['perc', 'Perc'], ['bass808', '808']] },
      { id: 'tune', name: 'Tune', type: 'knob', min: -24, max: 24, default: 0, step: 1, unit: ' st' },
      { id: 'decay', name: 'Decay', type: 'knob', min: 0.25, max: 3, default: 1, fmt: (v) => `${v.toFixed(2)}×` },
      { id: 'tone', name: 'Tone', type: 'knob', min: 200, max: 20000, default: 20000, curve: 'log', fmt: U.hz },
      { id: 'level', name: 'Level', type: 'knob', min: 0, max: 1, default: 0.9, fmt: U.pct },
    ],
    play(ctx, out, p, t, key, vel) {
      const g = ctx.createGain();
      g.gain.value = vel * p.level;
      let dest = g;
      if (p.tone < 19900) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = p.tone;
        lp.connect(g); dest = lp;
      }
      g.connect(out);
      BF.drumVoice(ctx, p.sound, dest, t, p.tune + (key - 60), p.decay);
      setTimeout(() => { try { g.disconnect(); } catch { /* gone */ } }, Math.max(0, (t - ctx.currentTime) * 1000) + 6000);
    },
  });

  // ---------- Forge Synth: 2 oscillators + sub, unison, filter with envelope, amp ADSR ----------
  BF.plugins.register({
    id: 'synth',
    name: 'Forge Synth',
    kind: 'instrument',
    params: [
      { id: 'osc1', name: 'Osc 1', type: 'select', default: 'sawtooth', options: W },
      { id: 'osc2', name: 'Osc 2', type: 'select', default: 'square', options: W },
      { id: 'semi2', name: 'Osc 2 semi', type: 'knob', min: -24, max: 24, default: 0, step: 1, unit: ' st' },
      { id: 'fine2', name: 'Osc 2 fine', type: 'knob', min: -50, max: 50, default: 7, step: 1, unit: ' ct' },
      { id: 'mix', name: 'Osc mix', type: 'knob', min: 0, max: 1, default: 0.35, fmt: U.pct },
      { id: 'sub', name: 'Sub', type: 'knob', min: 0, max: 1, default: 0, fmt: U.pct },
      { id: 'unison', name: 'Unison', type: 'knob', min: 1, max: 7, default: 1, step: 1, fmt: (v) => `${v} voice${v > 1 ? 's' : ''}` },
      { id: 'spread', name: 'Spread', type: 'knob', min: 0, max: 60, default: 18, unit: ' ct' },
      { id: 'cutoff', name: 'Cutoff', type: 'knob', min: 40, max: 18000, default: 2400, curve: 'log', fmt: U.hz },
      { id: 'reso', name: 'Resonance', type: 'knob', min: 0, max: 20, default: 2 },
      { id: 'fenv', name: 'Filter env', type: 'knob', min: 0, max: 1, default: 0.4, fmt: U.pct },
      { id: 'fdecay', name: 'Filter decay', type: 'knob', min: 0.01, max: 3, default: 0.35, curve: 'log', fmt: U.sec },
      { id: 'attack', name: 'Attack', type: 'knob', min: 0.001, max: 3, default: 0.004, curve: 'log', fmt: U.sec },
      { id: 'decay', name: 'Decay', type: 'knob', min: 0.01, max: 4, default: 0.3, curve: 'log', fmt: U.sec },
      { id: 'sustain', name: 'Sustain', type: 'knob', min: 0, max: 1, default: 0.7, fmt: U.pct },
      { id: 'release', name: 'Release', type: 'knob', min: 0.005, max: 6, default: 0.12, curve: 'log', fmt: U.sec },
      { id: 'level', name: 'Level', type: 'knob', min: 0, max: 1, default: 0.5, fmt: U.pct },
    ],
    presets: {
      'Init': {},
      'Sub bass': { osc1: 'sine', osc2: 'triangle', mix: 0.2, fine2: 0, sub: 0.5, cutoff: 900, reso: 1, fenv: 0.15, attack: 0.003, decay: 0.4, sustain: 0.85, release: 0.08, level: 0.7 },
      'Reese bass': { osc1: 'sawtooth', osc2: 'sawtooth', fine2: 18, mix: 0.5, sub: 0.35, unison: 2, spread: 22, cutoff: 700, reso: 3, fenv: 0.2, release: 0.1, level: 0.5 },
      'Bright lead': { osc1: 'sawtooth', osc2: 'square', fine2: 8, mix: 0.4, cutoff: 3800, reso: 3, fenv: 0.35, fdecay: 0.25, attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.15, level: 0.35 },
      'Supersaw': { osc1: 'sawtooth', osc2: 'sawtooth', semi2: 12, fine2: 5, mix: 0.3, unison: 7, spread: 35, cutoff: 6000, reso: 1, fenv: 0.2, attack: 0.01, sustain: 0.8, release: 0.35, level: 0.22 },
      'Pluck': { osc1: 'sawtooth', osc2: 'triangle', semi2: 12, mix: 0.3, cutoff: 600, reso: 6, fenv: 0.9, fdecay: 0.18, attack: 0.002, decay: 0.25, sustain: 0, release: 0.2, level: 0.45 },
      'Soft pad': { osc1: 'triangle', osc2: 'sawtooth', fine2: 9, mix: 0.4, unison: 3, spread: 25, cutoff: 1800, reso: 1, fenv: 0.1, attack: 0.6, decay: 1, sustain: 0.8, release: 1.6, level: 0.3 },
      'Square keys': { osc1: 'square', osc2: 'square', semi2: 12, fine2: 3, mix: 0.25, cutoff: 2600, reso: 2, fenv: 0.5, fdecay: 0.4, attack: 0.003, decay: 0.6, sustain: 0.3, release: 0.25, level: 0.35 },
      '808 glide': { osc1: 'sine', osc2: 'sine', mix: 0, sub: 0, cutoff: 1600, fenv: 0, attack: 0.002, decay: 1.4, sustain: 0.45, release: 0.3, level: 0.85 },
    },
    play(ctx, out, p, t, key, vel, dur) {
      const f = U.midiHz(key);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = p.reso;
      const base = Math.max(30, Math.min(18000, p.cutoff));
      const peakF = Math.min(18000, base * (1 + p.fenv * 7));
      lp.frequency.setValueAtTime(peakF, t);
      lp.frequency.setTargetAtTime(base, t + 0.001, Math.max(0.003, p.fdecay / 3));
      const amp = ctx.createGain();
      const end = U.adsr(amp.gain, t, dur, vel * p.level, p.attack, p.decay, p.sustain, p.release);
      lp.connect(amp).connect(out);
      const n = Math.round(p.unison);
      const uni = (i) => (n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * p.spread);
      const norm = 1 / Math.sqrt(n);
      const osc = (type, freq, detune, gain) => {
        if (gain <= 0.001) return;
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        o.detune.value = detune;
        const g = ctx.createGain();
        g.gain.value = gain;
        o.connect(g).connect(lp);
        o.start(t);
        o.stop(end);
      };
      for (let i = 0; i < n; i++) {
        osc(p.osc1, f, uni(i), (1 - p.mix) * norm);
        osc(p.osc2, f * U.semis(p.semi2), p.fine2 + uni(i), p.mix * norm);
      }
      osc('sine', f / 2, 0, p.sub);
    },
  });

  // ---------- Sampler: plays an imported sample across the keyboard ----------
  BF.plugins.register({
    id: 'sampler',
    name: 'Sampler',
    kind: 'instrument',
    params: [
      { id: 'sample', name: 'Sample', type: 'sample', default: null },
      { id: 'root', name: 'Root key', type: 'knob', min: 0, max: 127, default: 60, step: 1, fmt: (v) => BF.noteName(v) },
      { id: 'oneshot', name: 'One shot', type: 'toggle', default: true },
      { id: 'start', name: 'Start', type: 'knob', min: 0, max: 0.99, default: 0, fmt: U.pct },
      { id: 'attack', name: 'Attack', type: 'knob', min: 0.001, max: 2, default: 0.003, curve: 'log', fmt: U.sec },
      { id: 'release', name: 'Release', type: 'knob', min: 0.005, max: 4, default: 0.05, curve: 'log', fmt: U.sec },
      { id: 'reverse', name: 'Reverse', type: 'toggle', default: false },
      { id: 'level', name: 'Level', type: 'knob', min: 0, max: 1.5, default: 1, fmt: U.pct },
    ],
    play(ctx, out, p, t, key, vel, dur) {
      if (!p.sample) return;
      let buf = BF.audio.buffers.get(p.sample);
      if (!buf) return;
      if (p.reverse) buf = BF.audio.reversed(p.sample);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = U.semis(key - p.root);
      const offset = p.start * buf.duration;
      const natural = (buf.duration - offset) / src.playbackRate.value;
      const len = p.oneshot ? natural : Math.min(natural, dur + p.release);
      if (len <= 0.002) return;
      const g = ctx.createGain();
      const peak = vel * p.level;
      const a = Math.min(p.attack, len / 2);
      const r = p.oneshot ? Math.min(0.004, len / 2) : Math.min(p.release, len / 2);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + a);
      g.gain.setValueAtTime(peak, t + len - r);
      g.gain.linearRampToValueAtTime(0, t + len);
      src.connect(g).connect(out);
      src.start(t, offset);
      src.stop(t + len + 0.01);
    },
  });

  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  BF.noteName = (m) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;
})();
