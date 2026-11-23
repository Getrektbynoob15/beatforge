/* automation.js: automation clips. Right-click a knob -> "Create automation clip". The clip lives on a playlist track
 * and holds points { t: beats from clip start, v: 0..1 }, joined by straight lines.
 * Targets: channel volume/pan, instrument parameters, mixer volume/pan, effect parameters.
 *
 * Playback (Song mode): AudioParams (channel/mixer volume and pan) get ramps booked ahead at exact times;
 * effect parameters are applied with a timer (live) or with OfflineAudioContext.suspend (export);
 * instrument parameters are read at each note's start. */
(function () {
  'use strict';
  const BF = window.BF;
  const AU = (BF.auto = {});
  const VOL = { name: 'Volume', min: 0, max: 1.25, default: 0.78, fmt: BF.plugins.util.pct };
  const PAN = { name: 'Pan', min: -1, max: 1, default: 0, fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) };

  /** The parameter definition and a readable name for a target, or null if the target no longer exists. */
  AU.describe = function (tg, p = BF.project) {
    if (!tg) return null;
    if (tg.kind === 'ch' || tg.kind === 'chp') {
      const ch = p.channels.find((c) => c.id === tg.id);
      if (!ch) return null;
      if (tg.kind === 'ch') return { def: tg.field === 'pan' ? PAN : VOL, name: `${ch.name} ${tg.field}` };
      const def = BF.plugins.get(ch.plugin).params.find((x) => x.id === tg.param);
      return def && def.type === 'knob' ? { def, name: `${ch.name} · ${def.name}` } : null;
    }
    if (tg.kind === 'mx') {
      const m = p.mixer[tg.insert];
      return m ? { def: tg.field === 'pan' ? PAN : VOL, name: `${m.name} ${tg.field}` } : null;
    }
    if (tg.kind === 'fx') {
      const f = p.mixer[tg.insert]?.fx.find((x) => x.id === tg.fxId);
      if (!f) return null;
      const def = BF.plugins.get(f.plugin).params.find((x) => x.id === tg.param);
      return def && def.type === 'knob' ? { def, name: `${BF.plugins.get(f.plugin).name} · ${def.name}` } : null;
    }
    return null;
  };
  const sameTarget = (a, b) => a && b && a.kind === b.kind && a.id === b.id && a.field === b.field && a.param === b.param && a.insert === b.insert && a.fxId === b.fxId;
  const key = (tg) => JSON.stringify([tg.kind, tg.id, tg.field, tg.param, tg.insert, tg.fxId]);
  AU.key = key;

  /** The current (static) value of a target. */
  AU.current = function (tg, p = BF.project) {
    if (tg.kind === 'ch') return p.channels.find((c) => c.id === tg.id)?.[tg.field];
    if (tg.kind === 'chp') return p.channels.find((c) => c.id === tg.id)?.params[tg.param];
    if (tg.kind === 'mx') return p.mixer[tg.insert]?.[tg.field];
    if (tg.kind === 'fx') return p.mixer[tg.insert]?.fx.find((x) => x.id === tg.fxId)?.params[tg.param];
    return null;
  };

  /** Value (normalised 0..1) of a clip at `rel` beats from its start. */
  AU.clipValue = function (c, rel) {
    const pts = c.points;
    if (!pts.length) return null;
    if (rel <= pts[0].t) return pts[0].v;
    for (let i = 1; i < pts.length; i++) {
      if (rel <= pts[i].t) {
        const a = pts[i - 1], b = pts[i];
        const f = b.t === a.t ? 1 : (rel - a.t) / (b.t - a.t);
        return a.v + (b.v - a.v) * f;
      }
    }
    return pts[pts.length - 1].v;
  };

  /** Real (denormalised) automation value for a target at a song beat, or undefined when no clip covers it. */
  AU.valueAt = function (p, tg, beat) {
    let best = null;
    for (const c of p.clips) {
      if (c.kind !== 'auto' || p.tracks[c.track]?.mute || !sameTarget(c.target, tg)) continue;
      if (beat < c.start || beat >= c.start + c.len) continue;
      if (!best || c.start >= best.start) best = c;
    }
    if (!best) return undefined;
    const d = AU.describe(tg, p);
    if (!d) return undefined;
    return BF.ui.fromNorm(d.def, AU.clipValue(best, beat - best.start));
  };

  /** Instrument params for a note at `beat` with automation applied (song mode only). */
  AU.noteParams = function (p, ch, beat) {
    let out = ch.params;
    for (const c of p.clips) {
      if (c.kind !== 'auto' || c.target.kind !== 'chp' || c.target.id !== ch.id) continue;
      const v = AU.valueAt(p, c.target, beat);
      if (v !== undefined) { if (out === ch.params) out = { ...ch.params }; out[c.target.param] = v; }
    }
    return out;
  };

  /** Book automation for song beats [from, to) into graph g. `later(time, fn)` runs fn at an audio time. */
  AU.schedule = function (g, p, from, to, beatTime, later) {
    const targets = new Map();
    p.clips.forEach((c) => { if (c.kind === 'auto' && c.target.kind !== 'chp' && c.start < to && c.start + c.len > from) targets.set(key(c.target), c.target); });
    if (!targets.size) return;
    const STEP = 0.25; // apply 4 values per beat; AudioParams ramp linearly between them
    for (const tg of targets.values()) {
      for (let b = Math.ceil(from / STEP - 1e-9) * STEP; b < to - 1e-9; b += STEP) {
        const v = AU.valueAt(p, tg, b);
        if (v === undefined) continue;
        const t = beatTime(b);
        if (tg.kind === 'ch') {
          const s = g.channels.get(tg.id);
          if (!s) continue;
          const ch = p.channels.find((c) => c.id === tg.id);
          if (tg.field === 'pan') s.pan.pan.linearRampToValueAtTime(v, t);
          else s.gain.gain.linearRampToValueAtTime(ch && ch.mute ? 0 : v, t);
        } else if (tg.kind === 'mx') {
          const ins = g.inserts[tg.insert];
          if (tg.field === 'pan') ins.pan.pan.linearRampToValueAtTime(v, t);
          else ins.fader.gain.linearRampToValueAtTime(BF.insertAudible(tg.insert, p) ? v : 0, t);
        } else if (tg.kind === 'fx') {
          later(t, () => {
            const ins = g.inserts[tg.insert];
            const live = ins.fx.find((x) => x.id === tg.fxId);
            const f = p.mixer[tg.insert].fx.find((x) => x.id === tg.fxId);
            if (live && f) live.inst.set({ ...f.params, [tg.param]: v }, p.bpm);
          });
        }
      }
    }
  };

  // ---------- creating clips ----------
  AU.create = function (tg) {
    const d = AU.describe(tg);
    if (!d) return;
    const p = BF.project;
    const cur = AU.current(tg);
    const n = BF.ui.toNorm(d.def, cur);
    const used = new Set(p.clips.map((c) => c.track));
    let track = 0;
    for (let i = BF.TRACKS - 1; i >= 0; i--) if (!used.has(i)) track = i;
    const len = Math.max(16, BF.songEndBeat());
    const clip = { id: BF.uid('c'), kind: 'auto', track, start: 0, len, target: tg, points: [{ t: 0, v: n }, { t: len, v: n }] };
    BF.commit((q) => {
      q.clips.push(clip);
      if (q.tracks[track].name.startsWith('Track ')) q.tracks[track].name = d.name.slice(0, 40);
    });
    BF.playlist.sel = new Set([clip.id]);
    BF.win.toggle('playlist', true);
    AU.open(clip.id);
    if (BF.transport.mode !== 'song') BF.transport.setMode('song');
    BF.ui.toast(`Automation clip for ${d.name} added on track ${track + 1}. Click in the curve to add points, right-click to delete them.`);
  };

  /** Context menu for a knob that has an automation target. */
  AU.menu = function (x, y, tg, reset) {
    const d = AU.describe(tg);
    const has = BF.project.clips.some((c) => c.kind === 'auto' && sameTarget(c.target, tg));
    BF.ui.menu(x, y, [
      { label: `Create automation clip${d ? ` (${d.name})` : ''}`, action: () => AU.create(tg) },
      { label: 'Open existing automation', disabled: !has, action: () => { const c = BF.project.clips.find((k) => k.kind === 'auto' && sameTarget(k.target, tg)); if (c) AU.open(c.id); } },
      '-',
      { label: 'Reset to default', action: reset },
    ]);
  };

  // ---------- automation editor window ----------
  let cv, g, info, clipId = null, drag = null;
  AU.build = function () {
    const root = document.createElement('div');
    root.className = 'auto-ed';
    info = document.createElement('div');
    info.className = 'pr-tools';
    cv = document.createElement('canvas');
    cv.className = 'auto-cv';
    cv.tabIndex = 0;
    cv.setAttribute('role', 'application');
    cv.setAttribute('aria-label', 'Automation curve. Click to add a point, drag to move, right-click to delete.');
    root.append(info, cv);
    g = cv.getContext('2d');
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    return root;
  };

  AU.open = function (id) {
    clipId = id;
    BF.win.toggle('auto', true);
    AU.render();
  };
  const clip = () => BF.project.clips.find((c) => c.id === clipId && c.kind === 'auto');
  const PAD = 14;
  const geo = () => ({ w: cv.clientWidth, h: cv.clientHeight });
  const xOf = (c, t) => PAD + (t / c.len) * (geo().w - PAD * 2);
  const yOf = (v) => PAD + (1 - v) * (geo().h - PAD * 2);
  const tOf = (c, x) => Math.min(c.len, Math.max(0, ((x - PAD) / (geo().w - PAD * 2)) * c.len));
  const vOf = (y) => Math.min(1, Math.max(0, 1 - (y - PAD) / (geo().h - PAD * 2)));

  function down(e) {
    const c = clip();
    if (!c) return;
    cv.focus();
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let idx = c.points.findIndex((pt) => Math.hypot(xOf(c, pt.t) - x, yOf(pt.v) - y) < 8);
    const k = `auto-${e.timeStamp}`;
    const edit = (fn) => BF.commit((q) => { const cc = q.clips.find((z) => z.id === clipId); if (cc) { fn(cc); cc.points.sort((a, b) => a.t - b.t); } }, k, 'auto');
    if (e.button === 2) {
      if (idx >= 0 && c.points.length > 1) edit((cc) => cc.points.splice(idx, 1));
      return;
    }
    if (e.button !== 0) return;
    const snapT = (t) => (e.altKey ? t : Math.round(t * 4) / 4);
    if (idx < 0) {
      const pt = { t: snapT(tOf(c, x)), v: vOf(y) };
      edit((cc) => cc.points.push(pt));
      idx = clip().points.findIndex((p0) => p0.t === pt.t && p0.v === pt.v);
    }
    cv.setPointerCapture(e.pointerId);
    const id0 = idx;
    let cur = idx;
    const move = (ev) => {
      const xx = ev.clientX - r.left, yy = ev.clientY - r.top;
      const t = snapT(tOf(c, xx)), v = vOf(yy);
      edit((cc) => {
        const pt = cc.points[cur];
        if (!pt) return;
        pt.t = t; pt.v = v;
        cc.points.sort((a, b) => a.t - b.t);
        cur = cc.points.indexOf(pt);
      });
      showValue(v);
    };
    const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); drag = null; };
    void id0;
    drag = true;
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
  }

  function showValue(v) {
    const c = clip();
    const d = c && AU.describe(c.target);
    if (d) info.querySelector('.auto-val').textContent = BF.plugins.format(d.def, BF.ui.fromNorm(d.def, v));
  }

  AU.render = function () {
    if (!cv || !BF.win.isOpen('auto')) return;
    const c = clip();
    const w = BF.win.all.get('auto');
    info.textContent = '';
    if (!c) { if (w) w.title.textContent = 'Automation'; draw(); return; }
    const d = AU.describe(c.target);
    if (w) w.title.textContent = `Automation · ${d ? d.name : 'missing target'}`;
    const name = document.createElement('strong'); name.textContent = d ? d.name : 'Target was deleted';
    const val = document.createElement('span'); val.className = 'hint auto-val';
    const flat = document.createElement('button'); flat.className = 'btn small'; flat.textContent = 'Flatten';
    flat.title = 'Remove all points except a flat line at the first value';
    flat.addEventListener('click', () => BF.commit((q) => { const cc = q.clips.find((z) => z.id === clipId); cc.points = [{ t: 0, v: cc.points[0].v }, { t: cc.len, v: cc.points[0].v }]; }));
    const ramp = document.createElement('button'); ramp.className = 'btn small'; ramp.textContent = 'Ramp up';
    ramp.addEventListener('click', () => BF.commit((q) => { const cc = q.clips.find((z) => z.id === clipId); cc.points = [{ t: 0, v: 0 }, { t: cc.len, v: 1 }]; }));
    const down2 = document.createElement('button'); down2.className = 'btn small'; down2.textContent = 'Ramp down';
    down2.addEventListener('click', () => BF.commit((q) => { const cc = q.clips.find((z) => z.id === clipId); cc.points = [{ t: 0, v: 1 }, { t: cc.len, v: 0 }]; }));
    const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = 'Click: add point · drag: move (Alt = no snap) · right-click: delete';
    info.append(name, val, flat, ramp, down2, hint);
    draw();
  };

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = geo();
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#12151b'; g.fillRect(0, 0, w, h);
    const c = clip();
    if (!c) { g.fillStyle = '#9aa3b2'; g.font = '13px system-ui'; g.fillText('Right-click a knob and choose "Create automation clip", or double-click an automation clip.', 16, 30); return; }
    for (let b = 0; b <= c.len; b += 1) {
      g.fillStyle = b % 4 === 0 ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.05)';
      g.fillRect(Math.round(xOf(c, b)), PAD, 1, h - PAD * 2);
    }
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(PAD, yOf(0.5), w - PAD * 2, 1);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2fd4ff';
    g.strokeStyle = accent; g.lineWidth = 2; g.beginPath();
    g.moveTo(xOf(c, 0), yOf(AU.clipValue(c, 0)));
    c.points.forEach((pt) => g.lineTo(xOf(c, pt.t), yOf(pt.v)));
    g.lineTo(xOf(c, c.len), yOf(AU.clipValue(c, c.len)));
    g.stroke();
    g.fillStyle = 'rgba(47,212,255,.12)'; g.lineTo(xOf(c, c.len), h - PAD); g.lineTo(xOf(c, 0), h - PAD); g.fill();
    c.points.forEach((pt) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(xOf(c, pt.t), yOf(pt.v), 4.5, 0, Math.PI * 2); g.fill(); });
    const T = BF.transport;
    if (T.playing && T.mode === 'song') {
      const b = T.position() - c.start;
      if (b >= 0 && b <= c.len) { g.fillStyle = '#fff'; g.fillRect(xOf(c, b), PAD, 2, h - PAD * 2); }
    }
  }
  AU.draw = draw;

  /** Small curve drawing for a playlist clip. */
  AU.drawMini = function (canvas, c) {
    const w = Math.max(1, Math.min(6000, canvas.clientWidth)), h = canvas.clientHeight || 24;
    canvas.width = w; canvas.height = h;
    const gg = canvas.getContext('2d');
    gg.strokeStyle = 'rgba(0,0,0,.75)'; gg.lineWidth = 1.5; gg.beginPath();
    for (let x = 0; x <= w; x += 2) { const v = AU.clipValue(c, (x / w) * c.len); const y = 2 + (1 - v) * (h - 4); if (x === 0) gg.moveTo(x, y); else gg.lineTo(x, y); }
    gg.stroke();
  };
})();
