/* recorder.js: metronome and audio recording.
 * Record mode (Options → Recording): notes, audio, or both. With audio, pressing Play while Record is on captures
 * the microphone/line input on the audio thread; on Stop the take becomes an audio clip at the spot where recording
 * started (corrected for the sound card's latency), on the first empty playlist track. */
(function () {
  'use strict';
  const BF = window.BF;
  const R = (BF.recorder = { mode: 'notes', metronome: false, stream: null, take: null });

  // ---------- metronome ----------
  /** Book clicks for beats in [from, to) (live playback only). */
  R.bookClicks = function (g, from, to, beatTime) {
    if (!R.metronome && !(BF.rec.armed && R.mode !== 'notes')) return;
    const ctx = g.ctx;
    for (let b = Math.ceil(from - 1e-9); b < to - 1e-9; b++) {
      const t = beatTime(b);
      const o = ctx.createOscillator(), e = ctx.createGain();
      o.frequency.value = b % 4 === 0 ? 1760 : 1320;
      e.gain.setValueAtTime(0, t);
      e.gain.linearRampToValueAtTime(b % 4 === 0 ? 0.32 : 0.2, t + 0.002);
      e.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      e.gain.linearRampToValueAtTime(0, t + 0.055);
      o.connect(e).connect(g.inserts[0].preview);
      o.start(t); o.stop(t + 0.06);
    }
  };

  // ---------- audio recording ----------
  const REC_WORKLET = `
  class BfRecorder extends AudioWorkletProcessor {
    constructor() { super(); this.on = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; }; }
    process(inputs) {
      const inp = inputs[0];
      if (this.on && inp && inp.length) this.port.postMessage(inp.map((c) => c.slice(0)));
      return this.on;
    }
  }
  registerProcessor('bf-recorder', BfRecorder);`;
  let recUrl = null;

  R.getInput = async function () {
    if (R.stream) return R.stream;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record audio.');
    R.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    return R.stream;
  };

  /** Called by the transport when playback starts. */
  R.onPlay = async function (startBeat, startTime) {
    if (!BF.rec.armed || R.mode === 'notes') return;
    const ctx = BF.audio.ctx;
    try {
      const stream = await R.getInput();
      if (!ctx.__bfRec) {
        recUrl = recUrl || URL.createObjectURL(new Blob([REC_WORKLET], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(recUrl);
        ctx.__bfRec = true;
      }
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'bf-recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
      const chunks = [];
      node.port.onmessage = (e) => chunks.push(e.data);
      src.connect(node);
      // latency: what we hear is late by the output latency, and what we capture is late by the input latency
      const lat = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
      R.take = { src, node, chunks, startBeat, startTime, lat, capturedFrom: ctx.currentTime };
      BF.ui.toast('Recording audio… press Space to stop.');
    } catch (e) {
      BF.ui.toast(`Audio recording is not available: ${e.message || e}`, true);
    }
  };

  /** Called by the transport when playback stops: turn the take into a clip. */
  R.onStop = async function () {
    const t = R.take;
    if (!t) return;
    R.take = null;
    t.node.port.postMessage('stop');
    try { t.src.disconnect(); } catch { /* */ }
    const ctx = BF.audio.ctx;
    const frames = t.chunks.reduce((a, c) => a + c[0].length, 0);
    if (frames < ctx.sampleRate * 0.2) { BF.ui.toast('The recording was too short.'); return; }
    const chans = Math.min(2, t.chunks[0].length);
    const buf = new AudioBuffer({ numberOfChannels: chans, length: frames, sampleRate: ctx.sampleRate });
    for (let c = 0; c < chans; c++) {
      const d = buf.getChannelData(c);
      let o = 0;
      t.chunks.forEach((ch) => { d.set(ch[c] || ch[0], o); o += ch[0].length; });
    }
    // trim the latency from the start so the take lines up with the beat
    const skip = Math.min(frames - 1, Math.max(0, Math.round((t.lat + Math.max(0, t.startTime - t.capturedFrom)) * ctx.sampleRate)));
    const trimmed = new AudioBuffer({ numberOfChannels: chans, length: frames - skip, sampleRate: ctx.sampleRate });
    for (let c = 0; c < chans; c++) trimmed.copyToChannel(buf.getChannelData(c).subarray(skip), c);
    const wav = BF.encodeWav(trimmed);
    const bytes = new Uint8Array(await wav.arrayBuffer());
    const id = BF.uid('s');
    const n = Object.values(BF.project.samples).filter((s) => s.name.startsWith('Recording')).length + 1;
    BF.audio.buffers.set(id, trimmed);
    BF.project.samples[id] = { name: `Recording ${n}`, mime: 'audio/wav', base64: BF.io._b64.bytesToBase64(bytes) };
    const p = BF.project;
    const used = new Set(p.clips.map((c) => c.track));
    let track = p.tracks.findIndex((_, i) => !used.has(i));
    if (track < 0) track = BF.TRACKS - 1;
    const clip = { id: BF.uid('c'), kind: 'audio', track, start: t.startBeat, len: 0, sampleId: id, mode: 'resample', speed: 1, pitch: 0, srcBpm: p.bpm, gain: 1 };
    BF.commit((q) => { q.clips.push(clip); if (q.tracks[track].name.startsWith('Track ')) q.tracks[track].name = `Recording ${n}`; });
    BF.ui.toast(`Recording ${n} added on track ${track + 1} (${trimmed.duration.toFixed(1)} s).`);
  };
})();
