/* browser.js: the docked browser on the left (F8). Instruments, presets, effects and the project's own patterns,
 * channels and audio. Click to use an item, or drag it: instruments onto the channel rack, effects onto a mixer strip,
 * audio onto a playlist track. A search box filters everything. */
(function () {
  'use strict';
  const BF = window.BF;
  const B = (BF.browser = { open: true, collapsed: new Set(['Project · Channels', 'Instruments · Organ', 'Kits · Lo-fi kit', 'Kits · Rock kit', 'Kits · House kit']) });
  let root, list, search;
  const MIME = 'application/x-beatforge';

  B.build = function () {
    root = document.getElementById('browser');
    const head = document.createElement('div');
    head.className = 'br-head';
    const t = document.createElement('h2');
    t.textContent = 'Browser';
    search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search…';
    search.setAttribute('aria-label', 'Search the browser');
    search.addEventListener('input', B.render);
    head.append(t, search);
    list = document.createElement('div');
    list.className = 'br-list';
    list.setAttribute('role', 'tree');
    root.append(head, list, BF.ui.splitter({ cssVar: '--browser-w', min: 160, max: 520, key: 'beatforge.browserWidth', def: 230, onChange: () => BF.win.all.forEach((w) => w.place()) }));
    try { B.open = localStorage.getItem('beatforge.browser') !== '0'; } catch { /* */ }
    root.hidden = !B.open;
  };

  B.toggle = function (force) {
    B.open = force ?? !B.open;
    root.hidden = !B.open;
    try { localStorage.setItem('beatforge.browser', B.open ? '1' : '0'); } catch { /* */ }
    BF.win.all.forEach((w) => w.place());
    BF.emit('windows');
  };
  B.isOpen = () => B.open;

  function sections(q = '') {
    const p = BF.project;
    const drum = BF.plugins.get('drum');
    const synth = BF.plugins.get('synth');
    const out = [];
    // your files first, like a DAW's browser: imported packs and folders from this computer
    if (BF.files) {
      out.push({ name: 'Packs', tree: true, items: [
        ...(q ? [] : [{ label: 'Import a pack (.zip or folder)…', icon: '＋', hint: 'Add a sample / template pack to the browser (a .zip or a folder)', use: () => BF.packImport.ask() }]),
        ...BF.files.packItems(q),
      ] });
      out.push({ name: 'Folders', tree: true, items: [
        ...(q ? [] : [{ label: 'Add a folder from this computer…', icon: '＋', hint: 'Show a folder (your samples, downloads…) here, like adding a folder to a DAW browser', use: () => BF.files.addFolder() }]),
        ...BF.files.folderItems(q),
      ] });
    }
    out.push({ name: 'Instruments · Drums', items: drum.params[0].options.map(([id, label]) => ({
      label, hint: `Drum Kit: ${label}. Click to hear it, double-click to add a channel, or drag it onto the channel rack.`, useLabel: 'Add as channel', icon: '🥁',
      drag: { kind: 'instrument', plugin: 'drum', preset: { sound: id }, name: label },
      use: () => BF.rack.addChannel('drum', { sound: id }, label),
      preview: () => BF.audio.previewNote({ plugin: 'drum', params: BF.plugins.defaults('drum', { sound: id }), volume: 0.8, pan: 0, pitch: 0, insert: 0 }, 60, 0.9, 0.3),
    })) });
    const previewChord = (plugin, preset, name) => () => {
      const ch = { plugin, params: BF.plugins.defaults(plugin, preset), volume: 0.8, pan: 0, pitch: 0, insert: 0 };
      const low = /bass|808/i.test(name);
      (low ? [36, 36, 43, 39] : [60, 64, 67, 72]).forEach((k, i) => setTimeout(() => BF.audio.previewNote(ch, k, 0.85, 0.22), i * 170));
    };
    ['synth', 'fm', 'pluck', 'organ'].forEach((pid) => {
      const def = BF.plugins.get(pid);
      out.push({ name: `Instruments · ${def.name}`, items: Object.keys(def.presets).map((n) => ({
        label: n, hint: `${def.name} "${n}". Click to hear it, double-click to add a channel, or drag it onto the channel rack.`, icon: '🎹', useLabel: 'Add as channel',
        drag: { kind: 'instrument', plugin: pid, preset: n, name: n === 'Init' ? def.name : n },
        use: () => BF.rack.addChannel(pid, n, n === 'Init' ? def.name : n),
        preview: previewChord(pid, n, n),
      })) });
    });
    Object.entries(BF.KITS).forEach(([kit, sounds]) => {
      const opts = new Map(drum.params[0].options);
      out.push({ name: `Kits · ${kit}`, items: [
        { label: `Add the whole ${kit}`, icon: '📦', hint: `Adds every ${kit} sound as its own channel`, use: () => Object.entries(sounds).forEach(([s, o]) => BF.rack.addChannel('drum', { sound: s, ...o }, `${opts.get(s)} (${kit.split(' ')[0]})`)) },
        ...Object.entries(sounds).map(([s, o]) => ({
          label: opts.get(s), icon: '🥁', useLabel: 'Add as channel',
          hint: `${kit}: ${opts.get(s)}. Click to hear it, double-click to add, or drag it onto the channel rack.`,
          drag: { kind: 'instrument', plugin: 'drum', preset: { sound: s, ...o }, name: `${opts.get(s)} (${kit.split(' ')[0]})` },
          use: () => BF.rack.addChannel('drum', { sound: s, ...o }, `${opts.get(s)} (${kit.split(' ')[0]})`),
          preview: () => BF.audio.previewNote({ plugin: 'drum', params: BF.plugins.defaults('drum', { sound: s, ...o }), volume: 0.8, pan: 0, pitch: 0, insert: 0 }, 60, 0.9, 0.3),
        })),
      ] });
    });
    out.push({ name: 'Instruments · Other', items: [{
      label: 'Sampler (load audio…)', hint: 'Make a Sampler channel from an audio file', icon: '🎚',
      use: () => BF.io.pickFiles((f) => BF.io.importToRack(f)),
    }] });
    const ext = (kind) => BF.plugins.list(kind).filter((d) => d.ext && !d.missing);
    out.push({ name: 'Plugins · Community', items: [
      { label: 'Plugin store…', icon: '🛒', hint: 'Browse and install community plugins (checked by GRBN Studios before they show up)', use: () => BF.community.openStore() },
      ...ext('instrument').map((d) => ({
        label: d.name, icon: '🧩', useLabel: 'Add as channel', hint: `${d.name} by ${d.entry.meta.author} (community). Click to hear it, double-click to add a channel, or drag it onto the channel rack.`,
        drag: { kind: 'instrument', plugin: d.id, name: d.name },
        use: () => BF.rack.addChannel(d.id, null, d.name),
        preview: previewChord(d.id, null, d.name),
      })),
      ...ext('effect').map((d) => ({
        label: d.name, icon: '🧩', hint: `${d.name} by ${d.entry.meta.author} (community effect): click to add to the selected mixer insert, or drag it onto a mixer strip.`,
        drag: { kind: 'effect', plugin: d.id },
        use: () => B.addEffect(BF.mixer.selected, d.id),
      })),
    ] });
    out.push({ name: 'Effects', items: BF.plugins.list('effect').filter((d) => !d.ext).map((d) => ({
      label: d.name, hint: `${d.name}: click to add to the selected mixer insert, or drag it onto a mixer strip.`, icon: '✨',
      drag: { kind: 'effect', plugin: d.id },
      use: () => B.addEffect(BF.mixer.selected, d.id),
    })) });
    out.push({ name: 'Project · Patterns', items: p.patterns.map((pt) => ({
      label: pt.name, hint: 'Click to make this the current pattern', icon: '▦', color: pt.color, active: pt.id === p.currentPattern,
      use: () => { BF.playlist.pick = { kind: 'pattern' }; BF.setView((q) => { q.currentPattern = pt.id; }, 'pattern'); },
    })) });
    out.push({ name: 'Project · Channels', items: p.channels.map((c) => ({
      label: c.name, hint: `${BF.plugins.get(c.plugin).name}: click to open`, icon: '◉', active: c.id === p.selectedChannel,
      use: () => { BF.setView((q) => { q.selectedChannel = c.id; }, 'select'); BF.editor.openChannel(c.id); },
    })) });
    out.push({ name: 'Project · Audio', items: Object.keys(p.samples).filter((id) => BF.audio.buffers.has(id)).map((id) => ({
      label: p.samples[id].name, hint: 'Click to hear it, double-click to pick it for drawing in the playlist, or drag it onto a playlist track', useLabel: 'Pick for the playlist', icon: '〰',
      drag: { kind: 'audio', sampleId: id },
      use: () => { BF.playlist.pick = { kind: 'audio', sampleId: id }; BF.emit('pattern'); },
      preview: () => BF.audio.previewClip({ kind: 'audio', sampleId: id, mode: 'resample', speed: 1, pitch: 0, len: 0, track: 0 }),
    })) });
    return out;
  }

  B.addEffect = function (insert, plugin) {
    const m = BF.project.mixer[insert];
    if (m.fx.length >= 10) { BF.ui.toast('This insert already has 10 effects.', true); return; }
    const fx = { id: BF.uid('fx'), plugin, params: BF.plugins.defaults(plugin), bypass: false };
    BF.commit((p) => { p.mixer[insert].fx.push(fx); });
    BF.mixer.selected = insert;
    BF.win.toggle('mixer', true);
    BF.editor.openEffect(insert, fx.id);
  };

  let lastSig = '';
  B.render = function (force) {
    if (!list || root.hidden) return;
    const q = (search.value || '').trim().toLowerCase();
    const secs = sections(q);
    // nothing visible changed -> keep the DOM (so scrolling and drags are never interrupted)
    const sig = JSON.stringify([q, [...B.collapsed], secs.map((s) => [s.name, s.items.map((i) => [i.label, !!i.active, i.color || '', i.icon, i.depth || 0])])]);
    if (sig === lastSig && force !== true) return;
    lastSig = sig;
    const scroll = list.scrollTop;
    const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    list.textContent = '';
    secs.forEach((sec) => {
      const items = q && !sec.tree ? sec.items.filter((it) => it.label.toLowerCase().includes(q)) : sec.items;
      if (q && !items.length) return;
      const open = q || !B.collapsed.has(sec.name);
      const h = document.createElement('button');
      h.className = 'br-sec';
      h.setAttribute('aria-expanded', String(!!open));
      h.textContent = `${open ? '▾' : '▸'} ${sec.name}`;
      h.addEventListener('click', () => { if (B.collapsed.has(sec.name)) B.collapsed.delete(sec.name); else B.collapsed.add(sec.name); B.render(); });
      list.append(h);
      if (!open) return;
      if (!items.length) { const e = document.createElement('div'); e.className = 'br-empty'; e.textContent = '(empty)'; list.append(e); }
      items.forEach((it) => {
        const b = document.createElement('div');
        b.setAttribute('role', 'button');
        b.tabIndex = 0;
        b.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); b.click(); } });
        b.className = 'br-item' + (it.active ? ' on' : '');
        b.dataset.key = `${sec.name}|${it.label}`;
        b.dataset.hint = it.hint;
        if (it.color) b.style.setProperty('--c', it.color);
        if (it.depth) b.style.paddingLeft = `${10 + it.depth * 14}px`;
        if (it.folder) { b.classList.add('br-folder'); b.setAttribute('aria-expanded', String(!!it.open)); }
        if (it.menu) b.addEventListener('contextmenu', (e) => { e.preventDefault(); BF.ui.menu(e.clientX, e.clientY, it.menu); });
        const ic = document.createElement('span'); ic.className = 'br-ic'; ic.textContent = it.icon; ic.setAttribute('aria-hidden', 'true');
        const l = document.createElement('span'); l.textContent = it.label;
        b.append(ic, l);
        if (it.preview) {
          // like a sample browser: click = hear it, double-click (or Enter) = use it, drag = drop it somewhere
          b.addEventListener('click', () => it.preview());
          b.addEventListener('dblclick', () => it.use());
          b.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); it.use(); } });
          b.addEventListener('contextmenu', (e) => { e.preventDefault(); BF.ui.menu(e.clientX, e.clientY, [{ label: 'Preview', action: it.preview }, { label: it.useLabel || 'Add', action: it.use }]); });
        } else b.addEventListener('click', () => it.use());
        b._preview = it.preview || null;
        // ↑ ↓ move through the list; Shift+↑ ↓ also plays each sound (like a sample browser)
        b.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault(); e.stopPropagation();
          const all = [...list.querySelectorAll('.br-item')];
          const next = all[all.indexOf(b) + (e.key === 'ArrowUp' ? -1 : 1)];
          if (!next) return;
          next.focus();
          if (e.shiftKey && next._preview) next._preview();
        });
        if (it.drag) {
          b.draggable = true;
          b.addEventListener('dragstart', (e) => { e.dataTransfer.setData(MIME, JSON.stringify(it.drag)); e.dataTransfer.effectAllowed = 'copy'; });
        }
        list.append(b);
      });
    });
    list.scrollTop = scroll;
    // focus the same item again without scrolling (names repeat, e.g. "Kick" in Drums and in a pack)
    if (focusKey) [...list.querySelectorAll('.br-item')].find((x) => x.dataset.key === focusKey)?.focus({ preventScroll: true });
    list.scrollTop = scroll;
  };

  /** Open a section (and scroll to it). */
  B.reveal = function (name) {
    B.collapsed.delete(name);
    if (!B.open) B.toggle(true);
    B.render(true);
    [...list.querySelectorAll('.br-sec')].find((h) => h.textContent.includes(name))?.scrollIntoView({ block: 'start' });
  };

  /** Read a browser drag payload from a drop event (null if it is not one). */
  B.payload = function (e) {
    try { const s = e.dataTransfer?.getData(MIME); return s ? JSON.parse(s) : null; } catch { return null; }
  };
  B.isDrag = (e) => [...(e.dataTransfer?.types || [])].includes(MIME);
})();
