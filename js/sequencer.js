/* sequencer.js: the 8 x 16 step grid. Built once, then synced from the project on every change. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});
  const S = (BF.sequencer = {});
  let cells = []; // cells[track][step]
  let metas = [];
  let lit = -1;

  S.build = function (root) {
    root.textContent = '';
    const head = document.createElement('div');
    head.className = 'seq-row';
    head.setAttribute('role', 'row');
    head.append(document.createElement('div'));
    for (let s = 0; s < 16; s++) {
      const h = document.createElement('div');
      h.className = 'seq-steps-head';
      h.textContent = s % 4 === 0 ? String(s / 4 + 1) : '·';
      head.append(h);
    }
    root.append(head);

    cells = [];
    metas = [];
    for (let t = 0; t < 8; t++) {
      const row = document.createElement('div');
      row.className = 'seq-row';
      row.setAttribute('role', 'row');
      const meta = document.createElement('div');
      meta.className = 'seq-meta';
      meta.setAttribute('role', 'rowheader');
      const num = document.createElement('span');
      num.className = 'seq-name';
      num.textContent = String(t + 1);
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `Track ${t + 1} sound`);
      BF.SOUNDS.forEach((s) => sel.add(new Option(s.label, s.id)));
      sel.addEventListener('change', () => BF.commit((p) => {
        p.tracks[t].sound = sel.value;
        p.tracks[t].name = BF.SOUNDS.find((x) => x.id === sel.value).label;
      }));
      const pitch = document.createElement('input');
      pitch.type = 'number'; pitch.min = -12; pitch.max = 12; pitch.step = 1; pitch.className = 'pitch';
      pitch.title = 'Pitch in semitones (-12 to 12)';
      pitch.setAttribute('aria-label', `Track ${t + 1} pitch in semitones`);
      pitch.addEventListener('change', () => BF.commit((p) => { p.tracks[t].pitch = Math.round(BF.clamp(pitch.value, -12, 12, 0)); }));
      const audition = document.createElement('button');
      audition.className = 'btn small';
      audition.textContent = '♪';
      audition.title = 'Hear this sound';
      audition.setAttribute('aria-label', `Play track ${t + 1} sound`);
      audition.addEventListener('click', () => {
        const ctx = BF.audio.ensure();
        const tr = BF.project.tracks[t];
        BF.playSound(ctx, tr.sound, BF.audio.graph.preview, ctx.currentTime + 0.01, tr.pitch, 60 / BF.project.bpm / 4);
      });
      meta.append(num, sel, pitch, audition);
      row.append(meta);
      metas.push({ sel, pitch });

      const rowCells = [];
      for (let s = 0; s < 16; s++) {
        const c = document.createElement('button');
        c.className = 'cell' + (Math.floor(s / 4) % 2 === 0 ? ' beat' : '');
        c.setAttribute('role', 'gridcell');
        c.setAttribute('aria-label', `Track ${t + 1}, step ${s + 1}`);
        c.dataset.t = t;
        c.dataset.s = s;
        c.addEventListener('click', () => BF.commit((p) => { p.tracks[t].steps[s] = !p.tracks[t].steps[s]; }));
        c.addEventListener('keydown', onArrow);
        rowCells.push(c);
        row.append(c);
      }
      cells.push(rowCells);
      root.append(row);
    }
  };

  // Arrow keys move between cells; Enter/Space toggle (native button behaviour).
  function onArrow(e) {
    const t = +e.currentTarget.dataset.t, s = +e.currentTarget.dataset.s;
    const moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    const nt = (t + m[0] + 8) % 8, ns = (s + m[1] + 16) % 16;
    cells[nt][ns].focus();
  }

  S.sync = function () {
    const p = BF.project;
    p.tracks.forEach((tr, t) => {
      if (metas[t].sel.value !== tr.sound) metas[t].sel.value = tr.sound;
      if (document.activeElement !== metas[t].pitch) metas[t].pitch.value = tr.pitch;
      tr.steps.forEach((on, s) => {
        const v = on ? 'true' : 'false';
        if (cells[t][s].getAttribute('aria-pressed') !== v) cells[t][s].setAttribute('aria-pressed', v);
      });
    });
  };

  /** Highlight the current step column (-1 = none). */
  S.light = function (step) {
    if (step === lit) return;
    if (lit >= 0) cells.forEach((r) => r[lit].classList.remove('now'));
    lit = step;
    if (lit >= 0) cells.forEach((r) => r[lit].classList.add('now'));
  };
})();
