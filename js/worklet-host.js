/* worklet-host.js: everything BeatForge runs on the audio thread (AudioWorklet).
 * This one file works two ways:
 *  - loaded as a normal <script>, it only stores its own code in BF.WORKLET_SRC (the desktop app and file:// load
 *    that from a blob URL);
 *  - loaded with audioWorklet.addModule(url) (the website, where the security policy forbids blob scripts),
 *    it registers the processors.
 * Processors: bf-envelope (sidechain ducker), bf-comp (multiband compressor), bf-recorder (audio input capture), and the community plugin host
 * (__bfDefine), which runs approved plugins: their code only ever sees numbers in and numbers out. */
(function () {
  function audioThread() {
    'use strict';
    if (globalThis.__bfHostReady) return;
    globalThis.__bfHostReady = true;

    // ---------- sidechain envelope follower ----------
    class BfEnvelope extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return [
          { name: 'attack', defaultValue: 0.002, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
          { name: 'release', defaultValue: 0.18, minValue: 0.005, maxValue: 3, automationRate: 'k-rate' },
          { name: 'sens', defaultValue: 4, minValue: 0, maxValue: 50, automationRate: 'k-rate' },
          { name: 'amount', defaultValue: 0.75, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        ];
      }
      constructor() { super(); this.env = 0; }
      process(inputs, outputs, p) {
        const out = outputs[0][0]; const inp = inputs[0];
        const a = Math.exp(-1 / (p.attack[0] * sampleRate)), r = Math.exp(-1 / (p.release[0] * sampleRate));
        const sens = p.sens[0], amount = p.amount[0];
        let env = this.env;
        for (let i = 0; i < out.length; i++) {
          let x = 0;
          for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > x) x = v; }
          env = x > env ? a * env + (1 - a) * x : r * env + (1 - r) * x;
          out[i] = -Math.min(1, env * sens) * amount;
        }
        this.env = env;
        return true;
      }
    }
    registerProcessor('bf-envelope', BfEnvelope);

    // ---------- compressor gain computer (Multiband Compressor): input = signal, output = linear gain ----------
    // soft-knee, peak detection, no automatic makeup gain (the plugin's own gain knobs set the level)
    class BfComp extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return [
          { name: 'threshold', defaultValue: -18, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
          { name: 'ratio', defaultValue: 3, minValue: 1, maxValue: 50, automationRate: 'k-rate' },
          { name: 'attack', defaultValue: 0.01, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
          { name: 'release', defaultValue: 0.2, minValue: 0.005, maxValue: 3, automationRate: 'k-rate' },
          { name: 'knee', defaultValue: 6, minValue: 0, maxValue: 30, automationRate: 'k-rate' },
        ];
      }
      constructor() { super(); this.gr = 0; }
      process(inputs, outputs, p) {
        const out = outputs[0][0]; const inp = inputs[0];
        const T = p.threshold[0], R = p.ratio[0], W = p.knee[0];
        const a = Math.exp(-1 / (p.attack[0] * sampleRate)), r = Math.exp(-1 / (p.release[0] * sampleRate));
        let gr = this.gr;
        for (let i = 0; i < out.length; i++) {
          let x = 0;
          for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > x) x = v; }
          const xd = x > 1e-6 ? 20 * Math.log10(x) : -120, o = xd - T;
          let want = 0; // gain change in dB (<= 0)
          if (2 * o > W) want = o / R - o;
          else if (W > 0 && 2 * o > -W) { const k = o + W / 2; want = (1 / R - 1) * k * k / (2 * W); }
          gr = want < gr ? a * gr + (1 - a) * want : r * gr + (1 - r) * want;
          out[i] = Math.pow(10, gr / 20);
        }
        this.gr = gr;
        return true;
      }
    }
    registerProcessor('bf-comp', BfComp);

    // ---------- audio input capture ----------
    class BfRecorder extends AudioWorkletProcessor {
      constructor() { super(); this.on = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; }; }
      process(inputs) {
        const inp = inputs[0];
        if (this.on && inp && inp.length) this.port.postMessage(inp.map((c) => c.slice(0)));
        return this.on;
      }
    }
    registerProcessor('bf-recorder', BfRecorder);

    // ---------- community plugin host ----------
    const MAX_VOICES = 48;
    const MAX_RELEASE_S = 30;
    const errText = (e) => String((e && e.message) || e).slice(0, 300);
    // keep the speakers (and ears) safe from a buggy plugin: no NaN/Infinity, nothing louder than +12 dB
    function guard(buf) {
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        if (!(v > -4 && v < 4)) buf[i] = v !== v ? 0 : v > 0 ? 4 : -4; // eslint-disable-line no-self-compare
      }
    }
    const scratch = (n, o) => (o && o.length === n ? o : new Float32Array(n));

    const define = function (key, kind, params, factory) {
      const name = `bfp-${kind === 'effect' ? 'fx' : 'in'}:${key}`;
      let def = null, loadError = null;
      const api = Object.freeze({
        sampleRate,
        effect(d) { if (kind === 'effect' && !def && d && typeof d.process === 'function') def = d; },
        instrument(d) { if (kind === 'instrument' && !def && d && typeof d.voice === 'function' && typeof d.process === 'function') def = d; },
        midiToHz: (m) => 440 * Math.pow(2, (m - 69) / 12),
        dbToGain: (db) => Math.pow(10, db / 20),
      });
      try { factory(api); } catch (e) { loadError = errText(e); }
      if (!def && !loadError) loadError = `The plugin never called BeatForge.${kind}({ ... }).`;
      const descriptors = params.map((p) => ({
        name: `p_${p.id}`, defaultValue: p.default, automationRate: 'k-rate',
        minValue: p.options ? 0 : p.min, maxValue: p.options ? p.options.length - 1 : p.max,
      }));
      const readParams = (parameters, into) => {
        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          const v = parameters[`p_${p.id}`][0];
          into[p.id] = p.options ? Math.round(v) : p.step ? Math.round((v - p.min) / p.step) * p.step + p.min : v;
        }
        return into;
      };

      if (kind === 'effect') {
        class Fx extends AudioWorkletProcessor {
          static get parameterDescriptors() { return descriptors; }
          constructor() {
            super();
            this.p = {};
            this.ok = !loadError;
            if (loadError) this.port.postMessage({ error: loadError });
            try { this.state = this.ok && def.create ? def.create({ sampleRate }) || {} : {}; } catch (e) { this.fail(e); }
          }
          fail(e) { if (this.ok) { this.ok = false; this.port.postMessage({ error: errText(e) }); } }
          process(inputs, outputs, parameters) {
            const out = outputs[0], inp = inputs[0] || [];
            const n = out[0].length;
            this.zero = scratch(n, this.zero);
            const L = inp[0] || this.zero, R = inp[1] || L;
            const oL = out[0], oR = out[1] || (this.oR = scratch(n, this.oR));
            if (this.ok) {
              try { def.process(this.state, [L, R], [oL, oR], readParams(parameters, this.p), n); } catch (e) { this.fail(e); }
            }
            if (!this.ok) { oL.set(L); oR.set(R); } // a crashed effect becomes a straight wire
            guard(oL); guard(oR);
            return true;
          }
        }
        registerProcessor(name, Fx);
        return;
      }

      class Instrument extends AudioWorkletProcessor {
        static get parameterDescriptors() { return descriptors; }
        constructor(options) {
          super();
          this.p = {};
          this.voices = [];
          this.queue = ((options && options.processorOptions && options.processorOptions.notes) || []).slice().sort((a, b) => a.t - b.t);
          this.offs = new Map();
          this.ok = !loadError;
          this.info = { released: false, time: 0, releaseTime: 0 };
          if (loadError) this.port.postMessage({ error: loadError });
          this.port.onmessage = (e) => {
            const m = e.data || {};
            if (m.type === 'note') {
              let i = this.queue.length;
              while (i > 0 && this.queue[i - 1].t > m.t) i--;
              this.queue.splice(i, 0, m);
            } else if (m.type === 'off') {
              const f = Math.round(m.t * sampleRate);
              this.voices.forEach((v) => { if (v.id === m.id && v.rel > f) v.rel = f; });
              this.offs.set(m.id, f);
            } else if (m.type === 'stop') {
              const f = Math.round(m.t * sampleRate);
              this.queue = this.queue.filter((q) => q.t * sampleRate < f);
              this.voices.forEach((v) => { if (v.rel > f) v.rel = f; });
            }
          };
        }
        fail(e) { if (this.ok) { this.ok = false; this.voices = []; this.port.postMessage({ error: errText(e) }); } }
        process(inputs, outputs, parameters) {
          const oL = outputs[0][0], oR = outputs[0][1] || (this.oR = scratch(oL.length, this.oR));
          const n = oL.length, t0 = currentFrame, t1 = t0 + n;
          if (!this.ok) return true;
          const params = readParams(parameters, this.p);
          while (this.queue.length && this.queue[0].t * sampleRate < t1) {
            const m = this.queue.shift();
            const start = Math.max(t0, Math.round(m.t * sampleRate));
            const rel = m.dur == null ? Infinity : Math.round((m.t + m.dur) * sampleRate);
            if (rel < t0 - sampleRate * 0.05) continue; // far too late: skip
            let s;
            try { s = def.voice({ sampleRate, key: m.key, freq: api.midiToHz(m.key), velocity: m.vel, params: Object.assign({}, params) }); } catch (e) { this.fail(e); return true; }
            if (this.voices.length >= MAX_VOICES) this.voices.shift();
            const off = this.offs.get(m.id);
            this.voices.push({ s, id: m.id, start, rel: off !== undefined ? Math.min(rel, off) : rel });
          }
          this.tL = scratch(n, this.tL); this.tR = scratch(n, this.tR);
          const info = this.info;
          for (let vi = 0; vi < this.voices.length; vi++) {
            const v = this.voices[vi];
            let from = Math.max(0, v.start - t0);
            while (from < n && !v.done) {
              const absFrom = t0 + from;
              const released = absFrom >= v.rel;
              const to = !released && v.rel < t1 ? v.rel - t0 : n;
              const len = to - from;
              const a = this.tL.subarray(0, len), b = this.tR.subarray(0, len);
              a.fill(0); b.fill(0);
              info.released = released;
              info.time = (absFrom - v.start) / sampleRate;
              info.releaseTime = released ? (absFrom - v.rel) / sampleRate : 0;
              let alive;
              try { alive = def.process(v.s, [a, b], params, len, info); } catch (e) { this.fail(e); return true; }
              for (let i = 0; i < len; i++) { oL[from + i] += a[i]; oR[from + i] += b[i]; }
              if (alive === false || info.releaseTime > MAX_RELEASE_S) v.done = true;
              from = to;
            }
          }
          if (this.voices.some((v) => v.done)) this.voices = this.voices.filter((v) => !v.done);
          if (this.offs.size > 512) this.offs.clear();
          guard(oL); guard(oR);
          return true;
        }
      }
      registerProcessor(name, Instrument);
    };
    // fixed in place, so one plugin cannot replace the host for the plugins loaded after it
    Object.defineProperty(globalThis, '__bfDefine', { value: define, writable: false, configurable: false });
  }

  if (typeof registerProcessor === 'function' && typeof window === 'undefined') audioThread();
  else {
    window.BF = window.BF || {};
    window.BF.WORKLET_SRC = `(${audioThread.toString()})();`;
  }
})();
