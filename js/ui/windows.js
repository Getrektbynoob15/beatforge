/* windows.js: floating windows inside the workspace. Drag by the title bar, resize from the corner,
 * click to bring to front, close with ×. Positions are remembered per viewer (localStorage).
 * ⧉ pops a window out into a real window of its own (Electron: a native window; browser: a pop-up) that can go on
 * another screen. It is the same page (window.open of about:blank), so the panel's DOM simply moves there and keeps
 * working; the app's styles are copied in, keys are passed on to the shortcuts. Closing it docks the panel back. */
(function () {
  'use strict';
  const BF = window.BF;
  const W = (BF.win = { all: new Map() });
  let z = 10;
  const KEY = 'beatforge.windows.v4';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const persist = () => {
    const out = {};
    W.all.forEach((w, id) => { out[id] = { x: w.x, y: w.y, w: w.w, h: w.h, open: w.open }; });
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* private mode */ }
  };

  /**
   * id, title, body (element), rect {x,y,w,h} (in % of workspace when <= 1, else px), open, onShow, hotkey
   */
  W.create = function (opts) {
    const ws = document.getElementById('workspace');
    const el = document.createElement('section');
    el.className = 'win';
    el.dataset.win = opts.id;
    el.setAttribute('aria-label', opts.title);
    const bar = document.createElement('header');
    bar.className = 'win-bar';
    const title = document.createElement('h2');
    title.className = 'win-title';
    title.textContent = opts.title;
    const tools = document.createElement('div');
    tools.className = 'win-tools';
    const pop = document.createElement('button');
    pop.className = 'win-pop';
    pop.textContent = '⧉';
    pop.title = 'Open in its own window (for example on a second screen)';
    pop.setAttribute('aria-label', `Open ${opts.title} in its own window`);
    const close = document.createElement('button');
    close.className = 'win-close';
    close.textContent = '×';
    close.title = `Close${opts.hotkey ? ` (${opts.hotkey})` : ''}`;
    close.setAttribute('aria-label', `Close ${opts.title}`);
    bar.append(title, tools, pop, close);
    const body = document.createElement('div');
    body.className = 'win-body';
    body.append(opts.body);
    const grip = document.createElement('div');
    grip.className = 'win-grip';
    grip.setAttribute('aria-hidden', 'true');
    el.append(bar, body, grip);
    ws.append(el);

    const s = saved[opts.id] || {};
    const r = opts.rect;
    const w = {
      id: opts.id, el, body, bar, tools, title,
      x: s.x ?? r.x, y: s.y ?? r.y, w: s.w ?? r.w, h: s.h ?? r.h,
      open: s.open ?? opts.open, onShow: opts.onShow, onHide: opts.onHide,
    };
    W.all.set(opts.id, w);

    const place = () => {
      const R = ws.getBoundingClientRect();
      const px = (v, total) => (v <= 1 ? v * total : v);
      let x = px(w.x, R.width), y = px(w.y, R.height), ww = px(w.w, R.width), hh = px(w.h, R.height);
      ww = Math.min(Math.max(260, ww), R.width);
      hh = Math.min(Math.max(140, hh), R.height);
      x = Math.min(Math.max(0, x), Math.max(0, R.width - 80));
      y = Math.min(Math.max(0, y), Math.max(0, R.height - 32));
      Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${ww}px`, height: `${hh}px` });
    };
    w.place = place;
    place();
    el.hidden = !w.open;

    el.addEventListener('pointerdown', () => W.front(opts.id), true);
    close.addEventListener('click', () => W.toggle(opts.id, false));
    pop.addEventListener('click', () => W.popOut(opts.id));
    const drag = (e, mode) => {
      if (e.button !== 0 || e.target.closest('button,select,input')) return;
      e.preventDefault();
      const R = ws.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const x0 = e.clientX, y0 = e.clientY;
      const start = { x: b.left - R.left, y: b.top - R.top, w: b.width, h: b.height };
      const t = e.currentTarget;
      t.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (mode === 'move') { w.x = start.x + dx; w.y = Math.max(0, start.y + dy); }
        else { w.w = Math.max(260, start.w + dx); w.h = Math.max(140, start.h + dy); w.x = start.x; w.y = start.y; }
        place();
      };
      const up = () => { t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up); persist(); if (mode === 'size' && w.onShow) w.onShow(); };
      t.addEventListener('pointermove', move);
      t.addEventListener('pointerup', up);
    };
    bar.addEventListener('pointerdown', (e) => drag(e, 'move'));
    grip.addEventListener('pointerdown', (e) => drag(e, 'size'));
    bar.addEventListener('dblclick', (e) => { // maximise / restore
      if (e.target.closest('button,select,input')) return;
      if (w.max) { Object.assign(w, w.max); w.max = null; } else { w.max = { x: w.x, y: w.y, w: w.w, h: w.h }; Object.assign(w, { x: 0, y: 0, w: 1, h: 1 }); }
      place(); persist(); if (w.onShow) w.onShow();
    });
    return w;
  };

  W.front = function (id) {
    const w = W.all.get(id);
    if (!w) return;
    w.el.style.zIndex = ++z;
    W.all.forEach((x) => x.el.classList.toggle('focused', x === w));
    W.focused = id;
  };

  // ---------- popped-out windows ----------
  let lastDoc = null; // the document the user last worked in (menus open there)
  W.activeDoc = () => (lastDoc && lastDoc.defaultView && !lastDoc.defaultView.closed ? lastDoc : document);
  document.addEventListener('pointerdown', () => { lastDoc = document; }, true);

  W.popOut = function (id) {
    const w = W.all.get(id);
    if (!w) return;
    if (w.popup && !w.popup.closed) { w.popup.focus(); return; }
    const b = w.el.getBoundingClientRect();
    const sx = (window.screenX || 0) + b.left + 40, sy = (window.screenY || 0) + b.top + 40;
    const nw = window.open('', `bf-${id}`, `popup=yes,width=${Math.round(Math.max(420, b.width))},height=${Math.round(Math.max(260, b.height))},left=${Math.round(sx)},top=${Math.round(sy)}`);
    if (!nw) { BF.ui.toast('The window was blocked. Allow pop-ups for BeatForge and try again.', true); return; }
    const d = nw.document;
    d.open(); d.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'); d.close();
    d.title = `${w.title.textContent} - BeatForge`;
    // same look: the app's stylesheets, theme attributes and classes
    document.querySelectorAll('link[rel="stylesheet"], style').forEach((n) => {
      const c = d.importNode(n, true);
      if (c.tagName === 'LINK') c.href = n.href; // absolute
      d.head.append(c);
    });
    [...document.documentElement.attributes].forEach((a) => d.documentElement.setAttribute(a.name, a.value));
    d.body.className = `${document.body.className} win-popped`;
    const host = d.createElement('div');
    host.className = 'win popped';
    if (w.tools.childElementCount) { const bar = d.createElement('header'); bar.className = 'win-bar'; bar.append(w.tools); host.append(bar); } // title-bar tools go along
    host.append(w.body); // moves the live panel (with its listeners) into the new window
    d.body.append(host);
    w.popup = nw;
    w.open = true;
    w.el.hidden = true;
    const keys = (e) => { lastDoc = d; if (BF.keys.dispatch) BF.keys.dispatch(e); };
    nw.addEventListener('keydown', keys);
    nw.addEventListener('pointerdown', () => { lastDoc = d; W.focused = id; }, true);
    nw.addEventListener('pointerup', (e) => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: e.pointerId })));
    nw.addEventListener('resize', () => { if (w.onShow) w.onShow(); });
    nw.addEventListener('pagehide', () => dock(id)); // closed by the user (or the app is closing)
    if (w.onShow) setTimeout(() => w.onShow(), 30);
    persist();
    BF.emit('windows');
  };

  function dock(id) {
    const w = W.all.get(id);
    if (!w || !w.popup) return;
    const nw = w.popup;
    w.popup = null;
    w.el.insertBefore(w.body, w.el.querySelector('.win-grip'));
    w.bar.insertBefore(w.tools, w.bar.querySelector('.win-pop'));
    try { if (!nw.closed) nw.close(); } catch { /* gone */ }
    w.open = false; // closing the separate window closes the panel; F-key / menu opens it in the app again
    w.el.hidden = true;
    if (w.onHide) w.onHide();
    persist();
    BF.emit('windows');
  }
  W.dock = dock;
  W.isPopped = (id) => !!(W.all.get(id) && W.all.get(id).popup && !W.all.get(id).popup.closed);
  window.addEventListener('pagehide', () => W.all.forEach((w) => { try { if (w.popup && !w.popup.closed) w.popup.close(); } catch { /* */ } }));

  W.toggle = function (id, force) {
    const w = W.all.get(id);
    if (!w) return;
    if (w.popup && !w.popup.closed) { // popped out: the hotkey brings it to the front, or closes it
      if (force === false || (force === undefined && W.focused === id)) dock(id);
      else { w.popup.focus(); W.focused = id; if (w.onShow) w.onShow(); }
      return;
    }
    const open = force ?? (w.el.hidden || W.focused !== id);
    w.open = open;
    w.el.hidden = !open;
    if (open) { w.place(); W.front(id); if (w.onShow) w.onShow(); } else if (w.onHide) w.onHide();
    persist();
    BF.emit('windows');
  };

  W.isOpen = (id) => !!W.all.get(id) && (!W.all.get(id).el.hidden || W.isPopped(id));

  W.resetLayout = function () {
    try { localStorage.removeItem(KEY); } catch { /* */ }
    location.reload();
  };

  window.addEventListener('resize', () => W.all.forEach((w) => { w.place(); if (w.onShow && !w.el.hidden && !w.popup) w.onShow(); }));
})();
