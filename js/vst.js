/* vst.js: VST3 instruments in the desktop app (Windows; Linux for testing), through the BeatForge Plugin Host.
 * A VST channel is { plugin: 'vst:<class id>', vstState: base64 } : the plugin's own saved state is the source of truth
 * (its knobs are not copied into ch.params). Live: one AudioWorklet node per channel ('bf-vst' in worklet-host.js)
 * asks the host for audio a little ahead of time. Export: each VST channel is rendered by a fresh copy of the plugin
 * (same state), then played into the offline mix as audio. */
(function () {
  'use strict';
  const BF = window.BF;
  const V = (BF.vst = { plugins: [], folders: [], scanned: false, hosts: new Map(), info: new Map() });
  const desk = () => (window.beatforgeDesktop && typeof window.beatforgeDesktop.vst === 'function' ? window.beatforgeDesktop : null);
  const call = (cmd, args) => desk().vst(cmd, args);
  const ID = /^vst:[0-9A-F]{32}$/;
  const b64 = () => BF.io._b64;
  const CACHE = 'bf-vst-list';

  V.available = () => !!desk() && V.ok === true; // the desktop app, with the plugin host for this computer

  function register(p) {
    const id = `vst:${p.cid}`;
    const old = BF.plugins.get(id);
    if (old && !old.missing) return;
    BF.plugins.register({ id, kind: p.kind, name: p.name, vst: p, params: [], presets: {}, play() {}, create: p.kind === 'effect' ? passThrough : undefined });
  }
  function passThrough(ctx) { const g = ctx.createGain(); return { input: g, output: g, set() {}, dispose() { try { g.disconnect(); } catch { /* */ } } }; }

  /** A project uses a VST this computer does not have (or has not scanned yet): keep the channel and its state. */
  V.placeholder = function (id, kind, name) {
    if (BF.plugins.has(id)) return;
    BF.plugins.register({ id, kind, name: `${name || 'VST plugin'} (not found)`, vst: null, missing: true, params: [], presets: {}, play() {}, create: passThrough });
  };

  V.scan = async function () {
    if (!desk()) return [];
    const r = await call('scan');
    if (r.error) throw new Error(r.error);
    V.plugins = r.plugins; V.folders = r.folders || []; V.scanned = true;
    try { localStorage.setItem(CACHE, JSON.stringify(V.plugins.map(({ path, cid, name, vendor, kind }) => ({ path, cid, name, vendor, kind })))); } catch { /* */ }
    V.plugins.forEach(register);
    reconnectMissing();
    return V.plugins;
  };
  // channels whose plugin was a placeholder and is now found: start them
  function reconnectMissing() { if (BF.audio.ctx) V.sync(); }

  V.init = function () {
    if (!desk()) return;
    try { (JSON.parse(localStorage.getItem(CACHE) || '[]') || []).forEach((p) => p && /^[0-9A-F]{32}$/i.test(p.cid) && register(p)); } catch { /* */ }
    desk().onVstEvent(onEvent);
    BF.onChange(() => V.sync());
    call('available').then((r) => {
      V.ok = !!(r && r.ok);
      // scan in the background once the app is up (it loads every plugin file once, so it can take a few seconds)
      if (V.ok) setTimeout(() => V.scan().catch((e) => console.warn('vst scan', e)), 2500);
    });
  };

  // ---------- live instances (one per channel) ----------
  const instId = (prefix, chId) => `${prefix}${String(chId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;
  const ports = new Map(); // tag -> callback(port)
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.bfVstPort !== 'string') return;
    const cb = ports.get(e.data.bfVstPort);
    ports.delete(e.data.bfVstPort);
    if (cb && e.ports[0]) cb(e.ports[0]);
  });
  let portSeq = 0;
  const getPort = () => new Promise((resolve) => { const tag = `p${++portSeq}`; ports.set(tag, resolve); desk().vstPort(tag); });

  async function loadInto(inst, def, rate, state) {
    const r = await call('load', { inst, path: def.vst.path, cid: def.vst.cid, rate, block: 512 });
    if (r.error) throw new Error(r.error);
    if (state) { const s = await call('setState', { inst, state: b64().base64ToBytes(state) }); if (s.values) s.values.forEach(([id, v]) => { const p = r.params.find((x) => x.id === id); if (p) p.value = v; }); }
    return r;
  }

  function hostFor(g, ch) {
    let h = V.hosts.get(ch.id);
    if (h && h.plugin === ch.plugin) return h;
    if (h) dropHost(ch.id);
    const def = BF.plugins.get(ch.plugin);
    if (!def || !def.vst || !g.ctx.__bfWorkletsDone) return null;
    const node = new AudioWorkletNode(g.ctx, 'bf-vst', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(BF.audio.chanStrip(g, ch).gain);
    h = { plugin: ch.plugin, inst: instId('c', ch.id), node, ready: false, state: ch.vstState || null, chId: ch.id };
    V.hosts.set(ch.id, h);
    getPort().then((port) => node.port.postMessage({ type: 'port', port }, [port]));
    loadInto(h.inst, def, g.ctx.sampleRate, h.state).then((info) => {
      if (V.hosts.get(ch.id) !== h) { call('unload', { inst: h.inst }); return; }
      V.info.set(ch.id, info);
      h.ready = true;
      node.port.postMessage({ type: 'inst', inst: h.inst });
      node.port.postMessage({ type: 'transport', tempo: BF.project.bpm, playing: !!BF.transport.playing });
      if (BF.editor && BF.editor.target && BF.editor.target.id === ch.id) BF.editor.render();
    }).catch((e) => { BF.ui.toast(`${def.name}: ${e.message}`, true); V.hosts.delete(ch.id); try { node.disconnect(); } catch { /* */ } });
    return h;
  }
  function dropHost(chId) {
    const h = V.hosts.get(chId);
    if (!h) return;
    V.hosts.delete(chId); V.info.delete(chId);
    try { h.node.port.postMessage({ type: 'dispose' }); h.node.disconnect(); } catch { /* */ }
    call('unload', { inst: h.inst });
  }

  /** Keep live instances in step with the project (channels removed, plugin swapped, state changed by undo/open). */
  V.sync = function () {
    const g = BF.audio.graph;
    if (!g || !desk()) return;
    const live = new Map(BF.project.channels.map((c) => [c.id, c]));
    for (const [id, h] of V.hosts) {
      const ch = live.get(id);
      if (!ch || ch.plugin !== h.plugin) { dropHost(id); continue; }
      if (h.ready && (ch.vstState || null) !== h.state) { // undo, open project, a session guest's change
        h.state = ch.vstState || null;
        if (h.state) call('setState', { inst: h.inst, state: b64().base64ToBytes(h.state) }).then((s) => {
          const info = V.info.get(id);
          if (info && s.values) s.values.forEach(([pid, v]) => { const p = info.params.find((x) => x.id === pid); if (p) p.value = v; });
          if (BF.editor && BF.editor.target && BF.editor.target.id === id) BF.editor.sync();
        });
      }
    }
    // start instances for VST channels right away, so the first note is not late
    BF.project.channels.forEach((ch) => { const d = BF.plugins.get(ch.plugin); if (d && d.vst && !V.hosts.has(ch.id)) hostFor(g, ch); });
    V.hosts.forEach((h) => h.ready && h.node.port.postMessage({ type: 'transport', tempo: BF.project.bpm, playing: !!BF.transport.playing }));
  };

  /** Book one note (called from BF.audio.note). Offline renders collect the notes and render them in flush(). */
  V.note = function (g, ch, time, key, vel, dur) {
    const ctx = g.ctx;
    if (typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext) {
      const m = (ctx.__bfVst = ctx.__bfVst || new Map());
      if (!m.has(ch.id)) m.set(ch.id, { ch, evs: [] });
      m.get(ch.id).evs.push([time, key, vel, dur]);
      return null;
    }
    const h = hostFor(g, ch);
    if (!h) return null;
    h.node.port.postMessage({ type: 'note', t: time, key, vel, dur: dur == null ? null : dur });
    return { release: (t) => h.node.port.postMessage({ type: 'off', t: t == null ? ctx.currentTime : t, key }) };
  };
  V.stopAll = function () { V.hosts.forEach((h) => h.node.port.postMessage({ type: 'stop' })); };

  /** Offline export: render every VST channel's notes with a fresh copy of the plugin, then mix it in as audio. */
  V.flush = async function (ctx, g) {
    const m = ctx.__bfVst;
    if (!m || !m.size || !desk()) return;
    const rate = ctx.sampleRate, total = ctx.length, CH = 16384;
    for (const { ch, evs } of m.values()) {
      const def = BF.plugins.get(ch.plugin);
      if (!def || !def.vst) continue;
      const inst = instId('x', `${ch.id}${Math.random().toString(36).slice(2, 8)}`);
      try {
        await loadInto(inst, def, rate, ch.vstState);
        const list = [];
        evs.forEach(([t, key, vel, dur]) => { const f = Math.round(t * rate); list.push([f, 0, key, vel]); if (dur != null) list.push([f + Math.max(1, Math.round(dur * rate)), 1, key, 0]); });
        list.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
        const out = new AudioBuffer({ length: total, numberOfChannels: 2, sampleRate: rate });
        const L = out.getChannelData(0), R = out.getChannelData(1);
        let k = 0;
        for (let pos = 0; pos < total; pos += CH) {
          const n = Math.min(CH, total - pos);
          const take = [];
          while (k < list.length && list[k][0] < pos + n) take.push(list[k++]);
          const eb = new ArrayBuffer(16 * take.length), dv = new DataView(eb);
          take.forEach(([f, type, key, vel], i) => { dv.setInt32(i * 16, Math.max(0, f - pos), true); dv.setInt32(i * 16 + 4, type, true); dv.setInt32(i * 16 + 8, key, true); dv.setFloat32(i * 16 + 12, vel, true); });
          const r = await call('render', { inst, frames: n, nEv: take.length, events: new Uint8Array(eb), tempo: BF.project.bpm, pos });
          if (r.error) throw new Error(r.error);
          const a = new Float32Array(new Uint8Array(r.audio).slice().buffer);
          L.set(a.subarray(0, n), pos); R.set(a.subarray(n, 2 * n), pos);
        }
        const src = ctx.createBufferSource();
        src.buffer = out;
        src.connect(BF.audio.chanStrip(g, ch).gain);
        src.start(0);
      } catch (e) {
        BF.ui.toast(`${def.name} could not be exported: ${e.message}`, true);
      } finally { call('unload', { inst }); }
    }
  };

  // ---------- the plugin's state follows its knobs (saved in the project, undo, sessions) ----------
  const saveTimers = new Map();
  function captureSoon(chId, wait = 700) {
    clearTimeout(saveTimers.get(chId));
    saveTimers.set(chId, setTimeout(() => V.capture(chId), wait));
  }
  V.capture = async function (chId) {
    const h = V.hosts.get(chId);
    if (!h || !h.ready) return;
    const r = await call('getState', { inst: h.inst });
    if (r.error || !r.state) return;
    const s = b64().bytesToBase64(new Uint8Array(r.state));
    if (s === h.state) return;
    h.state = s;
    BF.commit((p) => { const c = p.channels.find((x) => x.id === chId); if (c) { c.vstState = s; if (!c.vstName) c.vstName = (BF.plugins.get(c.plugin) || {}).name || 'VST plugin'; } }, `vststate-${chId}`, 'param');
  };
  function onEvent(ev) {
    if (ev.ev === 'param') {
      const h = [...V.hosts.values()].find((x) => x.inst === ev.inst);
      if (!h) return;
      const info = V.info.get(h.chId);
      const p = info && info.params.find((x) => x.id === ev.pid);
      if (p) p.value = ev.value;
      if (BF.editor && BF.editor.target && BF.editor.target.id === h.chId) BF.editor.vstKnob && BF.editor.vstKnob(ev.pid, ev.value);
      captureSoon(h.chId);
    } else if (ev.ev === 'editorClosed') {
      const h = [...V.hosts.values()].find((x) => x.inst === ev.inst);
      if (h) V.capture(h.chId);
    } else if (ev.ev === 'crashed') {
      BF.ui.toast('A VST plugin crashed. BeatForge restarted the plugin host; your project is fine.', true);
      [...V.hosts.keys()].forEach((id) => { const h = V.hosts.get(id); V.hosts.delete(id); try { h.node.disconnect(); } catch { /* */ } });
      V.info.clear();
      setTimeout(() => V.sync(), 500);
    }
  }
  V.setParam = function (chId, id, value) {
    const h = V.hosts.get(chId);
    if (!h || !h.ready) return;
    call('setParam', { inst: h.inst, id, value });
    captureSoon(chId);
  };
  V.openWindow = async function (chId) {
    const h = V.hosts.get(chId);
    const ch = BF.project.channels.find((c) => c.id === chId);
    if (!h || !h.ready || !ch) { BF.ui.toast('The plugin is still loading…'); return; }
    const r = await call('edit', { inst: h.inst, title: `${ch.name} · ${BF.plugins.get(ch.plugin).name}` });
    if (r.error) BF.ui.toast(r.error, true);
  };

  /** New channel with a VST instrument (its default state is captured once it has loaded). */
  V.addChannel = function (p) {
    register(p);
    const id = `vst:${p.cid}`;
    BF.rack.addChannel(id, null, p.name);
    setTimeout(() => { const ch = BF.project.channels.filter((c) => c.plugin === id).pop(); if (ch) { BF.editor.openChannel(ch.id); setTimeout(() => V.capture(ch.id), 1500); } }, 50);
  };

  // ---------- the "VST plugins" window ----------
  V.open = async function () {
    if (!V.available()) { BF.ui.toast(desk() ? 'VST plugins are not available for this computer yet (Windows and Linux only for now).' : 'VST plugins work in the BeatForge desktop app (Windows).'); return; }
    const d = document.createElement('dialog');
    d.className = 'dlg vst-dlg';
    const h = document.createElement('h2'); h.textContent = 'VST plugins';
    const note = document.createElement('p'); note.className = 'hint';
    note.textContent = 'VST3 instruments from your plugin folders (like Serum, Vital, Sylenth). Click one to add it to the channel rack. VST2-only plugins (.dll) are not supported.';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search plugins'; search.className = 'prompt-input';
    const list = document.createElement('div'); list.className = 'vst-list';
    const folders = document.createElement('p'); folders.className = 'hint';
    const actions = document.createElement('div'); actions.className = 'dlg-actions';
    const btn = (label, cls, fn) => { const x = document.createElement('button'); x.className = `btn ${cls}`; x.textContent = label; x.addEventListener('click', fn); return x; };
    const draw = () => {
      list.textContent = '';
      const q = search.value.trim().toLowerCase();
      const items = V.plugins.filter((p) => p.kind === 'instrument' && (!q || `${p.name} ${p.vendor}`.toLowerCase().includes(q)));
      if (!V.scanned) list.textContent = 'Looking for plugins…';
      else if (!items.length) list.textContent = q ? 'No match.' : 'No VST3 instruments found. Install them in the standard VST3 folder (C:\\Program Files\\Common Files\\VST3) or add your own folder.';
      items.forEach((p) => {
        const row = document.createElement('button'); row.className = 'vst-item';
        const n = document.createElement('b'); n.textContent = p.name;
        const v = document.createElement('span'); v.textContent = p.vendor || '';
        row.append(n, v);
        row.addEventListener('click', () => { d.close(); V.addChannel(p); });
        list.append(row);
      });
      const fx = V.plugins.filter((p) => p.kind === 'effect').length;
      folders.textContent = `${fx ? `${fx} VST3 effects found (effects on mixer inserts come in a later version). ` : ''}Extra folders: ${V.folders.length ? V.folders.join(', ') : 'none'}`;
    };
    search.addEventListener('input', draw);
    const rescan = async (fn) => { list.textContent = 'Looking for plugins…'; try { const r = fn ? await fn() : await V.scan(); if (r && r.error) BF.ui.toast(r.error, true); if (fn && r && r.plugins) { V.plugins = r.plugins; V.folders = r.folders || []; V.plugins.forEach(register); } } catch (e) { BF.ui.toast(e.message, true); } draw(); };
    actions.append(btn('Add a plugin folder…', '', () => rescan(() => call('addFolder'))), btn('Scan again', '', () => rescan()), btn('Close', 'accent', () => d.close()));
    d.append(h, note, search, list, folders, actions);
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
    draw();
    if (!V.scanned) rescan();
  };
})();
