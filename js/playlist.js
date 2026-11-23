/* playlist.js: timeline with a ruler, a "pattern" row and 8 audio lanes.
 * Clips are positioned in beats; dragging snaps to 16th steps. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});
  const P = (BF.playlist = { selected: null });
  const PX = 28; // pixels per beat
  const SNAP = 0.25; // beats
  const LABEL_W = 120;
  let root, inner, playhead, rulerTrack;
  const peaksCache = new Map();

  P.PX = PX;

  P.build = function (el) {
    root = el;
    P.render();
  };

  function widthBeats() {
    const p = BF.project;
    let end = p.songBars * 4;
    p.clips.forEach((c) => { end = Math.max(end, c.startBeat + secToBeats(BF.audio.clipSeconds(c))); });
    return Math.ceil(end / 4) * 4 + 8;
  }
  const secToBeats = (sec) => (sec * BF.project.bpm) / 60;

  function gridStyle(div) {
    div.style.backgroundSize = `${PX * 4}px 100%, ${PX}px 100%`;
  }

  P.render = function () {
    const p = BF.project;
    const beats = widthBeats();
    const w = beats * PX;
    const scroll = root.scrollLeft;
    root.textContent = '';
    inner = document.createElement('div');
    inner.className = 'pl-inner';
    inner.style.width = `${LABEL_W + w}px`;

    // ruler: bar numbers; click to set where Song mode starts
    const ruler = row('Bars', 'ruler');
    rulerTrack = ruler.track;
    rulerTrack.style.width = `${w}px`;
    for (let b = 0; b < beats / 4; b++) {
      const n = document.createElement('div');
      n.className = 'bar-num';
      n.style.left = `${b * 4 * PX}px`;
      n.textContent = String(b + 1);
      if (b >= p.songBars) n.style.opacity = '.35';
      rulerTrack.append(n);
    }
    rulerTrack.title = 'Click to set the Song start position';
    rulerTrack.addEventListener('click', (e) => {
      const beat = Math.max(0, Math.floor(((e.clientX - rulerTrack.getBoundingClientRect().left) / PX) / SNAP) * SNAP);
      BF.transport.startBeat = Math.min(beat, p.songBars * 4 - SNAP);
      BF.emit('transport');
    });
    inner.append(ruler.row);

    // pattern row: which bars play the step pattern in Song mode
    const pat = row('Pattern', 'pattern-row');
    pat.track.style.width = `${w}px`;
    for (let b = 0; b < p.songBars; b++) {
      const btn = document.createElement('button');
      btn.className = 'pat-bar';
      btn.style.left = `${b * 4 * PX + 2}px`;
      btn.style.width = `${4 * PX - 4}px`;
      btn.setAttribute('aria-pressed', p.patternBars[b] ? 'true' : 'false');
      btn.setAttribute('aria-label', `Play the pattern in bar ${b + 1}`);
      btn.title = `Bar ${b + 1}: pattern ${p.patternBars[b] ? 'on' : 'off'} (Song mode)`;
      btn.addEventListener('click', () => BF.commit((q) => { q.patternBars[b] = !q.patternBars[b]; }));
      pat.track.append(btn);
    }
    inner.append(pat.row);

    // lanes
    p.lanes.forEach((lane, li) => {
      const r = row(lane.name, 'lane');
      r.track.style.width = `${w}px`;
      r.track.dataset.lane = li;
      const grid = document.createElement('div');
      grid.className = 'pl-grid';
      gridStyle(grid);
      r.track.append(grid);
      wireDrop(r.track, li);
      p.clips.filter((c) => c.lane === li).forEach((c) => r.track.append(clipEl(c)));
      inner.append(r.row);
    });

    playhead = document.createElement('div');
    playhead.className = 'playhead';
    inner.append(playhead);
    root.append(inner);
    root.scrollLeft = scroll;
    P.syncPanel();
    P.drawPlayhead(BF.transport.position());
  };

  function row(label, cls) {
    const r = document.createElement('div');
    r.className = `pl-row ${cls}`;
    const l = document.createElement('div');
    l.className = 'pl-label';
    l.textContent = label;
    const track = document.createElement('div');
    track.className = 'pl-track';
    r.append(l, track);
    return { row: r, track };
  }

  function clipEl(c) {
    const s = BF.project.samples[c.sampleId];
    const el = document.createElement('button');
    el.className = 'clip' + (P.selected === c.id ? ' sel' : '');
    el.dataset.id = c.id;
    const lenBeats = Math.max(SNAP, secToBeats(BF.audio.clipSeconds(c)));
    el.style.left = `${c.startBeat * PX}px`;
    el.style.width = `${lenBeats * PX}px`;
    const pct = Math.round(c.speed * 100);
    el.setAttribute('aria-label', `Clip ${s ? s.name : ''}, lane ${c.lane + 1}, beat ${c.startBeat + 1}, speed ${pct}%. Enter to preview, arrows to move, Delete to remove.`);
    const cv = document.createElement('canvas');
    const label = document.createElement('span');
    label.textContent = `${s ? s.name : 'missing'}${pct !== 100 ? ` · ${pct}%` : ''}`;
    el.append(cv, label);
    requestAnimationFrame(() => drawWave(cv, c));
    el.addEventListener('pointerdown', (e) => startDrag(e, el, c));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); select(c.id); BF.audio.preview(c); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); P.deleteSelected(c.id); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const d = e.key === 'ArrowLeft' ? -SNAP : SNAP;
        select(c.id);
        BF.commit((p) => { const k = p.clips.find((x) => x.id === c.id); if (k) k.startBeat = Math.max(0, k.startBeat + d); }, `move-${c.id}`);
        focusClip(c.id);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const d = e.key === 'ArrowUp' ? -1 : 1;
        select(c.id);
        BF.commit((p) => { const k = p.clips.find((x) => x.id === c.id); if (k) k.lane = Math.min(7, Math.max(0, k.lane + d)); }, `lane-${c.id}`);
        focusClip(c.id);
      }
    });
    el.addEventListener('focus', () => { if (P.selected !== c.id) select(c.id, false); });
    return el;
  }

  function focusClip(id) {
    const el = root.querySelector(`.clip[data-id="${CSS.escape(id)}"]`);
    if (el) el.focus();
  }

  function select(id, rerender = true) {
    P.selected = id;
    root.querySelectorAll('.clip').forEach((x) => x.classList.toggle('sel', x.dataset.id === id));
    P.syncPanel();
    if (rerender) { /* classes already updated */ }
  }
  P.select = select;

  P.deleteSelected = function (id = P.selected) {
    if (!id) return;
    BF.audio.stopPreview();
    BF.commit((p) => { p.clips = p.clips.filter((c) => c.id !== id); });
    P.selected = null;
    P.syncPanel();
  };

  function startDrag(e, el, c) {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    const startX = e.clientX, startY = e.clientY;
    const origLeft = c.startBeat * PX;
    let moved = false;
    let lane = c.lane;
    let beat = c.startBeat;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      el.classList.add('dragging');
      beat = Math.max(0, Math.round((origLeft + dx) / PX / SNAP) * SNAP);
      el.style.left = `${beat * PX}px`;
      // which lane is under the pointer?
      const tracks = [...root.querySelectorAll('.pl-track[data-lane]')];
      const hit = tracks.find((t) => { const r = t.getBoundingClientRect(); return ev.clientY >= r.top && ev.clientY < r.bottom; });
      if (hit && +hit.dataset.lane !== lane) { lane = +hit.dataset.lane; hit.append(el); }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!moved) { select(c.id); BF.audio.preview(c); return; }
      select(c.id);
      BF.commit((p) => { const k = p.clips.find((x) => x.id === c.id); if (k) { k.startBeat = beat; k.lane = lane; } });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function wireDrop(track, lane) {
    track.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      track.classList.add('drop');
    });
    track.addEventListener('dragleave', () => track.classList.remove('drop'));
    track.addEventListener('drop', (e) => {
      e.preventDefault();
      track.classList.remove('drop');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      const x = e.clientX - track.getBoundingClientRect().left;
      const beat = Math.max(0, Math.round(x / PX / SNAP) * SNAP);
      BF.io.importFiles(files, lane, beat);
    });
  }

  function peaks(sampleId, n) {
    const key = `${sampleId}:${n}`;
    if (peaksCache.has(key)) return peaksCache.get(key);
    const buf = BF.audio.buffers.get(sampleId);
    if (!buf) return null;
    const d = buf.getChannelData(0);
    const out = new Float32Array(n);
    const per = Math.max(1, Math.floor(d.length / n));
    for (let i = 0; i < n; i++) {
      let m = 0;
      const s = i * per;
      for (let j = 0; j < per; j += 8) { const v = Math.abs(d[s + j] || 0); if (v > m) m = v; }
      out[i] = m;
    }
    peaksCache.set(key, out);
    return out;
  }

  function drawWave(cv, c) {
    const w = Math.max(1, Math.min(4000, cv.clientWidth)), h = cv.clientHeight || 36;
    cv.width = w; cv.height = h;
    const pk = peaks(c.sampleId, w);
    if (!pk) return;
    const g = cv.getContext('2d');
    g.fillStyle = '#9feaff';
    for (let x = 0; x < w; x++) { const a = pk[x] * (h / 2 - 2); g.fillRect(x, h / 2 - a, 1, Math.max(1, a * 2)); }
  }

  P.drawPlayhead = function (beat) {
    if (!playhead) return;
    playhead.style.transform = `translateX(${LABEL_W + beat * PX}px)`;
  };

  /** Keep the playhead in view while playing in Song mode. */
  P.follow = function (beat) {
    const x = LABEL_W + beat * PX;
    if (x > root.scrollLeft + root.clientWidth - 60 || x < root.scrollLeft + LABEL_W) root.scrollLeft = Math.max(0, x - LABEL_W - 40);
  };

  // ---------- selected clip panel ----------
  P.syncPanel = function () {
    const panel = document.getElementById('clipPanel');
    const c = BF.project.clips.find((x) => x.id === P.selected);
    if (!c) { panel.hidden = true; if (P.selected) P.selected = null; return; }
    panel.hidden = false;
    const s = BF.project.samples[c.sampleId];
    document.getElementById('clipName').textContent = s ? s.name : 'Clip';
    const slider = document.getElementById('clipSpeed');
    const pct = Math.round(c.speed * 100);
    if (document.activeElement !== slider) slider.value = pct;
    document.getElementById('clipSpeedVal').textContent = `${pct}%`;
  };
})();
