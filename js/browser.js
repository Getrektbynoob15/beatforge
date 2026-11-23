/* browser.js: the docked browser on the left (F8). Instruments, presets, effects and the project's own patterns,
 * channels and audio. Click to use an item, or drag it: instruments onto the channel rack, effects onto a mixer strip,
 * audio onto a playlist track. A search box filters everything. */
(function () {
  'use strict';
  const BF = window.BF;
  const B = (BF.browser = { open: true, collapsed: new Set(['Project · Channels']) });
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
    root.append(head, list);
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

  function sections() {
    const p = BF.project;
    const drum = BF.plugins.get('drum');
    const synth = BF.plugins.get('synth');
    const out = [];
    out.push({ name: 'Instruments · Drums', items: drum.params[0].options.map(([id, label]) => ({
      label, hint: `Drum Kit: ${label}. Click to add a channel, or drag it onto the channel rack.`, icon: '🥁',
      drag: { kind: 'instrument', plugin: 'drum', preset: { sound: id }, name: label },
      use: () => BF.rack.addChannel('drum', { sound: id }, label),
      preview: () => BF.audio.previewNote({ plugin: 'drum', params: BF.plugins.defaults('drum', { sound: id }), volume: 0.8, pan: 0, pitch: 0, insert: 0 }, 60, 0.9, 0.3),
    })) });
    out.push({ name: 'Instruments · Synth presets', items: Object.keys(synth.presets).map((n) => ({
      label: n, hint: `Forge Synth preset "${n}". Click to add a channel.`, icon: '🎹',
      drag: { kind: 'instrument', plugin: 'synth', preset: n, name: n },
      use: () => BF.rack.addChannel('synth', n, n === 'Init' ? 'Forge Synth' : n),
      preview: () => BF.audio.previewNote({ plugin: 'synth', params: BF.plugins.defaults('synth', n), volume: 0.8, pan: 0, pitch: 0, insert: 0 }, 60, 0.9, 0.5),
    })) });
    out.push({ name: 'Instruments · Other', items: [{
      label: 'Sampler (load audio…)', hint: 'Make a Sampler channel from an audio file', icon: '🎚',
      use: () => BF.io.pickFiles((f) => BF.io.importToRack(f)),
    }] });
    out.push({ name: 'Effects', items: BF.plugins.list('effect').map((d) => ({
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
      label: p.samples[id].name, hint: 'Click to pick it for the playlist, or drag it onto a playlist track', icon: '〰',
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

  B.render = function () {
    if (!list || root.hidden) return;
    const q = (search.value || '').trim().toLowerCase();
    list.textContent = '';
    sections().forEach((sec) => {
      const items = q ? sec.items.filter((it) => it.label.toLowerCase().includes(q)) : sec.items;
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
        const b = document.createElement('button');
        b.className = 'br-item' + (it.active ? ' on' : '');
        b.dataset.hint = it.hint;
        if (it.color) b.style.setProperty('--c', it.color);
        const ic = document.createElement('span'); ic.className = 'br-ic'; ic.textContent = it.icon; ic.setAttribute('aria-hidden', 'true');
        const l = document.createElement('span'); l.textContent = it.label;
        b.append(ic, l);
        b.addEventListener('click', () => it.use());
        if (it.preview) b.addEventListener('pointerenter', (e) => { if (e.altKey) it.preview(); });
        if (it.preview) b.addEventListener('contextmenu', (e) => { e.preventDefault(); it.preview(); });
        if (it.drag) {
          b.draggable = true;
          b.addEventListener('dragstart', (e) => { e.dataTransfer.setData(MIME, JSON.stringify(it.drag)); e.dataTransfer.effectAllowed = 'copy'; });
        }
        list.append(b);
      });
    });
  };

  /** Read a browser drag payload from a drop event (null if it is not one). */
  B.payload = function (e) {
    try { const s = e.dataTransfer?.getData(MIME); return s ? JSON.parse(s) : null; } catch { return null; }
  };
  B.isDrag = (e) => [...(e.dataTransfer?.types || [])].includes(MIME);
})();
