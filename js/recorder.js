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
      const bb = BF.barBeats(), accent = Math.abs(b / bb - Math.round(b / bb)) < 1e-9; // first beat of a bar
      o.frequency.value = accent ? 1760 : 1320;
      e.gain.setValueAtTime(0, t);
      e.gain.linearRampToValueAtTime(accent ? 0.32 : 0.2, t + 0.002);
      e.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      e.gain.linearRampToValueAtTime(0, t + 0.055);
      o.connect(e).connect(g.inserts[0].preview);
      o.start(t); o.stop(t + 0.06);
    }
  };

  /** One metronome click at audio time t (accent = first beat of a bar). */
  R.click = function (g, t, accent) {
    const ctx = g.ctx;
    const o = ctx.createOscillator(), e = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1320;
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(accent ? 0.32 : 0.2, t + 0.002);
    e.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    e.gain.linearRampToValueAtTime(0, t + 0.055);
    o.connect(e).connect(g.inserts[0].preview);
    o.start(t); o.stop(t + 0.06);
  };

  // ---------- audio recording ----------

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
      await BF.audio.loadWorklets(ctx); // bf-recorder lives in js/worklet-host.js
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
    const p = BF.project;
    const n = Object.values(p.samples).filter((s) => /^Recording \d+$/.test(s.name)).length + 1;
    const addSample = async (b, name) => {
      const bytes = new Uint8Array(await BF.encodeWav(b).arrayBuffer());
      const id = BF.uid('s');
      BF.audio.buffers.set(id, b);
      BF.project.samples[id] = { name, mime: 'audio/wav', base64: BF.io._b64.bytesToBase64(bytes) };
      return id;
    };
    // Loop recording: the transport went round the loop while recording. Every pass becomes a take of the loop.
    const passes = R.loopPasses(trimmed, t.startBeat);
    let start = t.startBeat, len = 0, ids;
    if (passes) {
      ids = [];
      for (let k = 0; k < passes.buffers.length; k++) ids.push(await addSample(passes.buffers[k], `Recording ${n} take ${k + 1}`));
      start = passes.start; len = passes.len;
    } else ids = [await addSample(trimmed, `Recording ${n}`)];
    // recording again over a recording that starts at the same spot: the new audio becomes another take of that clip
    const near = (c) => c.kind === 'audio' && Math.abs(c.start - start) < 0.13 && (c.takes || /^Recording \d+/.test(p.samples[c.sampleId]?.name || ''));
    const old = p.clips.find(near);
    if (old) {
      const count = (old.takes ? old.takes.length : 1) + ids.length;
      BF.commit((q) => {
        const k = q.clips.find((x) => x.id === old.id);
        k.takes = [...(k.takes || [k.sampleId]), ...ids].slice(-32);
        k.sampleId = ids[ids.length - 1];
        k.len = len;
      }, null, 'clips');
      BF.ui.toast(`${ids.length > 1 ? `${ids.length} takes` : 'New take'} added to the clip on track ${old.track + 1} (${Math.min(32, count)} takes). Select the clip to compare them.`);
      return;
    }
    const used = new Set(p.clips.map((c) => c.track));
    let track = p.tracks.findIndex((_, i) => !used.has(i));
    if (track < 0) track = BF.TRACKS - 1;
    const clip = { id: BF.uid('c'), kind: 'audio', track, start, len, sampleId: ids[ids.length - 1], mode: 'resample', speed: 1, pitch: 0, srcBpm: p.bpm, gain: 1, ...(ids.length > 1 ? { takes: ids } : {}) };
    BF.commit((q) => { q.clips.push(clip); if (q.tracks[track].name.startsWith('Track ')) q.tracks[track].name = `Recording ${n}`; });
    BF.ui.toast(ids.length > 1 ? `Recording ${n}: ${ids.length} takes on track ${track + 1}. Select the clip to compare them; the last take is used.` : `Recording ${n} added on track ${track + 1} (${trimmed.duration.toFixed(1)} s).`);
  };

  /** Split a recording made while the song looped into one buffer per pass, each lined up with the loop start.
   *  Returns null when the transport did not go round. */
  R.loopPasses = function (buf, startBeat) {
    const T = BF.transport, p = BF.project;
    if (T.mode !== 'song') return null;
    const lS = T.loop ? T.loop.start : 0, lE = T.loop ? T.loop.end : BF.songEndBeat(p);
    if (!(lE > lS) || startBeat >= lE) return null;
    const tm = BF.tempoMap(p, 'song'), rate = buf.sampleRate;
    const first = tm.sec(lE) - tm.sec(startBeat), pass = tm.sec(lE) - tm.sec(lS), lead = tm.sec(startBeat) - tm.sec(lS);
    if (buf.duration < first + 0.3) return null; // stopped before the loop came round
    const out = [];
    const cut = (fromSec, toSec, padSec) => {
      const b = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: Math.max(1, Math.round(pass * rate)), sampleRate: rate });
      const a = Math.round(fromSec * rate), z = Math.min(buf.length, Math.round(toSec * rate)), o = Math.round(padSec * rate);
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = b.getChannelData(c); d.set(buf.getChannelData(c).subarray(a, Math.min(z, a + d.length - o)), o); }
      return b;
    };
    out.push(cut(0, first, lead)); // the first pass started where play was pressed
    for (let s = first; s < buf.duration - Math.max(0.5, pass * 0.25); s += pass) out.push(cut(s, s + pass, 0)); // full passes (a short last bit is dropped)
    return { buffers: out.slice(-32), start: lS, len: lE - lS };
  };
})();
