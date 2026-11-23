/* registry.js: BeatForge's own plugin format.
 * An instrument is stateless: play(ctx, out, params, time, key, vel, dur) books one note.
 * An effect is a node chain: create(ctx) -> { input, output, set(params, bpm), dispose() }.
 * Every plugin lists its parameters, so the editor UI and project validation are generic. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});
  const defs = new Map();

  const R = (BF.plugins = {
    register(def) { defs.set(def.id, def); },
    get: (id) => defs.get(id),
    has: (id) => defs.has(id),
    list: (kind) => [...defs.values()].filter((d) => d.kind === kind && !d.missing),

    /** Parameter values for a new instance. `preset` = preset name or an object of overrides. */
    defaults(id, preset) {
      const d = defs.get(id);
      const out = {};
      d.params.forEach((p) => { out[p.id] = p.default; });
      const over = typeof preset === 'string' ? (d.presets || {})[preset] : preset;
      if (over) Object.assign(out, over);
      return out;
    },

    /** Clamp/repair loaded parameter values against the plugin's parameter list. */
    sanitize(id, params, samples = {}) {
      const d = defs.get(id);
      const src = params && typeof params === 'object' ? params : {};
      const out = {};
      if (d.missing) { // a community plugin that is not installed: keep its settings as they are
        Object.keys(src).slice(0, 32).forEach((k) => { const v = src[k]; if (/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = v; });
        return out;
      }
      d.params.forEach((p) => {
        const v = src[p.id];
        if (p.type === 'select') out[p.id] = p.options.some((o) => o[0] === v) ? v : p.default;
        else if (p.type === 'toggle') out[p.id] = typeof v === 'boolean' ? v : p.default;
        else if (p.type === 'sample') out[p.id] = typeof v === 'string' && samples[v] ? v : null;
        else out[p.id] = BF.clamp(v, p.min, p.max, p.default);
      });
      return out;
    },

    /** Human-readable value for a knob. */
    format(p, v) {
      if (p.type === 'select') return (p.options.find((o) => o[0] === v) || [v, String(v)])[1];
      if (p.type === 'toggle') return v ? 'On' : 'Off';
      if (p.fmt) return p.fmt(v);
      const n = Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
      return `${n}${p.unit || ''}`;
    },
  });

  // shared helpers for plugin authors
  R.util = {
    semis: (s) => Math.pow(2, s / 12),
    midiHz: (m) => 440 * Math.pow(2, (m - 69) / 12),
    dbToGain: (db) => Math.pow(10, db / 20),
    pct: (v) => `${Math.round(v * 100)}%`,
    hz: (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`),
    sec: (v) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`),
    db: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
    /** ADSR on an AudioParam: attack to peak, decay to sustain, hold until noteEnd, release to 0. Returns the stop time. */
    adsr(param, t, dur, peak, a, d, s, r) {
      const end = t + Math.max(dur, 0.005);
      let held;
      param.setValueAtTime(0, t);
      if (end <= t + a) {
        held = (peak * (end - t)) / a;
        param.linearRampToValueAtTime(held, end);
      } else {
        const tau = Math.max(0.002, d / 4);
        param.linearRampToValueAtTime(peak, t + a);
        param.setTargetAtTime(peak * s, t + a, tau);
        held = peak * (s + (1 - s) * Math.exp(-(end - t - a) / tau));
        param.setValueAtTime(held, end);
      }
      param.exponentialRampToValueAtTime(Math.min(0.0008, Math.max(held, 1e-5)), end + r);
      param.linearRampToValueAtTime(0, end + r + 0.005);
      return end + r + 0.01;
    },
  };
})();
