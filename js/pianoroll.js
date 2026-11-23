/* pianoroll.js: note editor for the selected channel in the current pattern (canvas based).
 * Tools: Draw (P), Paint (B), Delete (D), Select (E). Right-click deletes. Ctrl+drag box-selects in any tool.
 * Drag a note to move it, drag its right edge to resize, Shift+drag to duplicate.
 * Keys: Delete, Ctrl+A/D (select all/none), Ctrl+C/X/V, Up/Down (semitone), Ctrl+Up/Down (octave),
 * Left/Right (move by snap), Ctrl+Q (quantize). Wheel scrolls, Shift+wheel scrolls sideways, Ctrl+wheel zooms. */
(function () {
  'use strict';
  const BF = window.BF;
  const PR = (BF.piano = { tool: 'draw', snap: 1, sel: new Set(), typing: false });
  const ROW = 14; // px per key
  const KEYW = 58; // keyboard width
  const RULER = 20;
  const VEL = 64; // velocity lane height
  let zoom = 22; // px per step
  let sx = 0; // scroll x in px
  let sy = (127 - 84) * ROW; // scroll y: show around C6 at top
  let lastLen = 2; // steps
  let root, cv, g, toolbar, chanSel, snapSel;
  let clipboard = null;
  let drag = null;
  let hover = null;
  const isBlack = (k) => [1, 3, 6, 8, 10].includes(k % 12);

  PR.build = function () {
    root = document.createElement('div');
    root.className = 'piano';
    toolbar = document.createElement('div');
    toolbar.className = 'pr-tools';
    chanSel = document.createElement('select');
    chanSel.setAttribute('aria-label', 'Channel to edit');
    chanSel.addEventListener('change', () => BF.setView((p) => { p.selectedChannel = chanSel.value; PR.sel.clear(); }, 'select'));
    const tools = [['draw', '✎ Draw', 'P'], ['paint', '🖌 Paint', 'B'], ['delete', '⌫ Delete', 'D'], ['select', '⬚ Select', 'E']];
    const toolBtns = tools.map(([id, label, key]) => {
      const b = document.createElement('button');
      b.className = 'btn small tool';
      b.dataset.tool = id;
      b.textContent = label;
      b.title = `${label.slice(2)} tool (${key})`;
      b.addEventListener('click', () => PR.setTool(id));
      return b;
    });
    snapSel = document.createElement('select');
    snapSel.setAttribute('aria-label', 'Snap');
    snapSel.title = 'Snap to grid';
    [[16, 'Snap: bar'], [4, 'Snap: beat'], [2, 'Snap: 1/8'], [1, 'Snap: step (1/16)'], [0.5, 'Snap: 1/32'], [1 / 3, 'Snap: 1/16 triplet'], [0, 'Snap: none']].forEach(([v, l]) => snapSel.add(new Option(l, v)));
    snapSel.value = '1';
    snapSel.addEventListener('change', () => { PR.snap = +snapSel.value; });
    const typing = document.createElement('button');
    typing.className = 'btn small';
    typing.textContent = '⌨ Typing keyboard';
    typing.title = 'Play notes with your computer keyboard: Z–M and Q–U rows';
    typing.setAttribute('aria-pressed', 'false');
    typing.addEventListener('click', () => { PR.typing = !PR.typing; typing.setAttribute('aria-pressed', String(PR.typing)); BF.ui.toast(PR.typing ? 'Typing keyboard on: Z S X D C V… and Q 2 W 3 E… play notes. Tool shortcuts are off.' : 'Typing keyboard off.'); });
    const zin = document.createElement('button'); zin.className = 'btn small'; zin.textContent = '+'; zin.title = 'Zoom in (Ctrl+wheel)'; zin.setAttribute('aria-label', 'Zoom in');
    const zout = document.createElement('button'); zout.className = 'btn small'; zout.textContent = '−'; zout.title = 'Zoom out'; zout.setAttribute('aria-label', 'Zoom out');
    zin.addEventListener('click', () => setZoom(zoom * 1.25));
    zout.addEventListener('click', () => setZoom(zoom / 1.25));
    toolbar.append(chanSel, ...toolBtns, snapSel, zout, zin, typing);
    cv = document.createElement('canvas');
    cv.className = 'pr-canvas';
    cv.tabIndex = 0;
    cv.setAttribute('role', 'application');
    cv.setAttribute('aria-label', 'Piano roll. Click to add notes, right-click to delete, arrow keys move selected notes.');
    root.append(toolbar, cv);
    g = cv.getContext('2d');
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', (e) => { if (!drag) { hover = hit(e); cursor(e); } });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', wheel, { passive: false });
    cv.addEventListener('keydown', keys);
    PR.setTool('draw');
    return root;
  };

  PR.setTool = function (t) {
    PR.tool = t;
    toolbar.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  };

  function setZoom(z) { zoom = Math.min(80, Math.max(6, z)); draw(); }

  // ---------- geometry ----------
  const dims = () => ({ w: cv.clientWidth, h: cv.clientHeight, gridH: cv.clientHeight - RULER - VEL });
  const xOf = (step) => KEYW + step * zoom - sx;
  const stepOf = (x) => (x - KEYW + sx) / zoom;
  const yOf = (key) => RULER + (127 - key) * ROW - sy;
  const keyOf = (y) => 127 - Math.floor((y - RULER + sy) / ROW);
  const snapStep = (s, mode = 'round') => (PR.snap ? Math[mode](s / PR.snap + 1e-6) * PR.snap : Math.round(s * 100) / 100);
  const ch = () => BF.channel();
  const notes = () => { const c = ch(); return c ? BF.pattern().notes[c.id] || [] : []; };

  function hit(e) {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const { h } = dims();
    const zone = y < RULER ? 'ruler' : y > h - VEL ? 'vel' : x < KEYW ? 'keys' : 'grid';
    const s = stepOf(x), k = keyOf(y);
    let note = null, edge = false;
    if (zone === 'grid') {
      for (const n of notes()) {
        if (n.key === k && s >= n.start && s <= n.start + n.len) { note = n; edge = xOf(n.start + n.len) - x < 7 && n.len * zoom > 10; }
      }
    }
    return { x, y, s, k, zone, note, edge };
  }

  function cursor(e) {
    const h = hover;
    cv.style.cursor = !h ? 'default' : h.zone === 'vel' ? 'ns-resize' : h.edge ? 'ew-resize' : h.note ? (PR.tool === 'delete' ? 'not-allowed' : 'move') : h.zone === 'grid' ? (PR.tool === 'select' || e.ctrlKey ? 'crosshair' : 'copy') : 'pointer';
  }

  // ---------- editing ----------
  function edit(fn, key) {
    const c = ch();
    if (!c) return;
    BF.commit(() => {
      const pt = BF.pattern();
      const arr = pt.notes[c.id] || (pt.notes[c.id] = []);
      fn(arr, pt);
      if (!arr.length) delete pt.notes[c.id];
    }, key, 'notes');
  }
  const newNote = (start, key, len = lastLen, vel = 0.8) => ({ id: BF.uid('n'), start: Math.max(0, start), len, key: Math.min(127, Math.max(0, key)), vel });

  function down(e) {
    cv.focus();
    const h = hit(e);
    const c = ch();
    if (!c) { BF.ui.toast('Add a channel first.'); return; }
    cv.setPointerCapture(e.pointerId);
    const key = `pr-${e.timeStamp}`;
    if (h.zone === 'keys') { BF.audio.previewNote(c, h.k, 0.8, 0.4); return; }
    if (h.zone === 'ruler') return;
    if (h.zone === 'vel') { drag = { type: 'vel', key }; velAt(h, key); return bindDrag(); }

    const rightOrDelete = e.button === 2 || (PR.tool === 'delete' && e.button === 0);
    if (rightOrDelete) {
      drag = { type: 'erase', key };
      if (h.note) eraseAt(h, key);
      return bindDrag();
    }
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || PR.tool === 'select') {
      drag = { type: 'box', x0: h.x, y0: h.y, x1: h.x, y1: h.y, add: e.shiftKey };
      if (!e.shiftKey) PR.sel.clear();
      return bindDrag();
    }
    if (h.note) {
      if (!PR.sel.has(h.note.id)) { PR.sel.clear(); PR.sel.add(h.note.id); }
      lastLen = h.note.len;
      if (h.edge) {
        drag = { type: 'resize', key, s0: h.s, orig: notes().filter((n) => PR.sel.has(n.id)).map((n) => ({ id: n.id, len: n.len, start: n.start })) };
      } else {
        if (e.shiftKey) { // duplicate the selection, then drag the copies
          const copies = notes().filter((n) => PR.sel.has(n.id)).map((n) => ({ ...n, id: BF.uid('n') }));
          edit((arr) => arr.push(...copies), key);
          PR.sel = new Set(copies.map((n) => n.id));
        }
        BF.audio.previewNote(c, h.note.key, h.note.vel, 0.25);
        drag = { type: 'move', key, s0: h.s, k0: h.k, orig: notes().filter((n) => PR.sel.has(n.id)).map((n) => ({ id: n.id, start: n.start, key: n.key })), lastK: h.k };
      }
      draw();
      return bindDrag();
    }
    // empty grid: add a note
    const start = snapStep(h.s, 'floor');
    const n = newNote(start, h.k);
    edit((arr) => arr.push(n), key);
    PR.sel = new Set([n.id]);
    BF.audio.previewNote(c, n.key, n.vel, 0.25);
    if (PR.tool === 'paint') drag = { type: 'paint', key, lastStart: start, k: h.k };
    else drag = { type: 'move', key, s0: start, k0: h.k, orig: [{ id: n.id, start: n.start, key: n.key }], lastK: h.k };
    bindDrag();
  }

  function bindDrag() {
    const move = (ev) => {
      const h = hit(ev);
      const d = drag;
      if (!d) return;
      if (d.type === 'vel') velAt(h, d.key);
      else if (d.type === 'erase') { if (h.note) eraseAt(h, d.key); }
      else if (d.type === 'box') { d.x1 = h.x; d.y1 = h.y; draw(); }
      else if (d.type === 'paint') {
        const st = snapStep(h.s, 'floor');
        const step = PR.snap || lastLen;
        if (st >= d.lastStart + Math.max(step, lastLen) - 1e-6) {
          const n = newNote(st, d.k);
          edit((arr) => arr.push(n), d.key);
          d.lastStart = st;
        }
      } else if (d.type === 'move') {
        const ds = PR.snap ? Math.round((h.s - d.s0) / PR.snap) * PR.snap : h.s - d.s0;
        const dk = h.k - d.k0;
        const minStart = Math.min(...d.orig.map((o) => o.start));
        const dss = Math.max(-minStart, ds);
        edit((arr) => d.orig.forEach((o) => { const n = arr.find((x) => x.id === o.id); if (n) { n.start = o.start + dss; n.key = Math.min(127, Math.max(0, o.key + dk)); } }), d.key);
        if (h.k !== d.lastK && d.orig.length === 1) { d.lastK = h.k; BF.audio.previewNote(ch(), Math.min(127, Math.max(0, d.orig[0].key + dk)), 0.7, 0.2); }
      } else if (d.type === 'resize') {
        const dl = h.s - d.s0;
        edit((arr) => d.orig.forEach((o) => {
          const n = arr.find((x) => x.id === o.id);
          if (!n) return;
          let end = o.start + o.len + dl;
          if (PR.snap) end = Math.round(end / PR.snap) * PR.snap;
          n.len = Math.max(PR.snap || 0.1, end - o.start);
          lastLen = n.len;
        }), d.key);
      }
    };
    const up = () => {
      if (drag && drag.type === 'box') {
        const s0 = stepOf(Math.min(drag.x0, drag.x1)), s1 = stepOf(Math.max(drag.x0, drag.x1));
        const k0 = keyOf(Math.max(drag.y0, drag.y1)), k1 = keyOf(Math.min(drag.y0, drag.y1));
        notes().forEach((n) => { if (n.key >= k0 && n.key <= k1 && n.start + n.len > s0 && n.start < s1) PR.sel.add(n.id); });
      }
      drag = null;
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      draw();
    };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  function eraseAt(h, key) {
    const id = h.note.id;
    PR.sel.delete(id);
    edit((arr) => { const i = arr.findIndex((n) => n.id === id); if (i >= 0) arr.splice(i, 1); }, key);
  }

  function velAt(h, key) {
    const { h: H } = dims();
    const v = Math.min(1, Math.max(0.02, (H - h.y) / (VEL - 6)));
    const s = stepOf(h.x);
    const targets = notes().filter((n) => s >= n.start && s <= n.start + Math.max(n.len, 0.5));
    const pick = targets.some((n) => PR.sel.has(n.id)) ? targets.filter((n) => PR.sel.has(n.id)) : targets;
    if (!pick.length) return;
    const ids = new Set(pick.map((n) => n.id));
    edit((arr) => arr.forEach((n) => { if (ids.has(n.id)) n.vel = v; }), key);
  }

  function keys(e) {
    if (PR.typing && typingKey(e, true)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const selected = () => notes().filter((n) => PR.sel.has(n.id));
    const shift = (fn) => { if (!PR.sel.size) return; e.preventDefault(); e.stopPropagation(); edit((arr) => arr.forEach((n) => { if (PR.sel.has(n.id)) fn(n); }), `prk-${k}`); };
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); e.stopPropagation(); const ids = new Set(PR.sel); PR.sel.clear(); edit((arr) => { for (let i = arr.length - 1; i >= 0; i--) if (ids.has(arr[i].id)) arr.splice(i, 1); }); }
    else if (mod && k.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); PR.sel = new Set(notes().map((n) => n.id)); draw(); }
    else if (mod && k.toLowerCase() === 'd') { e.preventDefault(); e.stopPropagation(); PR.sel.clear(); draw(); }
    else if (mod && (k.toLowerCase() === 'c' || k.toLowerCase() === 'x')) {
      e.preventDefault(); e.stopPropagation();
      const s = selected();
      if (!s.length) return;
      const min = Math.min(...s.map((n) => n.start)), max = Math.max(...s.map((n) => n.start + n.len));
      clipboard = { notes: s.map((n) => ({ ...n, start: n.start - min })), span: max - min, from: min };
      if (k.toLowerCase() === 'x') { const ids = new Set(PR.sel); PR.sel.clear(); edit((arr) => { for (let i = arr.length - 1; i >= 0; i--) if (ids.has(arr[i].id)) arr.splice(i, 1); }); }
      BF.ui.toast(`${s.length} note${s.length > 1 ? 's' : ''} copied`);
    } else if (mod && k.toLowerCase() === 'v') {
      e.preventDefault(); e.stopPropagation();
      if (!clipboard) return;
      const sel = selected();
      const at = sel.length ? Math.max(...sel.map((n) => n.start + n.len)) : clipboard.from + clipboard.span;
      const at2 = PR.snap ? Math.ceil(at / PR.snap - 1e-6) * PR.snap : at;
      const copies = clipboard.notes.map((n) => ({ ...n, id: BF.uid('n'), start: n.start + at2 }));
      edit((arr) => arr.push(...copies));
      PR.sel = new Set(copies.map((n) => n.id));
    } else if (mod && k.toLowerCase() === 'q') {
      e.preventDefault(); e.stopPropagation();
      const q = PR.snap || 1;
      const all = !PR.sel.size;
      edit((arr) => arr.forEach((n) => { if (all || PR.sel.has(n.id)) n.start = Math.round(n.start / q) * q; }));
      BF.ui.toast('Quantized to the snap grid');
    } else if (k === 'ArrowUp') shift((n) => { n.key = Math.min(127, n.key + (mod ? 12 : 1)); });
    else if (k === 'ArrowDown') shift((n) => { n.key = Math.max(0, n.key - (mod ? 12 : 1)); });
    else if (k === 'ArrowLeft') shift((n) => { n.start = Math.max(0, n.start - (PR.snap || 1)); });
    else if (k === 'ArrowRight') shift((n) => { n.start += PR.snap || 1; });
    else if (!mod && !PR.typing) {
      const t = { p: 'draw', b: 'paint', d: 'delete', e: 'select' }[k.toLowerCase()];
      if (t) { e.preventDefault(); e.stopPropagation(); PR.setTool(t); }
    }
  }

  // ---------- typing keyboard (notes go through BF.live, so they have a real note-off and can be recorded) ----------
  function typingKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const note = BF.live.typingNote(e);
    if (note === null) return false;
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) BF.live.on('key', note, 0.8);
    return true;
  }
  PR.typingKey = typingKey;

  function wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = cv.getBoundingClientRect();
      const s = stepOf(e.clientX - r.left);
      setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      sx = Math.max(0, s * zoom - (e.clientX - r.left - KEYW));
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      sx = Math.max(0, sx + (e.deltaX || e.deltaY));
    } else {
      const { gridH } = dims();
      sy = Math.min(Math.max(0, sy + e.deltaY), 128 * ROW - gridH);
    }
    draw();
  }

  // ---------- drawing ----------
  function css(name, fb) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; }

  function draw() {
    if (!cv || !BF.win.isOpen('piano')) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h, gridH } = dims();
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const accent = css('--accent', '#2fd4ff');
    const pt = BF.pattern();
    const c = ch();
    const lenSteps = pt.length;
    g.fillStyle = '#12151b';
    g.fillRect(0, 0, w, h);

    // rows
    g.save();
    g.beginPath(); g.rect(KEYW, RULER, w - KEYW, gridH); g.clip();
    for (let k = 127; k >= 0; k--) {
      const y = yOf(k);
      if (y > RULER + gridH || y + ROW < RULER) continue;
      g.fillStyle = isBlack(k) ? '#161a21' : '#1b1f27';
      g.fillRect(KEYW, y, w - KEYW, ROW);
      if (k % 12 === 0) { g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(KEYW, y + ROW - 1, w - KEYW, 1); }
    }
    // columns
    const first = Math.floor(stepOf(KEYW)), last = Math.ceil(stepOf(w));
    for (let s = Math.max(0, first); s <= last; s++) {
      const x = Math.round(xOf(s)) + 0.5;
      g.fillStyle = s % 16 === 0 ? 'rgba(255,255,255,.22)' : s % 4 === 0 ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.04)';
      if (zoom < 10 && s % 4) continue;
      g.fillRect(x, RULER, 1, gridH);
    }
    // past the pattern end
    const endX = xOf(lenSteps);
    if (endX < w) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(Math.max(KEYW, endX), RULER, w, gridH); }

    // ghost notes of other channels
    BF.project.channels.forEach((o) => {
      if (!c || o.id === c.id) return;
      (pt.notes[o.id] || []).forEach((n) => { g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(xOf(n.start), yOf(n.key) + 2, Math.max(2, n.len * zoom - 1), ROW - 4); });
    });
    // notes
    notes().forEach((n) => {
      const x = xOf(n.start), y = yOf(n.key), nw = Math.max(3, n.len * zoom - 1);
      const sel = PR.sel.has(n.id);
      g.globalAlpha = 0.45 + n.vel * 0.55;
      g.fillStyle = sel ? '#ffffff' : accent;
      g.fillRect(x, y + 1, nw, ROW - 2);
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.fillRect(x + nw - 3, y + 1, 3, ROW - 2);
      if (nw > 26 && ROW >= 12) { g.fillStyle = '#04212b'; g.font = '10px system-ui, sans-serif'; g.fillText(BF.noteName(n.key), x + 3, y + ROW - 4); }
    });
    // box select
    if (drag && drag.type === 'box') {
      g.strokeStyle = '#fff'; g.setLineDash([4, 3]);
      g.strokeRect(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      g.setLineDash([]);
    }
    // playhead
    const T = BF.transport;
    if (T.playing) {
      const ph = playheadStep();
      if (ph !== null) { g.fillStyle = '#fff'; g.fillRect(xOf(ph), RULER, 2, gridH); }
    }
    g.restore();

    // keyboard
    g.save();
    g.beginPath(); g.rect(0, RULER, KEYW, gridH); g.clip();
    for (let k = 127; k >= 0; k--) {
      const y = yOf(k);
      if (y > RULER + gridH || y + ROW < RULER) continue;
      g.fillStyle = isBlack(k) ? '#2a2f3a' : '#d9dee7';
      g.fillRect(0, y, isBlack(k) ? KEYW * 0.62 : KEYW, ROW - 1);
      if (k % 12 === 0) { g.fillStyle = '#333'; g.font = '10px system-ui, sans-serif'; g.fillText(BF.noteName(k), KEYW - 26, y + ROW - 3); }
    }
    g.restore();

    // ruler
    g.fillStyle = '#171a21';
    g.fillRect(0, 0, w, RULER);
    g.fillStyle = '#9aa3b2';
    g.font = '11px system-ui, sans-serif';
    for (let s = Math.max(0, Math.floor(first / 4) * 4); s <= last; s += 4) {
      if (s % 16 === 0 || zoom >= 12) g.fillText(s % 16 === 0 ? String(s / 16 + 1) : `${s / 16 + 1 | 0}.${(s % 16) / 4 + 1}`, xOf(s) + 3, 14);
    }
    // velocity lane
    const vy = h - VEL;
    g.fillStyle = '#0f1115';
    g.fillRect(0, vy, w, VEL);
    g.fillStyle = '#9aa3b2';
    g.fillText('Velocity', 6, vy + 14);
    g.save();
    g.beginPath(); g.rect(KEYW, vy, w - KEYW, VEL); g.clip();
    notes().forEach((n) => {
      const x = xOf(n.start), bh = n.vel * (VEL - 8);
      g.fillStyle = PR.sel.has(n.id) ? '#fff' : accent;
      g.fillRect(x, h - bh - 2, 3, bh);
      g.beginPath(); g.arc(x + 1.5, h - bh - 2, 3, 0, Math.PI * 2); g.fill();
    });
    g.restore();
    g.fillStyle = '#2a2f3a';
    g.fillRect(0, vy, w, 1);
    if (!c) { g.fillStyle = '#e8ebf1'; g.font = '14px system-ui, sans-serif'; g.fillText('No channel selected. Add one in the channel rack.', KEYW + 20, RULER + 40); }
  }
  PR.draw = draw;

  function playheadStep() {
    const T = BF.transport;
    const beat = T.position();
    if (T.mode === 'pattern') return (beat * 4) % BF.pattern().length;
    const clip = BF.project.clips.find((cl) => cl.kind === 'pattern' && cl.patternId === BF.project.currentPattern && beat >= cl.start && beat < cl.start + cl.len);
    return clip ? (beat - clip.start) * 4 : null;
  }

  PR.sync = function () {
    if (!chanSel) return;
    const p = BF.project;
    chanSel.textContent = '';
    p.channels.forEach((c) => chanSel.add(new Option(c.name, c.id)));
    chanSel.value = p.selectedChannel || '';
    const w = BF.win.all.get('piano');
    if (w) w.title.textContent = `Piano roll · ${BF.channel()?.name || '—'} · ${BF.pattern().name}`;
    const ids = new Set(notes().map((n) => n.id));
    PR.sel.forEach((id) => { if (!ids.has(id)) PR.sel.delete(id); });
    draw();
  };

  /** Scroll so the existing notes (or C5) are in view. */
  PR.reveal = function () {
    const ns = notes();
    const { gridH } = dims();
    const mid = ns.length ? ns.reduce((a, n) => a + n.key, 0) / ns.length : 66;
    sy = Math.min(Math.max(0, (127 - mid) * ROW - gridH / 2), 128 * ROW - gridH);
    sx = 0;
    draw();
  };
})();
