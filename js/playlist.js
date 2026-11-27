/* playlist.js: the arrangement. Left: picker (patterns + audio). Right: 16 tracks of clips.
 * Tools: Draw (P), Paint (B), Delete (D), Slice (C), Select (E).
 * Click empty space to place the picked pattern/audio, drag clips to move, drag the right edge to resize
 * (audio: trims; Shift+edge drag stretches the audio to the new length), Shift+drag duplicates, right-click deletes,
 * Ctrl+drag box-selects, Ctrl+B duplicates the selection, Delete removes it. Drop audio files on a track. */
(function () {
  'use strict';
  const BF = window.BF;
  const P = (BF.playlist = { tool: 'draw', snap: 1, sel: new Set(), pick: { kind: 'pattern' } });
  const HEADW = 150, TRACKH = 40, RULERH = 22;
  let px = 22; // px per beat
  let root, picker, scroller, inner, tracksEl, ruler, playhead, panel, toolbar, snapSel, loopEl, loopShade;
  function drawLoop() {
    const L = BF.transport.loop;
    [loopEl, loopShade].forEach((el) => {
      if (!el) return;
      el.hidden = !L;
      if (L) { el.style.left = `${HEADW + L.start * px}px`; el.style.width = `${(L.end - L.start) * px}px`; }
    });
  }
  let peaks = new Map();
  P.forgetPeaks = () => { peaks = new Map(); };
  let drag = null;

  P.build = function () {
    root = document.createElement('div');
    root.className = 'pl';
    toolbar = document.createElement('div');
    toolbar.className = 'pr-tools';
    [['draw', '✎ Draw', 'P'], ['paint', '🖌 Paint', 'B'], ['delete', '⌫ Delete', 'D'], ['mute', '🔇 Mute', 'T'], ['slice', '✂ Slice', 'C'], ['select', '⬚ Select', 'E']].forEach(([id, l, k]) => {
      const b = document.createElement('button');
      b.className = 'btn small tool'; b.dataset.tool = id; b.textContent = l; b.title = `${l.slice(2)} tool (${k})`;
      b.addEventListener('click', () => P.setTool(id));
      toolbar.append(b);
    });
    snapSel = document.createElement('select');
    snapSel.setAttribute('aria-label', 'Snap');
    [[4, 'Snap: bar'], [1, 'Snap: beat'], [0.5, 'Snap: 1/8'], [0.25, 'Snap: step'], [0, 'Snap: none']].forEach(([v, l]) => snapSel.add(new Option(l, v)));
    snapSel.value = '1';
    snapSel.addEventListener('change', () => { P.snap = +snapSel.value === 4 ? BF.barBeats() : +snapSel.value; }); // 'bar' follows the time signature
    const zout = document.createElement('button'); zout.className = 'btn small'; zout.textContent = '−'; zout.setAttribute('aria-label', 'Zoom out');
    const zin = document.createElement('button'); zin.className = 'btn small'; zin.textContent = '+'; zin.setAttribute('aria-label', 'Zoom in');
    zout.addEventListener('click', () => setZoom(px / 1.25));
    zin.addEventListener('click', () => setZoom(px * 1.25));
    const imp = document.createElement('button'); imp.className = 'btn small'; imp.textContent = 'Import audio…';
    imp.addEventListener('click', () => BF.io.pickFiles((files) => BF.io.importToPlaylist(files, firstFreeTrack(), 0)));
    toolbar.append(snapSel, zout, zin, imp);

    const main = document.createElement('div');
    main.className = 'pl-main';
    picker = document.createElement('div');
    picker.className = 'pl-picker';
    picker.setAttribute('aria-label', 'Picker: choose what to place');
    scroller = document.createElement('div');
    scroller.className = 'pl-scroll';
    scroller.tabIndex = 0;
    scroller.setAttribute('aria-label', 'Playlist tracks');
    inner = document.createElement('div');
    inner.className = 'pl-inner2';
    ruler = document.createElement('div');
    ruler.className = 'pl-ruler';
    tracksEl = document.createElement('div');
    tracksEl.className = 'pl-tracks';
    playhead = document.createElement('div');
    playhead.className = 'playhead';
    inner.append(ruler, tracksEl, playhead);
    scroller.append(inner);
    const split = document.createElement('div'); split.className = 'pl-split'; split.append(BF.ui.splitter({ cssVar: '--picker-w', min: 90, max: 420, key: 'beatforge.pickerWidth', def: 150 }));
    main.append(picker, split, scroller);
    panel = document.createElement('div');
    panel.className = 'clip-panel';
    panel.hidden = true;
    root.append(toolbar, main, panel);

    scroller.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = scroller.getBoundingClientRect();
        const beat = (e.clientX - r.left - HEADW + scroller.scrollLeft) / px;
        setZoom(px * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
        scroller.scrollLeft = beat * px - (e.clientX - r.left - HEADW);
      }
    }, { passive: false });
    scroller.addEventListener('keydown', keys);
    P.watchScroll();
    // ruler: click = set the start position (and clear the loop); drag = select a loop region
    ruler.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const b0 = Math.max(0, snap(xToBeat(e.clientX), 'floor'));
      const x0 = e.clientX;
      let dragged = false;
      ruler.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!dragged && Math.abs(ev.clientX - x0) < 5) return;
        dragged = true;
        const b1 = Math.max(0, snap(xToBeat(ev.clientX)));
        const s = Math.min(b0, b1), en = Math.max(b0, b1);
        BF.transport.loop = en - s >= (P.snap || 0.25) ? { start: s, end: en } : null;
        drawLoop();
      };
      const up = () => {
        ruler.removeEventListener('pointermove', move); ruler.removeEventListener('pointerup', up);
        if (!dragged) { BF.transport.loop = null; BF.transport.startBeat = b0; drawLoop(); }
        else if (BF.transport.loop) BF.transport.startBeat = BF.transport.loop.start;
        if (BF.transport.playing && BF.transport.mode === 'song') { BF.transport.stop(); setTimeout(BF.transport.play, 30); }
        BF.emit('transport');
      };
      ruler.addEventListener('pointermove', move);
      ruler.addEventListener('pointerup', up);
    });
    ruler.addEventListener('dblclick', () => { BF.transport.loop = null; drawLoop(); BF.emit('transport'); });
    P.setTool('draw');
    return root;
  };

  P.setTool = function (t) {
    P.tool = t;
    toolbar.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  };

  function setZoom(z) { px = Math.min(120, Math.max(4, z)); P.render(); }
  const snap = (b, mode = 'round') => (P.snap ? Math[mode](b / P.snap + 1e-6) * P.snap : Math.round(b * 100) / 100);
  const xToBeat = (clientX) => (clientX - tracksEl.getBoundingClientRect().left - HEADW) / px;
  const trackAt = (clientY) => {
    const r = tracksEl.getBoundingClientRect();
    return Math.min(BF.TRACKS - 1, Math.max(0, Math.floor((clientY - r.top) / TRACKH)));
  };
  function firstFreeTrack() {
    const used = new Set(BF.project.clips.map((c) => c.track));
    for (let i = 0; i < BF.TRACKS; i++) if (!used.has(i)) return i;
    return 0;
  }
  const clipLen = (c) => BF.audio.clipBeats(c);

  // ---------- picker ----------
  function renderPicker() {
    const p = BF.project;
    picker.textContent = '';
    const h1 = document.createElement('div'); h1.className = 'pk-h'; h1.textContent = 'Patterns';
    picker.append(h1);
    p.patterns.forEach((pt) => {
      const b = document.createElement('button');
      b.className = 'pk-item';
      b.style.setProperty('--c', pt.color);
      b.textContent = pt.name;
      const picked = P.pick.kind === 'pattern' && p.currentPattern === pt.id;
      b.setAttribute('aria-pressed', String(picked));
      b.title = 'Click: pick this pattern to draw. Double-click: rename. Right-click: options.';
      b.addEventListener('click', () => { P.pick = { kind: 'pattern' }; BF.setView((q) => { q.currentPattern = pt.id; }, 'pattern'); });
      b.addEventListener('dblclick', () => BF.patterns.rename(pt.id));
      b.draggable = true;
      b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-beatforge', JSON.stringify({ kind: 'pattern', patternId: pt.id })); e.dataTransfer.effectAllowed = 'copy'; });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); BF.ui.menu(e.clientX, e.clientY, BF.patterns.menu(pt.id)); });
      picker.append(b);
    });
    const add = document.createElement('button');
    add.className = 'pk-item add';
    add.textContent = '+ New pattern';
    add.addEventListener('click', () => BF.patterns.add());
    picker.append(add);
    const ids = Object.keys(p.samples).filter((id) => BF.audio.buffers.has(id));
    if (ids.length) {
      const h2 = document.createElement('div'); h2.className = 'pk-h'; h2.textContent = 'Audio';
      picker.append(h2);
      ids.forEach((id) => {
        const b = document.createElement('button');
        b.className = 'pk-item audio';
        b.textContent = p.samples[id].name;
        b.setAttribute('aria-pressed', String(P.pick.kind === 'audio' && P.pick.sampleId === id));
        b.title = 'Click: pick this audio to draw in the playlist. It plays when clicked.';
        b.draggable = true;
        b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-beatforge', JSON.stringify({ kind: 'audio', sampleId: id })); e.dataTransfer.effectAllowed = 'copy'; });
        b.addEventListener('click', () => {
          P.pick = { kind: 'audio', sampleId: id };
          BF.audio.previewClip({ kind: 'audio', sampleId: id, mode: 'resample', speed: 1, pitch: 0, len: 0, track: 0 });
          renderPicker();
        });
        picker.append(b);
      });
    }
  }

  // ---------- main render ----------
  P.render = function () {
    if (!root) return;
    const p = BF.project;
    renderPicker();
    const end = Math.max(BF.songEndBeat(), 64) + 32;
    const W = end * px;
    inner.style.width = `${HEADW + W}px`;
    const scrollL = scroller.scrollLeft, scrollT = scroller.scrollTop;
    const hadFocus = root.contains(document.activeElement) && !panel.contains(document.activeElement);

    // ruler
    ruler.textContent = '';
    ruler.style.width = `${HEADW + W}px`;
    const corner = document.createElement('div');
    corner.className = 'pl-corner';
    corner.textContent = 'Click bar to set start';
    ruler.append(corner);
    const bb = BF.barBeats();
    const every = px * bb < 26 ? 4 : px * bb < 50 ? 2 : 1;
    for (let b = 0; b < end / bb; b += every) {
      const n = document.createElement('div');
      n.className = 'bar-num';
      n.style.left = `${HEADW + b * bb * px}px`;
      n.textContent = String(b + 1);
      ruler.append(n);
    }
    const sEnd = document.createElement('div');
    sEnd.className = 'song-end';
    sEnd.style.left = `${HEADW + BF.songEndBeat() * px}px`;
    sEnd.title = 'Song end (loops here)';
    ruler.append(sEnd);
    loopEl = document.createElement('div');
    loopEl.className = 'loop-region';
    loopEl.title = 'Loop region (Song mode). Double-click the ruler to remove it.';
    ruler.append(loopEl);
    if (loopShade) loopShade.remove(); // one shade only (it used to pile up on every redraw until it looked solid)
    loopShade = document.createElement('div');
    loopShade.className = 'loop-shade';
    inner.append(loopShade);
    drawLoop();
    (p.markers || []).forEach((m, mi) => {
      const mk = document.createElement('div');
      mk.className = 'time-marker';
      mk.style.left = `${HEADW + m.beat * px}px`;
      mk.textContent = m.name;
      mk.title = `${m.name}. Click: jump here. Right-click: rename or remove. (Alt+T adds a marker, Alt+* / Alt+/ jump)`;
      mk.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      mk.addEventListener('click', (ev) => { ev.stopPropagation(); BF.transport.startBeat = m.beat; if (BF.transport.playing) { BF.transport.stop(); BF.transport.play(); } BF.emit('transport'); });
      mk.addEventListener('contextmenu', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        BF.ui.menuAt(mk, [
          { label: 'Rename…', action: async () => { const n = await BF.ui.prompt('Marker name', m.name); if (n) BF.commit((q) => { q.markers[mi].name = n.slice(0, 40); }); } },
          { label: 'Remove', action: () => BF.commit((q) => { q.markers.splice(mi, 1); }) },
        ]);
      });
      ruler.append(mk);
    });
    const start = document.createElement('div');
    start.className = 'start-mark';
    start.style.left = `${HEADW + BF.transport.startBeat * px}px`;
    ruler.append(start);

    // tracks
    tracksEl.textContent = '';
    p.tracks.forEach((t, ti) => {
      const row = document.createElement('div');
      row.className = 'pl-trk';
      row.style.height = `${TRACKH}px`;
      const head = document.createElement('div');
      head.className = 'pl-trk-head';
      const m = document.createElement('button');
      m.className = 'led';
      m.setAttribute('aria-pressed', String(!t.mute));
      m.setAttribute('aria-label', `${t.name} on/off`);
      m.addEventListener('click', () => BF.commit((q) => { q.tracks[ti].mute = !q.tracks[ti].mute; }));
      const nm = document.createElement('span');
      nm.className = 'trk-name';
      nm.textContent = t.name;
      nm.title = 'Double-click to rename';
      nm.addEventListener('dblclick', async () => { const n = await BF.ui.prompt('Track name', t.name); if (n) BF.commit((q) => { q.tracks[ti].name = n; }); });
      const ins = document.createElement('input');
      ins.type = 'number'; ins.min = 0; ins.max = BF.INSERTS; ins.value = t.insert || 0; ins.className = 'rack-ins';
      ins.title = 'Mixer insert for audio clips on this track (0 = Master)';
      ins.setAttribute('aria-label', `${t.name} mixer insert for audio`);
      ins.addEventListener('change', () => BF.commit((q) => { q.tracks[ti].insert = Math.round(BF.clamp(ins.value, 0, BF.INSERTS, 0)); }));
      head.append(m, nm, ins);
      const lane = document.createElement('div');
      lane.className = 'pl-lane' + (t.mute ? ' muted' : '');
      lane.style.width = `${W}px`;
      lane.style.backgroundSize = `${px * BF.barBeats() * 4}px 100%, ${px * BF.barBeats()}px 100%, ${px}px 100%`;
      lane.dataset.track = ti;
      lane.addEventListener('pointerdown', laneDown);
      lane.addEventListener('contextmenu', (e) => e.preventDefault());
      lane.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files') || BF.browser.isDrag(e)) { e.preventDefault(); lane.classList.add('drop'); } });
      lane.addEventListener('dragleave', () => lane.classList.remove('drop'));
      lane.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        lane.classList.remove('drop');
        const pl = BF.browser.payload(e);
        const at = Math.max(0, snap(xToBeat(e.clientX), 'floor'));
        if (pl && pl.kind === 'audio') { P.pick = { kind: 'audio', sampleId: pl.sampleId }; place(ti, at); return; }
        if (pl && pl.kind === 'file') { BF.files.dropOnPlaylist(pl, ti, at); return; }
        if (pl && pl.kind === 'pattern') { P.pick = { kind: 'pattern' }; BF.setView((q) => { q.currentPattern = pl.patternId; }, 'pattern'); place(ti, at); return; }
        if (pl && pl.kind === 'instrument') { BF.rack.addChannel(pl.plugin, pl.preset, pl.name); BF.win.toggle('rack', true); return; }
        if (pl) return;
        const files = [...(e.dataTransfer?.files || [])];
        if (files.length) BF.io.importToPlaylist(files, ti, Math.max(0, snap(xToBeat(e.clientX), 'floor')));
      });
      p.clips.filter((c) => c.track === ti).forEach((c) => lane.append(clipEl(c)));
      row.append(head, lane);
      tracksEl.append(row);
    });
    if (drag && drag.type === 'box') { /* box drawn by drag handler */ }
    scroller.scrollLeft = scrollL;
    scroller.scrollTop = scrollT;
    if (hadFocus && !root.contains(document.activeElement)) scroller.focus({ preventScroll: true });
    if (!BF.ui.knobDrag) renderPanel();
    P.drawPlayhead(BF.transport.position());
  };

  function clipEl(c) {
    const p = BF.project;
    const el = document.createElement('button');
    el.className = 'pclip ' + c.kind + (P.sel.has(c.id) ? ' sel' : '') + (c.muted ? ' muted' : '');
    el.dataset.id = c.id;
    const len = clipLen(c);
    el.style.left = `${c.start * px}px`;
    el.style.width = `${Math.max(4, len * px)}px`;
    let name;
    if (c.kind === 'pattern') {
      const pt = p.patterns.find((x) => x.id === c.patternId);
      name = pt ? pt.name : '?';
      el.style.setProperty('--c', pt ? pt.color : '#888');
    } else if (c.kind === 'auto') {
      const d = BF.auto.describe(c.target);
      name = `⟋ ${d ? d.name : 'missing'}`;
    } else {
      const s = p.samples[c.sampleId];
      name = s ? s.name : 'missing';
      const sp = BF.audio.clipSpeed(c);
      if (c.mode === 'fit') name += ' · fit';
      else if (Math.abs(sp - 1) > 0.004) name += ` · ${Math.round(sp * 100)}%`;
      if (c.pitch) name += ` · ${c.pitch > 0 ? '+' : ''}${c.pitch} st`;
      if (c.mode === 'resample') name += ' · resample';
      if (c.takes) name = `${name.replace(/ take \d+(?= ·|$)/, '')} · take ${c.takes.indexOf(c.sampleId) + 1}/${c.takes.length}`;
    }
    const cv0 = c.kind === 'pattern' ? c.vol ?? 1 : c.gain ?? 1; // this clip's own volume
    if (Math.abs(cv0 - 1) > 0.004) name += ` · vol ${Math.round(cv0 * 100)}%`;
    const label = document.createElement('span');
    label.textContent = name;
    el.append(label);
    if (c.kind === 'pattern') {
      const cv = document.createElement('canvas');
      el.prepend(cv);
      requestAnimationFrame(() => drawPatternMini(cv, c));
    } else if (c.kind === 'auto') {
      const cv = document.createElement('canvas');
      el.prepend(cv);
      requestAnimationFrame(() => BF.auto.drawMini(cv, c));
    } else {
      const cv = document.createElement('canvas');
      el.prepend(cv);
      requestAnimationFrame(() => drawWave(cv, c));
    }
    const edge = document.createElement('i');
    edge.className = 'pclip-edge';
    edge.title = 'Drag to resize. Shift+drag: stretch audio.';
    el.append(edge);
    el.setAttribute('aria-label', `${{ pattern: 'Pattern', audio: 'Audio', auto: 'Automation' }[c.kind]} clip ${name}, track ${c.track + 1}, bar ${Math.floor(c.start / BF.barBeats() + 1e-9) + 1}. Arrows move, Delete removes, Enter opens.`);
    el.addEventListener('pointerdown', (e) => clipDown(e, c, e.target === edge));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dblclick', () => openClip(c));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openClip(c); } });
    el.addEventListener('focus', () => { if (!P.sel.has(c.id)) { P.sel = new Set([c.id]); markSel(); renderPanel(); } });
    return el;
  }

  function openClip(c) {
    if (c.kind === 'auto') { BF.auto.open(c.id); return; }
    if (c.kind === 'pattern') {
      BF.setView((q) => { q.currentPattern = c.patternId; }, 'pattern');
      BF.win.toggle('rack', true);
    } else BF.sampleEditor.open(c.sampleId); // audio: open it in the audio editor
  }

  function markSel() { tracksEl.querySelectorAll('.pclip').forEach((x) => x.classList.toggle('sel', P.sel.has(x.dataset.id))); }

  // ---------- pointer handling ----------
  function laneDown(e) {
    if (e.target !== e.currentTarget) return;
    scroller.focus({ preventScroll: true });
    const ti = +e.currentTarget.dataset.track;
    const beat = Math.max(0, snap(xToBeat(e.clientX), 'floor'));
    if (e.button === 2 || P.tool === 'delete') { startErase(e); return; }
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || P.tool === 'select') { startBox(e); return; }
    if (P.tool === 'slice' || P.tool === 'mute') return;
    const c = place(ti, beat);
    if (!c) return;
    if (P.tool === 'paint') {
      const key = `paint-${e.timeStamp}`;
      let last = beat;
      track(e, (ev) => {
        const b = Math.max(0, snap(xToBeat(ev.clientX), 'floor'));
        const len = c.kind === 'pattern' ? c.len : clipLen(c);
        if (b >= last + len - 1e-6) { last = b; place(ti, b, key); }
      });
    } else {
      P.sel = new Set([c.id]);
      startMove(e, c, beat);
    }
  }

  function place(ti, beat, key = null) {
    const p = BF.project;
    let c;
    if (P.pick.kind === 'audio' && p.samples[P.pick.sampleId]) {
      c = { id: BF.uid('c'), kind: 'audio', track: ti, start: beat, len: 0, sampleId: P.pick.sampleId, mode: 'stretch', speed: 1, pitch: 0, srcBpm: p.bpm, gain: 1 };
    } else {
      const pt = BF.pattern();
      if (!pt) return null;
      c = { id: BF.uid('c'), kind: 'pattern', track: ti, start: beat, len: BF.patternBeats(pt), patternId: pt.id };
    }
    BF.commit((q) => q.clips.push(c), key);
    return c;
  }

  function track(e, onMove, onUp) {
    const t = scroller; // stable element: clips are re-rendered while dragging
    t.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(ev);
    const up = (ev) => { t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up); if (onUp) onUp(ev); drag = null; };
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', up);
    t.addEventListener('pointercancel', up);
  }

  function clipDown(e, c, onEdge) {
    e.stopPropagation();
    if (e.button === 2 || P.tool === 'delete') { startErase(e); eraseClip(c.id, `erase-${e.timeStamp}`); return; }
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey) { // toggle selection
      if (P.sel.has(c.id)) P.sel.delete(c.id); else P.sel.add(c.id);
      markSel(); renderPanel();
      return;
    }
    if (P.tool === 'mute') {
      BF.commit((q) => { const k = q.clips.find((x) => x.id === c.id); if (k) k.muted = !k.muted; });
      return;
    }
    if (P.tool === 'slice') {
      const at = snap(xToBeat(e.clientX));
      sliceClip(c, at);
      return;
    }
    if (!P.sel.has(c.id)) { P.sel = new Set([c.id]); markSel(); renderPanel(); }
    if (c.kind === 'pattern' && BF.project.currentPattern !== c.patternId) { P.pick = { kind: 'pattern' }; BF.setView((q) => { q.currentPattern = c.patternId; }, 'pattern'); }
    if (c.kind === 'audio') P.pick = { kind: 'audio', sampleId: c.sampleId };
    if (c.kind === 'auto') BF.auto.open(c.id);
    const beat = xToBeat(e.clientX);
    if (onEdge) startResize(e, c, e.shiftKey);
    else {
      if (e.shiftKey) { // duplicate selection, move the copies
        const copies = BF.project.clips.filter((x) => P.sel.has(x.id)).map((x) => ({ ...x, id: BF.uid('c') }));
        BF.commit((q) => q.clips.push(...copies));
        P.sel = new Set(copies.map((x) => x.id));
        const twin = copies.find((x) => x.start === c.start && x.track === c.track) || copies[0];
        startMove(e, twin, beat, true);
      } else startMove(e, c, beat);
    }
  }

  function startMove(e, c, beat0) {
    const key = `move-${e.timeStamp}`;
    const orig = BF.project.clips.filter((x) => P.sel.has(x.id)).map((x) => ({ id: x.id, start: x.start, track: x.track }));
    const t0 = c.track;
    let moved = false;
    drag = { type: 'move' };
    const x0 = e.clientX, y0 = e.clientY;
    track(e, (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      let db = xToBeat(ev.clientX) - beat0;
      db = P.snap ? Math.round(db / P.snap) * P.snap : db;
      const minStart = Math.min(...orig.map((o) => o.start));
      db = Math.max(-minStart, db);
      const dt = trackAt(ev.clientY) - t0;
      const minT = Math.min(...orig.map((o) => o.track)), maxT = Math.max(...orig.map((o) => o.track));
      const dtt = Math.max(-minT, Math.min(BF.TRACKS - 1 - maxT, dt));
      BF.commit((q) => orig.forEach((o) => { const k = q.clips.find((x) => x.id === o.id); if (k) { k.start = o.start + db; k.track = o.track + dtt; } }), key, 'clips');
    });
  }

  function startResize(e, c, stretch) {
    const key = `size-${e.timeStamp}`;
    const p = BF.project;
    const buf = c.kind === 'audio' ? BF.audio.buffers.get(c.sampleId) : null;
    drag = { type: 'size' };
    track(e, (ev) => {
      let endB = xToBeat(ev.clientX);
      endB = P.snap ? Math.round(endB / P.snap) * P.snap : endB;
      const len = Math.max(P.snap || 0.25, endB - c.start);
      BF.commit((q) => {
        const k = q.clips.find((x) => x.id === c.id);
        if (!k) return;
        if (k.kind !== 'audio') { k.len = len; return; }
        if (stretch && buf) {
          // Shift: stretch the whole audio to `len` beats
          const beatsAt1 = (buf.duration * p.bpm) / 60;
          k.speed = BF.clamp(beatsAt1 / len, 0.25, 4, 1);
          if (k.mode === 'fit') k.mode = 'stretch';
          k.len = 0;
        } else {
          const nat = (BF.audio.clipNaturalSec(k, p.bpm) * p.bpm) / 60;
          k.len = len >= nat - 1e-3 ? 0 : len;
        }
      }, key, 'clips');
    }, () => { if (stretch) BF.ui.toast('Stretched. Tempo changed, pitch kept. Use the clip panel to switch to Resample.'); });
  }

  function startErase(e) {
    const key = `erase-${e.timeStamp}`;
    drag = { type: 'erase' };
    track(e, (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.pclip');
      if (el) eraseClip(el.dataset.id, key);
    });
  }
  function eraseClip(id, key) {
    if (!BF.project.clips.some((c) => c.id === id)) return;
    P.sel.delete(id);
    BF.commit((q) => { q.clips = q.clips.filter((c) => c.id !== id); }, key);
  }

  function startBox(e) {
    const box = document.createElement('div');
    box.className = 'sel-box';
    inner.append(box);
    const r0 = inner.getBoundingClientRect();
    const x0 = e.clientX - r0.left, y0 = e.clientY - r0.top;
    if (!e.shiftKey) P.sel.clear();
    drag = { type: 'box' };
    track(e, (ev) => {
      const r = inner.getBoundingClientRect();
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      Object.assign(box.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    }, (ev) => {
      const br = box.getBoundingClientRect();
      tracksEl.querySelectorAll('.pclip').forEach((el) => {
        const cr = el.getBoundingClientRect();
        if (cr.right > br.left && cr.left < br.right && cr.bottom > br.top && cr.top < br.bottom) P.sel.add(el.dataset.id);
      });
      box.remove();
      markSel(); renderPanel();
      void ev;
    });
  }

  P.sliceClip = (c, at) => sliceClip(c, at);
  function sliceClip(c, at) {
    const len = clipLen(c);
    if (at <= c.start + 0.01 || at >= c.start + len - 0.01) return;
    if (c.kind === 'audio') { // audio: two clips, the right one starts later in the same audio (keeps its takes: comping)
      BF.commit((q) => {
        const k = q.clips.find((x) => x.id === c.id);
        const leftLen = at - k.start;
        const right = { ...k, id: BF.uid('c'), start: at, len: k.len > 0 ? k.start + k.len - at : 0, trim: (k.trim || 0) + (BF.tempoMap(q).sec(at) - BF.tempoMap(q).sec(k.start)) };
        if (k.takes) right.takes = [...k.takes];
        delete right.fadeIn; delete k.fadeOut;
        k.len = leftLen;
        q.clips.push(right);
        P.sel = new Set([right.id]);
      }, null, 'clips');
      return;
    }
    if (c.kind !== 'pattern') { BF.ui.toast('Automation clips can not be sliced. Trim them with the right edge instead.'); return; }
    BF.commit((q) => {
      const k = q.clips.find((x) => x.id === c.id);
      const right = { ...k, id: BF.uid('c'), start: at, len: k.start + k.len - at };
      k.len = at - k.start;
      // the right half should continue inside the pattern, so we make it a new pattern copy that starts later
      const pt = q.patterns.find((x) => x.id === k.patternId);
      const offSteps = Math.round(k.len * 4);
      if (pt && offSteps > 0 && offSteps < pt.length) {
        const np = BF.patterns.sliceCopy(q, pt, offSteps);
        right.patternId = np.id;
      }
      q.clips.push(right);
    });
  }

  // ---------- more classic-DAW keys ----------
  let clipboard = null, lastSnap = 1;
  P.toggleSnap = function () {
    if (P.snap) { lastSnap = P.snap; P.snap = 0; } else P.snap = lastSnap || 1;
    if (snapSel) snapSel.value = String(P.snap);
    BF.ui.toast(P.snap ? 'Snap on' : 'Snap off');
  };
  function moreKeys(e, mod, k, sel) {
    const K = k.toLowerCase();
    const stop = () => { e.preventDefault(); e.stopPropagation(); return true; };
    const p = BF.project;
    const editSel = (fn, msg) => { const s = sel(); if (!s.length) { BF.ui.toast('Select clips first (Ctrl+drag or the Select tool).'); return; } const ids = new Set(s.map((c) => c.id)); BF.commit((q) => q.clips.forEach((c) => { if (ids.has(c.id)) fn(c); })); if (msg) BF.ui.toast(msg); };
    if (e.altKey && !mod && K === 'm') { stop(); editSel((c) => { if (e.shiftKey) delete c.muted; else c.muted = true; }); return true; }
    if (e.altKey && !mod && K === 'p') { stop(); BF.win.toggle('picker'); return true; }
    if (e.shiftKey && !mod && !e.altKey) {
      if (K === 'i') { stop(); P.sel = new Set(p.clips.filter((c) => !P.sel.has(c.id)).map((c) => c.id)); markSel(); renderPanel(); return true; }
      if (K === 'c') { // all clips of the same pattern / audio as the selection
        stop();
        const src = new Set(sel().map((c) => c.patternId || c.sampleId));
        P.sel = new Set(p.clips.filter((c) => src.has(c.patternId || c.sampleId)).map((c) => c.id)); markSel(); renderPanel();
        return true;
      }
      if (K === 'q') { stop(); const q = P.snap || 1; editSel((c) => { c.start = Math.max(0, Math.round(c.start / q) * q); }, 'Clip starts quantized'); return true; }
      if (K === 'm') { // switch stretch mode of selected audio clips
        stop();
        const order = ['stretch', 'resample', 'fit'];
        const first = sel().find((c) => c.kind === 'audio');
        if (!first) { BF.ui.toast('Select an audio clip first.'); return true; }
        const next = order[(order.indexOf(first.mode) + 1) % order.length];
        editSel((c) => { if (c.kind === 'audio') { c.mode = next; c.len = 0; } }, `Stretch mode: ${{ stretch: 'Stretch (keep pitch)', resample: 'Resample', fit: 'Fit to tempo' }[next]}`);
        return true;
      }
    }
    if (!mod && !e.altKey && !e.shiftKey && (k === '7' || k === '8')) { stop(); editSel((c) => { if (c.kind === 'audio') c.pitch = Math.max(-24, Math.min(24, (c.pitch || 0) + (k === '8' ? 1 : -1))); }); return true; }
    if (!mod && !e.altKey && !e.shiftKey && k === '9') { stop(); editSel((c) => { if (c.kind === 'audio') { if (c.reverse) delete c.reverse; else c.reverse = true; } }, 'Reversed'); return true; }
    if (!mod && !e.altKey && k === 'Insert') { // slice the selected clips at the play position
      stop();
      const at = BF.transport.playing ? BF.transport.position() : BF.transport.startBeat || 0;
      sel().forEach((c) => sliceClip(BF.project.clips.find((x) => x.id === c.id), at));
      return true;
    }
    if (!mod && k === 'Home') { stop(); BF.transport.startBeat = 0; if (BF.transport.playing) { BF.transport.stop(); BF.transport.play(); } BF.emit('transport'); return true; }
    if (!mod && !e.altKey && k === 'Backspace') { stop(); P.toggleSnap(); return true; }
    if (!mod && (k === 'PageUp' || k === 'PageDown')) { stop(); setZoom(px * (k === 'PageUp' ? 1.25 : 0.8)); return true; }
    if (mod && !e.shiftKey && K === 'd') { stop(); P.sel.clear(); markSel(); renderPanel(); return true; }
    if (mod && !e.shiftKey && (K === 'c' || K === 'x')) {
      stop();
      const s = sel();
      if (!s.length) return true;
      const min = Math.min(...s.map((c) => c.start)), max = Math.max(...s.map((c) => c.start + clipLen(c)));
      clipboard = { clips: s.map((c) => ({ ...c, start: c.start - min })), span: max - min };
      if (K === 'x') { const ids = new Set(s.map((c) => c.id)); P.sel.clear(); BF.commit((q) => { q.clips = q.clips.filter((c) => !ids.has(c.id)); }); }
      BF.ui.toast(`${s.length} clip${s.length > 1 ? 's' : ''} ${K === 'x' ? 'cut' : 'copied'}`);
      return true;
    }
    if (mod && !e.shiftKey && K === 'v') {
      stop();
      if (!clipboard) return true;
      const at0 = BF.transport.playing ? BF.transport.position() : (BF.transport.startBeat || 0);
      const at = P.snap ? Math.round(at0 / P.snap) * P.snap : at0;
      const copies = clipboard.clips.map((c) => ({ ...c, id: BF.uid('c'), start: c.start + at }));
      BF.commit((q) => q.clips.push(...copies));
      P.sel = new Set(copies.map((c) => c.id)); markSel(); renderPanel();
      return true;
    }
    return false;
  }

  // ---------- keyboard ----------
  function keys(e) {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const sel = () => BF.project.clips.filter((c) => P.sel.has(c.id));
    if (k === 'Delete' && !mod) {
      if (!P.sel.size) return;
      e.preventDefault(); e.stopPropagation();
      const ids = new Set(P.sel); P.sel.clear();
      BF.commit((q) => { q.clips = q.clips.filter((c) => !ids.has(c.id)); });
    } else if (mod && k.toLowerCase() === 'b') { // duplicate after the selection
      e.preventDefault(); e.stopPropagation();
      const s = sel();
      if (!s.length) return;
      const min = Math.min(...s.map((c) => c.start)), max = Math.max(...s.map((c) => c.start + clipLen(c)));
      const span = Math.ceil((max - min) / (P.snap || 1) - 1e-6) * (P.snap || 1);
      const copies = s.map((c) => ({ ...c, id: BF.uid('c'), start: c.start + span }));
      BF.commit((q) => q.clips.push(...copies));
      P.sel = new Set(copies.map((c) => c.id));
      markSel();
    } else if (mod && k.toLowerCase() === 'a') {
      e.preventDefault(); e.stopPropagation();
      P.sel = new Set(BF.project.clips.map((c) => c.id)); markSel(); renderPanel();
    } else if ((k === 'ArrowLeft' || k === 'ArrowRight') && P.sel.size) {
      e.preventDefault(); e.stopPropagation();
      const d = (k === 'ArrowLeft' ? -1 : 1) * (P.snap || 1);
      BF.commit((q) => q.clips.forEach((c) => { if (P.sel.has(c.id)) c.start = Math.max(0, c.start + d); }), `arrow-${k}`);
    } else if ((k === 'ArrowUp' || k === 'ArrowDown') && P.sel.size) {
      e.preventDefault(); e.stopPropagation();
      const d = k === 'ArrowUp' ? -1 : 1;
      BF.commit((q) => q.clips.forEach((c) => { if (P.sel.has(c.id)) c.track = Math.min(BF.TRACKS - 1, Math.max(0, c.track + d)); }), `arrow-${k}`);
    } else if (moreKeys(e, mod, k, sel)) {
      // handled
    } else if (!mod && !e.altKey && !e.shiftKey) {
      const t = { p: 'draw', b: 'paint', d: 'delete', c: 'slice', e: 'select', t: 'mute' }[k.toLowerCase()];
      if (t) { e.preventDefault(); e.stopPropagation(); P.setTool(t); }
    }
  }

  // ---------- render selected clips to one audio clip (consolidate) ----------
  P.renderToAudio = async function () {
    const p = BF.project;
    const s = p.clips.filter((c) => P.sel.has(c.id) && (c.kind === 'pattern' || c.kind === 'audio') && !c.muted);
    if (!s.length) { BF.ui.toast('Select pattern or audio clips first.'); return; }
    const from = Math.min(...s.map((c) => c.start));
    const to = Math.max(...s.map((c) => c.start + clipLen(c)));
    if (to - from <= 0) return;
    BF.ui.busy('Rendering to audio…');
    try {
      // only the selected clips, through the mixer as usual (track mutes ignored, like soloing them) but not through
      // the Master insert: the new clip plays through the Master again, so its effects and volume must not apply twice
      const tmp = { ...p, clips: s.map((c) => ({ ...c })), tracks: p.tracks.map((t) => ({ ...t, mute: false })), mixer: p.mixer.map((m, i) => (i ? m : { ...m, fx: [], volume: 1, pan: 0, mute: false })) };
      const buf = await BF.renderRange(tmp, from, to, 44100, 0);
      const blob = BF.encodeWav(buf);
      const id = BF.uid('s');
      const names = [...new Set(s.map((c) => (c.kind === 'pattern' ? p.patterns.find((x) => x.id === c.patternId)?.name : p.samples[c.sampleId]?.name) || 'Clip'))];
      const sample = { name: `${names.slice(0, 2).join(' + ')}${names.length > 2 ? ' …' : ''} (rendered)`.slice(0, 120), mime: 'audio/wav', base64: BF.io._b64.bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
      BF.audio.buffers.set(id, buf);
      // first track below the selection with room for the new clip
      const free = (t) => !p.clips.some((c) => c.track === t && c.start < to - 1e-6 && c.start + clipLen(c) > from + 1e-6);
      const top = Math.max(...s.map((c) => c.track));
      let track = -1;
      for (let t = top + 1; t < BF.TRACKS && track < 0; t++) if (free(t)) track = t;
      for (let t = 0; t <= top && track < 0; t++) if (free(t)) track = t;
      if (track < 0) throw new Error('No free playlist track for the rendered clip.');
      const clip = { id: BF.uid('c'), kind: 'audio', track, start: from, len: 0, sampleId: id, mode: 'resample', speed: 1, pitch: 0, srcBpm: p.bpm, gain: 1 };
      const ids = new Set(s.map((c) => c.id));
      BF.commit((q) => { q.samples[id] = sample; q.clips.forEach((c) => { if (ids.has(c.id)) c.muted = true; }); q.clips.push(clip); });
      P.sel = new Set([clip.id]); markSel(); renderPanel();
      BF.ui.toast(`Rendered to an audio clip on ${p.tracks[track].name}. The original clips are muted (Alt+Shift+M to unmute).`);
    } catch (e) {
      BF.ui.toast(e.message || String(e), true);
    } finally { BF.ui.busy(null); }
  };

  // ---------- selected audio clip panel ----------
  function renderPanel() {
    if (BF.mixer && BF.mixer.tab === 'sources' && BF.win && BF.win.isOpen('mixer')) BF.mixer.render(); // its "Selected clips" follow the selection
    const p = BF.project;
    const c = P.sel.size === 1 ? p.clips.find((x) => P.sel.has(x.id) && x.kind === 'audio') : null;
    const any = p.clips.some((x) => P.sel.has(x.id) && (x.kind === 'pattern' || x.kind === 'audio'));
    panel.hidden = !c && !any;
    panel.textContent = '';
    const rend = document.createElement('button'); rend.className = 'btn small'; rend.textContent = '⤓ Render to audio';
    rend.title = 'Turn the selected clips into one audio clip (consolidate). The originals are muted, not deleted.';
    rend.addEventListener('click', () => P.renderToAudio());
    if (!c) {
      if (!any) return;
      const pc = P.sel.size === 1 ? p.clips.find((x) => P.sel.has(x.id) && x.kind === 'pattern') : null;
      const t = document.createElement('strong');
      t.textContent = pc ? (p.patterns.find((x) => x.id === pc.patternId)?.name || 'Pattern') : `${P.sel.size} clip${P.sel.size > 1 ? 's' : ''} selected`;
      panel.append(t);
      if (pc) { // this clip only: the other clips of the same pattern keep their volume
        const vol = BF.ui.knob({ param: { name: 'Volume', min: 0, max: 1, default: 1, fmt: BF.plugins.util.pct }, value: pc.vol ?? 1, onInput: (v) => BF.commit((q) => { const k = q.clips.find((x) => x.id === pc.id); if (k) { if (Math.abs(v - 1) < 0.004) delete k.vol; else k.vol = v; } }, `cvol-${pc.id}`, 'clips') });
        vol.el.classList.add('inline'); vol.el.title = 'Volume of this clip only (the other clips of this pattern are not changed)';
        panel.append(vol.el);
      }
      panel.append(rend);
      return;
    }
    const s = p.samples[c.sampleId];
    const name = document.createElement('strong'); name.textContent = s ? s.name : 'Audio';
    const mode = document.createElement('select');
    mode.setAttribute('aria-label', 'Stretch mode');
    [['stretch', 'Stretch (keep pitch)'], ['resample', 'Resample (pitch follows speed)'], ['fit', 'Fit to tempo']].forEach(([v, l]) => mode.add(new Option(l, v)));
    mode.value = c.mode;
    mode.addEventListener('change', () => BF.commit((q) => { const k = q.clips.find((x) => x.id === c.id); k.mode = mode.value; k.len = 0; }));
    const upd = (f, key) => BF.commit((q) => { const k = q.clips.find((x) => x.id === c.id); if (k) f(k); }, key, 'clips');
    const speed = BF.ui.knob({ param: { name: 'Speed', min: 0.25, max: 4, default: 1, curve: 'log', fmt: (v) => `${Math.round(v * 100)}%` }, value: BF.audio.clipSpeed(c), onInput: (v) => upd((k) => { k.speed = v; if (k.mode === 'fit') k.mode = 'stretch'; k.len = 0; }, `spd-${c.id}`) });
    const pitch = BF.ui.knob({ param: { name: 'Pitch', min: -24, max: 24, default: 0, step: 1, unit: ' st' }, value: c.pitch || 0, onInput: (v) => upd((k) => { k.pitch = v; }, `pit-${c.id}`) });
    const gain = BF.ui.knob({ param: { name: 'Gain', min: 0, max: 2, default: 1, fmt: BF.plugins.util.pct }, value: c.gain ?? 1, onInput: (v) => upd((k) => { k.gain = v; }, `gain-${c.id}`) });
    const bpmL = document.createElement('label'); bpmL.className = 'field'; bpmL.textContent = 'Sample BPM ';
    const bpm = document.createElement('input'); bpm.type = 'number'; bpm.min = 40; bpm.max = 300; bpm.step = 0.01; bpm.value = c.srcBpm;
    bpm.title = 'The tempo the audio was recorded at. Fit to tempo stretches it to the project tempo.';
    bpm.addEventListener('change', () => BF.commit((q) => { const k = q.clips.find((x) => x.id === c.id); k.srcBpm = BF.clamp(bpm.value, 40, 300, 120); k.mode = 'fit'; k.len = 0; }));
    bpmL.append(bpm);
    const guess = document.createElement('button');
    guess.className = 'btn small'; guess.textContent = 'Guess BPM';
    guess.title = 'Assumes the audio is a whole number of bars (1, 2, 4, 8…) and works out its tempo';
    guess.addEventListener('click', () => {
      const buf = BF.audio.buffers.get(c.sampleId);
      if (!buf) return;
      let best = null;
      for (const bars of [1, 2, 4, 8, 16, 32]) {
        const t = (bars * 4 * 60) / buf.duration;
        if (t >= 60 && t <= 200 && (!best || Math.abs(t - p.bpm) < Math.abs(best - p.bpm))) best = t;
      }
      if (!best) { BF.ui.toast('Could not guess a tempo for this length.'); return; }
      BF.commit((q) => { const k = q.clips.find((x) => x.id === c.id); k.srcBpm = Math.round(best * 100) / 100; k.mode = 'fit'; k.len = 0; });
      BF.ui.toast(`Guessed ${best.toFixed(2)} BPM. Fit to tempo is on.`);
    });
    const prev = document.createElement('button'); prev.className = 'btn small'; prev.textContent = '▶ Preview';
    prev.addEventListener('click', () => BF.audio.previewClip(BF.project.clips.find((x) => x.id === c.id)));
    const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = 'Tip: Shift + drag the clip edge to stretch it.';
    speed.el.classList.add('inline'); pitch.el.classList.add('inline'); gain.el.classList.add('inline');
    // more mix options per clip: fades, pan, start offset, reverse
    const srcDur = BF.audio.buffers.get(c.sampleId)?.duration || 1;
    const fadeIn = BF.ui.knob({ param: { name: 'Fade in', min: 0, max: 10, default: 0, fmt: (v) => (v < 0.005 ? 'Off' : BF.plugins.util.sec(v)) }, value: c.fadeIn || 0, onInput: (v) => upd((k) => { if (v > 0.004) k.fadeIn = v; else delete k.fadeIn; }, `fi-${c.id}`) });
    const fadeOut = BF.ui.knob({ param: { name: 'Fade out', min: 0, max: 10, default: 0, fmt: (v) => (v < 0.005 ? 'Off' : BF.plugins.util.sec(v)) }, value: c.fadeOut || 0, onInput: (v) => upd((k) => { if (v > 0.004) k.fadeOut = v; else delete k.fadeOut; }, `fo-${c.id}`) });
    const pan = BF.ui.knob({ param: { name: 'Pan', min: -1, max: 1, default: 0, fmt: (v) => (Math.abs(v) < 0.01 ? 'Centre' : v < 0 ? `${Math.round(-v * 100)}% L` : `${Math.round(v * 100)}% R`) }, value: c.pan || 0, onInput: (v) => upd((k) => { if (Math.abs(v) >= 0.01) k.pan = v; else delete k.pan; }, `pan-${c.id}`) });
    const trim = BF.ui.knob({ param: { name: 'Start', min: 0, max: Math.max(0.1, srcDur - 0.05), default: 0, fmt: BF.plugins.util.sec }, value: c.trim || 0, onInput: (v) => upd((k) => { if (v > 0.001) k.trim = v; else delete k.trim; k.len = 0; }, `trim-${c.id}`) });
    const rev = document.createElement('button'); rev.className = 'btn small'; rev.textContent = '⇆ Reverse';
    rev.setAttribute('aria-pressed', String(!!c.reverse));
    rev.title = 'Play this clip backwards (key 9)';
    rev.addEventListener('click', () => upd((k) => { if (k.reverse) delete k.reverse; else k.reverse = true; }));
    const editA = document.createElement('button'); editA.className = 'btn small'; editA.textContent = '✎ Edit audio…';
    editA.title = 'Open this audio in the audio editor (trim, cut, reverse, fades, normalize)';
    editA.addEventListener('click', () => BF.sampleEditor.open(c.sampleId));
    panel.append(name, mode, speed.el, pitch.el, gain.el, pan.el, fadeIn.el, fadeOut.el, trim.el, rev, bpmL, guess, prev, editA, rend, hint);
    if (c.takes) panel.append(takesView(c));
  }

  /** All takes of a recorded spot, one lane each, lined up in time. Click a lane to hear that take in the song.
   *  Comping: slice the clip (S or the Slice tool) and pick a different take for each piece. */
  function takesView(c) {
    const box = document.createElement('div'); box.className = 'takes';
    const h = document.createElement('strong'); h.textContent = `Takes (${c.takes.length})`;
    const tip = document.createElement('span'); tip.className = 'hint'; tip.textContent = 'Click a take to use it here. Slice the clip to use different takes for different parts.';
    box.append(h, tip);
    c.takes.forEach((id, i) => {
      const row = document.createElement('div'); row.className = 'take-row' + (id === c.sampleId ? ' on' : '');
      const pick = document.createElement('button'); pick.className = 'take-pick';
      pick.setAttribute('aria-pressed', String(id === c.sampleId));
      pick.setAttribute('aria-label', `Use take ${i + 1}`);
      const n = document.createElement('span'); n.textContent = `Take ${i + 1}`;
      const cv = document.createElement('canvas'); cv.className = 'take-wave';
      pick.append(n, cv);
      pick.addEventListener('click', () => BF.commit((q) => { const k = q.clips.find((x) => x.id === c.id); if (k) k.sampleId = id; }, null, 'clips'));
      const play = document.createElement('button'); play.className = 'btn small'; play.textContent = '▶';
      play.title = `Hear take ${i + 1}`;
      play.addEventListener('click', () => BF.audio.previewClip({ ...BF.project.clips.find((x) => x.id === c.id), sampleId: id }));
      const del = document.createElement('button'); del.className = 'btn small'; del.textContent = '✕';
      del.title = 'Remove this take from the clip (the audio stays in the project)';
      del.disabled = id === c.sampleId;
      del.addEventListener('click', () => BF.commit((q) => { const k = q.clips.find((x) => x.id === c.id); if (!k) return; k.takes = k.takes.filter((x) => x !== id); if (k.takes.length < 2) delete k.takes; }, null, 'clips'));
      row.append(pick, play, del);
      box.append(row);
      requestAnimationFrame(() => drawWave(cv, { ...c, sampleId: id }));
    });
    return box;
  }

  // ---------- drawing helpers ----------
  function drawWave(cv, c) {
    const w = Math.max(1, Math.min(6000, cv.clientWidth)), h = cv.clientHeight || 30;
    cv.width = w; cv.height = h;
    const buf = BF.audio.buffers.get(c.sampleId);
    if (!buf) return;
    const fullBeats = ((buf.duration / BF.audio.clipSpeed(c)) * BF.project.bpm) / 60; // the whole sample at the clip's speed
    const shown = clipLen(c) / fullBeats; // fraction of the sample visible
    const from = ((c.trim || 0) * BF.project.bpm) / 60 / fullBeats; // where the clip starts in it (trim, slices)
    const full = Math.max(1, Math.round(w / shown));
    const key = `${c.sampleId}:${full}`;
    let pk = peaks.get(key);
    if (!pk) {
      const d = buf.getChannelData(0);
      pk = new Float32Array(full);
      const per = Math.max(1, Math.floor(d.length / full));
      for (let i = 0; i < full; i++) { let m = 0; const s = i * per; for (let j = 0; j < per; j += 4) { const v = Math.abs(d[s + j] || 0); if (v > m) m = v; } pk[i] = m; }
      if (peaks.size > 200) peaks = new Map();
      peaks.set(key, pk);
    }
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(255,255,255,.75)';
    const o = Math.round(from * full);
    for (let x = 0; x < w; x++) { const a = (pk[x + o] || 0) * (h / 2 - 1); g.fillRect(x, h / 2 - a, 1, Math.max(1, a * 2)); }
  }
  P.drawWave = drawWave;

  function drawPatternMini(cv, c) {
    const w = Math.max(1, Math.min(6000, cv.clientWidth)), h = cv.clientHeight || 30;
    cv.width = w; cv.height = h;
    const pt = BF.project.patterns.find((x) => x.id === c.patternId);
    if (!pt) return;
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,.55)';
    const sw = (px / 4);
    const reps = 1;
    void reps;
    const chans = BF.project.channels;
    const rowH = Math.max(1, (h - 4) / Math.max(1, chans.length));
    chans.forEach((ch, ri) => {
      (pt.steps[ch.id] || []).forEach((on, i) => { if (on && i < pt.length && i * sw < w) g.fillRect(i * sw, 2 + ri * rowH, Math.max(1, sw - 1), Math.max(1, rowH - 1)); });
    });
    const all = chans.flatMap((ch) => pt.notes[ch.id] || []);
    if (all.length) {
      const ks = all.map((n) => n.key), lo = Math.min(...ks), hi = Math.max(...ks);
      all.forEach((n) => { if (n.start < pt.length) g.fillRect(n.start * sw, hi === lo ? h / 2 : 2 + (1 - (n.key - lo) / (hi - lo)) * (h - 6), Math.max(1, n.len * sw - 1), 2); });
    }
  }

  P.drawPlayhead = function (beat) {
    if (playhead) playhead.style.transform = `translateX(${HEADW + beat * px}px)`;
  };
  // Follow the play line while playing, until you scroll yourself (wheel, scrollbar, keys); it follows again from the
  // next time you press Play. Our own scrolling is ignored when deciding that.
  let ownScroll = false, userScrolled = false;
  P.follow = function (beat) {
    if (userScrolled) return;
    const x = HEADW + beat * px;
    if (x > scroller.scrollLeft + scroller.clientWidth - 40 || x < scroller.scrollLeft + HEADW) {
      ownScroll = true;
      scroller.scrollLeft = Math.max(0, x - HEADW - 40);
    }
  };
  P.resetFollow = () => { userScrolled = false; };
  P.watchScroll = function () {
    const mark = () => { if (BF.transport.playing) userScrolled = true; };
    scroller.addEventListener('wheel', mark, { passive: true });
    scroller.addEventListener('scroll', () => { if (ownScroll) { ownScroll = false; return; } mark(); });
    // dragging the scrollbar (a pointerdown on the scroller itself, not on a clip or lane)
    scroller.addEventListener('pointerdown', (e) => { if (e.target === scroller) mark(); });
  };
})();
