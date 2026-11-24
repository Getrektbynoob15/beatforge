/* pitch.js: pitch tools for the audio editor (all original code).
 *   BF.pitch.track(buffer)            pitch over time (YIN), one value per hop, 0 = no clear pitch (noise, silence)
 *   BF.pitch.correct(buffer, opts)    pitch correction for vocals: pull every sung note to the nearest note of a scale
 *                                     (PSOLA: moves pitch, keeps length and the voice's character)
 *   BF.pitch.shift(buffer, semitones) shift anything (drums, loops) up/down, same length (time stretch + resample)
 *   BF.pitch.noteName(hz)             'C#4 +12 ct' */
(function () {
  'use strict';
  const BF = window.BF;
  const P = (BF.pitch = {});
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  P.SCALES = { chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], 'harmonic minor': [0, 2, 3, 5, 7, 8, 11], pentatonic: [0, 2, 4, 7, 9], 'minor pentatonic': [0, 3, 5, 7, 10] };
  P.NAMES = NAMES;
  const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);
  P.noteName = (hz) => {
    if (!(hz > 0)) return '?';
    const m = midiOf(hz), r = Math.round(m), ct = Math.round((m - r) * 100);
    return `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}${ct ? ` ${ct > 0 ? '+' : ''}${ct} ct` : ''}`;
  };
  P.midiOf = midiOf;

  function mono(b, a = 0, z = b.length) {
    const out = new Float32Array(z - a);
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = a; i < z; i++) out[i - a] += d[i] / b.numberOfChannels; }
    return out;
  }

  /** YIN pitch tracking. Returns { hop, f0: Float32Array (Hz, 0 = unvoiced), rate }. Range 70..1000 Hz. */
  P.track = function (b, a = 0, z = b.length) {
    const rate = b.sampleRate, x = mono(b, a, z);
    const maxT = Math.ceil(rate / 70), minT = Math.floor(rate / 1000), W = maxT; // integration window
    const hop = Math.round(rate * 0.01);
    const frames = Math.max(0, Math.floor((x.length - W - maxT) / hop) + 1);
    const f0 = new Float32Array(Math.max(1, frames));
    const d = new Float32Array(maxT + 1);
    for (let f = 0; f < frames; f++) {
      const s = f * hop;
      let energy = 0;
      for (let i = 0; i < W; i++) energy += x[s + i] * x[s + i];
      if (energy / W < 1e-6) { f0[f] = 0; continue; } // silence
      d[0] = 1;
      let run = 0, found = -1;
      for (let t = 1; t <= maxT; t++) {
        let sum = 0;
        for (let i = 0; i < W; i++) { const v = x[s + i] - x[s + i + t]; sum += v * v; }
        run += sum;
        d[t] = run > 0 ? (sum * t) / run : 1; // cumulative mean normalised difference
        if (t > minT + 1 && found < 0 && d[t - 1] < 0.12 && d[t - 1] <= d[t]) found = t - 1;
      }
      if (found < 0) { f0[f] = 0; continue; }
      const t = found, y0 = d[t - 1], y1 = d[t], y2 = d[t + 1];
      const den = y0 - 2 * y1 + y2;
      const tt = den ? t + (y0 - y2) / (2 * den) : t; // parabolic interpolation
      f0[f] = rate / tt;
    }
    // drop single-frame blips (octave errors): a voiced frame needs a voiced neighbour within a semitone or so
    for (let f = 1; f < frames - 1; f++) if (f0[f] && !(f0[f - 1] && Math.abs(midiOf(f0[f - 1]) - midiOf(f0[f])) < 1.5) && !(f0[f + 1] && Math.abs(midiOf(f0[f + 1]) - midiOf(f0[f])) < 1.5)) f0[f] = 0;
    return { hop, f0, rate, offset: Math.round(W / 2) };
  };

  /** The most common pitch of a sound (for "Detect note"). */
  P.mainPitch = function (b, a, z) {
    const tr = P.track(b, a, z);
    const v = [...tr.f0].filter((x) => x > 0).map(midiOf).sort((p, q) => p - q);
    if (v.length < 3) return 0;
    return 440 * Math.pow(2, (v[Math.floor(v.length / 2)] - 69) / 12); // median
  };

  /** TD-PSOLA on one channel. f0At(i) -> Hz (0 = unvoiced), ratioAt(i) -> pitch factor at input sample i. */
  function psola(x, rate, f0At, ratioAt) {
    const n = x.length, out = new Float32Array(n), wsum = new Float32Array(n);
    const UNV = Math.round(rate * 0.006);
    // analysis marks, one per period in voiced parts
    const marks = [], periods = [];
    for (let i = 0; i < n;) { const f = f0At(i); const per = f > 0 ? Math.max(20, Math.round(rate / f)) : UNV; marks.push(i); periods.push(f > 0 ? per : 0); i += per; }
    let k = 0, tf = 0; // tf: exact (fractional) synthesis position, so the new period is not rounded off
    for (let t = 0; t < n;) {
      while (k + 1 < marks.length && Math.abs(marks[k + 1] - t) <= Math.abs(marks[k] - t)) k++; // nearest analysis mark (keeps timing)
      const per = periods[k] || UNV, voiced = periods[k] > 0;
      const r = voiced ? Math.max(0.25, Math.min(4, ratioAt(t))) : 1;
      const half = per, c = marks[k];
      for (let j = -half; j < half; j++) {
        const si = c + j, di = t + j;
        if (si < 0 || si >= n || di < 0 || di >= n) continue;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * j) / half);
        out[di] += x[si] * w; wsum[di] += w;
      }
      tf += Math.max(1, per / r);
      t = Math.round(tf);
    }
    for (let i = 0; i < n; i++) out[i] = wsum[i] > 0.05 ? out[i] / wsum[i] : out[i];
    return out;
  }

  /** Pitch correction. opts: { root 0..11, scale name, strength 0..1, speed 0 (instant, robotic) .. 1 (slow, natural) } */
  P.correct = function (b, a = 0, z = b.length, opts = {}) {
    const rate = b.sampleRate;
    const tr = P.track(b, a, z);
    const scale = P.SCALES[opts.scale] || P.SCALES.chromatic, root = opts.root || 0;
    const strength = opts.strength ?? 1, speed = opts.speed ?? 0.1;
    const nearest = (m) => { let best = m, bd = 99; for (let o = -1; o <= 1; o++) scale.forEach((s) => { const c = Math.round((m - root - s) / 12) * 12 + root + s + o * 12; if (Math.abs(c - m) < bd) { bd = Math.abs(c - m); best = c; } }); return best; };
    // per hop: how many semitones to move, smoothed by the retune speed
    const shift = new Float32Array(tr.f0.length);
    const tc = Math.max(0.0001, speed * 0.25); // seconds
    const alpha = 1 - Math.exp(-(tr.hop / rate) / tc);
    let cur = 0;
    for (let f = 0; f < tr.f0.length; f++) {
      const hz = tr.f0[f];
      if (!hz) { cur *= 1 - alpha; shift[f] = 0; continue; }
      const m = midiOf(hz), want = (nearest(m) - m) * strength;
      cur += (want - cur) * alpha;
      shift[f] = cur;
    }
    const frameOf = (i) => Math.max(0, Math.min(tr.f0.length - 1, Math.round((i - tr.offset) / tr.hop)));
    const f0At = (i) => tr.f0[frameOf(i)];
    const ratioAt = (i) => Math.pow(2, shift[frameOf(i)] / 12);
    const out = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: rate });
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c), o = out.getChannelData(c);
      o.set(d);
      const part = psola(d.subarray(a, z), rate, f0At, ratioAt);
      // short crossfades at the edges of the selection
      const xf = Math.min(256, part.length >> 2);
      for (let i = 0; i < part.length; i++) {
        const w = i < xf ? i / xf : i > part.length - xf ? (part.length - i) / xf : 1;
        o[a + i] = part[i] * w + d[a + i] * (1 - w);
      }
    }
    const voiced = [...tr.f0].filter((x) => x > 0).length;
    return { buffer: out, voiced: voiced / Math.max(1, tr.f0.length), moved: [...shift].reduce((s, v) => s + Math.abs(v), 0) / Math.max(1, voiced) };
  };

  /** Shift pitch by `semis`, same length: stretch to 1/r of the speed (pitch kept), then resample by r. */
  P.shift = function (b, semis, a = 0, z = b.length) {
    const r = Math.pow(2, semis / 12), rate = b.sampleRate;
    const part = new AudioBuffer({ length: z - a, numberOfChannels: b.numberOfChannels, sampleRate: rate });
    for (let c = 0; c < b.numberOfChannels; c++) part.getChannelData(c).set(b.getChannelData(c).subarray(a, z));
    const st = BF.timeStretch(part, 1 / r); // longer by r, same pitch
    const out = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: rate });
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c), s = st.getChannelData(c), o = out.getChannelData(c);
      o.set(d);
      for (let i = 0; i < z - a; i++) { const p = i * r, j = Math.floor(p), f = p - j; o[a + i] = j + 1 < s.length ? s[j] * (1 - f) + s[j + 1] * f : 0; }
    }
    return out;
  };
})();
