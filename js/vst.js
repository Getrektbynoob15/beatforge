/* vst.js: VST3 instruments and effects in the desktop app (Windows; Linux for testing), through the BeatForge Plugin
 * Host (vsthost/bfvsthost.cpp, a separate process).
 *
 * A VST channel is { plugin: 'vst:<class id>', vstState: base64, vstName }, a VST effect in a mixer slot the same. The
 * plugin's own saved state is the source of truth (its knobs are not copied into params).
 *
 * Live: instruments get an AudioWorklet node ('bf-vst') that asks the host for audio a little ahead of time (notes are
 * booked ahead, so they are exact). Effects ('bf-vstfx') send the insert's audio to the host and play the answer a
 * fixed time later; audio.js delays the other inserts by as much (delay compensation).
 * Export: instruments are rendered by a fresh copy of the plugin and mixed in as audio. Effects need the audio that
 * reaches them, so a song with VST effects is rendered in passes: each pass records what arrives at the next VST
 * effects, the host processes that, and the next pass plays the processed audio in their place.
 * Automation: clips with target { kind: 'vst', id: channel or effect id, param: plugin parameter id }. */
(function () {
  'use strict';
  const BF = window.BF;
  const V = (BF.vst = { plugins: [], folders: [], scanned: false, hosts: new Map(), info: new Map(), FX_DELAY: 1536 });
  const desk = () => (window.beatforgeDesktop && typeof window.beatforgeDesktop.vst === 'function' ? window.beatforgeDesktop : null);
  const call = (cmd, args) => desk().vst(cmd, args);
  const b64 = () => BF.io._b64;
  const CACHE = 'bf-vst-list';
  const isOff = (ctx) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

  V.available = () => !!desk() && V.ok === true; // the desktop app, with the plugin host for this computer

  function register(p) {
    const id = `vst:${p.cid}`;
    const old = BF.plugins.get(id);
    if (old && !old.missing) return;
    BF.plugins.register({ id, kind: p.kind, name: p.name, vst: p, params: [], presets: {}, play() {}, create: p.kind === 'effect' ? (ctx, o) => V.createFx(ctx, o) : undefined });
  }
  function passThrough(ctx) { const g = ctx.createGain(); return { input: g, output: g, set() {}, dispose() { try { g.disconnect(); } catch { /* */ } } }; }

  /** A project uses a VST this computer does not have (or has not scanned yet): keep it and its state. */
  V.placeholder = function (id, kind, name) {
    if (BF.plugins.has(id)) return;
    BF.plugins.register({ id, kind, name: `${name || 'VST plugin'} (not found)`, vst: null, missing: true, params: [], presets: {}, play() {}, create: passThrough });
  };

  V.scan = async function () {
    if (!desk()) return [];
    const r = await call('scan');
    if (r.error) throw new Error(r.error);
    adopt(r);
    return V.plugins;
  };
  function adopt(r) {
    V.plugins = r.plugins || []; V.folders = r.folders || []; V.scanned = true;
    try { localStorage.setItem(CACHE, JSON.stringify(V.plugins.map(({ path, cid, name, vendor, kind }) => ({ path, cid, name, vendor, kind })))); } catch { /* */ }
    V.plugins.forEach(register);
    if (BF.browser && BF.browser.render) BF.browser.render(true);
    // plugins that were placeholders may be real now: rebuild effect chains and start instruments
    const g = BF.audio.graph;
    if (g) { g.inserts.forEach((ins) => { if (ins.fx.some((x) => /^vst:/.test(x.plugin))) ins.fxKey = null; }); BF.audio.sync(g, BF.project); V.sync(); }
  }

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

  // ---------- who owns a plugin: a channel or a mixer effect slot ----------
  function owners(p = BF.project) {
    const m = new Map();
    p.channels.forEach((c) => { if (/^vst:/.test(c.plugin)) m.set(c.id, { obj: c, kind: 'ch' }); });
    p.mixer.forEach((mx, i) => mx.fx.forEach((f) => { if (/^vst:/.test(f.plugin)) m.set(f.id, { obj: f, kind: 'fx', insert: i }); }));
    return m;
  }
  const findOwner = (id, p = BF.project) => owners(p).get(id);
  V.owner = (id) => findOwner(id);

  // ---------- live instances ----------
  const instId = (prefix, id) => `${prefix}${String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;
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

  /** Start a live instance for `id` (channel or effect) with node `node`. */
  function startHost(id, plugin, kind, node, state, rate) {
    const def = BF.plugins.get(plugin);
    const h = { id, kind, plugin, inst: instId(kind === 'fx' ? 'f' : 'c', id), node, ready: false, state: state || null };
    V.hosts.set(id, h);
    getPort().then((port) => node.port.postMessage({ type: 'port', port }, [port]));
    loadInto(h.inst, def, rate, h.state).then((info) => {
      if (V.hosts.get(id) !== h) { call('unload', { inst: h.inst }); return; }
      V.info.set(id, info);
      h.ready = true;
      node.port.postMessage({ type: 'inst', inst: h.inst });
      node.port.postMessage({ type: 'transport', tempo: BF.project.bpm, playing: !!BF.transport.playing });
      if (BF.editor && BF.editor.target && BF.editor.target.id === id) BF.editor.render();
    }).catch((e) => { BF.ui.toast(`${def.name}: ${e.message}`, true); if (V.hosts.get(id) === h) V.hosts.delete(id); });
    return h;
  }

  function hostFor(g, ch) {
    let h = V.hosts.get(ch.id);
    if (h && h.plugin === ch.plugin) return h;
    if (h) dropHost(ch.id);
    const def = BF.plugins.get(ch.plugin);
    if (!def || !def.vst || !g.ctx.__bfWorkletsDone) return null;
    const node = new AudioWorkletNode(g.ctx, 'bf-vst', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(BF.audio.chanStrip(g, ch).gain);
    return startHost(ch.id, ch.plugin, 'ch', node, ch.vstState, g.ctx.sampleRate);
  }
  function dropHost(id) {
    const h = V.hosts.get(id);
    if (!h) return;
    V.hosts.delete(id); V.info.delete(id);
    try { h.node.port.postMessage({ type: 'dispose' }); h.node.disconnect(); } catch { /* */ }
    call('unload', { inst: h.inst });
  }

  /** A VST effect in a mixer slot (called by audio.js when it builds the insert's effect chain). */
  V.createFx = function (ctx, o = {}) {
    const f = o.fx;
    if (!f) return passThrough(ctx);
    if (isOff(ctx)) return offlineFx(ctx, f);
    const def = BF.plugins.get(f.plugin);
    if (!def || !def.vst || !ctx.__bfWorkletsDone || !desk()) return passThrough(ctx);
    if (V.hosts.has(f.id)) dropHost(f.id);
    const node = new AudioWorkletNode(ctx, 'bf-vstfx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { delay: V.FX_DELAY } });
    node.port.onmessage = (e) => { if (e.data && e.data.type === 'late' && e.data.n === 1) console.warn('VST effect audio arrived late'); };
    const h = startHost(f.id, f.plugin, 'fx', node, f.vstState, ctx.sampleRate);
    return { input: node, output: node, latency: V.FX_DELAY, set() {}, dispose() { if (V.hosts.get(f.id) === h) dropHost(f.id); } };
  };

  /** Keep live instances in step with the project (removed, plugin swapped, state changed by undo/open/a guest). */
  V.sync = function () {
    const g = BF.audio.graph;
    if (!g || !desk()) return;
    const own = owners();
    for (const [id, h] of V.hosts) {
      const o = own.get(id);
      if (!o || o.obj.plugin !== h.plugin) { if (h.kind === 'ch') dropHost(id); continue; } // effects are dropped by their chain
      if (h.ready && (o.obj.vstState || null) !== h.state) {
        h.state = o.obj.vstState || null;
        if (h.state) call('setState', { inst: h.inst, state: b64().base64ToBytes(h.state) }).then((s) => {
          const info = V.info.get(id);
          if (info && s.values) s.values.forEach(([pid, v]) => { const p = info.params.find((x) => x.id === pid); if (p) p.value = v; });
          if (BF.editor && BF.editor.target && BF.editor.target.id === id) BF.editor.sync();
        });
      }
    }
    // start instrument instances right away, so the first note is not late
    BF.project.channels.forEach((ch) => { const d = BF.plugins.get(ch.plugin); if (d && d.vst && !V.hosts.has(ch.id)) hostFor(g, ch); });
    V.hosts.forEach((h) => h.ready && h.node.port.postMessage({ type: 'transport', tempo: BF.project.bpm, playing: !!BF.transport.playing }));
  };

  /** Book one note (called from BF.audio.note). Offline renders collect the notes and render them in flush(). */
  V.note = function (g, ch, time, key, vel, dur) {
    const ctx = g.ctx;
    if (isOff(ctx)) {
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
  V.stopAll = function () { V.hosts.forEach((h) => h.kind === 'ch' && h.node.port.postMessage({ type: 'stop' })); };

  /** Automation: set plugin parameter `pid` (0..1) of channel/effect `id` at audio time `t`. */
  V.param = function (g, id, pid, value, t) {
    if (isOff(g.ctx)) {
      const m = (g.ctx.__bfVstPar = g.ctx.__bfVstPar || new Map());
      if (!m.has(id)) m.set(id, []);
      m.get(id).push([t, pid, value]);
      return;
    }
    const h = V.hosts.get(id);
    if (h) h.node.port.postMessage({ type: 'param', t, id: pid, value });
  };

  // ---------- offline rendering ----------
  /** Render with the host: fresh instance of `def` with `state`, `total` frames, notes, automation, optional input. */
  async function renderOffline(def, state, rate, total, notes, pars, input) {
    const inst = instId('x', Math.random().toString(36).slice(2, 12));
    try {
      await loadInto(inst, def, rate, state);
      const list = [];
      (notes || []).forEach(([t, key, vel, dur]) => { const f = Math.round(t * rate); list.push([f, 0, key, vel]); if (dur != null) list.push([f + Math.max(1, Math.round(dur * rate)), 1, key, 0]); });
      list.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      const plist = (pars || []).map(([t, pid, v]) => [Math.round(t * rate), pid, v]).sort((a, b) => a[0] - b[0]);
      const CH = plist.length ? 1024 : 16384; // finer blocks when knobs move
      const out = new AudioBuffer({ length: total, numberOfChannels: 2, sampleRate: rate });
      const L = out.getChannelData(0), R = out.getChannelData(1);
      let k = 0, q = 0;
      for (let pos = 0; pos < total; pos += CH) {
        const n = Math.min(CH, total - pos);
        const take = []; while (k < list.length && list[k][0] < pos + n) take.push(list[k++]);
        const ps = []; while (q < plist.length && plist[q][0] < pos + n) ps.push(plist[q++]);
        const bytes = 16 * take.length + 12 * ps.length + (input ? 8 * n : 0);
        const eb = new ArrayBuffer(bytes), dv = new DataView(eb);
        take.forEach(([f, type, key, vel], i) => { dv.setInt32(i * 16, Math.max(0, f - pos), true); dv.setInt32(i * 16 + 4, type, true); dv.setInt32(i * 16 + 8, key, true); dv.setFloat32(i * 16 + 12, vel, true); });
        ps.forEach(([, pid, v], i) => { const o = 16 * take.length + 12 * i; dv.setUint32(o, pid, true); dv.setFloat64(o + 4, v, true); });
        if (input) {
          const o = 16 * take.length + 12 * ps.length;
          for (let i = 0; i < n; i++) { dv.setFloat32(o + 4 * i, input[0][pos + i] || 0, true); dv.setFloat32(o + 4 * (n + i), input[1][pos + i] || 0, true); }
        }
        const r = await call('render', { inst, frames: n, nEv: take.length, nPar: ps.length, events: new Uint8Array(eb), tempo: BF.project.bpm, pos });
        if (r.error) throw new Error(r.error);
        const a = new Float32Array(new Uint8Array(r.audio).slice().buffer);
        L.set(a.subarray(0, n), pos); R.set(a.subarray(n, 2 * n), pos);
      }
      return out;
    } finally { call('unload', { inst }); }
  }

  /** Before an offline render starts: render every VST instrument's notes and mix them in as audio. */
  V.flush = async function (ctx, g) {
    const m = ctx.__bfVst;
    if (!m || !m.size || !desk()) return;
    const par = ctx.__bfVstPar || new Map();
    const cache = ctx.__bfSession && ctx.__bfSession.inst;
    for (const { ch, evs } of m.values()) {
      const def = BF.plugins.get(ch.plugin);
      if (!def || !def.vst) continue;
      try {
        const ck = `${ch.id}|${ctx.length}|${ctx.sampleRate}`;
        let buf = cache && cache.get(ck);
        if (!buf) { buf = await renderOffline(def, ch.vstState, ctx.sampleRate, ctx.length, evs, par.get(ch.id)); if (cache) cache.set(ck, buf); }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(BF.audio.chanStrip(g, ch).gain);
        src.start(0);
      } catch (e) { BF.ui.toast(`${def.name} could not be exported: ${e.message}`, true); }
    }
  };

  /** A VST effect inside an offline render: already processed -> play that; otherwise pass through (and record). */
  function offlineFx(ctx, f) {
    const s = ctx.__bfSession;
    const input = ctx.createGain(), output = ctx.createGain();
    const done = s && s.processed.get(f.id);
    if (done) {
      const src = ctx.createBufferSource();
      src.buffer = done;
      src.connect(output);
      src.start(0);
    } else {
      input.connect(output);
      if (s && s.taps.includes(f.id)) s.tapNodes.set(f.id, input);
    }
    return { input, output, set() {}, dispose() { try { input.disconnect(); output.disconnect(); } catch { /* */ } } };
  }

  /** Does the project use VST effects (export then needs passes)? */
  V.hasFx = (p = BF.project) => !!desk() && p.mixer.some((m) => m.fx.some((f) => !f.bypass && /^vst:/.test(f.plugin) && BF.plugins.get(f.plugin)?.vst));

  /** Export with VST effects. renderPart(p, mode, rate, from, to, tail, session) -> AudioBuffer (2 + 2*taps channels). */
  V.renderWithFx = async function (p, mode, rate, end, tail, renderPart, onProgress) {
    const list = [];
    p.mixer.forEach((m, i) => m.fx.forEach((f, pos) => { if (!f.bypass && /^vst:/.test(f.plugin) && BF.plugins.get(f.plugin)?.vst) list.push({ f, insert: i, pos }); }));
    // which inserts feed which (to know what has to be processed first)
    const feeds = (to) => { const out = []; for (let j = 1; j <= BF.INSERTS; j++) { const r = p.mixer[j].route || { master: true, sends: [] }; if ((to === 0 && r.master) || r.sends.some((s) => s.to === to)) out.push(j); } return out; };
    const upstream = (i, seen = new Set()) => { feeds(i).forEach((j) => { if (j !== i && !seen.has(j)) { seen.add(j); upstream(j, seen); } }); return seen; };
    const session = { processed: new Map(), taps: [], tapNodes: new Map(), inst: new Map() };
    const passes = list.length + 1;
    let n = 0;
    for (let guard = 0; guard < 24; guard++) {
      const pending = list.filter((x) => !session.processed.has(x.f.id));
      if (!pending.length) break;
      const firsts = [];
      pending.forEach((x) => { const cur = firsts.find((y) => y.insert === x.insert); if (!cur) firsts.push(x); else if (x.pos < cur.pos) firsts.splice(firsts.indexOf(cur), 1, x); });
      const busy = new Set(pending.map((x) => x.insert));
      let ready = firsts.filter((x) => ![...upstream(x.insert)].some((j) => busy.has(j)));
      if (!ready.length) ready = firsts; // feedback loop: just go
      session.taps = ready.map((x) => x.f.id);
      session.tapNodes = new Map();
      const buf = await renderPart(p, mode, rate, 0, end, tail, session);
      for (let k = 0; k < ready.length; k++) {
        const x = ready[k];
        const tapped = [buf.getChannelData(2 + 2 * k), buf.getChannelData(3 + 2 * k)];
        const def = BF.plugins.get(x.f.plugin);
        try { session.processed.set(x.f.id, await renderOffline(def, x.f.vstState, rate, buf.length, null, (session.par && session.par.get(x.f.id)) || null, tapped)); }
        catch (e) { BF.ui.toast(`${def.name} could not be exported: ${e.message}`, true); session.processed.set(x.f.id, null); }
      }
      if (onProgress) onProgress(++n / passes);
    }
    // processed === null (failed): pass the audio through instead
    session.processed.forEach((v, k) => { if (!v) session.processed.delete(k); });
    session.taps = [];
    const out = await renderPart(p, mode, rate, 0, end, tail, session);
    if (onProgress) onProgress(1);
    return out;
  };

  // ---------- the plugin's state follows its knobs (saved in the project, undo, sessions) ----------
  const saveTimers = new Map();
  function captureSoon(id, wait = 700) {
    clearTimeout(saveTimers.get(id));
    saveTimers.set(id, setTimeout(() => V.capture(id), wait));
  }
  V.capture = async function (id) {
    const h = V.hosts.get(id);
    if (!h || !h.ready) return;
    const r = await call('getState', { inst: h.inst });
    if (r.error || !r.state) return;
    const s = b64().bytesToBase64(new Uint8Array(r.state));
    if (s === h.state) return;
    h.state = s;
    BF.commit((p) => {
      const o = findOwner(id, p);
      if (o) { o.obj.vstState = s; if (!o.obj.vstName) o.obj.vstName = (BF.plugins.get(o.obj.plugin) || {}).name || 'VST plugin'; }
    }, `vststate-${id}`, 'param');
  };
  const hostByInst = (inst) => [...V.hosts.values()].find((x) => x.inst === inst);
  function onEvent(ev) {
    if (ev.ev === 'param') {
      const h = hostByInst(ev.inst);
      if (!h) return;
      const info = V.info.get(h.id);
      const p = info && info.params.find((x) => x.id === ev.pid);
      if (p) p.value = ev.value;
      if (BF.editor && BF.editor.target && BF.editor.target.id === h.id && BF.editor.vstKnob) BF.editor.vstKnob(ev.pid, ev.value);
      captureSoon(h.id);
    } else if (ev.ev === 'editorClosed') {
      const h = hostByInst(ev.inst);
      if (h) V.capture(h.id);
    } else if (ev.ev === 'crashed') {
      BF.ui.toast('A VST plugin crashed. BeatForge restarted the plugin host; your project is fine.', true);
      [...V.hosts.keys()].forEach((id) => { const h = V.hosts.get(id); V.hosts.delete(id); try { h.node.port.postMessage({ type: 'dispose' }); h.node.disconnect(); } catch { /* */ } });
      V.info.clear();
      setTimeout(() => { const g = BF.audio.graph; if (g) { g.inserts.forEach((ins) => { if (ins.fx.some((x) => /^vst:/.test(x.plugin))) ins.fxKey = null; }); BF.audio.sync(g, BF.project); } V.sync(); }, 500);
    }
  }
  V.setParam = function (id, pid, value) {
    const h = V.hosts.get(id);
    if (!h || !h.ready) return;
    call('setParam', { inst: h.inst, id: pid, value });
    captureSoon(id);
  };
  V.openWindow = async function (id) {
    const h = V.hosts.get(id);
    const o = findOwner(id);
    if (!h || !h.ready || !o) { BF.ui.toast('The plugin is still loading…'); return; }
    const where = o.kind === 'ch' ? o.obj.name : BF.project.mixer[o.insert].name;
    const r = await call('edit', { inst: h.inst, title: `${where} · ${BF.plugins.get(o.obj.plugin).name}` });
    if (r.error) BF.ui.toast(r.error, true);
  };

  /** New channel with a VST instrument (its default state is captured once it has loaded). */
  V.addChannel = function (p) {
    register(p);
    const id = `vst:${p.cid}`;
    BF.rack.addChannel(id, null, p.name);
    setTimeout(() => { const ch = BF.project.channels.filter((c) => c.plugin === id).pop(); if (ch) { BF.editor.openChannel(ch.id); setTimeout(() => V.capture(ch.id), 1500); } }, 50);
  };
  /** VST effect into a mixer insert. */
  V.addEffect = function (p, insert) {
    register(p);
    const i = Number.isInteger(insert) ? insert : (BF.mixer && Number.isInteger(BF.mixer.selected) ? BF.mixer.selected : 0);
    if (BF.project.mixer[i].fx.length >= 10) { BF.ui.toast('This insert is full (10 effects).'); return; }
    const fx = { id: BF.uid('fx'), plugin: `vst:${p.cid}`, params: {}, bypass: false, vstName: p.name };
    BF.commit((q) => { q.mixer[i].fx.push(fx); });
    BF.win.toggle('mixer', true);
    BF.editor.openEffect(i, fx.id);
    setTimeout(() => V.capture(fx.id), 1500);
  };

  // ---------- the "VST plugins" window ----------
  V.open = async function (kind = 'instrument', insert = null) {
    if (!V.available()) { BF.ui.toast(desk() ? 'VST plugins are not available for this computer yet (Windows and Linux only for now).' : 'VST plugins work in the BeatForge desktop app (Windows).'); return; }
    const d = document.createElement('dialog');
    d.className = 'dlg vst-dlg';
    const h = document.createElement('h2');
    const tabs = document.createElement('div'); tabs.className = 'vst-tabs';
    const note = document.createElement('p'); note.className = 'hint';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search plugins'; search.className = 'prompt-input';
    const list = document.createElement('div'); list.className = 'vst-list';
    const folders = document.createElement('p'); folders.className = 'hint';
    const actions = document.createElement('div'); actions.className = 'dlg-actions';
    const btn = (label, cls, fn) => { const x = document.createElement('button'); x.className = `btn ${cls}`; x.textContent = label; x.addEventListener('click', fn); return x; };
    const tabI = btn('Instruments', 'small', () => { kind = 'instrument'; draw(); }), tabE = btn('Effects', 'small', () => { kind = 'effect'; draw(); });
    tabs.append(tabI, tabE);
    const draw = () => {
      tabI.setAttribute('aria-pressed', String(kind === 'instrument')); tabE.setAttribute('aria-pressed', String(kind === 'effect'));
      const ins = Number.isInteger(insert) ? insert : (BF.mixer && Number.isInteger(BF.mixer.selected) ? BF.mixer.selected : 0);
      h.textContent = kind === 'instrument' ? 'VST instruments' : 'VST effects';
      note.textContent = kind === 'instrument'
        ? 'VST3 instruments from your plugin folders (Serum, Vital, Sylenth…). Click one to add it to the channel rack.'
        : `VST3 effects (OTT, Valhalla, FabFilter…). Click one to add it to ${BF.project.mixer[ins].name}.`;
      list.textContent = '';
      const q = search.value.trim().toLowerCase();
      const items = V.plugins.filter((p) => p.kind === kind && (!q || `${p.name} ${p.vendor}`.toLowerCase().includes(q)));
      if (!V.scanned) list.textContent = 'Looking for plugins…';
      else if (!items.length) list.textContent = q ? 'No match.' : 'None found. Install VST3 plugins in the standard folder (C:\\Program Files\\Common Files\\VST3) or add your own folder.';
      items.forEach((p) => {
        const row = document.createElement('button'); row.className = 'vst-item';
        const n = document.createElement('b'); n.textContent = p.name;
        const v = document.createElement('span'); v.textContent = p.vendor || '';
        row.append(n, v);
        row.addEventListener('click', () => { d.close(); if (kind === 'instrument') V.addChannel(p); else V.addEffect(p, ins); });
        list.append(row);
      });
      folders.textContent = `Only VST3 (not VST2 .dll). Extra folders: ${V.folders.length ? V.folders.join(', ') : 'none'}`;
    };
    search.addEventListener('input', draw);
    const rescan = async (fn) => { list.textContent = 'Looking for plugins…'; try { if (fn) { const r = await fn(); if (r && r.error) BF.ui.toast(r.error, true); else if (r && r.plugins) adopt(r); } else await V.scan(); } catch (e) { BF.ui.toast(e.message, true); } draw(); };
    actions.append(btn('Add a plugin folder…', '', () => rescan(() => call('addFolder'))), btn('Scan again', '', () => rescan()), btn('Close', 'accent', () => d.close()));
    d.append(h, tabs, note, search, list, folders, actions);
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
    draw();
    if (!V.scanned) rescan();
  };
})();
