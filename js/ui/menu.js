/* menu.js: a small context/drop-down menu. Arrow keys move, Enter picks, Esc closes. */
(function () {
  'use strict';
  const BF = window.BF;
  let open = null;

  function close() {
    if (!open) return;
    open.el.remove();
    document.removeEventListener('pointerdown', open.outside, true);
    const back = open.back;
    open = null;
    if (back && back.focus) back.focus();
  }

  /** items: [{ label, action, disabled, checked, hint } | '-'] */
  BF.ui.menu = function (x, y, items) {
    close();
    const el = document.createElement('div');
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
      const i = buttons.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      e.stopPropagation();
    });
    document.body.append(el);
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
    el.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
    const outside = (e) => { if (!el.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    open = { el, outside, back: document.activeElement };
    (buttons.find((b) => !b.disabled) || buttons[0])?.focus();
  };
  BF.ui.closeMenu = close;

  /** Open a menu under a button. */
  BF.ui.menuAt = function (btn, items) {
    const r = btn.getBoundingClientRect();
    BF.ui.menu(r.left, r.bottom + 2, items);
  };

  BF.ui.prompt = function (label, value) {
    const v = window.prompt(label, value);
    return v === null ? null : v.trim().slice(0, 60);
  };
})();
