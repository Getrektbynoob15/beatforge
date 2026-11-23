/* pianoroll.js: note editor for the selected channel in the current pattern (canvas based).
 * Tools: Draw (P), Paint (B), Delete (D), Select (E). Right-click deletes. Ctrl+drag box-selects in any tool.
 * Drag a note to move it, drag its right edge to resize, Shift+drag to duplicate.
 * Keys: Delete, Ctrl+A/D (select all/none), Ctrl+C/X/V, Up/Down (semitone), Ctrl+Up/Down (octave),
 * Left/Right (move by snap), Ctrl+Q (quantize). Wheel scrolls, Shift+wheel scrolls sideways, Ctrl+wheel zooms. */
(function () {
  'use strict';
  const BF = window.BF;
  const PR = (BF.piano = { tool: 'draw', snap: 1, sel: new Set(), typing: false, ghost: true, slide: false, porta: false, lane: 'vel', color: 0 });
  // note colours (0 = the channel colour); like a DAW's note colour groups
  const NOTE_COLORS = [null, '#ff6b6b', '#ff9f43', '#feca57', '#7bed9f', '#2ed573', '#1dd1a1', '#48dbfb', '#54a0ff', '#5f27cd', '#a29bfe', '#ff9ff3', '#f368e0', '#c8d6e5', '#8395a7', '#ffffff'];
  const LANES = { vel: 'Velocity', pan: 'Pan', fine: 'Fine pitch' };
  const ROW = 14; // px per key
  const KEYW = 58; // keyboard width
  const RULER = 20;
  const VEL = 64; // velocity lane height
  let zoom = 22; // px per step
  let sx = 0; // scroll x in px
  let sy = (127 - 84) * ROW; // scroll y: show around C6 at top
  let lastLen = 2; // steps
  let root, cv, g, toolbar, chanSel, snapSel, stampSel, keySel, scaleSel;
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const CHORDS = { Major: [0, 4, 7], Minor: [0, 3, 7], '7th': [0, 4, 7, 10], 'Major 7th': [0, 4, 7, 11], 'Minor 7th': [0, 3, 7, 10], 'Sus2': [0, 2, 7], 'Sus4': [0, 5, 7], Diminished: [0, 3, 6], Augmented: [0, 4, 8], 'Power (5th)': [0, 7, 12], 'Add9': [0, 4, 7, 14], 'Minor 9th': [0, 3, 7, 10, 14] };
  const SCALES = { Major: [0, 2, 4, 5, 7, 9, 11], Minor: [0, 2, 3, 5, 7, 8, 10], 'Harmonic minor': [0, 2, 3, 5, 7, 8, 11], Dorian: [0, 2, 3, 5, 7, 9, 10], Phrygian: [0, 1, 3, 5, 7, 8, 10], Mixolydian: [0, 2, 4, 5, 7, 9, 10], 'Pentatonic major': [0, 2, 4, 7, 9], 'Pentatonic minor': [0, 3, 5, 7, 10], Blues: [0, 3, 5, 6, 7, 10] };
  PR.stamp = null;
  PR.scale = null;
  const inScale = (k) => !PR.scale || SCALES[PR.scale.name].includes(((k - PR.scale.root) % 12 + 12) % 12);
  const toScale = (k) => { if (!PR.scale) return k; for (let d = 0; d < 12; d++) { if (inScale(k - d)) return k - d; if (inScale(k + d)) return k + d; } return k; };
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
    const tools = [['draw', '✎ Draw', 'P'], ['paint', '🖌 Paint', 'B'], ['delete', '⌫ Delete', 'D'], ['mute', '🔇 Mute', 'T'], ['slice', '✂ Slice', 'C'], ['select', '⬚ Select', 'E']];
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
    stampSel = document.createElement('select');
    stampSel.setAttribute('aria-label', 'Stamp: place a whole chord with one click');
    stampSel.title = 'Stamp: click places a whole chord';
    stampSel.add(new Option('Stamp: off', ''));
    Object.keys(CHORDS).forEach((n) => stampSel.add(new Option(`Stamp: ${n}`, n)));
    stampSel.addEventListener('change', () => { PR.stamp = stampSel.value || null; });
    keySel = document.createElement('select');
    keySel.setAttribute('aria-label', 'Scale root');
    NOTE_NAMES.forEach((n, i) => keySel.add(new Option(n, i)));
    scaleSel = document.createElement('select');
    scaleSel.setAttribute('aria-label', 'Scale highlighting');
    scaleSel.title = 'Highlight the notes of a scale (and snap new notes to it)';
    scaleSel.add(new Option('Scale: none', ''));
    Object.keys(SCALES).forEach((n) => scaleSel.add(new Option(`Scale: ${n}`, n)));
    const onScale = () => { PR.scale = scaleSel.value ? { root: +keySel.value, name: scaleSel.value } : null; draw(); };
    keySel.addEventListener('change', onScale);
    scaleSel.addEventListener('change', onScale);
    const toolsBtn = document.createElement('button');
    toolsBtn.className = 'btn small';
    toolsBtn.textContent = 'Tools ▾';
    toolsBtn.title = 'Note tools (work on the selected notes, or all notes when nothing is selected)';
    toolsBtn.addEventListener('click', () => BF.ui.menuAt(toolsBtn, PR.toolsMenu()));
    const mk = (label, title, on) => { const b = document.createElement('button'); b.className = 'btn small'; b.textContent = label; b.title = title; b.setAttribute('aria-pressed', 'false'); b.addEventListener('click', on); return b; };
    PR.slideBtn = mk('◢ Slide', 'Slide notes (S): new notes bend the note that is playing to their pitch instead of playing themselves', () => PR.toggleMode('slide'));
    PR.portaBtn = mk('⤳ Porta', 'Portamento (O): new notes glide in from the previous note', () => PR.toggleMode('porta'));
    PR.laneSel = document.createElement('select');
    PR.laneSel.setAttribute('aria-label', 'Event lane');
    PR.laneSel.title = 'What the lane under the notes edits (F)';
    Object.entries(LANES).forEach(([v, l]) => PR.laneSel.add(new Option(`Lane: ${l}`, v)));
    PR.laneSel.addEventListener('change', () => { PR.lane = PR.laneSel.value; draw(); });
    PR.colorSel = document.createElement('select');
    PR.colorSel.setAttribute('aria-label', 'Note colour');
    PR.colorSel.title = 'Colour for new notes (Alt+C colours the selected notes)';
    NOTE_COLORS.forEach((c, i) => PR.colorSel.add(new Option(i ? `Colour ${i}` : 'Colour: channel', i)));
    PR.colorSel.addEventListener('change', () => { PR.color = +PR.colorSel.value; });
    toolbar.append(chanSel, ...toolBtns, snapSel, stampSel, keySel, scaleSel, toolsBtn, PR.slideBtn, PR.portaBtn, PR.laneSel, PR.colorSel, zout, zin, typing);
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
    cv.addEventListener('dblclick', (e) => { const h = hit(e); if (h.note) PR.noteProps(h.note.id); });
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
  const newNote = (start, key, len = lastLen, vel = 0.8) => Object.assign({ id: BF.uid('n'), start: Math.max(0, start), len, key: Math.min(127, Math.max(0, key)), vel },
    PR.slide ? { slide: true } : {}, PR.porta ? { porta: true } : {}, PR.color ? { color: PR.color } : {});

  function down(e) {
    cv.focus();
    const h = hit(e);
    const c = ch();
    if (!c) { BF.ui.toast('Add a channel first.'); return; }
    cv.setPointerCapture(e.pointerId);
    const key = `pr-${e.timeStamp}`;
    if (h.zone === 'keys') { BF.audio.previewNote(c, h.k, 0.8, 0.4); return; }
    if (h.zone === 'ruler') { PR.cursor = Math.max(0, snapStep(h.s, 'floor')); draw(); return; } // edit cursor (step edit)
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
    if (PR.tool === 'mute') {
      if (h.note) { const id = h.note.id; edit((arr) => { const n = arr.find((x) => x.id === id); if (n) n.mute = !n.mute; }, key); }
      return;
    }
    if (PR.tool === 'slice') {
      if (h.note) {
        const id = h.note.id, at = snapStep(h.s);
        edit((arr) => {
          const n = arr.find((x) => x.id === id);
          if (!n || at <= n.start + 0.01 || at >= n.start + n.len - 0.01) return;
          arr.push({ ...n, id: BF.uid('n'), start: at, len: n.start + n.len - at });
          n.len = at - n.start;
        }, key);
      }
      return;
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
    const root = toScale(h.k);
    if (PR.stamp) {
      const chord = CHORDS[PR.stamp].map((iv) => newNote(start, PR.scale ? toScale(root + iv) : root + iv));
      edit((arr) => arr.push(...chord), key);
      PR.sel = new Set(chord.map((x) => x.id));
      chord.forEach((x) => BF.audio.previewNote(c, x.key, 0.7, 0.4));
      return bindDrag();
    }
    const n = newNote(start, root);
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
    const f = Math.min(1, Math.max(0, (H - 3 - h.y) / (VEL - 6))); // 0 bottom .. 1 top of the lane
    const v = PR.lane === 'pan' ? Math.round((f * 2 - 1) * 100) / 100 : PR.lane === 'fine' ? Math.round(f * 200 - 100) : Math.max(0.02, f);
    const field = PR.lane;
    const s = stepOf(h.x);
    const targets = notes().filter((n) => s >= n.start && s <= n.start + Math.max(n.len, 0.5));
    const pick = targets.some((n) => PR.sel.has(n.id)) ? targets.filter((n) => PR.sel.has(n.id)) : targets;
    if (!pick.length) return;
    const ids = new Set(pick.map((n) => n.id));
    edit((arr) => arr.forEach((n) => {
      if (!ids.has(n.id)) return;
      if (field === 'vel') n.vel = v;
      else if (Math.abs(v) < (field === 'pan' ? 0.04 : 3)) delete n[field]; // snaps to the centre
      else n[field] = v;
    }), key);
  }

  function keys(e) {
    if (PR.typing && typingKey(e, true)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const selected = () => notes().filter((n) => PR.sel.has(n.id));
    const shift = (fn) => { if (!PR.sel.size) return; e.preventDefault(); e.stopPropagation(); edit((arr) => arr.forEach((n) => { if (PR.sel.has(n.id)) fn(n); }), `prk-${k}`); };
    if (moreKeys(e, mod, k)) return;
    if (e.altKey && !mod) {
      const op = { a: 'arp', s: 'strum', r: 'random', u: 'chop', g: 'glue', q: 'quantize', y: 'flip', f: 'flam' }[k.toLowerCase()];
      if (op) { e.preventDefault(); e.stopPropagation(); PR.op(op); return; }
    }
    if (mod && k.toLowerCase() === 'l') { e.preventDefault(); e.stopPropagation(); PR.op('legato'); return; }
    if (mod && k.toLowerCase() === 'b') { e.preventDefault(); e.stopPropagation(); PR.op('duplicate'); return; }
    if (k === 'Delete') { e.preventDefault(); e.stopPropagation(); const ids = new Set(PR.sel); PR.sel.clear(); edit((arr) => { for (let i = arr.length - 1; i >= 0; i--) if (ids.has(arr[i].id)) arr.splice(i, 1); }); }
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
      const t = { p: 'draw', b: 'paint', d: 'delete', e: 'select', t: 'mute', c: 'slice' }[k.toLowerCase()];
      if (t) { e.preventDefault(); e.stopPropagation(); PR.setTool(t); }
    }
  }

  // ---------- note tools (FL-style names and Alt shortcuts) ----------
  /** S / O: slide or portamento mode for new notes; with notes selected it also switches them. */
  PR.toggleMode = function (m) {
    PR[m] = !PR[m];
    const btn = m === 'slide' ? PR.slideBtn : PR.portaBtn;
    if (btn) btn.setAttribute('aria-pressed', String(PR[m]));
    if (PR.sel.size) PR.op(m, PR[m]);
    BF.ui.toast(`${m === 'slide' ? 'Slide' : 'Portamento'} ${PR[m] ? 'on' : 'off'}${PR.sel.size ? ' (selected notes too)' : ''}`);
  };

  /** Double-click a note: all of its properties. */
  PR.noteProps = function (id) {
    const n0 = notes().find((n) => n.id === id);
    if (!n0) return;
    const d = document.createElement('dialog');
    d.className = 'dlg';
    const h2 = document.createElement('h2'); h2.textContent = `Note ${BF.noteName(n0.key)}`;
    const body = document.createElement('div');
    const row = (label, el) => { const l = document.createElement('label'); l.className = 'set-row'; const t = document.createElement('span'); t.textContent = label; l.append(t, el); body.append(l); return el; };
    const num = (v, min, max, step) => { const i = document.createElement('input'); i.type = 'number'; i.min = min; i.max = max; i.step = step; i.value = v; return i; };
    const chk = (v) => { const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!v; return i; };
    const f = {
      key: row('Pitch (MIDI note, 60 = C5)', num(n0.key, 0, 127, 1)),
      vel: row('Velocity (%)', num(Math.round(n0.vel * 100), 1, 100, 1)),
      pan: row('Pan (−100 left … 100 right)', num(Math.round((n0.pan || 0) * 100), -100, 100, 1)),
      fine: row('Fine pitch (cents)', num(n0.fine || 0, -100, 100, 1)),
      start: row('Start (steps)', num(n0.start, 0, 4096, 0.01)),
      len: row('Length (steps)', num(n0.len, 0.05, 4096, 0.01)),
      slide: row('Slide note', chk(n0.slide)),
      porta: row('Portamento', chk(n0.porta)),
      mute: row('Muted', chk(n0.mute)),
      color: row('Colour', (() => { const s2 = document.createElement('select'); NOTE_COLORS.forEach((c, i) => s2.add(new Option(i ? `Colour ${i}` : 'Channel colour', i))); s2.value = n0.color || 0; return s2; })()),
    };
    const ok = document.createElement('button'); ok.className = 'btn accent'; ok.textContent = 'OK';
    const cancel = document.createElement('button'); cancel.className = 'btn'; cancel.textContent = 'Cancel';
    const actions = document.createElement('div'); actions.className = 'dlg-actions'; actions.append(cancel, ok);
    d.append(h2, body, actions);
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    cancel.addEventListener('click', () => d.close());
    ok.addEventListener('click', () => {
      edit((arr) => {
        const n = arr.find((x) => x.id === id);
        if (!n) return;
        n.key = Math.round(BF.clamp(f.key.value, 0, 127, n.key));
        n.vel = BF.clamp(f.vel.value / 100, 0.01, 1, n.vel);
        const pan = BF.clamp(f.pan.value / 100, -1, 1, 0); if (pan) n.pan = pan; else delete n.pan;
        const fine = Math.round(BF.clamp(f.fine.value, -100, 100, 0)); if (fine) n.fine = fine; else delete n.fine;
        n.start = BF.clamp(f.start.value, 0, 4096, n.start);
        n.len = BF.clamp(f.len.value, 0.05, 4096, n.len);
        ['slide', 'porta', 'mute'].forEach((k) => { if (f[k].checked) n[k] = true; else delete n[k]; });
        const col = +f.color.value; if (col) n.color = col; else delete n.color;
      });
      d.close();
    });
    d.showModal();
    f.vel.focus();
  };

  // ---------- more classic-DAW keys ----------
  let lastSnap = 1;
  PR.toggleSnap = function () {
    if (PR.snap) { lastSnap = PR.snap; PR.snap = 0; } else PR.snap = lastSnap || 1;
    if (snapSel) snapSel.value = String(PR.snap);
    BF.ui.toast(PR.snap ? 'Snap on' : 'Snap off');
  };
  function selectChannel(dir, withNotes) {
    const p = BF.project, pt = BF.pattern();
    let i = p.channels.findIndex((c) => c.id === p.selectedChannel);
    for (let n = 0; n < p.channels.length; n++) {
      i += dir;
      if (i < 0 || i >= p.channels.length) return;
      const c = p.channels[i];
      if (!withNotes || (pt.notes[c.id] || []).length) { BF.setView((q) => { q.selectedChannel = c.id; }, 'select'); return; }
    }
  }
  function moreKeys(e, mod, k) {
    const K = k.toLowerCase();
    const stop = () => { e.preventDefault(); e.stopPropagation(); return true; };
    const ns = notes();
    const select = (list) => { PR.sel = new Set(list.map((n) => n.id)); draw(); };
    if (e.altKey && !mod && K === 'm') { stop(); PR.op(e.shiftKey ? 'unmuteSel' : 'mute'); return true; }
    if (!mod && !e.altKey && !e.shiftKey && !PR.typing && (K === 's' || K === 'o')) { stop(); PR.toggleMode(K === 's' ? 'slide' : 'porta'); return true; }
    if (!mod && !e.altKey && !PR.typing && K === 'f') { // next property in the event lane (Shift+F: previous)
      stop();
      const ks = Object.keys(LANES), i = ks.indexOf(PR.lane);
      PR.lane = ks[(i + (e.shiftKey ? ks.length - 1 : 1)) % ks.length];
      if (PR.laneSel) PR.laneSel.value = PR.lane;
      BF.ui.toast(`Lane: ${LANES[PR.lane]}`);
      draw();
      return true;
    }
    if (e.altKey && !mod && K === 'c') { stop(); const c = PR.color || 1; PR.op('color', c); BF.ui.toast(`Selected notes: colour ${c}`); return true; }
    if (e.altKey && !mod && K === 'v') { stop(); PR.ghost = !PR.ghost; BF.ui.toast(`Ghost notes ${PR.ghost ? 'on' : 'off'}`); draw(); return true; }
    if (e.altKey && !mod && (k === 'ArrowLeft' || k === 'ArrowRight')) { // nudge: a tenth of a step
      if (!PR.sel.size) return false;
      stop();
      const d = k === 'ArrowLeft' ? -0.1 : 0.1;
      edit((arr) => arr.forEach((n) => { if (PR.sel.has(n.id)) n.start = Math.max(0, Math.round((n.start + d) * 100) / 100); }), 'nudge');
      return true;
    }
    if (e.shiftKey && !mod && !e.altKey) {
      if (K === 'i') { stop(); select(ns.filter((n) => !PR.sel.has(n.id))); return true; }
      if (K === 'r') { stop(); const pick = ns.filter(() => Math.random() < 0.5); select(pick.length || !ns.length ? pick : [ns[0]]); return true; }
      if (K === 'm') { // select whole chords / note groups at random
        stop();
        const groups = new Map();
        ns.forEach((n) => { const g2 = Math.round(n.start * 100); if (!groups.has(g2)) groups.set(g2, []); groups.get(g2).push(n); });
        let pick = [...groups.values()].filter(() => Math.random() < 0.5).flat();
        if (!pick.length && groups.size) pick = [...groups.values()][0];
        select(pick);
        return true;
      }
      if (K === 'c') { // select by colour (or by pitch when the selected notes have no colour)
        stop();
        const s0 = ns.filter((n) => PR.sel.has(n.id));
        const cols = new Set(s0.map((n) => n.color || 0));
        if (s0.length && !cols.has(0)) select(ns.filter((n) => cols.has(n.color || 0)));
        else { const keys = new Set(s0.map((n) => n.key)); select(ns.filter((n) => keys.has(n.key))); }
        return true;
      }
      if (K === 'd') { stop(); PR.op('discard'); return true; }
    }
    if (mod && !e.altKey && !e.shiftKey && K === 'g') { stop(); PR.op('glue'); return true; }
    if (mod && !e.altKey && !e.shiftKey && K === 'u') { stop(); PR.op('chop'); return true; }
    if (mod && !e.altKey && !e.shiftKey && K === 'm') { stop(); document.getElementById('openInput')?.click(); return true; }
    if (!mod && !e.altKey && k === 'Backspace') { stop(); PR.toggleSnap(); return true; }
    if (!mod && (k === 'PageUp' || k === 'PageDown')) { stop(); setZoom(zoom * (k === 'PageUp' ? 1.25 : 0.8)); return true; }
    if (e.shiftKey && !mod && e.code === 'Digit4') { stop(); sx = 0; setZoom((dims().w - KEYW - 10) / Math.max(4, BF.pattern().length)); return true; }
    if (!mod && !e.altKey && !e.shiftKey && !PR.typing && ['g', 'k', 'h', 'j'].includes(K)) {
      stop();
      selectChannel(K === 'g' || K === 'h' ? -1 : 1, K === 'h' || K === 'j');
      return true;
    }
    return false;
  }

  PR.toolsMenu = () => [
    { label: 'Quick legato', hint: 'Ctrl+L', action: () => PR.op('legato') },
    { label: 'Arpeggiate (up)', hint: 'Alt+A', action: () => PR.op('arp', 'up') },
    { label: 'Arpeggiate (down)', action: () => PR.op('arp', 'down') },
    { label: 'Arpeggiate (up and down)', action: () => PR.op('arp', 'updown') },
    { label: 'Strum', hint: 'Alt+S', action: () => PR.op('strum') },
    { label: 'Randomize velocity and timing', hint: 'Alt+R', action: () => PR.op('random') },
    { label: 'Chop to the snap', hint: 'Alt+U', action: () => PR.op('chop') },
    { label: 'Glue touching notes', hint: 'Alt+G', action: () => PR.op('glue') },
    { label: 'Quantize starts and ends', hint: 'Alt+Q', action: () => PR.op('quantize') },
    { label: 'Flip horizontally', hint: 'Alt+Y', action: () => PR.op('flip') },
    { label: 'Duplicate after selection', hint: 'Ctrl+B', action: () => PR.op('duplicate') },
    '-',
    { label: 'Velocity: all 100%', action: () => PR.op('vel', 1) },
    { label: 'Velocity: fade in', action: () => PR.op('velramp', 1) },
    { label: 'Velocity: fade out', action: () => PR.op('velramp', -1) },
    { label: 'Transpose up an octave', hint: 'Ctrl+↑', action: () => PR.op('transpose', 12) },
    { label: 'Transpose down an octave', hint: 'Ctrl+↓', action: () => PR.op('transpose', -12) },
    { label: 'Flam', hint: 'Alt+F', action: () => PR.op('flam') },
    { label: 'Mute selected notes', hint: 'Alt+M', action: () => PR.op('mute') },
    { label: 'Unmute selected notes', hint: 'Alt+Shift+M', action: () => PR.op('unmuteSel') },
    { label: 'Unmute all notes', action: () => PR.op('unmute') },
    { label: 'Discard note lengths', hint: 'Shift+D', action: () => PR.op('discard') },
    { label: `Ghost notes ${PR.ghost ? 'on' : 'off'}`, hint: 'Alt+V', action: () => { PR.ghost = !PR.ghost; draw(); } },
  ];

  /** Run a note tool on the selected notes (or every note when nothing is selected). */
  PR.op = function (op, arg) {
    const all = !PR.sel.size;
    const step = PR.snap || 1;
    let made = null;
    edit((arr, pt) => {
      const pick = arr.filter((n) => all || PR.sel.has(n.id)).sort((a, b) => a.start - b.start || a.key - b.key);
      if (!pick.length) return;
      const ids = new Set(pick.map((n) => n.id));
      if (op === 'legato') {
        const starts = [...new Set(arr.map((n) => n.start))].sort((a, b) => a - b);
        pick.forEach((n) => { const next = starts.find((s) => s > n.start + 1e-6); n.len = Math.max(0.1, (next ?? pt.length) - n.start); });
      } else if (op === 'strum') {
        const groups = new Map();
        pick.forEach((n) => { const k = Math.round(n.start * 100); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); });
        groups.forEach((g) => g.sort((a, b) => a.key - b.key).forEach((n, i) => { n.start += i * 0.25; n.len = Math.max(0.1, n.len - i * 0.25); }));
      } else if (op === 'arp') {
        const dir = arg || 'up';
        const groups = new Map();
        pick.forEach((n) => { const k = Math.round(n.start * 100); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); });
        const add = [];
        groups.forEach((g) => {
          const keys = g.map((n) => n.key).sort((a, b) => a - b);
          const seq = dir === 'down' ? keys.slice().reverse() : dir === 'updown' ? [...keys, ...keys.slice(1, -1).reverse()] : keys;
          const startAt = g[0].start, end = Math.max(...g.map((n) => n.start + n.len));
          for (let s = startAt, i = 0; s < end - 1e-6; s += step, i++) add.push({ id: BF.uid('n'), start: s, len: Math.min(step, end - s), key: seq[i % seq.length], vel: g[0].vel });
        });
        for (let i = arr.length - 1; i >= 0; i--) if (ids.has(arr[i].id)) arr.splice(i, 1);
        arr.push(...add);
        made = add;
      } else if (op === 'random') {
        pick.forEach((n) => { n.vel = BF.clamp(n.vel + (Math.random() - 0.5) * 0.3, 0.05, 1, 0.8); n.start = Math.max(0, n.start + (Math.random() - 0.5) * 0.12); });
      } else if (op === 'chop') {
        const add = [];
        pick.forEach((n) => { for (let s = n.start + step; s < n.start + n.len - 1e-6; s += step) add.push({ ...n, id: BF.uid('n'), start: s, len: Math.min(step, n.start + n.len - s) }); n.len = Math.min(n.len, step); });
        arr.push(...add);
      } else if (op === 'glue') {
        const byKey = new Map();
        pick.forEach((n) => { if (!byKey.has(n.key)) byKey.set(n.key, []); byKey.get(n.key).push(n); });
        const drop = new Set();
        byKey.forEach((list) => { list.sort((a, b) => a.start - b.start); for (let i = 1; i < list.length; i++) { const a = list.slice(0, i).reverse().find((x) => !drop.has(x.id)); const b = list[i]; if (a && b.start <= a.start + a.len + 0.01) { a.len = Math.max(a.len, b.start + b.len - a.start); drop.add(b.id); } } });
        for (let i = arr.length - 1; i >= 0; i--) if (drop.has(arr[i].id)) arr.splice(i, 1);
      } else if (op === 'quantize') {
        pick.forEach((n) => { const s = Math.round(n.start / step) * step; const e2 = Math.max(s + step, Math.round((n.start + n.len) / step) * step); n.start = s; n.len = e2 - s; });
      } else if (op === 'flip') {
        const min = Math.min(...pick.map((n) => n.start)), max = Math.max(...pick.map((n) => n.start + n.len));
        pick.forEach((n) => { n.start = min + (max - (n.start + n.len)); });
      } else if (op === 'duplicate') {
        const min = Math.min(...pick.map((n) => n.start)), max = Math.max(...pick.map((n) => n.start + n.len));
        const span = Math.ceil((max - min) / step - 1e-6) * step;
        const add = pick.map((n) => ({ ...n, id: BF.uid('n'), start: n.start + span }));
        arr.push(...add);
        made = add;
      } else if (op === 'vel') pick.forEach((n) => { n.vel = arg; });
      else if (op === 'velramp') pick.forEach((n, i) => { const f = pick.length > 1 ? i / (pick.length - 1) : 1; n.vel = 0.2 + 0.8 * (arg > 0 ? f : 1 - f); });
      else if (op === 'transpose') pick.forEach((n) => { n.key = Math.min(127, Math.max(0, n.key + arg)); });
      else if (op === 'unmute') arr.forEach((n) => { delete n.mute; });
      else if (op === 'mute') pick.forEach((n) => { n.mute = true; });
      else if (op === 'color') pick.forEach((n) => { if (arg) n.color = arg; else delete n.color; });
      else if (op === 'slide') pick.forEach((n) => { if (arg) n.slide = true; else delete n.slide; });
      else if (op === 'porta') pick.forEach((n) => { if (arg) n.porta = true; else delete n.porta; });
      else if (op === 'unmuteSel') pick.forEach((n) => { delete n.mute; });
      else if (op === 'discard') pick.forEach((n) => { n.len = Math.min(n.len, 0.5); });
      else if (op === 'flam') {
        const add = pick.map((n) => ({ ...n, id: BF.uid('n'), start: Math.max(0, n.start - 0.25), len: 0.25, vel: Math.max(0.05, n.vel * 0.6) })).filter((x, i) => x.start < pick[i].start);
        arr.push(...add);
      }
    });
    if (made) PR.sel = new Set(made.map((n) => n.id));
    draw();
  };

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
      g.fillStyle = PR.scale ? (inScale(k) ? (((k - PR.scale.root) % 12 + 12) % 12 === 0 ? '#22303a' : '#1d242d') : '#121419') : isBlack(k) ? '#161a21' : '#1b1f27';
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
      if (!c || o.id === c.id || !PR.ghost) return;
      (pt.notes[o.id] || []).forEach((n) => { g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(xOf(n.start), yOf(n.key) + 2, Math.max(2, n.len * zoom - 1), ROW - 4); });
    });
    // notes
    notes().forEach((n) => {
      const x = xOf(n.start), y = yOf(n.key), nw = Math.max(3, n.len * zoom - 1);
      const sel = PR.sel.has(n.id);
      g.globalAlpha = 0.45 + n.vel * 0.55;
      g.fillStyle = sel ? '#ffffff' : n.mute ? '#5b6270' : NOTE_COLORS[n.color] || accent;
      g.fillRect(x, y + 1, nw, ROW - 2);
      g.globalAlpha = 1;
      if (n.slide) { // slide note: a ramp drawn across it
        g.fillStyle = 'rgba(0,0,0,.45)';
        g.beginPath(); g.moveTo(x, y + ROW - 1); g.lineTo(x + nw, y + 1); g.lineTo(x + nw, y + ROW - 1); g.closePath(); g.fill();
      }
      if (n.porta) { g.fillStyle = '#04212b'; g.beginPath(); g.moveTo(x, y + 1); g.lineTo(x + 6, y + ROW / 2); g.lineTo(x, y + ROW - 1); g.closePath(); g.fill(); }
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
    // step-edit cursor
    if (BF.rec.stepEdit) { g.fillStyle = '#ffc94d'; g.fillRect(xOf(PR.cursor || 0), RULER, 2, gridH); }
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
    g.fillText(LANES[PR.lane], 6, vy + 14);
    g.save();
    g.beginPath(); g.rect(KEYW, vy, w - KEYW, VEL); g.clip();
    const lh = VEL - 8, mid = h - 3 - lh / 2;
    if (PR.lane !== 'vel') { g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(KEYW, mid, w - KEYW, 1); }
    notes().forEach((n) => {
      const x = xOf(n.start);
      g.fillStyle = PR.sel.has(n.id) ? '#fff' : NOTE_COLORS[n.color] || accent;
      let top, bh;
      if (PR.lane === 'vel') { bh = n.vel * lh; top = h - bh - 2; }
      else { const f = PR.lane === 'pan' ? (n.pan || 0) : (n.fine || 0) / 100; top = f >= 0 ? mid - f * (lh / 2) : mid; bh = Math.max(1, Math.abs(f) * (lh / 2)); }
      g.fillRect(x, top, 3, bh);
      const dotY = PR.lane === 'vel' ? top : (PR.lane === 'pan' ? (n.pan || 0) : (n.fine || 0) / 100) >= 0 ? top : top + bh;
      g.beginPath(); g.arc(x + 1.5, dotY, 3, 0, Math.PI * 2); g.fill();
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
