/* perform.js: Performance mode. A grid of the playlist's clips, one column per track, to launch live.
 *  - Click a pad: it starts at the next bar (or beat, or at once) and loops until another pad in its column starts or
 *    the column is stopped. One pad per column plays at a time.
 *  - The ▶ at the start of a row launches that row in every column (a "scene").
 *  - "Record" writes what you launch into the playlist, after the end of the song (nothing is overwritten).
 * The transport runs in its own mode ('perf') while this is used: an endless timeline from beat 0. */
(function () {
  'use strict';
  const BF = window.BF;
  const PF = (BF.perf = { quant: 'bar', cols: new Map(), rec: false, take: [], recBase: 0 });
  let body, grid;

  /** Pads from the playlist: per track, every different pattern/audio in order of first use. No clips: one per pattern. */
  PF.pads = function (p = BF.project) {
    const cols = [];
    for (let t = 0; t < BF.TRACKS; t++) {
      const seen = new Set(), pads = [];
      p.clips.filter((c) => c.track === t && (c.kind === 'pattern' || c.kind === 'audio')).sort((a, b) => a.start - b.start).forEach((c) => {
        const k = c.kind === 'pattern' ? `p:${c.patternId}` : `a:${c.sampleId}`;
        if (seen.has(k)) return;
        seen.add(k);
        pads.push({ key: k, clip: c });
      });
      if (pads.length) cols.push({ track: t, pads });
    }
    if (!cols.length) p.patterns.slice(0, BF.TRACKS).forEach((pt, i) => cols.push({ track: i, pads: [{ key: `p:${pt.id}`, clip: { kind: 'pattern', patternId: pt.id, track: i, start: 0, len: BF.patternBeats(pt) } }] }));
    return cols;
  };
  const padLen = (c, p) => (c.kind === 'pattern' ? (() => { const pt = p.patterns.find((x) => x.id === c.patternId); return pt ? BF.patternBeats(pt) : 4; })() : BF.audio.clipBeats(c, p.bpm));

  function quantize(beat) {
    if (PF.quant === 'none') return beat + 0.02;
    const q = PF.quant === 'beat' ? 1 : BF.barBeats();
    return Math.ceil((beat + 0.02) / q) * q;
  }

  /** Launch a pad (or stop the column with pad = null). */
  PF.launch = function (track, pad) {
    const T = BF.transport;
    if (!(T.playing && T.mode === 'perf')) { // not running yet: this pad starts the clock and plays from beat 0
      PF.start(() => { if (pad) PF.cols.set(track, { cur: null, next: { pad, at: 0 } }); });
      PF.render();
      return;
    }
    const col = PF.cols.get(track) || { cur: null, next: null };
    col.next = { pad, at: quantize(T.position()) };
    PF.cols.set(track, col);
    PF.render();
  };
  PF.scene = function (row) {
    const T = BF.transport, list = PF.pads().filter((col) => col.pads[row]);
    if (!(T.playing && T.mode === 'perf')) { PF.start(() => list.forEach((col) => PF.cols.set(col.track, { cur: null, next: { pad: col.pads[row], at: 0 } }))); PF.render(); return; }
    list.forEach((col) => PF.launch(col.track, col.pads[row]));
  };
  PF.stopAll = function () { PF.cols.forEach((col, t) => { if (col.cur || col.next) PF.launch(t, null); }); };

  /** Start the transport in performance mode (nothing plays until a pad is launched). */
  PF.start = function (first) {
    const T = BF.transport;
    if (T.playing) T.stop();
    PF.cols = new Map(); PF.take = [];
    if (first) first(); // pads that start together with the clock
    PF.recBase = Math.ceil(BF.songEndBeat() / BF.barBeats()) * BF.barBeats();
    if (T.mode !== 'perf') PF.prevMode = T.mode;
    T.mode = 'perf';
    T.play();
  };

  // called by the scheduler for every look-ahead window in 'perf' mode
  PF.schedule = function (g, p, from, to, beatTime, sources, spb) {
    PF.cols.forEach((col, track) => {
      if (col.next && col.next.at < to) {
        const at = Math.max(from, col.next.at);
        if (col.cur) { book(g, p, col, from, at, beatTime, spb, track); endCur(col, track, at, beatTime); }
        col.cur = col.next.pad ? { pad: col.next.pad, start: at, srcs: [] } : null;
        col.next = null;
        if (col.cur && PF.rec) PF.take.push({ track, pad: col.cur.pad, start: at, end: null });
        book(g, p, col, at, to, beatTime, spb, track);
        setTimeout(() => PF.render(), Math.max(0, (beatTime(at) - BF.audio.ctx.currentTime) * 1000));
      } else book(g, p, col, from, to, beatTime, spb, track);
    });
  };
  function endCur(col, track, at, beatTime) {
    col.cur.srcs.forEach((s) => { try { s.stop(beatTime(at)); } catch { /* ended */ } });
    const r = PF.take.find((x) => x.pad === col.cur.pad && x.end === null && x.track === track);
    if (r) r.end = at;
  }
  function book(g, p, col, from, to, beatTime, spb, track) {
    const cur = col.cur;
    if (!cur || to <= from) return;
    const c = cur.pad.clip, L = Math.max(0.25, padLen(c, p));
    const k0 = Math.max(0, Math.floor((from - cur.start) / L - 1e-9));
    for (let k = k0; cur.start + k * L < to; k++) {
      const at = cur.start + k * L;
      if (c.kind === 'pattern') {
        const pt = p.patterns.find((x) => x.id === c.patternId);
        if (pt) BF.bookPattern(g, p, pt, at, Math.max(from, at), to, at + L, beatTime, spb, false);
      } else if (at >= from - 1e-9 && at < to - 1e-9) {
        const ins = p.tracks[track]?.insert || 0;
        const src = BF.audio.playClip(g.ctx, c, g.inserts[ins].transport, beatTime(at), 0, p.bpm);
        if (src) { cur.srcs.push(src); BF.transport.sources.push(src); if (cur.srcs.length > 8) cur.srcs.shift(); }
      }
    }
  }

  /** Transport stopped: write the recorded performance into the playlist (one undo step). */
  PF.onStop = function (pos) {
    BF.transport.mode = PF.prevMode || 'song'; // Space plays the song/pattern again afterwards
    const take = PF.take.filter((r) => r.start < (r.end ?? pos));
    PF.cols = new Map(); PF.take = [];
    PF.render();
    if (!take.length) return;
    const bb = BF.barBeats(), base = PF.recBase;
    BF.commit((p) => {
      take.forEach((r) => {
        const end = r.end ?? Math.ceil(pos / bb) * bb;
        const c = r.pad.clip, L = Math.max(0.25, padLen(c, p));
        // one playlist clip per loop of the pad (like launching it again and again)
        for (let s = r.start; s < end - 1e-6; s += L) {
          const len = Math.min(L, end - s);
          if (c.kind === 'pattern') p.clips.push({ id: BF.uid('c'), kind: 'pattern', track: r.track, start: base + s, len, patternId: c.patternId });
          else p.clips.push({ ...c, id: BF.uid('c'), track: r.track, start: base + s, len: Math.min(len, BF.audio.clipBeats(c, p.bpm)) });
        }
      });
    }, null, 'clips');
    BF.ui.toast(`Performance recorded into the playlist from bar ${Math.round(base / bb) + 1}.`);
  };

  const refresh = () => { if (BF.win && BF.win.isOpen('perf')) PF.render(); };
  BF.onChange((reason) => { if (reason !== 'param') refresh(); });
  // ---------- window ----------
  PF.build = function () {
    body = document.createElement('div'); body.className = 'perf';
    const bar = document.createElement('div'); bar.className = 'perf-bar';
    const btn = (label, title, fn, cls = '') => { const b = document.createElement('button'); b.className = `btn small ${cls}`; b.textContent = label; b.title = title; b.addEventListener('click', fn); return b; };
    const q = document.createElement('select'); q.setAttribute('aria-label', 'Launch on');
    [['bar', 'Launch on next bar'], ['beat', 'Launch on next beat'], ['none', 'Launch at once']].forEach(([v, l]) => q.add(new Option(l, v)));
    q.addEventListener('change', () => { PF.quant = q.value; });
    const rec = btn('● Record', 'Write what you launch into the playlist, after the end of the song', () => { PF.rec = !PF.rec; rec.setAttribute('aria-pressed', String(PF.rec)); }, 'perf-rec');
    rec.setAttribute('aria-pressed', 'false');
    const play = btn('▶ Start', 'Start the clock (pads wait for the next bar)', () => { if (BF.transport.playing && BF.transport.mode === 'perf') BF.transport.stop(); else PF.start(); });
    bar.append(play, btn('■ Stop all clips', 'Stop every column at the next bar', () => PF.stopAll()), q, rec);
    const tip = document.createElement('span'); tip.className = 'hint'; tip.textContent = 'Click a clip to launch it. Keys 1–9 launch a row.';
    bar.append(tip);
    grid = document.createElement('div'); grid.className = 'perf-grid';
    body.append(bar, grid);
    body.tabIndex = 0;
    body.addEventListener('keydown', (e) => { if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); PF.scene(+e.key - 1); } });
    PF.playBtn = play;
    return body;
  };

  PF.render = function () {
    if (!grid) return;
    const p = BF.project, cols = PF.pads(p), T = BF.transport;
    if (PF.playBtn) PF.playBtn.textContent = T.playing && T.mode === 'perf' ? '■ Stop' : '▶ Start';
    grid.textContent = '';
    const rows = Math.max(1, ...cols.map((c) => c.pads.length));
    grid.style.gridTemplateColumns = `32px repeat(${cols.length}, minmax(96px, 1fr))`;
    grid.append(document.createElement('span'));
    cols.forEach((col) => {
      const h = document.createElement('div'); h.className = 'perf-head';
      const n = document.createElement('span'); n.textContent = p.tracks[col.track]?.name || `Track ${col.track + 1}`;
      const st = document.createElement('button'); st.className = 'btn small'; st.textContent = '■'; st.title = 'Stop this column';
      st.addEventListener('click', () => PF.launch(col.track, null));
      h.append(n, st); grid.append(h);
    });
    for (let r = 0; r < rows; r++) {
      const sc = document.createElement('button'); sc.className = 'btn small perf-scene'; sc.textContent = `${r + 1}`; sc.title = `Launch row ${r + 1} (key ${r + 1})`;
      sc.addEventListener('click', () => PF.scene(r));
      grid.append(sc);
      cols.forEach((col) => {
        const pad = col.pads[r];
        if (!pad) { grid.append(document.createElement('span')); return; }
        const st = PF.cols.get(col.track);
        const b = document.createElement('button'); b.className = 'perf-pad';
        const c = pad.clip;
        const pt = c.kind === 'pattern' ? p.patterns.find((x) => x.id === c.patternId) : null;
        b.textContent = pt ? pt.name : (p.samples[c.sampleId]?.name || 'Audio');
        b.style.setProperty('--c', pt ? pt.color : '#8fa3b8');
        const playing = st && st.cur && st.cur.pad.key === pad.key, queued = st && st.next && st.next.pad && st.next.pad.key === pad.key;
        b.classList.toggle('on', !!playing); b.classList.toggle('queued', !!queued);
        b.setAttribute('aria-pressed', String(!!playing));
        b.addEventListener('click', () => PF.launch(col.track, pad));
        grid.append(b);
      });
    }
  };
})();
