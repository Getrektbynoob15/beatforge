/* audio.js: AudioContext, the mixer graph, effect chains, channel strips, and audio caches.
 * The same graph builder runs live and inside an OfflineAudioContext for WAV export.
 *
 *  channel: instrument voices -> chan gain (volume) -> chan pan -> transport[insert] -> insert.input
 *  insert:  input -> fx1 -> fx2 ... -> fader -> pan -> meter -> master.input   (master -> destination)
 *  audio clip -> transport[track.insert] -> insert.input
 *  previews skip the transport gain, so Stop never cuts a key you are holding. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});
  const A = (BF.audio = {});

  A.ctx = null;
  A.graph = null;
  A.buffers = new Map(); // sampleId -> AudioBuffer
  A.stretched = new Map(); // `${sampleId}@${factor}` -> AudioBuffer
  A.reversedCache = new Map();
  A.FADE = 0.004;

  // Audio-thread processors live in js/worklet-host.js. On the website the security policy forbids blob: scripts,
  // so the file itself is loaded; the desktop app / file:// cannot fetch files, so it uses a blob of the same code.
  let workletUrl = null;
  const hostUrl = () => {
    if (/^https?:$/.test(location.protocol)) return new URL('js/worklet-host.js?v=' + (window.BF_VERSION || '1'), location.href).href;
    return (workletUrl = workletUrl || URL.createObjectURL(new Blob([BF.WORKLET_SRC], { type: 'application/javascript' })));
  };
  A.loadWorklets = async function (ctx) {
    if (!ctx.audioWorklet) return;
    if (!ctx.__bfWorklets) ctx.__bfWorklets = ctx.audioWorklet.addModule(hostUrl());
    await ctx.__bfWorklets;
    if (BF.community) await BF.community.loadInto(ctx);
  };

  A.ensure = function () {
    if (!A.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      A.ctx = new Ctx({ latencyHint: 'interactive' });
      A.graph = A.buildGraph(A.ctx);
      A.sync(A.graph, BF.project);
      // once the processors are loaded, rebuild effect chains so plugins that need them use them
      A.loadWorklets(A.ctx).then(() => { A.graph.inserts.forEach((ins) => { ins.fxKey = null; ins.fx.forEach((x) => x.inst.dispose()); ins.fx = []; }); A.sync(A.graph, BF.project); }).catch((e) => console.warn('worklet', e));
    }
    if (A.ctx.state === 'suspended') A.ctx.resume();
    return A.ctx;
  };

  const isOffline = (ctx) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
  function setP(ctx, param, v) {
    if (isOffline(ctx)) { param.value = v; return; }
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(v, ctx.currentTime, 0.012);
  }
  A.setP = setP;

  A.buildGraph = function (ctx) {
    const inserts = [];
    for (let i = 0; i <= BF.INSERTS; i++) {
      const input = ctx.createGain();
      const fader = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const meter = ctx.createAnalyser();
      meter.fftSize = 512;
      const transport = ctx.createGain();
      const preview = ctx.createGain();
      transport.connect(input);
      preview.connect(input);
      fader.connect(pan).connect(meter);
      inserts.push({ input, fader, pan, meter, transport, preview, fx: [], fxKey: null });
    }
    inserts[0].meter.connect(ctx.destination);
    // inserts 1..16 are routed by syncRoutes() (to Master and/or sends to other inserts)
    return { ctx, inserts, channels: new Map() };
  };

  /** Rebuild an insert's effect chain when the list of effects changed; otherwise just push parameters. */
  function syncFx(g, ins, m, bpm) {
    const key = m.fx.map((f) => `${f.id}:${f.plugin}:${f.bypass ? 1 : 0}`).join('|');
    if (key !== ins.fxKey) {
      try { ins.input.disconnect(); } catch { /* */ }
      ins.fx.forEach((x) => { try { x.inst.output.disconnect(); } catch { /* */ } });
      const keep = new Map(ins.fx.map((x) => [x.id, x]));
      const next = [];
      m.fx.forEach((f) => {
        let x = keep.get(f.id);
        if (x && x.plugin === f.plugin) keep.delete(f.id);
        else x = { id: f.id, plugin: f.plugin, inst: BF.plugins.get(f.plugin).create(g.ctx) };
        next.push(x);
      });
      keep.forEach((x) => x.inst.dispose());
      let node = ins.input;
      next.forEach((x, i) => {
        if (m.fx[i].bypass) return;
        node.connect(x.inst.input);
        node = x.inst.output;
      });
      node.connect(ins.fader);
      ins.fx = next;
      ins.fxKey = key;
    }
    ins.fx.forEach((x, i) => {
      x.inst.set(m.fx[i].params, bpm);
      // sidechain: feed the chosen insert's output into the effect's detector
      if (x.inst.sidechainInput) {
        const src = m.fx[i].bypass ? 0 : x.inst.sidechainSource(m.fx[i].params);
        if (x.scFrom !== src) {
          if (x.scFrom) { try { g.inserts[x.scFrom].pan.disconnect(x.inst.sidechainInput); } catch { /* */ } }
          if (src) g.inserts[src].pan.connect(x.inst.sidechainInput);
          x.scFrom = src;
        }
      }
    });
  }

  /** Insert outputs: to Master (unless switched off) and sends (post-fader) to other inserts. */
  function syncRoutes(g, p) {
    for (let i = 1; i <= BF.INSERTS; i++) {
      const ins = g.inserts[i];
      const r = p.mixer[i].route || { master: true, sends: [] };
      const key = JSON.stringify(r);
      if (key === ins.routeKey) {
        (ins.sendNodes || []).forEach((n, k) => setP(g.ctx, n.gain, r.sends[k].level));
        continue;
      }
      try { ins.meter.disconnect(); } catch { /* */ }
      (ins.sendNodes || []).forEach((n) => { try { n.disconnect(); } catch { /* */ } });
      if (r.master) ins.meter.connect(g.inserts[0].input);
      ins.sendNodes = r.sends.map((s) => {
        const n = g.ctx.createGain();
        n.gain.value = s.level;
        ins.meter.connect(n).connect(g.inserts[s.to].input);
        return n;
      });
      ins.routeKey = key;
    }
  }

  A.chanStrip = (g, ch) => chanStrip(g, ch);
  function chanStrip(g, ch) {
    let s = g.channels.get(ch.id);
    if (!s) {
      const gain = g.ctx.createGain(), pan = g.ctx.createStereoPanner();
      gain.connect(pan);
      s = { gain, pan, insert: -1 };
      g.channels.set(ch.id, s);
    }
    return s;
  }

  /** Push the whole mixer/channel state into a graph. Cheap enough to run on every change. */
  A.sync = function (g, p) {
    const ctx = g.ctx;
    p.mixer.forEach((m, i) => {
      const ins = g.inserts[i];
      setP(ctx, ins.fader.gain, BF.insertAudible(i, p) ? m.volume : 0);
      setP(ctx, ins.pan.pan, m.pan);
      syncFx(g, ins, m, p.bpm);
    });
    syncRoutes(g, p);
    const live = new Set();
    p.channels.forEach((ch) => {
      live.add(ch.id);
      const s = chanStrip(g, ch);
      setP(ctx, s.gain.gain, ch.mute ? 0 : ch.volume);
      setP(ctx, s.pan.pan, ch.pan);
      if (s.insert !== ch.insert) {
        try { s.pan.disconnect(); } catch { /* */ }
        s.pan.connect(g.inserts[ch.insert].transport);
        s.insert = ch.insert;
      }
    });
    for (const [id, s] of g.channels) if (!live.has(id)) { try { s.pan.disconnect(); s.gain.disconnect(); } catch { /* */ } g.channels.delete(id); }
  };

  /** Book one note of a channel's instrument into graph `g`. */
  A.note = function (g, ch, time, key, vel, dur, preview = false, params = null, extras = null) {
    const def = BF.plugins.get(ch.plugin);
    if (!def || def.kind !== 'instrument') return;
    const mp = BF.project.masterPitch || 0;
    if (mp && !extras) extras = {};
    if (def.ext) return BF.community.note(g, ch, time, key + ch.pitch, vel, dur, preview ? 'preview' : 'main', params);
    let out;
    if (preview) {
      // preview: channel volume/pan via a throwaway strip straight into the insert's preview input
      const gn = g.ctx.createGain(), pn = g.ctx.createStereoPanner();
      gn.gain.value = ch.volume; pn.pan.value = ch.pan;
      gn.connect(pn).connect(g.inserts[ch.insert].preview);
      out = gn;
      setTimeout(() => { try { pn.disconnect(); } catch { /* */ } }, (dur + 8) * 1000);
    } else {
      out = chanStrip(g, ch).gain;
    }
    if (!extras) { def.play(g.ctx, out, params || ch.params, time, key + ch.pitch, vel, dur); return; }
    playWithExtras(g.ctx, def, out, params || ch.params, time, key + ch.pitch, vel, dur, extras, mp);
  };

  /** Per-note pan / fine pitch / portamento / slide bends / master pitch. Pitch moves go through every oscillator's and
   * sample player's `detune` (cents), driven by one ConstantSource per note, so every instrument supports them. */
  function playWithExtras(ctx, def, out, params, time, key, vel, dur, x, masterPitch) {
    let dest = out, pan = null;
    if (x.pan) { pan = ctx.createStereoPanner(); pan.pan.value = x.pan; pan.connect(out); dest = pan; }
    const base = (x.fine || 0) + masterPitch;
    let det = null;
    if (base || x.glideFrom || x.bends) {
      det = ctx.createConstantSource();
      const o = det.offset;
      o.setValueAtTime(base + (x.glideFrom || 0), time);
      if (x.glideFrom) o.linearRampToValueAtTime(base, time + Math.max(0.01, x.glideTime || 0.05));
      let last = base;
      (x.bends || []).forEach((b) => {
        o.setValueAtTime(last, b.t);
        last = base + b.cents;
        o.linearRampToValueAtTime(last, b.t + Math.max(0.005, b.dur));
      });
      det.start(time);
      det.stop(time + dur + 12);
    }
    const made = [];
    const origOsc = ctx.createOscillator, origBuf = ctx.createBufferSource;
    if (det) {
      ctx.createOscillator = function () { const n = origOsc.call(ctx); made.push(n); return n; };
      ctx.createBufferSource = function () { const n = origBuf.call(ctx); made.push(n); return n; };
    }
    try { def.play(ctx, dest, params, time, key, vel, dur); } finally {
      if (det) { delete ctx.createOscillator; delete ctx.createBufferSource; }
    }
    // pitch the sound sources, not slow LFOs (vibrato etc.)
    made.forEach((n) => { if (!(n instanceof OscillatorNode) || n.frequency.value >= 25) det.connect(n.detune); });
    if (pan && !(ctx instanceof OfflineAudioContext)) setTimeout(() => { try { pan.disconnect(); } catch { /* */ } }, (dur + 12) * 1000);
  }

  A.previewNote = function (ch, key, vel = 0.8, dur = 0.35) {
    const ctx = A.ensure();
    A.note(A.graph, ch, ctx.currentTime + 0.005, key, vel, dur, true);
  };

  // ---------- audio clips ----------
  A.reversed = function (sampleId) {
    let r = A.reversedCache.get(sampleId);
    if (!r) {
      const b = A.buffers.get(sampleId);
      r = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
      for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c).slice().reverse(); r.copyToChannel(d, c); }
      A.reversedCache.set(sampleId, r);
    }
    return r;
  };

  /** Effective speed of an audio clip (Fit mode follows the project tempo). */
  A.clipSpeed = (c, bpm = BF.project.bpm) => (c.mode === 'fit' ? BF.clamp(bpm / (c.srcBpm || bpm), 0.25, 4, 1) : c.speed);

  /** Length of an audio clip in seconds when it plays at its speed (before trimming). */
  A.clipNaturalSec = function (c, bpm) {
    const b = A.buffers.get(c.sampleId);
    return b ? b.duration / A.clipSpeed(c, bpm) : 0;
  };
  /** Length in beats as shown in the playlist (trimmed length if set). */
  A.clipBeats = function (c, bpm = BF.project.bpm) {
    if (c.kind !== 'audio') return c.len;
    const nat = (A.clipNaturalSec(c, bpm) * bpm) / 60;
    return c.len > 0 ? Math.min(c.len, nat) : nat;
  };

  /** {buffer, rate}: what to play for an audio clip. Stretch keeps pitch (plus the pitch knob); Resample changes both. */
  A.clipRender = function (c, bpm) {
    if (!A.buffers.get(c.sampleId)) return null;
    const buf = c.reverse ? A.reversed(c.sampleId) : A.buffers.get(c.sampleId);
    const speed = A.clipSpeed(c, bpm);
    const shift = Math.pow(2, (c.pitch || 0) / 12);
    if (c.mode === 'resample') return { buffer: buf, rate: speed * shift };
    // stretch: time factor = speed / shift, then play back at `shift` to move the pitch
    const factor = Math.round((speed / shift) * 1000) / 1000;
    if (Math.abs(factor - 1) < 0.002) return { buffer: buf, rate: shift };
    const key = `${c.sampleId}${c.reverse ? ':rev' : ''}@${factor}`;
    let s = A.stretched.get(key);
    if (!s) {
      s = BF.timeStretch(buf, factor);
      A.stretched.set(key, s);
    }
    return { buffer: s, rate: shift };
  };

  /** Play an audio clip (from `offsetSec` into it) at `when` into `dest`. Returns the source. */
  A.playClip = function (ctx, c, dest, when, offsetSec, bpm) {
    const r = A.clipRender(c, bpm);
    if (!r) return null;
    const totalSec = (A.clipBeats(c, bpm) * 60) / bpm;
    const len = totalSec - offsetSec;
    if (len <= 0.003) return null;
    const src = ctx.createBufferSource();
    src.buffer = r.buffer;
    src.playbackRate.value = r.rate;
    const env = ctx.createGain();
    const f = Math.min(A.FADE, len / 2);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(c.gain ?? 1, when + f);
    env.gain.setValueAtTime(c.gain ?? 1, when + len - f);
    env.gain.linearRampToValueAtTime(0, when + len);
    src.connect(env).connect(dest);
    src.start(when, offsetSec * r.rate);
    src.stop(when + len + 0.01);
    src.onended = () => { try { env.disconnect(); } catch { /* */ } };
    return src;
  };

  // ---------- preview of playlist audio clips ----------
  let previewSrc = null;
  A.previewClip = function (c) {
    const ctx = A.ensure();
    A.stopPreview();
    const t = BF.project.tracks[c.track];
    previewSrc = A.playClip(ctx, { ...c, len: Math.min(A.clipBeats(c), (8 * BF.project.bpm) / 60) }, A.graph.inserts[t ? t.insert || 0 : 0].preview, ctx.currentTime + 0.01, 0, BF.project.bpm);
  };
  A.stopPreview = function () {
    if (previewSrc) { try { previewSrc.stop(); } catch { /* */ } previewSrc = null; }
  };

  A.decode = async function (arrayBuffer) {
    const ctx = A.ensure();
    try {
      return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch {
      throw new Error('This file could not be decoded. Use WAV or MP3 (OGG/FLAC work in most browsers).');
    }
  };

  /** Peak level (0..1+) of an insert's meter, for the mixer UI. */
  const meterBuf = new Float32Array(512);
  A.peak = function (i) {
    if (!A.graph) return 0;
    const m = A.graph.inserts[i].meter;
    m.getFloatTimeDomainData(meterBuf);
    let pk = 0;
    for (let k = 0; k < meterBuf.length; k++) { const v = Math.abs(meterBuf[k]); if (v > pk) pk = v; }
    return pk;
  };
})();
