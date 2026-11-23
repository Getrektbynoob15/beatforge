/* scheduler.js: look-ahead transport.
 * A timer wakes every 25 ms and books every note/clip that starts in the next 120 ms at its exact
 * AudioContext time. The audio clock does the timing, so the music never drifts with the timer.
 * Positions are kept in beats; a BPM change re-anchors (anchorBeat, anchorTime) so nothing jumps. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});

  const LOOKAHEAD = 0.12; // seconds
  const TICK_MS = 25;
  const STEP_BEATS = 0.25; // one 16th step

  /**
   * Book everything that starts in [fromBeat, toBeat). Shared by live play and WAV export.
   * beatTime(beat) -> AudioContext seconds. mode: 'pattern' | 'song'.
   */
  BF.scheduleRange = function (ctx, graph, p, fromBeat, toBeat, beatTime, mode, sources) {
    const stepSec = 60 / p.bpm / 4;
    // steps of the pattern
    let first = Math.ceil(fromBeat / STEP_BEATS - 1e-9);
    for (let s = first; s * STEP_BEATS < toBeat - 1e-9; s++) {
      const beat = s * STEP_BEATS;
      const bar = Math.floor(beat / 4);
      if (mode === 'song' && !p.patternBars[bar]) continue;
      const idx = ((s % 16) + 16) % 16;
      const when = beatTime(beat);
      p.tracks.forEach((t, i) => {
        if (t.steps[idx]) BF.playSound(ctx, t.sound, graph.tracks[i].input, when, t.pitch, stepSec);
      });
    }
    // clips start (song mode only)
    if (mode === 'song') {
      for (const c of p.clips) {
        if (c.startBeat >= fromBeat - 1e-9 && c.startBeat < toBeat - 1e-9) {
          const buf = BF.audio.clipBuffer(ctx, c);
          if (buf) {
            const src = BF.audio.playBuffer(ctx, buf, graph.lanes[c.lane].input, beatTime(c.startBeat));
            if (src && sources) sources.push(src);
          }
        }
      }
    }
  };

  const T = (BF.transport = {
    playing: false,
    mode: 'pattern',
    startBeat: 0, // where Song mode starts (set by clicking the ruler)
    anchorBeat: 0,
    anchorTime: 0,
    bpm: 120,
    nextBeat: 0,
    sources: [],
    timer: null,
  });

  const beatTime = (beat) => T.anchorTime + ((beat - T.anchorBeat) * 60) / T.bpm;

  T.position = function () {
    if (!T.playing) return T.mode === 'song' ? T.startBeat : 0;
    const ctx = BF.audio.ctx;
    return T.anchorBeat + ((ctx.currentTime - T.anchorTime) * T.bpm) / 60;
  };

  T.songEndBeat = () => BF.project.songBars * 4;

  function tick() {
    const ctx = BF.audio.ctx;
    const p = BF.project;
    if (p.bpm !== T.bpm) { // re-anchor at the current spot, then continue at the new tempo
      const nowBeat = T.position();
      T.anchorBeat = nowBeat;
      T.anchorTime = ctx.currentTime;
      T.bpm = p.bpm;
      if (T.nextBeat < nowBeat) T.nextBeat = Math.ceil(nowBeat / STEP_BEATS) * STEP_BEATS;
    }
    const horizon = ctx.currentTime + LOOKAHEAD;
    const horizonBeat = T.anchorBeat + ((horizon - T.anchorTime) * T.bpm) / 60;
    if (T.mode === 'song') {
      const end = T.songEndBeat();
      if (T.nextBeat < end) {
        const to = Math.min(horizonBeat, end);
        if (to > T.nextBeat) { BF.scheduleRange(ctx, BF.audio.graph, p, T.nextBeat, to, beatTime, 'song', T.sources); T.nextBeat = to; }
      }
      if (T.position() >= end) { T.stop(); return; }
    } else if (horizonBeat > T.nextBeat) {
      BF.scheduleRange(ctx, BF.audio.graph, p, T.nextBeat, horizonBeat, beatTime, 'pattern', null);
      T.nextBeat = horizonBeat;
    }
  }

  T.play = function () {
    const ctx = BF.audio.ensure();
    const g = BF.audio.graph;
    BF.audio.stopPreview();
    g.transport.gain.cancelScheduledValues(ctx.currentTime);
    g.transport.gain.setValueAtTime(1, ctx.currentTime);
    T.bpm = BF.project.bpm;
    T.anchorTime = ctx.currentTime + 0.05;
    T.anchorBeat = T.mode === 'song' ? T.startBeat : 0;
    if (T.mode === 'song' && T.anchorBeat >= T.songEndBeat()) T.anchorBeat = T.startBeat = 0;
    T.nextBeat = T.anchorBeat;
    T.sources = [];
    // Song mode starting in the middle of a clip: start that clip part-way through.
    if (T.mode === 'song') {
      for (const c of BF.project.clips) {
        const len = BF.audio.clipSeconds(c);
        const startSec = ((T.anchorBeat - c.startBeat) * 60) / T.bpm;
        if (c.startBeat < T.anchorBeat && startSec < len) {
          const buf = BF.audio.clipBuffer(ctx, c);
          const src = buf && BF.audio.playBuffer(ctx, buf, g.lanes[c.lane].input, T.anchorTime, startSec);
          if (src) T.sources.push(src);
        }
      }
    }
    T.playing = true;
    tick();
    T.timer = setInterval(tick, TICK_MS);
    BF.emit('transport');
  };

  T.stop = function () {
    if (!T.playing) return;
    const ctx = BF.audio.ctx;
    const g = BF.audio.graph;
    clearInterval(T.timer);
    T.timer = null;
    T.playing = false;
    // fade the whole transport out over 15 ms, then cut the sources and restore the level
    const now = ctx.currentTime;
    g.transport.gain.cancelScheduledValues(now);
    g.transport.gain.setValueAtTime(g.transport.gain.value, now);
    g.transport.gain.linearRampToValueAtTime(0, now + 0.015);
    const old = T.sources;
    T.sources = [];
    // Synth voices are short; clip sources can be long, so stop them explicitly after the fade.
    old.forEach((s) => { try { s.stop(now + 0.02); } catch { /* ended */ } });
    // Voices already booked in the look-ahead window land inside the silence; bring the level back after it.
    g.transport.gain.setValueAtTime(0, now + LOOKAHEAD + 0.25);
    g.transport.gain.linearRampToValueAtTime(1, now + LOOKAHEAD + 0.26);
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

  /** Book a whole song into an OfflineAudioContext and render it. */
  BF.renderSong = async function () {
    const p = BF.project;
    const rate = 44100;
    const songBeats = p.songBars * 4;
    let lastSec = (songBeats * 60) / p.bpm;
    // let clips that start inside the song ring out to their end
    p.clips.forEach((c) => {
      if (c.startBeat < songBeats) lastSec = Math.max(lastSec, (c.startBeat * 60) / p.bpm + BF.audio.clipSeconds(c));
    });
    const total = Math.ceil((lastSec + 1.0) * rate); // +1 s tail for decays
    const ctx = new OfflineAudioContext(2, total, rate);
    const graph = BF.audio.buildGraph(ctx);
    BF.audio.updateGraph(graph, p, ctx);
    BF.scheduleRange(ctx, graph, p, 0, songBeats, (b) => (b * 60) / p.bpm, 'song', null);
    return ctx.startRendering();
  };
})();
