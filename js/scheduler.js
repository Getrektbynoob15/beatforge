/* scheduler.js: look-ahead transport.
 * A timer wakes every 25 ms and books every note/clip starting in the next 120 ms at its exact AudioContext time,
 * so the music never drifts with the timer. Positions are in beats. Both modes loop:
 *   Pattern mode loops the current pattern; Song mode loops the playlist (0 .. song end).
 * A BPM change or a loop wrap re-anchors (anchorBeat, anchorTime); the previous anchor is kept so the playhead
 * stays right while already-booked audio from before the wrap is still playing. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});

  const LOOKAHEAD = 0.12;
  const TICK_MS = 25;

  /** Book one pattern instance that starts at `atBeat`, events in [from, to) only, cut at `cutBeat`. */
  /** Per-note extras: pan, fine pitch, portamento (glide from the previous note) and slide notes (bend this note). */
  function noteExtras(n, notes, slides, atBeat, beatTime, secPerBeat, dur) {
    const x = {};
    if (n.pan) x.pan = n.pan;
    if (n.fine) x.fine = n.fine;
    if (n.porta) {
      let prev = null;
      for (const o of notes) if (!o.slide && !o.mute && o !== n && o.start < n.start - 1e-6 && (!prev || o.start > prev.start)) prev = o;
      if (prev && prev.key !== n.key) { x.glideFrom = (prev.key - n.key) * 100; x.glideTime = Math.min(dur, secPerBeat / 3); }
    }
    for (const s of slides) {
      if (s.start > n.start + 1e-6 && s.start < n.start + n.len - 1e-6) {
        (x.bends = x.bends || []).push({ t: beatTime(atBeat + s.start / 4), cents: (s.key - n.key) * 100 + (s.fine || 0), dur: (s.len / 4) * secPerBeat });
      }
    }
    if (x.bends) x.bends.sort((a, b) => a.t - b.t);
    return Object.keys(x).length ? x : null;
  }

  function bookPattern(g, p, pt, atBeat, from, to, cutBeat, beatTime, secPerBeat, auto = false) {
    const swing = p.swing * (1 / 4) * (1 / 3); // max swing pushes off-beat 16ths by 1/3 of a step
    for (const ch of p.channels) {
      if (ch.mute) continue;
      const steps = pt.steps[ch.id];
      if (steps) {
        for (let i = 0; i < Math.min(steps.length, pt.length); i++) {
          if (!steps[i]) continue;
          const beat = atBeat + i / 4 + (i % 2 ? swing : 0);
          if (beat < from - 1e-9 || beat >= to - 1e-9 || beat >= cutBeat - 1e-9) continue;
          BF.audio.note(g, ch, beatTime(beat), 60, 0.8, secPerBeat / 4, false, auto ? BF.auto.noteParams(p, ch, beat) : null);
        }
      }
      const notes = pt.notes[ch.id];
      if (notes) {
        const slides = notes.filter((n) => n.slide && !n.mute);
        for (const n of notes) {
          if (n.start >= pt.length || n.mute || n.slide) continue;
          const beat = atBeat + n.start / 4 + (Math.round(n.start) === n.start && n.start % 2 ? swing : 0);
          if (beat < from - 1e-9 || beat >= to - 1e-9 || beat >= cutBeat - 1e-9) continue;
          const dur = (n.len / 4) * secPerBeat;
          BF.audio.note(g, ch, beatTime(beat), n.key, n.vel, dur, false, auto ? BF.auto.noteParams(p, ch, beat) : null, noteExtras(n, notes, slides, atBeat, beatTime, secPerBeat, dur));
        }
      }
    }
  }

  /** Book everything in [from, to). mode 'pattern': current pattern looped from beat 0. 'song': the playlist. */
  BF.scheduleRange = function (g, p, from, to, beatTime, mode, sources, later) {
    const spb = 60 / p.bpm;
    if (mode === 'pattern') {
      const pt = BF.pattern();
      if (!pt) return;
      const len = BF.patternBeats(pt);
      for (let k = Math.floor(from / len); k * len < to; k++) bookPattern(g, p, pt, k * len, from, to, Infinity, beatTime, spb);
      return;
    }
    for (const c of p.clips) {
      if (p.tracks[c.track]?.mute || c.muted) continue;
      if (c.kind === 'pattern') {
        const end = c.start + c.len;
        if (end <= from || c.start >= to) continue;
        const pt = p.patterns.find((x) => x.id === c.patternId);
        if (pt) bookPattern(g, p, pt, c.start, from, to, end, beatTime, spb, true);
      } else if (c.kind === 'audio' && c.start >= from - 1e-9 && c.start < to - 1e-9) {
        const ins = p.tracks[c.track]?.insert || 0;
        const src = BF.audio.playClip(g.ctx, c, g.inserts[ins].transport, beatTime(c.start), 0, p.bpm);
        if (src && sources) sources.push(src);
      }
    }
    BF.auto.schedule(g, p, from, to, beatTime, later || liveLater(g.ctx));
  };
  const liveLater = (ctx) => (t, fn) => setTimeout(fn, Math.max(0, (t - ctx.currentTime) * 1000));

  BF.songEndBeat = function (p = BF.project) {
    let end = p.songBars * 4;
    p.clips.forEach((c) => { end = Math.max(end, c.start + BF.audio.clipBeats(c, p.bpm)); });
    return Math.ceil(end / 4 - 1e-9) * 4;
  };

  const T = (BF.transport = {
    playing: false,
    mode: 'pattern',
    startBeat: 0,
    anchorBeat: 0,
    anchorTime: 0,
    prev: null,
    bpm: 120,
    nextBeat: 0,
    sources: [],
    timer: null,
  });

  const beatTime = (beat) => T.anchorTime + ((beat - T.anchorBeat) * 60) / T.bpm;
  const loopEnd = () => (T.mode === 'song' ? (T.loop ? T.loop.end : BF.songEndBeat()) : BF.patternBeats(BF.pattern()));
  const loopStart = () => (T.mode === 'song' && T.loop ? T.loop.start : 0);
  T.loop = null; // Song mode loop region { start, end } in beats (drag on the playlist ruler)

  T.position = function () {
    if (!T.playing) return T.mode === 'song' ? T.startBeat : 0;
    const now = BF.audio.ctx.currentTime;
    const a = T.prev && now < T.anchorTime ? T.prev : T;
    return Math.max(0, a.anchorBeat + ((now - a.anchorTime) * a.bpm) / 60);
  };

  /** Start audio clips that are already running at `beat` (playing from the middle of a clip). */
  function startRunningClips(beat, when) {
    if (T.mode !== 'song') return;
    const p = BF.project;
    for (const c of p.clips) {
      if (c.kind !== 'audio' || c.muted || p.tracks[c.track]?.mute) continue;
      const lenBeats = BF.audio.clipBeats(c, p.bpm);
      if (c.start < beat && c.start + lenBeats > beat) {
        const ins = p.tracks[c.track]?.insert || 0;
        const src = BF.audio.playClip(BF.audio.ctx, c, BF.audio.graph.inserts[ins].transport, when, ((beat - c.start) * 60) / p.bpm, p.bpm);
        if (src) T.sources.push(src);
      }
    }
  }

  function tick() {
    const ctx = BF.audio.ctx;
    const p = BF.project;
    if (p.bpm !== T.bpm) {
      const nowBeat = T.position();
      T.prev = null;
      T.anchorBeat = nowBeat;
      T.anchorTime = ctx.currentTime;
      T.bpm = p.bpm;
    }
    const horizon = ctx.currentTime + LOOKAHEAD;
    let guard = 0;
    while (guard++ < 8) {
      const end = loopEnd();
      const horizonBeat = T.anchorBeat + ((horizon - T.anchorTime) * T.bpm) / 60;
      const to = Math.min(horizonBeat, end);
      if (to > T.nextBeat) {
        BF.scheduleRange(BF.audio.graph, p, T.nextBeat, to, beatTime, T.mode, T.sources);
        BF.recorder.bookClicks(BF.audio.graph, T.nextBeat, to, beatTime);
        T.nextBeat = to;
      }
      if (horizonBeat < end) break;
      // loop: beat `end` happens at beatTime(end); continue from 0 there
      const wrapTime = beatTime(end);
      T.prev = { anchorBeat: T.anchorBeat, anchorTime: T.anchorTime, bpm: T.bpm };
      T.anchorBeat = loopStart();
      T.anchorTime = wrapTime;
      T.nextBeat = T.anchorBeat;
      if (T.sources.length > 200) T.sources = T.sources.slice(-100);
    }
  }

  T.play = function () {
    const ctx = BF.audio.ensure();
    const g = BF.audio.graph;
    BF.audio.stopPreview();
    g.inserts.forEach((ins) => { ins.transport.gain.cancelScheduledValues(ctx.currentTime); ins.transport.gain.setValueAtTime(1, ctx.currentTime); });
    T.bpm = BF.project.bpm;
    T.prev = null;
    T.anchorTime = ctx.currentTime + 0.05;
    // precount (Ctrl+P): one bar of clicks before recording starts
    if (BF.rec.armed && BF.rec.precount) {
      const spb = 60 / BF.project.bpm;
      for (let b = 0; b < 4; b++) BF.recorder.click(g, T.anchorTime + b * spb, b === 0);
      T.anchorTime += 4 * spb;
    }
    let start = T.mode === 'song' ? T.startBeat : 0;
    if (T.mode === 'song' && T.loop && (start < T.loop.start || start >= T.loop.end)) start = T.loop.start;
    if (start >= loopEnd()) start = T.startBeat = 0;
    T.anchorBeat = start;
    T.nextBeat = start;
    T.sources = [];
    startRunningClips(start, T.anchorTime);
    T.playing = true;
    tick();
    T.timer = setInterval(tick, TICK_MS);
    BF.recorder.onPlay(start, T.anchorTime);
    BF.emit('transport');
  };

  T.stop = function () {
    if (!T.playing) return;
    const ctx = BF.audio.ctx;
    clearInterval(T.timer);
    T.timer = null;
    T.playing = false;
    const now = ctx.currentTime;
    BF.audio.graph.inserts.forEach((ins) => {
      const gp = ins.transport.gain;
      gp.cancelScheduledValues(now);
      gp.setValueAtTime(gp.value, now);
      gp.linearRampToValueAtTime(0, now + 0.015);
      // notes already booked in the look-ahead window land in the silence; bring the level back after it
      gp.setValueAtTime(0, now + LOOKAHEAD + 0.25);
      gp.linearRampToValueAtTime(1, now + LOOKAHEAD + 0.26);
    });
    T.sources.forEach((s) => { try { s.stop(now + 0.02); } catch { /* ended */ } });
    T.sources = [];
    BF.recorder.onStop();
    if (BF.community) BF.community.stopAll();
    // drop booked automation ramps, go back to the static mixer/channel values
    setTimeout(() => BF.audio.sync(BF.audio.graph, BF.project), 20);
    BF.emit('transport');
  };

  T.toggle = () => (T.playing ? T.stop() : T.play());

  T.setMode = function (mode) {
    if (mode === T.mode) return;
    const was = T.playing;
    if (was) T.stop();
    T.mode = mode;
    BF.emit('transport');
    if (was) setTimeout(T.play, 140);
  };

  /** Render the whole song (Song mode, no loop) into an OfflineAudioContext. */
  /** Render beats [from, to) of the song (+ tailSec) into a buffer that starts at `from`. */
  async function renderPart(p, mode, rate, from, to, tailSec) {
    const spb = 60 / p.bpm;
    const total = Math.max(128, Math.ceil(((to - from) * spb + tailSec) * rate));
    const ctx = new OfflineAudioContext(2, total, rate);
    await BF.audio.loadWorklets(ctx).catch(() => {});
    const g = BF.audio.buildGraph(ctx);
    BF.audio.sync(g, p);
    const events = new Map(); // render-quantum frame -> [fn]
    const later = (t, fn) => {
      const q = Math.round((t * rate) / 128) * 128;
      if (!events.has(q)) events.set(q, []);
      events.get(q).push(fn);
    };
    const bt = (b) => (b - from) * spb;
    BF.scheduleRange(g, p, from, to, bt, mode, null, later);
    if (mode === 'song' && from > 0) { // audio clips that are already playing when this part starts
      for (const c of p.clips) {
        if (c.kind !== 'audio' || c.muted || p.tracks[c.track]?.mute) continue;
        const len = BF.audio.clipBeats(c, p.bpm);
        if (c.start < from - 1e-9 && c.start + len > from) BF.audio.playClip(ctx, c, g.inserts[p.tracks[c.track]?.insert || 0].transport, 0, (from - c.start) * spb, p.bpm);
      }
    }
    for (const [q, fns] of [...events.entries()].sort((a, b) => a[0] - b[0])) {
      if (q <= 0) { fns.forEach((f) => f()); continue; }
      if (q >= total) continue;
      ctx.suspend(q / rate).then(() => { fns.forEach((f) => f()); ctx.resume(); });
    }
    if (BF.community) BF.community.flush(ctx);
    return ctx.startRendering();
  }

  /** Render the song (or the current pattern) offline. Long songs are cut into parts that render at the same time on
   * several CPU cores (each part starts a few seconds early so notes, echoes and reverb tails carry over, and parts are
   * joined with a short crossfade), which makes exports several times faster. `onProgress(0..1)` is optional. */
  BF.renderSong = async function (mode = 'song', rate = 44100, onProgress = null) {
    const p = BF.project;
    const end = mode === 'song' ? BF.songEndBeat(p) : BF.patternBeats(BF.pattern());
    const spb = 60 / p.bpm;
    const TAIL = 2.5; // reverb / delay / release after the last note
    const songSec = end * spb;
    const cores = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
    const parts = mode === 'song' && songSec > 40 ? Math.min(8, cores, Math.ceil(songSec / 20)) : 1;
    if (parts <= 1) return renderPart(p, mode, rate, 0, end, TAIL);
    const PRE = Math.min(8, Math.max(4, songSec / parts / 3)) / spb; // pre-roll in beats
    const XF = 0.03 / spb; // crossfade in beats
    const bounds = Array.from({ length: parts + 1 }, (_, i) => (i === parts ? end : Math.round(((end * i) / parts) * 4) / 4));
    let done = 0;
    const bufs = await Promise.all(bounds.slice(0, -1).map((k0, i) => {
      const k1 = bounds[i + 1], last = i === parts - 1;
      const from = Math.max(0, k0 - PRE);
      return renderPart(p, mode, rate, from, last ? k1 : Math.min(end, k1 + XF), last ? TAIL : 0)
        .then((b) => { done++; if (onProgress) onProgress(done / parts); return { b, from, k0, k1, last }; });
    }));
    const total = Math.ceil((songSec + TAIL) * rate);
    const out = new AudioBuffer({ length: total, numberOfChannels: 2, sampleRate: rate });
    const xfN = Math.max(1, Math.round(XF * spb * rate));
    for (const { b, from, k0, k1, last } of bufs) {
      const dst0 = Math.round(k0 * spb * rate);
      const src0 = dst0 - Math.round(from * spb * rate);
      const n = Math.min(b.length - src0, (last ? total : Math.round(k1 * spb * rate) + xfN) - dst0, total - dst0);
      for (let c = 0; c < 2; c++) {
        const d = out.getChannelData(c), s = b.getChannelData(c);
        for (let i = 0; i < n; i++) {
          const v = s[src0 + i];
          if (k0 > 0 && i < xfN) { const w = i / xfN; d[dst0 + i] = d[dst0 + i] * (1 - w) + v * w; } // fade in over the previous part's overlap
          else d[dst0 + i] = v;
        }
      }
    }
    return out;
  };
})();
