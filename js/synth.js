/* synth.js: every built-in sound is made from oscillators and noise, no audio files.
 * Each voice gets a short attack fade and ends at exactly zero gain before it stops, so nothing clicks. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});
  const noiseCache = new WeakMap();

  function noise(ctx) {
    let b = noiseCache.get(ctx);
    if (!b) {
      b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0);
      let seed = 12345; // deterministic noise so exports are repeatable
      for (let i = 0; i < d.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = seed / 2147483648 - 1; }
      noiseCache.set(ctx, b);
    }
    return b;
  }

  /** gain node with an attack/decay envelope that ends at 0 */
  function env(ctx, when, peak, decay, attack = 0.003) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.001, when + attack + decay);
    g.gain.linearRampToValueAtTime(0, when + attack + decay + 0.004);
    return { g, end: when + attack + decay + 0.01 };
  }

  function noiseSrc(ctx, when, end) {
    const s = ctx.createBufferSource();
    s.buffer = noise(ctx);
    s.loop = true;
    s.start(when, Math.random() * 0.5);
    s.stop(end);
    return s;
  }

  const semis = (p) => Math.pow(2, p / 12);
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const VOICES = {
    kick(ctx, out, t, p) {
      const o = ctx.createOscillator();
      const { g, end } = env(ctx, t, 1, 0.42);
      o.frequency.setValueAtTime(160 * p, t);
      o.frequency.exponentialRampToValueAtTime(45 * p, t + 0.11);
      o.connect(g).connect(out);
      o.start(t); o.stop(end);
    },
    snare(ctx, out, t, p) {
      const n = env(ctx, t, 0.7, 0.18);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200 * p;
      noiseSrc(ctx, t, n.end).connect(hp).connect(n.g).connect(out);
      const o = ctx.createOscillator(); o.type = 'triangle';
      const b = env(ctx, t, 0.5, 0.09);
      o.frequency.setValueAtTime(220 * p, t); o.frequency.exponentialRampToValueAtTime(160 * p, t + 0.08);
      o.connect(b.g).connect(out); o.start(t); o.stop(b.end);
    },
    hihat(ctx, out, t, p) {
      const e = env(ctx, t, 0.35, 0.045, 0.002);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7500 * p;
      noiseSrc(ctx, t, e.end).connect(hp).connect(e.g).connect(out);
    },
    openhat(ctx, out, t, p) {
      const e = env(ctx, t, 0.3, 0.32, 0.002);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500 * p;
      noiseSrc(ctx, t, e.end).connect(hp).connect(e.g).connect(out);
    },
    clap(ctx, out, t, p) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400 * p; bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      // three quick hits, then a short tail
      [0, 0.011, 0.022].forEach((d) => {
        g.gain.linearRampToValueAtTime(0.8, t + d + 0.002);
        g.gain.linearRampToValueAtTime(0.15, t + d + 0.009);
      });
      g.gain.linearRampToValueAtTime(0.6, t + 0.034);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      g.gain.linearRampToValueAtTime(0, t + 0.205);
      noiseSrc(ctx, t, t + 0.21).connect(bp).connect(g).connect(out);
    },
    tom(ctx, out, t, p) {
      const o = ctx.createOscillator();
      const { g, end } = env(ctx, t, 0.8, 0.3);
      o.frequency.setValueAtTime(220 * p, t);
      o.frequency.exponentialRampToValueAtTime(95 * p, t + 0.25);
      o.connect(g).connect(out); o.start(t); o.stop(end);
    },
    bass(ctx, out, t, p, step) {
      const f = midiHz(36) * p; // C2
      const len = Math.max(0.08, step * 1.8);
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = f / 2;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
      lp.frequency.setValueAtTime(1600, t); lp.frequency.exponentialRampToValueAtTime(220, t + len);
      const { g, end } = env(ctx, t, 0.55, len, 0.004);
      o.connect(lp); sub.connect(lp); lp.connect(g).connect(out);
      o.start(t); sub.start(t); o.stop(end); sub.stop(end);
    },
    lead(ctx, out, t, p, step) {
      const f = midiHz(72) * p; // C5
      const len = Math.max(0.08, step * 1.6);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 2;
      const { g, end } = env(ctx, t, 0.22, len, 0.005);
      [-7, 7].forEach((cents) => {
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f; o.detune.value = cents;
        o.connect(lp); o.start(t); o.stop(end);
      });
      lp.connect(g).connect(out);
    },
  };

  /** Schedule one hit of `sound` at time `when` into node `out`. `stepSec` = length of a 16th step. */
  BF.playSound = function (ctx, sound, out, when, pitch = 0, stepSec = 0.125) {
    const v = VOICES[sound];
    if (v) v(ctx, out, when, semis(pitch), stepSec);
  };
})();
