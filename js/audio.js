/* audio.js: AudioContext, the mixer graph, and decoded/stretched audio caches.
 * The same graph builder is used for live playback and for the offline WAV export. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});
  const A = (BF.audio = {});

  A.ctx = null;
  A.buffers = new Map(); // sampleId -> AudioBuffer (decoded)
  A.stretched = new Map(); // `${sampleId}@${speed}` -> AudioBuffer
  A.FADE = 0.004; // 4 ms fades on every sound, to avoid clicks

  A.ensure = function () {
    if (!A.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      A.ctx = new Ctx({ latencyHint: 'interactive' });
      A.graph = A.buildGraph(A.ctx);
      A.updateGraph(A.graph, BF.project, A.ctx);
    }
    if (A.ctx.state === 'suspended') A.ctx.resume();
    return A.ctx;
  };

  /**
   * channel strip: input -> gain(volume * audible) -> panner -> master
   * master: transport gain (used to fade out on Stop) -> master gain -> limiter -> destination
   */
  A.buildGraph = function (ctx) {
    const master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    master.connect(limiter).connect(ctx.destination);
    const transport = ctx.createGain();
    transport.connect(master);
    const preview = ctx.createGain(); // previews bypass the transport so Stop doesn't kill them
    preview.connect(master);
    const strip = () => {
      const input = ctx.createGain();
      const pan = ctx.createStereoPanner();
      input.connect(pan).connect(transport);
      return { input, pan };
    };
    return { master, transport, preview, tracks: Array.from({ length: 8 }, strip), lanes: Array.from({ length: 8 }, strip) };
  };

  /** Push mixer values from the project into a graph. Smooth changes so sliders don't zipper. */
  A.updateGraph = function (g, p, ctx) {
    const t = ctx.currentTime;
    const set = (param, v) => { param.cancelScheduledValues(t); param.setTargetAtTime(v, t, 0.015); };
    const setNow = (param, v) => { param.value = v; };
    const s = ctx instanceof OfflineAudioContext ? setNow : set;
    s(g.master.gain, p.masterVolume);
    p.tracks.forEach((tr, i) => { s(g.tracks[i].input.gain, BF.audible(tr) ? tr.volume : 0); s(g.tracks[i].pan.pan, tr.pan); });
    p.lanes.forEach((ln, i) => { s(g.lanes[i].input.gain, BF.audible(ln) ? ln.volume : 0); s(g.lanes[i].pan.pan, ln.pan); });
  };

  /** Decoded buffer for a clip at its speed (stretched copies are cached). */
  A.clipBuffer = function (ctx, clip) {
    const buf = A.buffers.get(clip.sampleId);
    if (!buf) return null;
    const speed = Math.round(clip.speed * 100) / 100;
    if (speed === 1) return buf;
    const key = `${clip.sampleId}@${speed}`;
    let s = A.stretched.get(key);
    if (!s) {
      s = BF.timeStretch(ctx, buf, speed);
      A.stretched.set(key, s);
    }
    return s;
  };

  /** Length of a clip in seconds, after stretching. */
  A.clipSeconds = function (clip) {
    const buf = A.buffers.get(clip.sampleId);
    return buf ? buf.duration / clip.speed : 0;
  };

  /** Play a buffer with short fades. Returns the source node. */
  A.playBuffer = function (ctx, buffer, dest, when, offset = 0, duration = null) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const env = ctx.createGain();
    const len = duration == null ? buffer.duration - offset : Math.min(duration, buffer.duration - offset);
    if (len <= 0) return null;
    const f = Math.min(A.FADE, len / 2);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(1, when + f);
    env.gain.setValueAtTime(1, when + len - f);
    env.gain.linearRampToValueAtTime(0, when + len);
    src.connect(env).connect(dest);
    src.start(when, offset, len);
    src.onended = () => { try { env.disconnect(); } catch { /* already gone */ } };
    return src;
  };

  // ---------- preview (clips in the playlist) ----------
  let previewSrc = null;
  A.preview = function (clip) {
    const ctx = A.ensure();
    A.stopPreview();
    const buf = A.clipBuffer(ctx, clip);
    if (!buf) return;
    previewSrc = A.playBuffer(ctx, buf, A.graph.preview, ctx.currentTime + 0.01, 0, Math.min(buf.duration, 8));
  };
  A.stopPreview = function () {
    if (previewSrc) { try { previewSrc.stop(); } catch { /* not started */ } previewSrc = null; }
  };

  /** Decode bytes into an AudioBuffer, with friendly errors. */
  A.decode = async function (arrayBuffer) {
    const ctx = A.ensure();
    try {
      return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch {
      throw new Error('This file could not be decoded. Use WAV or MP3 (OGG/FLAC work in most browsers).');
    }
  };
})();
