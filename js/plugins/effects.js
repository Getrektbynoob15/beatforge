/* effects.js: built-in effect plugins (all original).
 * create(ctx) -> { input, output, set(params, bpm), dispose() }. set() may be called often (knob drags). */
(function () {
  'use strict';
  const BF = window.BF;
  const U = BF.plugins.util;
  const MIX = { id: 'mix', name: 'Mix', type: 'knob', min: 0, max: 1, default: 1, fmt: U.pct };

  /** in -> [dry, wet chain] -> out, with a mix control */
  function dryWet(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    input.connect(dry).connect(output);
    wet.connect(output);
    return { input, output, dry, wet, mix(v) { smooth(ctx, dry.gain, Math.cos(v * Math.PI / 2)); smooth(ctx, wet.gain, Math.sin(v * Math.PI / 2)); } };
  }
  function smooth(ctx, param, v) {
    if (ctx instanceof OfflineAudioContext) { param.value = v; return; }
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(v, ctx.currentTime, 0.012);
  }
  const off = (...nodes) => nodes.forEach((n) => { try { n.disconnect(); } catch { /* gone */ } });
  const SYNC = [['0.0625', '1/16'], ['0.125', '1/8'], ['0.1875', '1/8 dotted'], ['0.1667', '1/8 triplet'], ['0.25', '1/4'], ['0.375', '1/4 dotted'], ['0.5', '1/2'], ['1', '1 bar']];

  BF.plugins.register({
    id: 'eq', name: 'Forge EQ', kind: 'effect',
    params: [
      { id: 'low', name: 'Low', type: 'knob', min: -18, max: 18, default: 0, fmt: U.db },
      { id: 'lowF', name: 'Low freq', type: 'knob', min: 30, max: 600, default: 120, curve: 'log', fmt: U.hz },
      { id: 'mid', name: 'Mid', type: 'knob', min: -18, max: 18, default: 0, fmt: U.db },
      { id: 'midF', name: 'Mid freq', type: 'knob', min: 150, max: 9000, default: 1200, curve: 'log', fmt: U.hz },
      { id: 'midQ', name: 'Mid width', type: 'knob', min: 0.2, max: 8, default: 1, curve: 'log' },
      { id: 'high', name: 'High', type: 'knob', min: -18, max: 18, default: 0, fmt: U.db },
      { id: 'highF', name: 'High freq', type: 'knob', min: 1500, max: 18000, default: 7000, curve: 'log', fmt: U.hz },
      { id: 'cut', name: 'Low cut', type: 'knob', min: 10, max: 1000, default: 10, curve: 'log', fmt: (v) => (v <= 11 ? 'Off' : U.hz(v)) },
    ],
    create(ctx) {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf';
      const mi = ctx.createBiquadFilter(); mi.type = 'peaking';
      const hi = ctx.createBiquadFilter(); hi.type = 'highshelf';
      hp.connect(lo).connect(mi).connect(hi);
      return {
        input: hp, output: hi,
        set(p) {
          smooth(ctx, hp.frequency, p.cut <= 11 ? 5 : p.cut);
          smooth(ctx, lo.gain, p.low); smooth(ctx, lo.frequency, p.lowF);
          smooth(ctx, mi.gain, p.mid); smooth(ctx, mi.frequency, p.midF); smooth(ctx, mi.Q, p.midQ);
          smooth(ctx, hi.gain, p.high); smooth(ctx, hi.frequency, p.highF);
        },
        dispose() { off(hp, lo, mi, hi); },
      };
    },
  });

  BF.plugins.register({
    id: 'filter', name: 'Forge Filter', kind: 'effect',
    params: [
      { id: 'type', name: 'Type', type: 'select', default: 'lowpass', options: [['lowpass', 'Low pass'], ['highpass', 'High pass'], ['bandpass', 'Band pass'], ['notch', 'Notch']] },
      { id: 'freq', name: 'Cutoff', type: 'knob', min: 20, max: 20000, default: 20000, curve: 'log', fmt: U.hz },
      { id: 'q', name: 'Resonance', type: 'knob', min: 0.1, max: 20, default: 0.7, curve: 'log' },
      { id: 'lfo', name: 'LFO depth', type: 'knob', min: 0, max: 1, default: 0, fmt: U.pct },
      { id: 'rate', name: 'LFO rate', type: 'select', default: '0.25', options: SYNC },
      MIX,
    ],
    create(ctx) {
      const dw = dryWet(ctx);
      const f = ctx.createBiquadFilter();
      const lfo = ctx.createOscillator(); const depth = ctx.createGain();
      lfo.type = 'sine'; lfo.connect(depth).connect(f.detune); lfo.start();
      dw.input.connect(f).connect(dw.wet);
      return {
        input: dw.input, output: dw.output,
        set(p, bpm) {
          f.type = p.type; smooth(ctx, f.frequency, p.freq); smooth(ctx, f.Q, p.q);
          smooth(ctx, depth.gain, p.lfo * 2400);
          smooth(ctx, lfo.frequency, 1 / ((parseFloat(p.rate) * 4 * 60) / bpm));
          dw.mix(p.mix);
        },
        dispose() { try { lfo.stop(); } catch { /* */ } off(dw.input, dw.output, dw.dry, dw.wet, f, lfo, depth); },
      };
    },
  });

  BF.plugins.register({
    id: 'delay', name: 'Echo Delay', kind: 'effect',
    params: [
      { id: 'time', name: 'Time', type: 'select', default: '0.1875', options: SYNC },
      { id: 'feedback', name: 'Feedback', type: 'knob', min: 0, max: 0.92, default: 0.4, fmt: U.pct },
      { id: 'tone', name: 'Tone', type: 'knob', min: 500, max: 18000, default: 6000, curve: 'log', fmt: U.hz },
      { id: 'pingpong', name: 'Ping-pong', type: 'toggle', default: true },
      { id: 'mix', name: 'Mix', type: 'knob', min: 0, max: 1, default: 0.3, fmt: U.pct },
    ],
    create(ctx) {
      const dw = dryWet(ctx);
      const dl = ctx.createDelay(4), dr = ctx.createDelay(4);
      const fbL = ctx.createGain(), fbR = ctx.createGain(), tone = ctx.createBiquadFilter();
      const merger = ctx.createChannelMerger(2), panL = ctx.createStereoPanner(), panR = ctx.createStereoPanner();
      tone.type = 'lowpass';
      dw.input.connect(tone).connect(dl);
      dl.connect(fbL); dr.connect(fbR);
      // ping-pong: L feeds R, R feeds L; plain: each feeds itself
      let ping = null;
      const wire = (pp) => {
        if (ping === pp) return;
        off(fbL, fbR);
        if (pp) { fbL.connect(dr); fbR.connect(dl); } else { fbL.connect(dl); fbR.connect(dr); }
        ping = pp;
      };
      dl.connect(panL).connect(dw.wet); dr.connect(panR).connect(dw.wet);
      void merger;
      return {
        input: dw.input, output: dw.output,
        set(p, bpm) {
          const sec = (parseFloat(p.time) * 4 * 60) / bpm;
          smooth(ctx, dl.delayTime, Math.min(4, sec)); smooth(ctx, dr.delayTime, Math.min(4, sec));
          smooth(ctx, fbL.gain, p.feedback); smooth(ctx, fbR.gain, p.feedback);
          smooth(ctx, tone.frequency, p.tone);
          wire(p.pingpong);
          panL.pan.value = p.pingpong ? -0.8 : 0; panR.pan.value = p.pingpong ? 0.8 : 0;
          dw.mix(p.mix);
        },
        dispose() { off(dw.input, dw.output, dw.dry, dw.wet, dl, dr, fbL, fbR, tone, panL, panR); },
      };
    },
  });

  // Impulse responses are generated (decaying stereo noise), cached by size/decay/rate.
  const irCache = new Map();
  function impulse(ctx, size, decay) {
    const key = `${ctx.sampleRate}:${size.toFixed(2)}:${decay.toFixed(1)}`;
    if (irCache.has(key)) return irCache.get(key);
    const n = Math.floor(ctx.sampleRate * size);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    let seed = 777;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const fadeIn = Math.min(1, i / (ctx.sampleRate * 0.004));
        d[i] = (seed / 2147483648 - 1) * Math.pow(1 - i / n, decay) * fadeIn;
      }
    }
    irCache.set(key, b);
    return b;
  }

  BF.plugins.register({
    id: 'reverb', name: 'Room Reverb', kind: 'effect',
    params: [
      { id: 'size', name: 'Size', type: 'knob', min: 0.2, max: 8, default: 2.2, curve: 'log', fmt: U.sec },
      { id: 'decay', name: 'Decay shape', type: 'knob', min: 1, max: 8, default: 3 },
      { id: 'predelay', name: 'Pre-delay', type: 'knob', min: 0, max: 0.2, default: 0.02, fmt: U.sec },
      { id: 'lowcut', name: 'Low cut', type: 'knob', min: 20, max: 1000, default: 200, curve: 'log', fmt: U.hz },
      { id: 'highcut', name: 'High cut', type: 'knob', min: 1000, max: 20000, default: 9000, curve: 'log', fmt: U.hz },
      { id: 'mix', name: 'Mix', type: 'knob', min: 0, max: 1, default: 0.25, fmt: U.pct },
    ],
    create(ctx) {
      const dw = dryWet(ctx);
      const pre = ctx.createDelay(0.5), conv = ctx.createConvolver(), hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
      hp.type = 'highpass'; lp.type = 'lowpass';
      dw.input.connect(pre).connect(hp).connect(lp).connect(conv).connect(dw.wet);
      let irKey = '', timer = null;
      return {
        input: dw.input, output: dw.output,
        set(p) {
          smooth(ctx, pre.delayTime, p.predelay); smooth(ctx, hp.frequency, p.lowcut); smooth(ctx, lp.frequency, p.highcut);
          dw.mix(p.mix);
          const k = `${p.size.toFixed(2)}:${p.decay.toFixed(1)}`;
          if (k !== irKey) {
            irKey = k;
            const apply = () => { conv.buffer = impulse(ctx, p.size, p.decay); };
            // building a long impulse takes a moment; wait until the knob stops moving (live only)
            if (ctx instanceof OfflineAudioContext || !conv.buffer) apply();
            else { clearTimeout(timer); timer = setTimeout(apply, 150); }
          }
        },
        dispose() { clearTimeout(timer); off(dw.input, dw.output, dw.dry, dw.wet, pre, conv, hp, lp); },
      };
    },
  });

  BF.plugins.register({
    id: 'compressor', name: 'Compressor', kind: 'effect',
    params: [
      { id: 'threshold', name: 'Threshold', type: 'knob', min: -60, max: 0, default: -18, fmt: U.db },
      { id: 'ratio', name: 'Ratio', type: 'knob', min: 1, max: 20, default: 4, curve: 'log', fmt: (v) => `${v.toFixed(1)}:1` },
      { id: 'attack', name: 'Attack', type: 'knob', min: 0.0005, max: 0.3, default: 0.01, curve: 'log', fmt: U.sec },
      { id: 'release', name: 'Release', type: 'knob', min: 0.02, max: 1.5, default: 0.2, curve: 'log', fmt: U.sec },
      { id: 'knee', name: 'Knee', type: 'knob', min: 0, max: 30, default: 6, fmt: U.db },
      { id: 'makeup', name: 'Makeup', type: 'knob', min: 0, max: 24, default: 4, fmt: U.db },
    ],
    create(ctx) {
      const c = ctx.createDynamicsCompressor(), g = ctx.createGain();
      c.connect(g);
      return {
        input: c, output: g, node: c,
        set(p) {
          c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.attack.value = p.attack; c.release.value = p.release; c.knee.value = p.knee;
          smooth(ctx, g.gain, U.dbToGain(p.makeup));
        },
        dispose() { off(c, g); },
      };
    },
  });

  BF.plugins.register({
    id: 'distortion', name: 'Drive', kind: 'effect',
    params: [
      { id: 'drive', name: 'Drive', type: 'knob', min: 0, max: 1, default: 0.35, fmt: U.pct },
      { id: 'shape', name: 'Shape', type: 'select', default: 'soft', options: [['soft', 'Soft clip'], ['hard', 'Hard clip'], ['fold', 'Wave fold'], ['bit', 'Bit crush']] },
      { id: 'tone', name: 'Tone', type: 'knob', min: 500, max: 20000, default: 9000, curve: 'log', fmt: U.hz },
      { id: 'output', name: 'Output', type: 'knob', min: -24, max: 6, default: -4, fmt: U.db },
      MIX,
    ],
    create(ctx) {
      const dw = dryWet(ctx);
      const pre = ctx.createGain(), sh = ctx.createWaveShaper(), lp = ctx.createBiquadFilter(), outG = ctx.createGain();
      sh.oversample = '4x'; lp.type = 'lowpass';
      dw.input.connect(pre).connect(sh).connect(lp).connect(outG).connect(dw.wet);
      let key = '';
      return {
        input: dw.input, output: dw.output,
        set(p) {
          const k = `${p.shape}:${p.drive.toFixed(3)}`;
          if (k !== key) {
            key = k;
            const n = 2048, c = new Float32Array(n), d = 1 + p.drive * 40;
            for (let i = 0; i < n; i++) {
              const x = (i / (n - 1)) * 2 - 1;
              let y;
              if (p.shape === 'hard') y = Math.max(-1, Math.min(1, x * d));
              else if (p.shape === 'fold') y = Math.sin(x * d * 1.2);
              else if (p.shape === 'bit') { const steps = Math.max(2, Math.round(64 - p.drive * 60)); y = Math.round(x * steps) / steps; }
              else y = Math.tanh(x * d) / Math.tanh(d);
              c[i] = y;
            }
            sh.curve = c;
          }
          smooth(ctx, lp.frequency, p.tone); smooth(ctx, outG.gain, U.dbToGain(p.output));
          dw.mix(p.mix);
        },
        dispose() { off(dw.input, dw.output, dw.dry, dw.wet, pre, sh, lp, outG); },
      };
    },
  });

  BF.plugins.register({
    id: 'chorus', name: 'Chorus', kind: 'effect',
    params: [
      { id: 'rate', name: 'Rate', type: 'knob', min: 0.05, max: 8, default: 0.8, curve: 'log', unit: ' Hz' },
      { id: 'depth', name: 'Depth', type: 'knob', min: 0, max: 1, default: 0.5, fmt: U.pct },
      { id: 'delay', name: 'Delay', type: 'knob', min: 0.005, max: 0.04, default: 0.015, fmt: U.sec },
      { id: 'mix', name: 'Mix', type: 'knob', min: 0, max: 1, default: 0.5, fmt: U.pct },
    ],
    create(ctx) {
      const dw = dryWet(ctx);
      const nodes = [];
      const voices = [-1, 1].map((side, i) => {
        const d = ctx.createDelay(0.1), lfo = ctx.createOscillator(), amt = ctx.createGain(), pan = ctx.createStereoPanner();
        lfo.type = 'sine'; pan.pan.value = side * 0.7;
        lfo.connect(amt).connect(d.delayTime); lfo.start(ctx.currentTime + i * 0.13);
        dw.input.connect(d).connect(pan).connect(dw.wet);
        nodes.push(d, lfo, amt, pan);
        return { d, lfo, amt };
      });
      return {
        input: dw.input, output: dw.output,
        set(p) {
          voices.forEach((v, i) => { smooth(ctx, v.d.delayTime, p.delay); smooth(ctx, v.lfo.frequency, p.rate * (i ? 1.1 : 1)); smooth(ctx, v.amt.gain, p.depth * p.delay * 0.9); });
          dw.mix(p.mix);
        },
        dispose() { voices.forEach((v) => { try { v.lfo.stop(); } catch { /* */ } }); off(dw.input, dw.output, dw.dry, dw.wet, ...nodes); },
      };
    },
  });

  BF.plugins.register({
    id: 'limiter', name: 'Limiter', kind: 'effect',
    params: [
      { id: 'gain', name: 'Input gain', type: 'knob', min: 0, max: 18, default: 0, fmt: U.db },
      { id: 'ceiling', name: 'Ceiling', type: 'knob', min: -12, max: 0, default: -0.5, fmt: U.db },
      { id: 'release', name: 'Release', type: 'knob', min: 0.01, max: 1, default: 0.08, curve: 'log', fmt: U.sec },
    ],
    create(ctx) {
      const inG = ctx.createGain(), c = ctx.createDynamicsCompressor(), outG = ctx.createGain();
      c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001;
      inG.connect(c).connect(outG);
      return {
        input: inG, output: outG, node: c,
        set(p) {
          smooth(ctx, inG.gain, U.dbToGain(p.gain));
          c.threshold.value = p.ceiling - 1; c.release.value = p.release;
          smooth(ctx, outG.gain, U.dbToGain(0.8));
        },
        dispose() { off(inG, c, outG); },
      };
    },
  });

  BF.plugins.register({
    id: 'utility', name: 'Utility', kind: 'effect',
    params: [
      { id: 'gain', name: 'Gain', type: 'knob', min: -36, max: 12, default: 0, fmt: U.db },
      { id: 'pan', name: 'Pan', type: 'knob', min: -1, max: 1, default: 0, fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) },
      { id: 'phase', name: 'Invert phase', type: 'toggle', default: false },
    ],
    create(ctx) {
      const g = ctx.createGain(), pan = ctx.createStereoPanner();
      g.connect(pan);
      return {
        input: g, output: pan,
        set(p) { smooth(ctx, g.gain, U.dbToGain(p.gain) * (p.phase ? -1 : 1)); smooth(ctx, pan.pan, p.pan); },
        dispose() { off(g, pan); },
      };
    },
  });
})();
