/* menu.js: a small context/drop-down menu. Arrow keys move, Enter picks, Esc closes. */
(function () {
  'use strict';
  const BF = window.BF;
  let open = null;

  function close() {
    if (!open) return;
    open.el.remove();
    open.doc.removeEventListener('pointerdown', open.outside, true);
    const back = open.back;
    open = null;
    if (back && back.focus) back.focus();
  }

  /** items: [{ label, action, disabled, checked, hint } | '-'] */
  BF.ui.menu = function (x, y, items) {
    close();
    const doc = (BF.win && BF.win.activeDoc && BF.win.activeDoc()) || document; // a popped-out window, or the app
    const view = doc.defaultView || window;
    const el = doc.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    const buttons = [];
    items.forEach((it) => {
      if (it === '-') { const s = document.createElement('div'); s.className = 'menu-sep'; el.append(s); return; }
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.className = 'menu-item';
      b.disabled = !!it.disabled;
      b.innerHTML = '';
      const l = document.createElement('span'); l.textContent = (it.checked ? '✓ ' : '') + it.label;
      b.append(l);
      if (it.hint) { const h = document.createElement('kbd'); h.textContent = it.hint; b.append(h); }
      b.addEventListener('click', () => { close(); it.action(); });
      el.append(b);
      buttons.push(b);
    });
    el.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(doc.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      e.stopPropagation();
    });
    doc.body.append(el);
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.min(x, view.innerWidth - r.width - 4)}px`;
    el.style.top = `${Math.min(y, view.innerHeight - r.height - 4)}px`;
    const outside = (e) => { if (!el.contains(e.target)) close(); };
    setTimeout(() => doc.addEventListener('pointerdown', outside, true), 0);
    open = { el, outside, doc, back: doc.activeElement };
    (buttons.find((b) => !b.disabled) || buttons[0])?.focus();
  };
  BF.ui.closeMenu = close;

  /** Open a menu under a button. */
  BF.ui.menuAt = function (btn, items) {
    const r = btn.getBoundingClientRect();
    BF.ui.menu(r.left, r.bottom + 2, items);
  };

  /** A drag handle that resizes a panel: sets the CSS variable `cssVar` (px) on <html>, remembered per computer. */
  BF.ui.splitter = function ({ cssVar, min, max, key, def, onChange }) {
    const h = document.createElement('div');
    h.className = 'splitter';
    h.setAttribute('role', 'separator');
    h.setAttribute('aria-orientation', 'vertical');
    h.title = 'Drag to resize (double-click: default size)';
    const set = (px) => {
      px = Math.round(Math.max(min, Math.min(max, px)));
      document.documentElement.style.setProperty(cssVar, `${px}px`);
      try { localStorage.setItem(key, String(px)); } catch { /* */ }
      return px;
    };
    let saved = def;
    try { saved = +localStorage.getItem(key) || def; } catch { /* */ }
    set(saved);
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const w0 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || def;
      let raf = 0;
      const move = (ev) => { set(w0 + ev.clientX - x0); if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (onChange) onChange(); }); };
      const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); if (onChange) onChange(); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
    h.addEventListener('dblclick', () => { set(def); if (onChange) onChange(); });
    return h;
  };

  /** Ask for a line of text in BeatForge's own dialog (the desktop app has no window.prompt).
   * Resolves to the trimmed text, or null when cancelled. */
  BF.ui.prompt = function (label, value = '') {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'dlg prompt-dlg';
      const form = document.createElement('form');
      form.method = 'dialog';
      const l = document.createElement('label');
      l.className = 'prompt-label';
      l.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = value ?? '';
      inp.maxLength = 120;
      inp.className = 'prompt-input';
      l.append(inp);
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel';
      const ok = document.createElement('button'); ok.type = 'submit'; ok.className = 'btn accent'; ok.textContent = 'OK';
      const actions = document.createElement('div'); actions.className = 'dlg-actions'; actions.append(cancel, ok);
      form.append(l, actions);
      d.append(form);
      document.body.append(d);
      let result = null;
      form.addEventListener('submit', () => { result = inp.value.trim().slice(0, 60); });
      cancel.addEventListener('click', () => d.close());
      d.addEventListener('close', () => { d.remove(); resolve(result); });
      d.showModal();
      inp.focus();
      inp.select();
    });
  };
})();
