/* knob.js: an accessible rotary knob (role=slider).
 * Drag up/down (Shift = fine), mouse wheel, arrow keys / PageUp / PageDown / Home / End, double-click = default. */
(function () {
  'use strict';
  const BF = window.BF;
  BF.ui = BF.ui || {};

  const toNorm = (p, v) => (p.curve === 'log' ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min));
  const fromNorm = (p, n) => {
    n = Math.min(1, Math.max(0, n));
    let v = p.curve === 'log' ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min);
    if (p.step) v = Math.round(v / p.step) * p.step;
    return Math.min(p.max, Math.max(p.min, v));
  };
  BF.ui.toNorm = toNorm;
  BF.ui.fromNorm = fromNorm;

  /**
   * opts: { param, value, label, size, onInput(v), compact }
   * Returns { el, set(v) }.
   */
  BF.ui.knob = function (opts) {
    const p = opts.param;
    const el = document.createElement('div');
    el.className = 'knob' + (opts.compact ? ' compact' : '');
    const dial = document.createElement('div');
    dial.className = 'knob-dial';
    dial.tabIndex = 0;
    dial.setAttribute('role', 'slider');
    dial.setAttribute('aria-label', opts.label || p.name);
    dial.setAttribute('aria-valuemin', '0');
    dial.setAttribute('aria-valuemax', '100');
    const ind = document.createElement('div');
    ind.className = 'knob-ind';
    dial.append(ind);
    const lab = document.createElement('div');
    lab.className = 'knob-label';
    lab.textContent = opts.compact ? '' : p.name;
    const val = document.createElement('div');
    val.className = 'knob-val';
    el.append(dial);
    if (!opts.compact) el.append(lab, val);
    let value = opts.value;

    function draw() {
      const n = toNorm(p, value);
      const bipolar = p.min < 0 && p.max > 0;
      const ang = -135 + n * 270;
      ind.style.transform = `rotate(${ang}deg)`;
      const z = bipolar ? toNorm(p, 0) : 0;
      const a0 = -135 + Math.min(z, n) * 270, a1 = -135 + Math.max(z, n) * 270;
      dial.style.setProperty('--a0', `${a0 + 135}deg`);
      dial.style.setProperty('--a1', `${a1 + 135}deg`);
      const text = BF.plugins.format(p, value);
      val.textContent = text;
      dial.setAttribute('aria-valuenow', String(Math.round(n * 100)));
      dial.setAttribute('aria-valuetext', text);
      dial.title = `${opts.label || p.name}: ${text}`;
    }
    function change(v) {
      v = fromNorm(p, toNorm(p, v));
      if (v === value) return;
      value = v;
      draw();
      opts.onInput(v);
    }
    const nudge = (dn) => change(fromNorm(p, toNorm(p, value) + dn));

    dial.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dial.focus();
      dial.setPointerCapture(e.pointerId);
      BF.ui.knobDrag = true;
      const y0 = e.clientY, n0 = toNorm(p, value);
      const move = (ev) => change(fromNorm(p, n0 + (y0 - ev.clientY) / (ev.shiftKey ? 800 : 160)));
      const up = () => {
        dial.removeEventListener('pointermove', move); dial.removeEventListener('pointerup', up); dial.removeEventListener('pointercancel', up);
        BF.ui.knobDrag = false;
        BF.emit('knob-end');
      };
      dial.addEventListener('pointermove', move);
      dial.addEventListener('pointerup', up);
      dial.addEventListener('pointercancel', up);
    });
    dial.addEventListener('wheel', (e) => { e.preventDefault(); nudge((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.03)); }, { passive: false });
    dial.addEventListener('dblclick', () => change(p.default));
    dial.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (opts.target && BF.auto) BF.auto.menu(e.clientX, e.clientY, opts.target, () => change(p.default));
      else BF.ui.menu(e.clientX, e.clientY, [{ label: 'Reset to default', action: () => change(p.default) }]);
    });
    dial.addEventListener('keydown', (e) => {
      const fine = e.shiftKey ? 0.005 : 0.02;
      const step = p.step ? Math.max(fine, toNorm(p, p.min + p.step) - toNorm(p, p.min)) : fine;
      const k = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 0.1, PageDown: -0.1 }[e.key];
      if (k !== undefined) { e.preventDefault(); e.stopPropagation(); nudge(k); }
      else if (e.key === 'Home') { e.preventDefault(); change(p.min); }
      else if (e.key === 'End') { e.preventDefault(); change(p.max); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); change(p.default); }
    });
    draw();
    return { el, dial, set(v) { if (v !== value && dial.ownerDocument.activeElement !== dial) { value = v; draw(); } }, get value() { return value; } };
  };

  /** A select / toggle / knob control for any plugin parameter. */
  BF.ui.paramControl = function (p, value, onInput, extra = {}) {
    if (p.type === 'knob') return BF.ui.knob({ param: p, value, onInput, label: extra.label, target: extra.target });
    const el = document.createElement('label');
    el.className = 'param-ctl';
    const name = document.createElement('span');
    name.className = 'knob-label';
    name.textContent = p.name;
    let input;
    if (p.type === 'toggle') {
      input = document.createElement('button');
      input.className = 'toggle';
      input.setAttribute('aria-pressed', String(!!value));
      input.textContent = value ? 'On' : 'Off';
      input.addEventListener('click', () => { const v = input.getAttribute('aria-pressed') !== 'true'; input.setAttribute('aria-pressed', String(v)); input.textContent = v ? 'On' : 'Off'; onInput(v); });
      el.append(name, input);
      return { el, set(v) { input.setAttribute('aria-pressed', String(!!v)); input.textContent = v ? 'On' : 'Off'; } };
    }
    input = document.createElement('select');
    const opts = p.type === 'sample' ? [[null, '(none)'], ...Object.entries(BF.project.samples).map(([id, s]) => [id, s.name])] : p.options;
    opts.forEach(([v, l]) => { const o = new Option(l, v === null ? '' : v); input.add(o); });
    input.value = value === null ? '' : value;
    input.addEventListener('change', () => onInput(input.value === '' && p.type === 'sample' ? null : input.value));
    el.append(name, input);
    return { el, set(v) { if (input.ownerDocument.activeElement !== input) input.value = v === null ? '' : v; } };
  };
})();
