/* community.js: community plugins (the BeatForge plugin store).
 * Plugins are reviewed and approved by the site Owner on grbnstudios.com before they appear in the store. The
 * catalog is signed (Ed25519); the desktop app checks the signature and every file's SHA-256 before installing.
 * A plugin's code runs only on the audio thread (js/worklet-host.js): no page, no network, no files.
 * Installed plugins become instruments / effects named `ext:<id>` and behave like the built-in ones (knobs,
 * presets-free, automation, saving). A project that uses a plugin you do not have keeps its settings and plays
 * silence on that channel until you install it. */
(function () {
  'use strict';
  const BF = window.BF;
  const F = BF.pluginFormat;
  const U = BF.plugins.util;
  const KEY = 'bf.plugins.v1';
  const SITE = 'https://grbnstudios.com';
  const API = '/api/main/beatforge/plugins';
  const C = (BF.community = { installed: new Map(), catalog: null, errors: new Map() });

  // ---------- storage ----------
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ plugins: [...C.installed.values()] })); } catch (e) { BF.ui.toast(`Could not save the plugin list: ${e.message}`, true); }
  }
  function load() {
    let list = [];
    try { list = (JSON.parse(localStorage.getItem(KEY) || '{}').plugins || []); } catch { list = []; }
    list.forEach((e) => {
      try {
        if (!e || !F.ID_RE.test(e.id)) return;
        // re-read the header from the stored source when we have it (never trust stored metadata over the code)
        if (e.source) { const r = F.parse(e.source); if (r.meta.id !== e.id) return; e.meta = r.meta; e.params = r.params; e.version = r.meta.version; e.kind = r.meta.kind; }
        if (!e.meta || !Array.isArray(e.params)) return;
        C.installed.set(e.id, e);
        register(e);
      } catch (err) { console.warn('plugin', e && e.id, err); }
    });
  }

  // ---------- parameters -> BeatForge knobs ----------
  function fmtFor(p) {
    const num = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
    switch (p.unit) {
      case '%': return p.max <= 1 ? U.pct : (v) => `${Math.round(v)}%`;
      case 'dB': return U.db;
      case 'Hz': return U.hz;
      case 's': return U.sec;
      case 'ms': return (v) => `${Math.round(v)} ms`;
      case undefined: return p.step && p.step >= 1 ? (v) => String(Math.round(v)) : null;
      default: return (v) => `${p.step && p.step >= 1 ? Math.round(v) : num(v)} ${p.unit}`;
    }
  }
  const toBF = (p) => (p.options
    ? { id: p.id, name: p.name, type: 'select', default: p.default, options: p.options.map((o, i) => [i, o]) }
    : Object.assign({ id: p.id, name: p.name, type: 'knob', min: p.min, max: p.max, default: p.default }, p.step ? { step: p.step } : {}, p.curve ? { curve: p.curve } : {}, fmtFor(p) ? { fmt: fmtFor(p) } : {}));

  const keyOf = (e) => `${e.id}@${e.version}`;

  function register(e) {
    const id = `ext:${e.id}`;
    const def = { id, kind: e.kind, name: e.meta.name, ext: true, entry: e, params: e.params.map(toBF), presets: {} };
    if (e.kind === 'effect') def.create = (ctx) => createEffect(ctx, e, def);
    else def.play = () => {}; // instruments go through C.note (persistent per-channel hosts)
    BF.plugins.register(def);
  }

  /** A project uses a plugin that is not installed: keep the channel/effect (and its settings), make no sound. */
  C.placeholder = function (pluginId, kind) {
    const id = String(pluginId).slice(4);
    BF.plugins.register({
      id: pluginId, kind, name: `${id} (not installed)`, ext: true, missing: true, params: [], presets: {},
      play() {}, create(ctx) { const g = ctx.createGain(); return { input: g, output: g, set() {}, dispose() { try { g.disconnect(); } catch { /* */ } } }; },
    });
  };

  // ---------- loading code onto an audio thread ----------
  const blobUrls = new Map();
  function moduleUrl(e) {
    if (e.source) {
      if (!blobUrls.has(keyOf(e))) blobUrls.set(keyOf(e), URL.createObjectURL(new Blob([F.wrap(e.meta, e.params, e.source)], { type: 'application/javascript' })));
      return blobUrls.get(keyOf(e));
    }
    return new URL(`${API}/worklet/${encodeURIComponent(e.id)}/${encodeURIComponent(e.version)}.js`, location.origin).href;
  }
  C.loadInto = async function (ctx) {
    if (!ctx.audioWorklet) return;
    ctx.__bfPlugins = ctx.__bfPlugins || new Map();
    const jobs = [];
    for (const e of C.installed.values()) {
      if (e.enabled === false || ctx.__bfPlugins.has(keyOf(e))) continue;
      const job = ctx.audioWorklet.addModule(moduleUrl(e)).then(
        () => { C.errors.delete(e.id); return true; },
        (err) => { C.errors.set(e.id, e.source && /^https?:$/.test(location.protocol) ? 'Plugins loaded from a file only run in the desktop app (the website blocks them).' : `Could not load: ${err.message || err}`); return false; });
      ctx.__bfPlugins.set(keyOf(e), job);
      jobs.push(job);
    }
    await Promise.all([...ctx.__bfPlugins.values()]);
  };
  const ready = (ctx, e) => ctx.__bfPlugins && ctx.__bfPlugins.has(keyOf(e));

  function reportFrom(node, e) {
    node.port.onmessage = (m) => {
      if (m.data && m.data.error && !C.errors.has(e.id)) {
        C.errors.set(e.id, m.data.error);
        BF.ui.toast(`Plugin "${e.meta.name}" stopped working: ${m.data.error}`, true);
      }
    };
  }

  function setParams(ctx, node, e, params, t, last) {
    e.params.forEach((p) => {
      let v = params ? params[p.id] : undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) v = p.default;
      if (last && last[p.id] === v) return;
      if (last) last[p.id] = v;
      const ap = node.parameters.get(`p_${p.id}`);
      if (!ap) return;
      if (ctx instanceof OfflineAudioContext && ctx.state !== 'running') ap.setValueAtTime(v, t || 0);
      else ap.setValueAtTime(v, Math.max(t || 0, ctx.currentTime));
    });
  }

  // ---------- effects ----------
  function createEffect(ctx, e) {
    let node = null;
    if (ready(ctx, e) && !C.errors.has(e.id)) {
      try {
        node = new AudioWorkletNode(ctx, `bfp-fx:${keyOf(e)}`, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
      } catch (err) { node = null; }
    }
    if (!node) { // still loading (it is rebuilt when ready) or broken: a straight wire
      const g = ctx.createGain();
      return { input: g, output: g, set() {}, dispose() { try { g.disconnect(); } catch { /* */ } } };
    }
    reportFrom(node, e);
    return {
      input: node, output: node,
      set(params) { setParams(ctx, node, e, params, ctx.currentTime, null); },
      dispose() { try { node.disconnect(); } catch { /* */ } node.port.onmessage = null; },
    };
  }

  // ---------- instruments ----------
  // One audio-thread host per channel (and one for previews / live playing), fed with timed notes.
  // Offline exports collect every note first and hand them over when the node is made (C.flush), so the
  // render is exact; live playback posts each note ~120 ms ahead.
  const hosts = new WeakMap(); // ctx -> Map(key -> host)
  let noteId = 0;
  function hostFor(g, ch, e, mode) {
    const ctx = g.ctx;
    if (!hosts.has(ctx)) hosts.set(ctx, new Map());
    const map = hosts.get(ctx);
    const out = mode === 'main' ? BF.audio.chanStrip(g, ch).gain : null;
    const k = `${ch.id}|${mode}|${keyOf(e)}`;
    let h = map.get(k);
    if (h && (h.out !== out || (mode !== 'main' && h.insert !== ch.insert))) { try { (h.node || {}).disconnect?.(); h.strip && h.strip.pan.disconnect(); } catch { /* */ } h = null; }
    if (!h) {
      h = { e, out, insert: ch.insert, node: null, pending: [], paramEvents: [], last: {}, strip: null };
      if (mode !== 'main') { // previews and live notes: a persistent strip into the insert's preview input
        const gn = ctx.createGain(), pn = ctx.createStereoPanner();
        gn.connect(pn).connect(g.inserts[ch.insert].preview);
        h.strip = { gain: gn, pan: pn };
        h.out = gn;
      }
      map.set(k, h);
    }
    if (h.strip) { h.strip.gain.gain.value = ch.volume; h.strip.pan.pan.value = ch.pan; }
    return h;
  }
  function makeNode(ctx, h, notes) {
    try {
      h.node = new AudioWorkletNode(ctx, `bfp-in:${keyOf(h.e)}`, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { notes } });
    } catch (err) { h.node = null; return false; }
    reportFrom(h.node, h.e);
    h.node.connect(h.out);
    return true;
  }
  const isOffline = (ctx) => ctx instanceof OfflineAudioContext;

  /** Book one note on an ext instrument. Returns { release(time) } (used by live playing). */
  C.note = function (g, ch, time, key, vel, dur, mode, params) {
    const e = BF.plugins.get(ch.plugin)?.entry;
    const ctx = g.ctx;
    if (!e || !ready(ctx, e) || C.errors.has(e.id)) return null;
    const h = hostFor(g, ch, e, mode);
    const id = ++noteId;
    const msg = { type: 'note', id, t: time, key, vel, dur: dur == null ? null : dur };
    if (isOffline(ctx) && !h.flushed) {
      h.pending.push(msg);
      h.paramEvents.push([time, params || ch.params]);
      h.ctx = ctx;
      (ctx.__bfInstHosts = ctx.__bfInstHosts || new Set()).add(h);
      return null;
    }
    if (!h.node && !makeNode(ctx, h, [])) return null;
    setParams(ctx, h.node, e, params || ch.params, time, h.last);
    h.node.port.postMessage(msg);
    return { release: (t) => h.node && h.node.port.postMessage({ type: 'off', id, t: t == null ? ctx.currentTime : t }) };
  };

  /** Before an offline render starts: create the instrument nodes with all their notes. */
  C.flush = function (ctx) {
    (ctx.__bfInstHosts || []).forEach((h) => {
      if (h.flushed) return;
      h.flushed = true;
      if (!makeNode(ctx, h, h.pending)) return;
      h.paramEvents.sort((a, b) => a[0] - b[0]).forEach(([t, prm]) => setParams(ctx, h.node, h.e, prm, t, h.last));
    });
  };

  /** Transport stop: drop booked notes and release everything that sounds. */
  C.stopAll = function () {
    const ctx = BF.audio.ctx;
    const map = ctx && hosts.get(ctx);
    if (!map) return;
    map.forEach((h) => h.node && h.node.port.postMessage({ type: 'stop', t: ctx.currentTime }));
  };

  // ---------- installing ----------
  const desktop = () => window.beatforgeDesktop && typeof window.beatforgeDesktop.pluginCatalog === 'function' ? window.beatforgeDesktop : null;
  const onSite = () => /^https?:$/.test(location.protocol);
  C.storeAvailable = () => !!desktop() || onSite();

  C.fetchCatalog = async function () {
    let res;
    if (desktop()) res = await desktop().pluginCatalog();
    else if (onSite()) {
      const r = await fetch(`${API}/catalog`, { cache: 'no-store', credentials: 'omit' });
      if (!r.ok) throw new Error(`The store answered ${r.status}.`);
      const body = await r.json();
      res = { catalog: JSON.parse(body.catalog) };
    } else throw new Error('The plugin store works in the desktop app and on grbnstudios.com/beatforge-web.');
    if (res.error) throw new Error(res.error);
    C.catalog = res.catalog;
    return C.catalog;
  };

  async function activate(e) {
    C.installed.set(e.id, e);
    register(e);
    save();
    C.errors.delete(e.id);
    // load it into the running audio context, then rebuild effect chains so new effects come alive
    if (BF.audio.ctx) {
      await C.loadInto(BF.audio.ctx).catch(() => {});
      BF.audio.graph.inserts.forEach((ins) => { ins.fxKey = null; ins.fx.forEach((x) => x.inst.dispose()); ins.fx = []; });
      BF.audio.sync(BF.audio.graph, BF.project);
    }
    BF.emit('load');
  }

  C.install = async function (item) {
    const old = C.installed.get(item.id);
    if (old && old.origin === 'file' && !confirm(`"${item.name}" from a file is installed. Replace it with the store version?`)) return;
    BF.ui.busy(`Installing ${item.name}…`);
    try {
      let e;
      if (desktop()) {
        const r = await desktop().pluginSource(item.id, item.version);
        if (r.error) throw new Error(r.error);
        const parsed = F.parse(r.source);
        if (parsed.meta.id !== item.id || parsed.meta.version !== item.version) throw new Error('The downloaded plugin does not match the store.');
        e = { id: item.id, version: item.version, kind: parsed.meta.kind, meta: parsed.meta, params: parsed.params, sha256: item.sha256, source: r.source, origin: 'store' };
      } else {
        e = { id: item.id, version: item.version, kind: item.kind, meta: { id: item.id, name: item.name, kind: item.kind, version: item.version, author: item.author, description: item.description }, params: item.params, sha256: item.sha256, origin: 'store' };
      }
      await activate(e);
      BF.ui.toast(`${item.name} ${item.version} installed. Find it in the browser under "Plugins".`);
    } catch (err) {
      BF.ui.toast(`Install failed: ${err.message || err}`, true);
    } finally { BF.ui.busy(null); }
  };

  C.remove = function (id) {
    const e = C.installed.get(id);
    if (!e) return;
    const used = BF.project.channels.some((c) => c.plugin === `ext:${id}`) || BF.project.mixer.some((m) => m.fx.some((f) => f.plugin === `ext:${id}`));
    if (!confirm(`Remove ${e.meta.name}?${used ? ' This project uses it: those channels/effects will go silent until you install it again.' : ''}`)) return;
    C.installed.delete(id);
    save();
    C.placeholder(`ext:${id}`, e.kind);
    if (BF.audio.graph) { BF.audio.graph.inserts.forEach((ins) => { ins.fxKey = null; }); BF.audio.sync(BF.audio.graph, BF.project); }
    BF.emit('load');
    renderStore();
  };

  /** Developer mode: load a plugin file you are writing (not reviewed). */
  C.installFile = function () {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.js,text/javascript';
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        const source = await f.text();
        const r = F.parse(source);
        const old = C.installed.get(r.meta.id);
        if (old && old.origin === 'store' && !confirm(`${r.meta.name} from the store is installed. Replace it with this file?`)) return;
        // a new blob each time, so editing the file and loading it again picks up the changes
        const e = { id: r.meta.id, version: r.meta.version, kind: r.meta.kind, meta: r.meta, params: r.params, source, origin: 'file', loadedAt: Date.now() };
        blobUrls.delete(keyOf(e));
        if (BF.audio.ctx && BF.audio.ctx.__bfPlugins && BF.audio.ctx.__bfPlugins.has(keyOf(e))) {
          BF.ui.toast('This exact id and version is already running. Raise @version (e.g. 1.0.1) to load your changes, or reload the app.', true);
        }
        await activate(e);
        BF.ui.toast(`Loaded ${r.meta.name} ${r.meta.version} from a file${r.warnings.length ? ` (${r.warnings.length} review note${r.warnings.length > 1 ? 's' : ''})` : ''}.`);
        renderStore();
      } catch (err) { BF.ui.toast(`This plugin file has a problem: ${err.message || err}`, true); }
    });
    inp.click();
  };

  // ---------- the store window ----------
  let root = null, listEl = null, statusEl = null, filter = 'all', query = '';
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  C.build = function () {
    root = h('div', 'store');
    const bar = h('div', 'store-bar');
    const search = h('input', 'store-search');
    search.type = 'search'; search.placeholder = 'Search plugins'; search.setAttribute('aria-label', 'Search plugins');
    search.addEventListener('input', () => { query = search.value.toLowerCase(); renderStore(); });
    const tabs = h('div', 'seg');
    [['all', 'All'], ['instrument', 'Instruments'], ['effect', 'Effects'], ['installed', 'Installed']].forEach(([v, l]) => {
      const b = h('button', 'seg-btn', l);
      b.type = 'button'; b.dataset.f = v;
      b.addEventListener('click', () => { filter = v; renderStore(); });
      tabs.append(b);
    });
    const refresh = h('button', 'btn', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', () => C.openStore(true));
    const file = h('button', 'btn', 'Load plugin file…');
    file.type = 'button';
    file.title = 'For plugin makers: load a plugin you are writing (not reviewed). Runs in the desktop app.';
    file.addEventListener('click', () => C.installFile());
    const submit = h('a', 'btn', 'Submit a plugin');
    submit.href = `${SITE}/beatforge-plugins`; submit.target = '_blank'; submit.rel = 'noopener';
    bar.append(search, tabs, refresh, file, submit);
    statusEl = h('p', 'store-status');
    listEl = h('div', 'store-list');
    root.append(bar, statusEl, listEl);
    return root;
  };

  function renderStore() {
    if (!root) return;
    root.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
    const byId = new Map();
    (C.catalog?.plugins || []).forEach((p) => byId.set(p.id, { item: p, inst: C.installed.get(p.id) }));
    C.installed.forEach((e, id) => { if (!byId.has(id)) byId.set(id, { item: null, inst: e }); });
    let rows = [...byId.values()];
    rows = rows.filter(({ item, inst }) => {
      const kind = (item || inst.meta).kind;
      if (filter === 'installed' && !inst) return false;
      if ((filter === 'instrument' || filter === 'effect') && kind !== filter) return false;
      if (!query) return true;
      const m = item || inst.meta;
      return `${m.name} ${m.author} ${m.description} ${m.id}`.toLowerCase().includes(query);
    }).sort((a, b) => (a.item || a.inst.meta).name.localeCompare((b.item || b.inst.meta).name));
    listEl.replaceChildren();
    if (!rows.length) listEl.append(h('p', 'store-empty', C.catalog ? 'No plugins match.' : 'No plugins yet.'));
    rows.forEach(({ item, inst }) => {
      const m = item || inst.meta;
      const card = h('article', 'store-card');
      const top = h('div', 'store-top');
      top.append(h('b', null, m.name), h('span', `store-kind k-${m.kind}`, m.kind === 'effect' ? 'Effect' : 'Instrument'));
      const by = h('p', 'store-by', `by ${m.author} · v${item ? item.version : inst.version}${inst && item && F.cmpVersion(item.version, inst.version) > 0 ? ` (you have ${inst.version})` : ''}`);
      const desc = h('p', 'store-desc', m.description || '');
      const actions = h('div', 'store-actions');
      if (item && (!inst || inst.origin === 'file' || F.cmpVersion(item.version, inst.version) > 0)) {
        const b = h('button', 'btn accent', !inst ? 'Install' : inst.origin === 'file' ? 'Install store version' : `Update to ${item.version}`);
        b.type = 'button';
        b.addEventListener('click', async () => { await C.install(item); renderStore(); });
        actions.append(b);
      }
      if (inst) {
        const r = h('button', 'btn', 'Remove');
        r.type = 'button';
        r.addEventListener('click', () => C.remove(inst.id));
        actions.append(r);
        if (inst.origin === 'file') actions.append(h('span', 'store-note', 'From a file (not reviewed)'));
        else if (!item && C.catalog) actions.append(h('span', 'store-note', 'No longer in the store'));
        if (C.errors.has(inst.id)) actions.append(h('span', 'store-err', C.errors.get(inst.id)));
      }
      card.append(top, by, desc, actions);
      listEl.append(card);
    });
  }
  C.render = renderStore;

  C.openStore = async function (force) {
    BF.win.toggle('store', true);
    renderStore();
    if (C.catalog && !force) return;
    if (!C.storeAvailable()) { statusEl.textContent = 'The store needs the desktop app or the website version. You can still load plugin files.'; return; }
    statusEl.textContent = 'Loading the store…';
    try {
      const cat = await C.fetchCatalog();
      statusEl.textContent = `${cat.plugins.length} approved plugin${cat.plugins.length === 1 ? '' : 's'}. Every plugin is checked by GRBN Studios before it shows up here, and only makes sound: no access to your files or the internet.`;
    } catch (err) {
      statusEl.textContent = `Could not load the store: ${err.message || err}`;
    }
    renderStore();
  };

  load();
})();
