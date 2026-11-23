/* templates.js: start a project from a template (File → New from template) and save your own (File → Save as template).
 * Built-in starters are made in code; your own templates are whole projects (with their audio) kept in this
 * computer's browser storage (IndexedDB), so they are there every time you open BeatForge. */
(function () {
  'use strict';
  const BF = window.BF;
  const T = (BF.templates = {});
  const DB = 'beatforge', STORE = 'templates';

  // ---------- storage ----------
  function db() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('Browser storage is not available.'));
    });
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => { d.close(); resolve(out && 'result' in out ? out.result : undefined); };
      t.onerror = () => { d.close(); reject(t.error); };
    });
  }
  T.listMine = async () => ((await tx('readonly', (s) => s.getAll())) || []).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  T.remove = (id) => tx('readwrite', (s) => s.delete(id));

  T.saveCurrent = async function () {
    const name = await BF.ui.prompt('Template name', BF.project.name === 'Untitled' ? 'My template' : BF.project.name);
    if (!name) return;
    const data = BF.io.serialize(BF.project);
    try {
      await tx('readwrite', (s) => s.put({ id: BF.uid('tpl'), name: name.slice(0, 60), savedAt: new Date().toISOString(), project: data }));
      BF.ui.toast(`Saved template "${name}". File → New from template… to use it.`);
    } catch (e) {
      BF.ui.toast(`Could not save the template: ${e.message || e}`, true);
    }
  };

  // ---------- built-in starters ----------
  function starter({ bpm, swing = 0, kit, drums, synths = [], name }) {
    const p = BF.newProject(false);
    p.name = name;
    p.bpm = bpm;
    p.swing = swing;
    p.channels = [];
    p.mixer.forEach((m, i) => { if (i) m.name = `Insert ${i}`; });
    const pt = p.patterns[0];
    pt.steps = {}; pt.notes = {}; pt.length = 16;
    const opts = new Map(BF.plugins.get('drum').params[0].options);
    const add = (plugin, preset, chName) => {
      const ch = BF.newChannel(plugin, chName, { preset });
      ch.insert = BF.rack.freeInsert(p);
      if (ch.insert) p.mixer[ch.insert].name = ch.name;
      p.channels.push(ch);
      return ch;
    };
    Object.entries(drums).forEach(([sound, steps]) => {
      const ch = add('drum', { sound, ...((BF.KITS[kit] || {})[sound] || {}) }, opts.get(sound));
      if (steps) pt.steps[ch.id] = Array.from({ length: 16 }, (_, i) => steps.includes(i));
    });
    synths.forEach(([plugin, preset, chName, notes]) => {
      const ch = add(plugin, preset, chName);
      if (notes) pt.notes[ch.id] = notes.map(([start, len, key]) => ({ id: BF.uid('n'), start, len, key, vel: 0.8 }));
    });
    p.selectedChannel = p.channels[0].id;
    p.clips.push({ id: BF.uid('c'), kind: 'pattern', track: 0, start: 0, len: 4, patternId: pt.id });
    return p;
  }
  T.builtIn = [
    { name: 'Empty project', note: 'Nothing in it', make: () => BF.newProject(false) },
    { name: 'Demo beat', note: 'The BeatForge demo', make: () => BF.newProject(true) },
    {
      name: 'Trap starter', note: '140 BPM · Trap kit, 808, lead',
      make: () => starter({
        name: 'Trap beat', bpm: 140, kit: 'Trap kit',
        drums: { kick: [0, 7, 10], snare: [4, 12], hihat: [0, 2, 4, 6, 8, 9, 10, 12, 14, 15], openhat: [11], clap: [4, 12], bass808: null },
        synths: [['synth', '808 glide', '808 bass', [[0, 6, 36], [7, 3, 36], [10, 6, 39]]], ['synth', 'Bright lead', 'Lead', null]],
      }),
    },
    {
      name: 'House starter', note: '124 BPM · four on the floor, bass',
      make: () => starter({
        name: 'House track', bpm: 124, kit: 'House kit',
        drums: { kick: [0, 4, 8, 12], clap: [4, 12], hihat: [2, 6, 10, 14], openhat: [2, 6, 10, 14], snare: null, cowbell: null },
        synths: [['synth', 'Sub bass', 'Bass', [[2, 1.5, 33], [6, 1.5, 33], [10, 1.5, 36], [14, 1.5, 31]]], ['synth', 'Soft pad', 'Pad', null]],
      }),
    },
    {
      name: 'Lo-fi starter', note: '84 BPM · swing, dusty kit, keys',
      make: () => starter({
        name: 'Lo-fi beat', bpm: 84, swing: 0.35, kit: 'Lo-fi kit',
        drums: { kick: [0, 7, 10], snare: [4, 12], hihat: [0, 2, 4, 6, 8, 10, 12, 14], rim: [14], perc: null },
        synths: [['fm', 'E-piano', 'Keys', [[0, 8, 60], [0, 8, 64], [0, 8, 67], [0, 8, 71], [8, 8, 57], [8, 8, 60], [8, 8, 64], [8, 8, 67]]], ['synth', 'Sub bass', 'Bass', [[0, 7, 36], [8, 7, 33]]]],
      }),
    },
    {
      name: 'Rock starter', note: '110 BPM · live kit',
      make: () => starter({ name: 'Rock song', bpm: 110, kit: 'Rock kit', drums: { kick: [0, 6, 8], snare: [4, 12], hihat: [0, 2, 4, 6, 8, 10, 12, 14], crash: [0], tom: null }, synths: [['pluck', 'Steel', 'Guitar', null]] }),
    },
  ];

  // ---------- the picker ----------
  T.open = async function () {
    let mine = [];
    try { mine = await T.listMine(); } catch { mine = []; }
    const d = document.createElement('dialog');
    d.className = 'dlg tpl-dlg';
    d.innerHTML = '<h2>New from template</h2>';
    const grid = document.createElement('div');
    grid.className = 'tpl-grid';
    const use = async (make, label) => {
      if (BF.dirty && !confirm('Start a new project? Unsaved changes are lost.')) return;
      d.close();
      try {
        const made = await make();
        if (made && made.raw) await BF.io.load(made.raw, label, { keepName: true });
        else { BF.transport.stop(); BF.replaceProject(BF.normalizeProject(made)); }
        BF.dirty = false;
        BF.ui.toast(`New project from "${label}"`);
      } catch (e) { BF.ui.toast(`Could not use the template: ${e.message || e}`, true); }
    };
    const card = (title, note, onUse, onDelete) => {
      const c = document.createElement('div');
      c.className = 'tpl-card';
      c.setAttribute('role', 'button');
      c.tabIndex = 0;
      const b = document.createElement('b'); b.textContent = title;
      const s = document.createElement('span'); s.textContent = note;
      c.append(b, s);
      c.addEventListener('click', onUse);
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onUse(); } });
      if (onDelete) {
        const x = document.createElement('button');
        x.className = 'btn small danger tpl-del';
        x.textContent = 'Delete';
        x.setAttribute('aria-label', `Delete template ${title}`);
        x.addEventListener('click', async (e) => { e.stopPropagation(); if (!confirm(`Delete the template "${title}"?`)) return; await T.remove(onDelete); c.remove(); });
        c.append(x);
      }
      return c;
    };
    const h1 = document.createElement('h3'); h1.textContent = 'Starters';
    grid.append(h1);
    T.builtIn.forEach((t) => grid.append(card(t.name, t.note, () => use(t.make, t.name))));
    const h2 = document.createElement('h3'); h2.textContent = 'Your templates';
    grid.append(h2);
    if (!mine.length) { const e = document.createElement('p'); e.className = 'hint'; e.textContent = 'None yet. Set up a project the way you like it (channels, mixer, effects), then File → Save as template…'; grid.append(e); }
    mine.forEach((t) => grid.append(card(t.name, `Saved ${new Date(t.savedAt).toLocaleDateString()}`, () => use(() => ({ raw: t.project }), t.name), t.id)));
    const pack = document.createElement('button'); pack.className = 'btn'; pack.textContent = 'Import a template pack (.zip)…';
    pack.title = 'A zip with stems, MIDI and samples (like the template packs made for other DAWs)';
    pack.addEventListener('click', () => { d.close(); BF.packImport.ask(); });
    const close = document.createElement('button'); close.className = 'btn'; close.textContent = 'Cancel';
    close.addEventListener('click', () => d.close());
    const actions = document.createElement('div'); actions.className = 'dlg-actions'; actions.append(pack, close);
    d.append(grid, actions);
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
  };
})();
