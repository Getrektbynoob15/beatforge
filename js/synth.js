/* synth.js: drum sounds made from oscillators and noise, no audio files.
 * BF.drumVoice(ctx, sound, out, when, semitones, decayMult)
 * Each voice has a short attack fade and ends at exactly zero gain before it stops, so nothing clicks. */
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
    s.start(when, (when * 7.31) % 0.5);
    s.stop(end);
    return s;
  }

  function tone(ctx, out, t, type, f0, f1, sweep, peak, decay) {
    const o = ctx.createOscillator();
    o.type = type;
    const e = env(ctx, t, peak, decay);
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    o.connect(e.g).connect(out);
    o.start(t); o.stop(e.end);
  }

  function filtered(ctx, out, t, type, freq, q, peak, decay, attack = 0.002) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = Math.min(20000, freq); f.Q.value = q;
    const e = env(ctx, t, peak, decay, attack);
    noiseSrc(ctx, t, e.end).connect(f).connect(e.g).connect(out);
  }

  const VOICES = {
    kick(ctx, out, t, p, k) { tone(ctx, out, t, 'sine', 160 * p, 45 * p, 0.11, 1, 0.42 * k); },
    snare(ctx, out, t, p, k) {
      filtered(ctx, out, t, 'highpass', 1200 * p, 0.7, 0.7, 0.18 * k);
      tone(ctx, out, t, 'triangle', 220 * p, 160 * p, 0.08, 0.5, 0.09 * k);
    },
    hihat(ctx, out, t, p, k) { filtered(ctx, out, t, 'highpass', 7500 * p, 0.7, 0.35, 0.045 * k); },
    openhat(ctx, out, t, p, k) { filtered(ctx, out, t, 'highpass', 6500 * p, 0.7, 0.3, 0.32 * k); },
    crash(ctx, out, t, p, k) { filtered(ctx, out, t, 'highpass', 4500 * p, 0.5, 0.3, 1.4 * k, 0.004); },
    clap(ctx, out, t, p, k) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400 * p; bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      [0, 0.011, 0.022].forEach((d) => {
        g.gain.linearRampToValueAtTime(0.8, t + d + 0.002);
        g.gain.linearRampToValueAtTime(0.15, t + d + 0.009);
      });
      g.gain.linearRampToValueAtTime(0.6, t + 0.034);
      const end = t + 0.034 + 0.17 * k;
      g.gain.exponentialRampToValueAtTime(0.001, end);
      g.gain.linearRampToValueAtTime(0, end + 0.005);
      noiseSrc(ctx, t, end + 0.01).connect(bp).connect(g).connect(out);
    },
    tom(ctx, out, t, p, k) { tone(ctx, out, t, 'sine', 220 * p, 95 * p, 0.25, 0.8, 0.3 * k); },
    rim(ctx, out, t, p, k) {
      tone(ctx, out, t, 'square', 1700 * p, 1700 * p, 0, 0.18, 0.025 * k);
      filtered(ctx, out, t, 'bandpass', 3000 * p, 2, 0.4, 0.02 * k);
    },
    cowbell(ctx, out, t, p, k) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 800 * p; bp.Q.value = 3;
      const e = env(ctx, t, 0.35, 0.28 * k, 0.002);
      [540, 800].forEach((f) => { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f * p; o.connect(bp); o.start(t); o.stop(e.end); });
      bp.connect(e.g).connect(out);
    },
    perc(ctx, out, t, p, k) { tone(ctx, out, t, 'triangle', 900 * p, 450 * p, 0.04, 0.5, 0.08 * k); },
    bass808(ctx, out, t, p, k) {
      const o = ctx.createOscillator();
      const e = env(ctx, t, 0.95, 1.1 * k, 0.002);
      o.frequency.setValueAtTime(110 * p, t);
      o.frequency.exponentialRampToValueAtTime(55 * p, t + 0.06);
      const sh = ctx.createWaveShaper(); // a little drive, like a classic 808
      const c = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(x * 1.6); }
      sh.curve = c;
      o.connect(sh).connect(e.g).connect(out);
      o.start(t); o.stop(e.end);
    },
  };

  BF.drumVoice = function (ctx, sound, out, when, semitones = 0, decay = 1) {
    const v = VOICES[sound];
    if (v) v(ctx, out, when, Math.pow(2, semitones / 12), decay);
  };
})();
