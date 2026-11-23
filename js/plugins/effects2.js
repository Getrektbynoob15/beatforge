/* effects2.js: more effect plugins (all original): Sidechain Ducker, Phaser, Flanger, Stereo Width, Volume Shaper.
 * The ducker listens to another mixer insert: audio.js connects that insert's output to `sidechainInput`. */
(function () {
  'use strict';
  const BF = window.BF;
  const U = BF.plugins.util;
  const off = (...nodes) => nodes.forEach((n) => { try { n.disconnect(); } catch { /* gone */ } });
  const isOff = (ctx) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
  function smooth(ctx, param, v) {
    if (isOff(ctx)) { param.value = v; return; }
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(v, ctx.currentTime, 0.012);
  }
  const SYNC = [['0.0625', '1/16'], ['0.125', '1/8'], ['0.25', '1/4'], ['0.5', '1/2'], ['1', '1 bar'], ['2', '2 bars']];
  const syncHz = (v, bpm) => 1 / ((parseFloat(v) * 4 * 60) / bpm);
  const SOURCES = [['0', 'Off'], ...Array.from({ length: 16 }, (_, i) => [String(i + 1), `Insert ${i + 1}`])];

  function dryWet(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    input.connect(dry).connect(output);
    wet.connect(output);
    return { input, output, dry, wet, mix(v) { smooth(ctx, dry.gain, Math.cos(v * Math.PI / 2)); smooth(ctx, wet.gain, Math.sin(v * Math.PI / 2)); } };
  }

  // ---------- Sidechain Ducker ----------
  // a peak envelope follower (AudioWorklet 'bf-envelope' in audio.js) drives the duck gain: 1 - clamp(env*sens)*amount
  BF.plugins.register({
    id: 'ducker', name: 'Sidechain Ducker', kind: 'effect',
    params: [
      { id: 'source', name: 'Listen to', type: 'select', default: '1', options: SOURCES },
      { id: 'amount', name: 'Amount', type: 'knob', min: 0, max: 1, default: 0.75, fmt: U.pct },
      { id: 'sens', name: 'Sensitivity', type: 'knob', min: 0.5, max: 12, default: 4, curve: 'log', fmt: (v) => `${v.toFixed(1)}×` },
      { id: 'release', name: 'Release', type: 'knob', min: 0.02, max: 0.8, default: 0.18, curve: 'log', fmt: U.sec },
    ],
    presets: { 'Kick pump (insert 1)': { source: '1', amount: 0.8, sens: 5, release: 0.2 }, 'Gentle duck': { amount: 0.45, sens: 3, release: 0.3 } },
    create(ctx) {
      const input = ctx.createGain(), duck = ctx.createGain(), output = ctx.createGain();
      input.connect(duck).connect(output);
      duck.gain.value = 1;
      const scIn = ctx.createGain();
      let env = null;
      if (ctx.__bfWorklets) {
        // proper peak envelope follower with fast attack / adjustable release (audio thread)
        env = new AudioWorkletNode(ctx, 'bf-envelope', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        scIn.connect(env).connect(duck.gain);
      }
      return {
        input, output, sidechainInput: scIn,
        sidechainSource: (p) => +p.source,
        set(p) {
          if (!env) return;
          const P = (n) => env.parameters.get(n);
          P('release').value = p.release; P('sens').value = p.sens; P('amount').value = +p.source ? p.amount : 0; P('attack').value = 0.002;
        },
        dispose() { off(input, duck, output, scIn, ...(env ? [env] : [])); },
      };
    },
  });

  // ---------- Phaser: 6 all-pass stages swept by an LFO, with feedback ----------
  BF.plugins.register({
    id: 'phaser', name: 'Phaser', kind: 'effect',
    params: [
      { id: 'rate', name: 'Rate', type: 'knob', min: 0.05, max: 8, default: 0.5, curve: 'log', unit: ' Hz' },
      { id: 'depth', name: 'Depth', type: 'knob', min: 0, max: 1, default: 0.7, fmt: U.pct },
      { id: 'freq', name: 'Centre', type: 'knob', min: 200, max: 4000, default: 900, curve: 'log', fmt: U.hz },
      { id: 'feedback', name: 'Feedback', type: 'knob', min: 0, max: 0.9, default: 0.5, fmt: U.pct },
      { id: 'mix', name: 'Mix', type: 'knob', min: 0, max: 1, default: 0.5, fmt: U.pct },
    ],
    create(ctx) {
      const dw = dryWet(ctx);
      const stages = Array.from({ length: 6 }, () => { const f = ctx.createBiquadFilter(); f.type = 'allpass'; f.Q.value = 0.6; return f; });
      const fb = ctx.createGain();
      const lfo = ctx.createOscillator(), lfoAmt = ctx.createGain();
      lfo.connect(lfoAmt); stages.forEach((s) => lfoAmt.connect(s.detune)); lfo.start();
      let node = dw.input;
      stages.forEach((s) => { node.connect(s); node = s; });
      node.connect(dw.wet); node.connect(fb).connect(stages[0]);
      return {
        input: dw.input, output: dw.output,
        set(p) {
          stages.forEach((s) => smooth(ctx, s.frequency, p.freq));
          smooth(ctx, lfo.frequency, p.rate); smooth(ctx, lfoAmt.gain, p.depth * 2400);
          smooth(ctx, fb.gain, p.feedback); dw.mix(p.mix);
        },
        dispose() { try { lfo.stop(); } catch { /* */ } off(dw.input, dw.output, dw.dry, dw.wet, fb, lfo, lfoAmt, ...stages); },
      };
    },
  });

  // ---------- Flanger: short modulated delay with feedback ----------
  BF.plugins.register({
    id: 'flanger', name: 'Flanger', kind: 'effect',
    params: [
      { id: 'rate', name: 'Rate', type: 'knob', min: 0.05, max: 5, default: 0.25, curve: 'log', unit: ' Hz' },
      { id: 'depth', name: 'Depth', type: 'knob', min: 0, max: 1, default: 0.6, fmt: U.pct },
      { id: 'delay', name: 'Delay', type: 'knob', min: 0.0005, max: 0.012, default: 0.003, curve: 'log', fmt: U.sec },
      { id: 'feedback', name: 'Feedback', type: 'knob', min: -0.9, max: 0.9, default: 0.5, fmt: U.pct },
      { id: 'mix', name: 'Mix', type: 'knob', min: 0, max: 1, default: 0.5, fmt: U.pct },
    ],
    create(ctx) {
      const dw = dryWet(ctx);
      const d = ctx.createDelay(0.05), fb = ctx.createGain(), lfo = ctx.createOscillator(), amt = ctx.createGain();
      lfo.connect(amt).connect(d.delayTime); lfo.start();
      dw.input.connect(d); d.connect(dw.wet); d.connect(fb).connect(d);
      return {
        input: dw.input, output: dw.output,
        set(p) {
          smooth(ctx, d.delayTime, p.delay); smooth(ctx, amt.gain, p.delay * p.depth * 0.95);
          smooth(ctx, lfo.frequency, p.rate); smooth(ctx, fb.gain, p.feedback); dw.mix(p.mix);
        },
        dispose() { try { lfo.stop(); } catch { /* */ } off(dw.input, dw.output, dw.dry, dw.wet, d, fb, lfo, amt); },
      };
    },
  });

  // ---------- Stereo Width: mid/side matrix ----------
  BF.plugins.register({
    id: 'width', name: 'Stereo Width', kind: 'effect',
    params: [
      { id: 'width', name: 'Width', type: 'knob', min: 0, max: 2, default: 1, fmt: (v) => (v < 0.01 ? 'Mono' : `${Math.round(v * 100)}%`) },
      { id: 'gain', name: 'Gain', type: 'knob', min: -12, max: 12, default: 0, fmt: U.db },
    ],
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      input.channelCountMode = 'explicit'; input.channelCount = 2;
      const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      // L' = a*L + b*R, R' = b*L + a*R  with a = (1+w)/2, b = (1-w)/2
      const ll = ctx.createGain(), lr = ctx.createGain(), rl = ctx.createGain(), rr = ctx.createGain();
      input.connect(split);
      split.connect(ll, 0); split.connect(lr, 0); split.connect(rl, 1); split.connect(rr, 1);
      ll.connect(merge, 0, 0); rl.connect(merge, 0, 0); lr.connect(merge, 0, 1); rr.connect(merge, 0, 1);
      merge.connect(output);
      return {
        input, output,
        set(p) {
          const a = (1 + p.width) / 2, b = (1 - p.width) / 2;
          smooth(ctx, ll.gain, a); smooth(ctx, rr.gain, a); smooth(ctx, lr.gain, b); smooth(ctx, rl.gain, b);
          smooth(ctx, output.gain, U.dbToGain(p.gain));
        },
        dispose() { off(input, output, split, merge, ll, lr, rl, rr); },
      };
    },
  });

  // ---------- Volume Shaper: tempo-synced volume LFO (pumping, tremolo, auto-pan) ----------
  BF.plugins.register({
    id: 'shaper', name: 'Volume Shaper', kind: 'effect',
    params: [
      { id: 'rate', name: 'Rate', type: 'select', default: '0.25', options: SYNC },
      { id: 'shape', name: 'Shape', type: 'select', default: 'pump', options: [['pump', 'Pump (duck)'], ['sine', 'Tremolo'], ['square', 'Gate'], ['pan', 'Auto-pan']] },
      { id: 'depth', name: 'Depth', type: 'knob', min: 0, max: 1, default: 0.7, fmt: U.pct },
    ],
    presets: { 'Quarter pump': { rate: '0.25', shape: 'pump', depth: 0.8 }, '1/8 trance gate': { rate: '0.125', shape: 'square', depth: 1 }, 'Slow auto-pan': { rate: '1', shape: 'pan', depth: 0.8 } },
    create(ctx) {
      const input = ctx.createGain(), vca = ctx.createGain(), pan = ctx.createStereoPanner(), output = ctx.createGain();
      input.connect(vca).connect(pan).connect(output);
      const lfo = ctx.createOscillator(), amt = ctx.createGain(), panAmt = ctx.createGain();
      lfo.connect(amt).connect(vca.gain); lfo.connect(panAmt).connect(pan.pan); lfo.start();
      const waves = new Map();
      const wave = (shape) => {
        if (waves.has(shape)) return waves.get(shape);
        const n = 64, re = new Float32Array(n), im = new Float32Array(n);
        // pump: a sawtooth that rises after each beat (down fast, back up slowly)
        for (let k = 1; k < n; k++) im[k] = shape === 'pump' ? -1 / k : 0;
        const w = ctx.createPeriodicWave(re, im, { disableNormalization: false });
        waves.set(shape, w);
        return w;
      };
      return {
        input, output,
        set(p, bpm) {
          lfo.frequency.value = syncHz(p.rate, bpm);
          if (p.shape === 'pump') lfo.setPeriodicWave(wave('pump'));
          else lfo.type = p.shape === 'square' ? 'square' : 'sine';
          const d = p.depth / 2;
          if (p.shape === 'pan') { vca.gain.value = 1; smooth(ctx, amt.gain, 0); smooth(ctx, panAmt.gain, p.depth); }
          else { vca.gain.value = 1 - d; smooth(ctx, amt.gain, d); smooth(ctx, panAmt.gain, 0); }
        },
        dispose() { try { lfo.stop(); } catch { /* */ } off(input, vca, pan, output, lfo, amt, panAmt); },
      };
    },
  });
})();
