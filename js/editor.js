/* editor.js: the plugin editor window. Shows the knobs of a channel's instrument or a mixer effect.
 * Built from the plugin's parameter list, so every plugin gets an editor for free. */
(function () {
  'use strict';
  const BF = window.BF;
  const E = (BF.editor = { target: null }); // { kind:'channel', id } | { kind:'effect', insert, id }
  let body;
  let controls = new Map();

  E.build = function () {
    body = document.createElement('div');
    body.className = 'ed';
    return body;
  };

  E.openChannel = function (id) {
    E.target = { kind: 'channel', id };
    BF.win.toggle('editor', true);
    E.render();
  };
  E.openEffect = function (insert, id) {
    E.target = { kind: 'effect', insert, id };
    BF.win.toggle('editor', true);
    E.render();
  };
  E.closeIf = function (id) { if (E.target && E.target.id === id) { E.target = null; BF.win.toggle('editor', false); } };

  /** Find the live object being edited (after undo/redo it may be a new object). */
  function current() {
    const p = BF.project, t = E.target;
    if (!t) return null;
    if (t.kind === 'channel') { const ch = p.channels.find((c) => c.id === t.id); return ch ? { obj: ch, plugin: ch.plugin, title: ch.name } : null; }
    const f = p.mixer[t.insert]?.fx.find((x) => x.id === t.id);
    return f ? { obj: f, plugin: f.plugin, title: `${p.mixer[t.insert].name} · slot ${p.mixer[t.insert].fx.indexOf(f) + 1}` } : null;
  }

  function locate(p) {
    const t = E.target;
    return t.kind === 'channel' ? p.channels.find((c) => c.id === t.id) : p.mixer[t.insert].fx.find((x) => x.id === t.id);
  }

  E.render = function () {
    if (!body) return;
    const cur = current();
    const w = BF.win.all.get('editor');
    body.textContent = '';
    controls = new Map();
    if (!cur) {
      if (w) w.title.textContent = 'Plugin';
      const e = document.createElement('p'); e.className = 'empty'; e.textContent = 'Click a channel name in the channel rack, or an effect slot in the mixer.'; body.append(e);
      return;
    }
    const def = BF.plugins.get(cur.plugin);
    if (w) w.title.textContent = `${def.name} · ${cur.title}`;
    const top = document.createElement('div');
    top.className = 'ed-top';
    const badge = document.createElement('span');
    badge.className = 'ed-badge';
    badge.textContent = def.kind === 'instrument' ? 'Instrument' : 'Effect';
    top.append(badge);
    if (def.presets) {
      const ps = document.createElement('select');
      ps.setAttribute('aria-label', 'Preset');
      ps.add(new Option('Presets…', ''));
      Object.keys(def.presets).forEach((n) => ps.add(new Option(n, n)));
      ps.addEventListener('change', () => {
        if (!ps.value) return;
        const vals = BF.plugins.defaults(def.id, ps.value);
        BF.commit((p) => { locate(p).params = vals; });
        E.render();
      });
      top.append(ps);
    }
    const reset = document.createElement('button');
    reset.className = 'btn small';
    reset.textContent = 'Reset';
    reset.title = 'All knobs back to default';
    reset.addEventListener('click', () => { BF.commit((p) => { locate(p).params = BF.plugins.defaults(def.id); }); E.render(); });
    top.append(reset);
    if (cur.plugin === 'sampler') {
      const load = document.createElement('button');
      load.className = 'btn small';
      load.textContent = 'Load audio file…';
      load.addEventListener('click', () => BF.io.pickFiles(async (files) => {
        const id = await BF.io.addSample(files[0]);
        if (id) { BF.commit((p) => { locate(p).params.sample = id; }); E.render(); }
      }, false));
      top.append(load);
    }
    if (def.kind === 'instrument') {
      const test = document.createElement('button');
      test.className = 'btn small';
      test.textContent = '▶ Test note';
      test.addEventListener('click', () => BF.audio.previewNote(cur.obj, 60, 0.85, 0.6));
      top.append(test);
    }
    body.append(top);
    const grid = document.createElement('div');
    grid.className = 'ed-grid';
    def.params.forEach((pd) => {
      const t = E.target;
      const target = t.kind === 'channel' ? { kind: 'chp', id: t.id, param: pd.id } : { kind: 'fx', insert: t.insert, fxId: t.id, param: pd.id };
      const ctl = BF.ui.paramControl(pd, cur.obj.params[pd.id], (v) => {
        BF.commit((p) => { locate(p).params[pd.id] = v; }, `param-${E.target.id}-${pd.id}`, 'param');
      }, { target });
      controls.set(pd.id, ctl);
      grid.append(ctl.el);
    });
    if (def.kind === 'instrument') {
      const pitch = BF.ui.knob({ param: { id: 'pitch', name: 'Channel pitch', min: -24, max: 24, default: 0, step: 1, unit: ' st' }, value: cur.obj.pitch, onInput: (v) => BF.commit((p) => { locate(p).pitch = v; }, `pitch-${E.target.id}`, 'param') });
      grid.append(pitch.el);
      controls.set('__pitch', pitch);
    }
    body.append(grid);
  };

  /** Refresh knob positions (after undo/redo) without rebuilding. */
  E.sync = function () {
    const cur = current();
    if (!cur) { E.render(); return; }
    controls.forEach((ctl, id) => ctl.set(id === '__pitch' ? cur.obj.pitch : cur.obj.params[id]));
  };
})();
