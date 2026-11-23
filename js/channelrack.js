/* channelrack.js: the channel rack. One row per instrument channel with mute, pan, volume, mixer insert,
 * name (click = open the instrument), and either step buttons or a mini preview of piano-roll notes.
 * Steps: click toggles, drag paints, right-click erases. Drop audio files here to make Sampler channels. */
(function () {
  'use strict';
  const BF = window.BF;
  const C = (BF.rack = {});
  let root, rowsEl, head;
  let paint = null; // { on: bool } while painting steps

  C.build = function () {
    root = document.createElement('div');
    root.className = 'rack';
    head = document.createElement('div');
    head.className = 'rack-head';
    rowsEl = document.createElement('div');
    rowsEl.className = 'rack-rows';
    const add = document.createElement('button');
    add.className = 'btn small rack-add';
    add.textContent = '+ Add channel';
    add.addEventListener('click', () => BF.ui.menuAt(add, addMenu()));
    root.append(head, rowsEl, add);
    window.addEventListener('pointerup', () => { paint = null; });

    root.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files') || BF.browser.isDrag(e)) { e.preventDefault(); root.classList.add('drop'); } });
    root.addEventListener('dragleave', () => root.classList.remove('drop'));
    root.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      root.classList.remove('drop');
      const pl = BF.browser.payload(e);
      if (pl) { if (pl.kind === 'instrument') addChannel(pl.plugin, pl.preset, pl.name); return; }
      BF.io.importToRack([...(e.dataTransfer?.files || [])]);
    });
    return root;
  };

  function addMenu() {
    const items = BF.plugins.list('instrument').filter((d) => d.id !== 'sampler').map((d) => ({ label: d.name, action: () => addChannel(d.id) }));
    ['synth', 'fm', 'pluck', 'organ'].forEach((pid) => {
      const def = BF.plugins.get(pid);
      items.push('-');
      Object.keys(def.presets).filter((n) => n !== 'Init').forEach((n) => items.push({ label: `${def.name}: ${n}`, action: () => addChannel(pid, n, n) }));
    });
    items.push('-', { label: 'Sampler (from audio file)…', action: () => BF.io.pickFiles((files) => BF.io.importToRack(files)) });
    return items;
  }

  function freeInsert(p) {
    const used = new Set(p.channels.map((c) => c.insert));
    for (let i = 1; i <= BF.INSERTS; i++) if (!used.has(i)) return i;
    return 0;
  }

  function addChannel(plugin, preset, name) {
    BF.commit((p) => {
      const ch = BF.newChannel(plugin, name, { preset });
      ch.insert = freeInsert(p);
      if (ch.insert) p.mixer[ch.insert].name = ch.name;
      p.channels.push(ch);
      p.selectedChannel = ch.id;
    });
  }
  C.addChannel = addChannel;
  C.freeInsert = freeInsert;

  function chanMenu(ch) {
    const pt = BF.pattern();
    const fill = (every) => BF.commit((p) => { const q = BF.pattern(); q.steps[ch.id] = Array.from({ length: q.length }, (_, i) => i % every === 0); });
    return [
      { label: 'Open instrument', action: () => BF.editor.openChannel(ch.id) },
      { label: 'Piano roll', hint: 'F7', action: () => { BF.setView((p) => { p.selectedChannel = ch.id; }); BF.win.toggle('piano', true); } },
      '-',
      { label: 'Rename…', action: async () => { const n = await BF.ui.prompt('Channel name', ch.name); if (n) BF.commit((p) => { find(p, ch.id).name = n; }); } },
      { label: 'Clone', action: () => BF.commit((p) => {
        const c = JSON.parse(JSON.stringify(find(p, ch.id)));
        c.id = BF.uid('ch'); c.name = `${c.name} 2`;
        p.channels.splice(p.channels.findIndex((x) => x.id === ch.id) + 1, 0, c);
        p.selectedChannel = c.id;
      }) },
      { label: 'Delete channel', action: () => BF.commit((p) => {
        p.channels = p.channels.filter((x) => x.id !== ch.id);
        p.patterns.forEach((q) => { delete q.steps[ch.id]; delete q.notes[ch.id]; });
        if (p.selectedChannel === ch.id) p.selectedChannel = p.channels[0]?.id || null;
      }) },
      '-',
      { label: 'Fill every 2 steps', action: () => fill(2) },
      { label: 'Fill every 4 steps', action: () => fill(4) },
      { label: 'Fill every 8 steps', action: () => fill(8) },
      { label: 'Clear steps and notes', disabled: !pt, action: () => BF.commit(() => { const q = BF.pattern(); delete q.steps[ch.id]; delete q.notes[ch.id]; }) },
      { label: 'Move up', action: () => move(ch.id, -1) },
      { label: 'Move down', action: () => move(ch.id, 1) },
    ];
  }
  const find = (p, id) => p.channels.find((x) => x.id === id);
  function move(id, d) {
    BF.commit((p) => {
      const i = p.channels.findIndex((x) => x.id === id), j = i + d;
      if (j < 0 || j >= p.channels.length) return;
      [p.channels[i], p.channels[j]] = [p.channels[j], p.channels[i]];
    });
  }

  function renderHead() {
    const p = BF.project, pt = BF.pattern();
    head.textContent = '';
    const lenSel = document.createElement('select');
    lenSel.setAttribute('aria-label', 'Pattern length in steps');
    [8, 16, 24, 32, 48, 64].forEach((n) => lenSel.add(new Option(`${n} steps`, n)));
    lenSel.value = pt.length;
    lenSel.title = 'Pattern length';
    lenSel.addEventListener('change', () => BF.commit((q) => { const x = BF.pattern(); x.length = +lenSel.value; q.clips.forEach((c) => { if (c.patternId === x.id) c.len = BF.patternBeats(x); }); }));
    const swing = BF.ui.knob({ param: { id: 'swing', name: 'Swing', min: 0, max: 1, default: 0, fmt: BF.plugins.util.pct }, value: p.swing, onInput: (v) => BF.commit((q) => { q.swing = v; }, 'swing') });
    swing.el.classList.add('inline');
    const label = document.createElement('span');
    label.className = 'rack-pat';
    label.style.setProperty('--c', pt.color);
    label.textContent = pt.name;
    // channel groups (Alt+G puts the selected channel in a group; Page Up / Down switch groups)
    const groups = [...new Set(p.channels.map((c) => c.group).filter(Boolean))];
    const gsel = document.createElement('select');
    gsel.setAttribute('aria-label', 'Channel group filter');
    gsel.title = 'Show one channel group (Alt+G: group the selected channel · Page Up / Down: switch group)';
    gsel.add(new Option('All channels', ''));
    groups.forEach((g2) => gsel.add(new Option(g2, g2)));
    gsel.value = groups.includes(C.group) ? C.group : '';
    gsel.addEventListener('change', () => { C.group = gsel.value; C.render(); });
    head.append(label, lenSel, swing.el, gsel);
  }

  function row(ch) {
    const p = BF.project, pt = BF.pattern();
    const r = document.createElement('div');
    r.className = 'rack-row' + (p.selectedChannel === ch.id ? ' sel' : '');
    r.dataset.id = ch.id;

    const mute = document.createElement('button');
    mute.className = 'led';
    mute.setAttribute('aria-pressed', String(!ch.mute));
    mute.setAttribute('aria-label', `${ch.name} on/off`);
    mute.title = 'On/off (mute)';
    mute.addEventListener('click', () => BF.commit((q) => { const c = find(q, ch.id); c.mute = !c.mute; }));

    const pan = BF.ui.knob({ param: { name: 'Pan', min: -1, max: 1, default: 0, fmt: (v) => (Math.abs(v) < 0.01 ? 'Centre' : v < 0 ? `${Math.round(-v * 100)}% left` : `${Math.round(v * 100)}% right`) }, value: ch.pan, compact: true, label: `${ch.name} pan`, target: { kind: 'ch', id: ch.id, field: 'pan' }, onInput: (v) => BF.commit((q) => { find(q, ch.id).pan = v; }, `pan-${ch.id}`, 'mix') });
    const vol = BF.ui.knob({ param: { name: 'Volume', min: 0, max: 1.25, default: 0.78, fmt: BF.plugins.util.pct }, value: ch.volume, compact: true, label: `${ch.name} volume`, target: { kind: 'ch', id: ch.id, field: 'volume' }, onInput: (v) => BF.commit((q) => { find(q, ch.id).volume = v; }, `vol-${ch.id}`, 'mix') });

    const ins = document.createElement('input');
    ins.type = 'number'; ins.min = 0; ins.max = BF.INSERTS; ins.value = ch.insert; ins.className = 'rack-ins';
    ins.title = 'Mixer insert (0 = Master)';
    ins.setAttribute('aria-label', `${ch.name} mixer insert`);
    ins.addEventListener('change', () => BF.commit((q) => { find(q, ch.id).insert = Math.round(BF.clamp(ins.value, 0, BF.INSERTS, 0)); }));

    const name = document.createElement('button');
    name.className = 'rack-name';
    name.textContent = ch.name;
    name.title = `${ch.name} (${BF.plugins.get(ch.plugin).name}). Click: open instrument. Right-click: options.`;
    name.addEventListener('click', () => { BF.setView((q) => { q.selectedChannel = ch.id; }); BF.editor.openChannel(ch.id); });
    name.addEventListener('contextmenu', (e) => { e.preventDefault(); BF.ui.menu(e.clientX, e.clientY, chanMenu(ch)); });
    name.addEventListener('keydown', (e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); BF.ui.menuAt(name, chanMenu(ch)); } });

    const steps = document.createElement('div');
    steps.className = 'rack-steps';
    const notes = pt.notes[ch.id];
    if (notes && notes.length) {
      const cv = document.createElement('canvas');
      cv.className = 'rack-notes';
      cv.title = 'This channel uses the piano roll in this pattern. Click to open it.';
      cv.addEventListener('click', () => { BF.setView((q) => { q.selectedChannel = ch.id; }); BF.win.toggle('piano', true); });
      steps.append(cv);
      requestAnimationFrame(() => drawNotes(cv, notes, pt.length));
    } else {
      const arr = pt.steps[ch.id] || [];
      for (let i = 0; i < pt.length; i++) {
        const b = document.createElement('button');
        b.className = 'step' + (Math.floor(i / 4) % 2 === 0 ? ' a' : ' b');
        b.dataset.i = i;
        b.setAttribute('aria-pressed', String(!!arr[i]));
        b.setAttribute('aria-label', `${ch.name} step ${i + 1}`);
        b.addEventListener('pointerdown', (e) => {
          if (e.button === 2) { setStep(ch.id, i, false); paint = { on: false, id: ch.id }; return; }
          if (e.button !== 0) return;
          const on = b.getAttribute('aria-pressed') !== 'true';
          paint = { on, id: ch.id };
          setStep(ch.id, i, on, `paint-${ch.id}-${e.timeStamp}`);
          if (on) BF.audio.previewNote(BF.channel(ch.id), 60, 0.8, 0.2);
          paint.key = `paint-${ch.id}-${e.timeStamp}`;
        });
        b.addEventListener('pointerenter', () => { if (paint && paint.id === ch.id) setStep(ch.id, i, paint.on, paint.key); });
        b.addEventListener('contextmenu', (e) => e.preventDefault());
        b.addEventListener('click', (e) => { if (e.detail === 0) setStep(ch.id, i, b.getAttribute('aria-pressed') !== 'true'); }); // keyboard
        b.addEventListener('keydown', onArrow);
        steps.append(b);
      }
    }
    const roll = document.createElement('button');
    roll.className = 'btn small icon';
    roll.textContent = '🎹';
    roll.title = 'Open in piano roll (F7)';
    roll.setAttribute('aria-label', `Open ${ch.name} in piano roll`);
    roll.addEventListener('click', () => { BF.setView((q) => { q.selectedChannel = ch.id; }); BF.win.toggle('piano', true); });

    r.addEventListener('pointerdown', (e) => { if (!e.target.closest('.step') && BF.project.selectedChannel !== ch.id) BF.setView((q) => { q.selectedChannel = ch.id; }, 'select'); });
    r.append(mute, pan.el, vol.el, ins, name, steps, roll);
    return r;
  }

  function setStep(id, i, on, key) {
    const pt = BF.pattern();
    const cur = !!(pt.steps[id] || [])[i];
    if (cur === on) return;
    BF.commit(() => {
      const q = BF.pattern();
      const arr = q.steps[id] || (q.steps[id] = []);
      while (arr.length < q.length) arr.push(false);
      arr[i] = on;
    }, key || null, 'steps');
  }

  function onArrow(e) {
    const cells = [...rowsEl.querySelectorAll('.step')];
    const per = BF.pattern().length;
    const i = cells.indexOf(e.currentTarget);
    const m = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -per, ArrowDown: per }[e.key];
    if (m === undefined) return;
    e.preventDefault();
    const n = cells[i + m];
    if (n) n.focus();
  }

  function drawNotes(cv, notes, len) {
    const w = cv.clientWidth || 300, h = cv.clientHeight || 24;
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const keys = notes.map((n) => n.key);
    const lo = Math.min(...keys), hi = Math.max(...keys);
    g.fillStyle = 'rgba(255,255,255,.05)';
    g.fillRect(0, 0, w, h);
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#2fd4ff';
    notes.forEach((n) => {
      const y = hi === lo ? h / 2 - 2 : (1 - (n.key - lo) / (hi - lo)) * (h - 5) + 1;
      g.fillRect((n.start / len) * w, y, Math.max(2, (n.len / len) * w - 1), 3);
    });
  }

  C.render = function () {
    if (!root) return;
    renderHead();
    const focusedStep = document.activeElement?.classList.contains('step') ? [document.activeElement.closest('.rack-row')?.dataset.id, document.activeElement.dataset.i] : null;
    rowsEl.textContent = '';
    const grp = C.group && BF.project.channels.some((c) => c.group === C.group) ? C.group : (C.group = '');
    BF.project.channels.filter((ch) => !grp || ch.group === grp).forEach((ch) => { const r = row(ch); if (ch.zip) r.classList.add('zipped'); rowsEl.append(r); });
    if (!BF.project.channels.length) {
      const e = document.createElement('p'); e.className = 'empty'; e.textContent = 'No channels. Add one with + Add channel, or drop audio files here.'; rowsEl.append(e);
    }
    if (focusedStep) rowsEl.querySelector(`.rack-row[data-id="${CSS.escape(focusedStep[0])}"] .step[data-i="${focusedStep[1]}"]`)?.focus();
  };

  /** Light the current step while playing. */
  let lit = -1;
  C.light = function (step) {
    if (step === lit || !rowsEl) return;
    rowsEl.querySelectorAll('.step.now').forEach((b) => b.classList.remove('now'));
    lit = step;
    if (step >= 0) rowsEl.querySelectorAll(`.step[data-i="${step}"]`).forEach((b) => b.classList.add('now'));
  };
})();
