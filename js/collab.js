/* collab.js: live collaboration, peer to peer.
 * The host's BeatForge holds the project; friends connect straight to it (WebRTC data channel). grbnstudios.com only
 * introduces the two apps (a short code, then one offer / answer exchange, see beatforge-collab.js on the server);
 * the project, every edit and the audio go directly between the computers, encrypted.
 *
 * Sync: every change is turned into small operations (a diff of the project, minus the audio data and minus what is
 * only "where you are looking": current pattern / selected channel). Lists of things with an id (channels, notes,
 * clips…) are diffed by id, so two people editing different notes never clash. The host relays each friend's
 * changes to the others; for the same value the last change wins. Audio files are sent once, in pieces, on request. */
(function () {
  'use strict';
  const BF = window.BF;
  const C = (BF.collab = { role: null, peers: new Map(), code: null, name: '' });
  const ICE = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
  const VIEW_KEYS = ['currentPattern', 'selectedChannel'];
  const LOCAL_REASONS = new Set(['view', 'select', 'pattern', 'transport', 'windows', 'midi', 'remote', 'knob-end']);
  const MAX_MSG = 48000;
  let shadow = null; // the project as last synced (stripped)
  let pollTimer = null, flushTimer = null;

  // ---------- talking to the matchmaker ----------
  const desktop = () => window.beatforgeDesktop && typeof window.beatforgeDesktop.collab === 'function' ? window.beatforgeDesktop : null;
  C.available = () => !!desktop() || /^https?:$/.test(location.protocol);
  async function api(method, path, body) {
    let r;
    if (desktop()) r = await desktop().collab(method, path, body || null);
    else {
      const res = await fetch(`/api/main${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store' });
      r = { status: res.status, json: await res.json().catch(() => ({})) };
    }
    if (r.error) throw new Error(r.error);
    if (r.status >= 400) throw new Error((r.json && r.json.error) || `The server answered ${r.status}.`);
    return r.json;
  }

  // ---------- the diff ----------
  const kindOf = (x) => (Array.isArray(x) ? 'arr' : x && typeof x === 'object' ? 'obj' : 'prim');
  const keyed = (arr) => arr.every((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string');
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  function diff(a, b, path, ops) {
    if (a === b) return;
    const ka = kindOf(a), kb = kindOf(b);
    if (ka !== kb) { ops.push({ p: path, v: b }); return; }
    if (ka === 'obj') {
      for (const k of Object.keys(a)) if (!(k in b)) ops.push({ p: [...path, k], d: 1 });
      for (const k of Object.keys(b)) { if (!(k in a)) ops.push({ p: [...path, k], v: b[k] }); else diff(a[k], b[k], [...path, k], ops); }
      return;
    }
    if (ka === 'arr') {
      if ((a.length || b.length) && keyed(a) && keyed(b)) {
        const am = new Map(a.map((x) => [x.id, x])), bm = new Map(b.map((x) => [x.id, x]));
        for (const id of am.keys()) if (!bm.has(id)) ops.push({ p: [...path, { id }], d: 1 });
        for (const [id, x] of bm) { if (!am.has(id)) ops.push({ p: [...path, { id }], v: x }); else diff(am.get(id), x, [...path, { id }], ops); }
        const order = b.map((x) => x.id);
        if (a.map((x) => x.id).filter((id) => bm.has(id)).join('\u0001') !== order.filter((id) => am.has(id)).join('\u0001')) ops.push({ p: path, ord: order });
        return;
      }
      if (JSON.stringify(a) !== JSON.stringify(b)) ops.push({ p: path, v: b });
      return;
    }
    ops.push({ p: path, v: b });
  }
  const stepInto = (node, k) => (node == null ? undefined : typeof k === 'object' ? (Array.isArray(node) ? node.find((x) => x && x.id === k.id) : undefined) : node[k]);
  function applyOp(root, op) {
    const p = op.p;
    if (!Array.isArray(p) || !p.length) return;
    if (op.ord) {
      const arr = p.reduce(stepInto, root);
      if (!Array.isArray(arr)) return;
      const rank = new Map(op.ord.map((id, i) => [id, i]));
      arr.sort((x, y) => (rank.has(x.id) ? rank.get(x.id) : 1e9) - (rank.has(y.id) ? rank.get(y.id) : 1e9));
      return;
    }
    const parent = p.slice(0, -1).reduce(stepInto, root);
    const last = p[p.length - 1];
    if (parent == null || typeof parent !== 'object') return;
    if (typeof last === 'object') {
      if (!Array.isArray(parent)) return;
      const i = parent.findIndex((x) => x && x.id === last.id);
      if (op.d) { if (i >= 0) parent.splice(i, 1); } else if (i >= 0) parent[i] = clone(op.v); else parent.push(clone(op.v));
    } else if (op.d) { if (Array.isArray(parent)) parent.splice(+last, 1); else delete parent[last]; }
    else parent[last] = clone(op.v);
  }

  /** The shared part of the project: no audio bytes (sampleMeta instead), no view state. */
  function strip(p) {
    const o = {};
    for (const k of Object.keys(p)) if (k !== 'samples' && !VIEW_KEYS.includes(k)) o[k] = p[k];
    const s = clone(o);
    s.sampleMeta = {};
    for (const [id, x] of Object.entries(p.samples || {})) s.sampleMeta[id] = { name: x.name, mime: x.mime, len: x.base64.length };
    return s;
  }

  // ---------- messages over the data channel (split into pieces, with back-pressure) ----------
  const waitRoom = (dc) => new Promise((res) => {
    if (dc.bufferedAmount < 2e6) return res();
    dc.bufferedAmountLowThreshold = 5e5;
    dc.addEventListener('bufferedamountlow', () => res(), { once: true });
  });
  async function send(peer, obj) {
    const dc = peer.dc;
    if (!dc || dc.readyState !== 'open') return;
    const s = JSON.stringify(obj);
    if (s.length <= MAX_MSG) { await waitRoom(dc); dc.send(s); return; }
    const id = Math.random().toString(36).slice(2), n = Math.ceil(s.length / MAX_MSG);
    for (let i = 0; i < n; i++) {
      await waitRoom(dc);
      if (dc.readyState !== 'open') return;
      dc.send(JSON.stringify({ t: 'part', id, i, n, s: s.slice(i * MAX_MSG, (i + 1) * MAX_MSG) }));
    }
  }
  const broadcast = (obj, except) => C.peers.forEach((peer) => { if (peer !== except) send(peer, obj); });

  // ---------- local changes -> ops ----------
  BF.onChange((reason) => {
    if (!C.role || !shadow || LOCAL_REASONS.has(reason)) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 60);
  });
  // knob drags only emit 'param'/'mix' while moving; also flush on knob release
  BF.onChange((reason) => { if (C.role && shadow && reason === 'knob-end') { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 30); } });
  function flush() {
    if (!C.role || !shadow) return;
    const now = strip(BF.project);
    const ops = [];
    diff(shadow, now, [], ops);
    shadow = now;
    if (ops.length) broadcast({ t: 'ops', ops });
  }

  // ---------- remote ops -> project ----------
  function applyRemote(ops, from) {
    const needs = [];
    for (const op of ops) {
      if (op.p[0] === 'sampleMeta') {
        const id = op.p[1];
        if (op.v && typeof op.v === 'object' && op.p.length === 2) {
          const have = BF.project.samples[id];
          if (!have || have.base64.length !== op.v.len) {
            needs.push(id);
            if (!have) BF.project.samples[id] = { name: op.v.name, mime: op.v.mime, base64: 'AA==' };
          }
        } else if (op.p.length === 3 && op.p[2] === 'len') {
          const have = BF.project.samples[id];
          if (!have || have.base64.length !== op.v) needs.push(id);
        }
        continue;
      }
      if (VIEW_KEYS.includes(op.p[0])) continue;
      applyOp(BF.project, op);
    }
    // keep the view valid if the thing we were looking at was deleted
    if (!BF.project.patterns.some((x) => x.id === BF.project.currentPattern)) BF.project.currentPattern = BF.project.patterns[0]?.id;
    if (!BF.project.channels.some((x) => x.id === BF.project.selectedChannel)) BF.project.selectedChannel = BF.project.channels[0]?.id || null;
    shadow = strip(BF.project);
    if (needs.length && from) send(from, { t: 'need', ids: [...new Set(needs)] });
    BF.dirty = true;
    BF.emit('remote');
  }

  async function receiveSample(m) {
    const s = BF.project.samples[m.id] || (BF.project.samples[m.id] = {});
    Object.assign(s, { name: m.name, mime: m.mime, base64: m.base64 });
    try {
      const bytes = BF.io._b64.base64ToBytes(m.base64);
      const buf = await BF.audio.decode(bytes.buffer);
      BF.audio.buffers.set(m.id, buf);
      for (const k of [...BF.audio.stretched.keys()]) if (k.startsWith(`${m.id}@`) || k.startsWith(`${m.id}:`)) BF.audio.stretched.delete(k);
      BF.audio.reversedCache.delete(m.id);
      BF.playlist.forgetPeaks?.();
    } catch (e) { console.warn('collab sample', m.id, e); }
    if (shadow && shadow.sampleMeta) shadow.sampleMeta[m.id] = { name: m.name, mime: m.mime, len: m.base64.length };
    BF.emit('remote');
    C.render();
  }

  function onMessage(peer, data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'part') {
      const buf = peer.parts.get(m.id) || [];
      buf[m.i] = m.s;
      peer.parts.set(m.id, buf);
      if (buf.filter((x) => x !== undefined).length === m.n) { peer.parts.delete(m.id); onMessage(peer, buf.join('')); }
      return;
    }
    switch (m.t) {
      case 'hello':
        peer.name = String(m.name || 'Friend').slice(0, 40);
        if (C.role === 'host') {
          send(peer, { t: 'snapshot', state: strip(BF.project), host: C.name, people: [...C.peers.values()].map((x) => x.name) });
          BF.ui.toast(`${peer.name} joined your session.`);
          broadcast({ t: 'people', people: [C.name, ...[...C.peers.values()].map((x) => x.name)] });
        }
        C.render();
        break;
      case 'snapshot': loadSnapshot(peer, m); break;
      case 'ops':
        applyRemote(m.ops || [], peer);
        if (C.role === 'host') broadcast({ t: 'ops', ops: m.ops }, peer); // pass a friend's changes on to the others
        break;
      case 'need':
        (m.ids || []).forEach((id) => { const s = BF.project.samples[id]; if (s && s.base64.length > 4) send(peer, { t: 'sample', id, name: s.name, mime: s.mime, base64: s.base64 }); });
        break;
      case 'sample': receiveSample(m); break;
      case 'people': C.people = m.people; C.render(); break;
      case 'bye': peer.dc?.close(); break;
      default: break;
    }
  }

  function loadSnapshot(peer, m) {
    const st = m.state;
    const raw = clone(st);
    raw.samples = {};
    Object.entries(st.sampleMeta || {}).forEach(([id, x]) => { raw.samples[id] = { name: x.name, mime: x.mime, base64: 'AA==' }; });
    delete raw.sampleMeta;
    BF.transport.stop();
    BF.audio.buffers.clear();
    BF.replaceProject(BF.normalizeProject(raw));
    BF.dirty = true;
    shadow = strip(BF.project);
    // the placeholders say len 4; remember the real lengths so we don't send "changes" back
    Object.entries(st.sampleMeta || {}).forEach(([id, x]) => { shadow.sampleMeta[id] = x; });
    const ids = Object.keys(st.sampleMeta || {});
    if (ids.length) send(peer, { t: 'need', ids });
    C.hostName = m.host;
    BF.ui.toast(`Connected to ${m.host}'s session.${ids.length ? ` Getting ${ids.length} audio file${ids.length === 1 ? '' : 's'}…` : ''}`);
    C.render();
  }

  // ---------- connections ----------
  function waitGather(pc) {
    return new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 4000);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  function wire(peer, dc) {
    peer.dc = dc;
    peer.parts = new Map();
    dc.onopen = () => { send(peer, { t: 'hello', name: C.name }); C.render(); };
    dc.onmessage = (e) => onMessage(peer, e.data);
    dc.onclose = () => left(peer);
  }
  function left(peer) {
    if (!C.peers.has(peer.id)) return;
    C.peers.delete(peer.id);
    try { peer.pc.close(); } catch { /* */ }
    if (C.role === 'guest') {
      BF.ui.toast(`The session ended. You keep a copy of the project (save it with Ctrl+S).`);
      reset();
    } else if (peer.name) {
      BF.ui.toast(`${peer.name} left the session.`);
      broadcast({ t: 'people', people: [C.name, ...[...C.peers.values()].map((x) => x.name)] });
    }
    C.render();
  }
  function watch(peer) {
    peer.pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed'].includes(peer.pc.connectionState)) left(peer); });
  }
  function reset() {
    clearInterval(pollTimer);
    pollTimer = null;
    C.role = null; C.code = null; C.token = null; C.hostName = null; C.people = null;
    shadow = null;
    C.peers.forEach((p) => { try { p.pc.close(); } catch { /* */ } });
    C.peers.clear();
    C.render();
  }

  async function askName() {
    let saved = '';
    try { saved = localStorage.getItem('beatforge.collabName') || ''; } catch { /* */ }
    const n = await BF.ui.prompt('Your name (shown to the others)', saved || 'Producer');
    if (!n) return null;
    try { localStorage.setItem('beatforge.collabName', n); } catch { /* */ }
    return n.slice(0, 40);
  }

  /** Host: open a session for the current project. */
  C.host = async function () {
    if (C.role) return;
    if (!C.available()) { C.needDesktopUpdate(); return; }
    const name = await askName();
    if (!name) return;
    try {
      const r = await api('POST', '/beatforge/collab/rooms', { name });
      Object.assign(C, { role: 'host', code: r.code, token: r.token, name });
      shadow = strip(BF.project);
      pollTimer = setInterval(poll, 1200);
      C.render();
      C.open();
    } catch (e) { BF.ui.toast(`Could not start a session: ${e.message || e}`, true); }
  };
  async function poll() {
    if (C.role !== 'host') return;
    try {
      const r = await api('GET', `/beatforge/collab/rooms/${C.code}/pending?token=${C.token}`);
      for (const j of r.joins) accept(j);
    } catch (e) { console.warn('collab poll', e); }
  }
  async function accept(j) {
    if (C.peers.size >= 7) return;
    const pc = new RTCPeerConnection(ICE);
    const peer = { id: j.joinId, name: j.name, pc };
    C.peers.set(peer.id, peer);
    watch(peer);
    pc.ondatachannel = (e) => wire(peer, e.channel);
    try {
      await pc.setRemoteDescription(j.offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitGather(pc);
      await api('POST', `/beatforge/collab/rooms/${C.code}/answer`, { token: C.token, joinId: j.joinId, answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } catch (e) { console.warn('collab accept', e); left(peer); }
  }

  /** Friend: join with the host's code. */
  C.join = async function (code) {
    if (C.role) return;
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) { BF.ui.toast('A session code has 6 letters/numbers.', true); return; }
    if (!C.available()) { C.needDesktopUpdate(); return; }
    if (BF.dirty && !confirm('Joining replaces the project you have open with the host\'s project. Continue? (Save first if you want to keep it.)')) return;
    const name = await askName();
    if (!name) return;
    const pc = new RTCPeerConnection(ICE);
    const peer = { id: 'host', name: 'Host', pc };
    Object.assign(C, { role: 'guest', code, name });
    C.peers.set(peer.id, peer);
    watch(peer);
    wire(peer, pc.createDataChannel('beatforge', { ordered: true }));
    C.render();
    BF.ui.busy('Connecting…');
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitGather(pc);
      const r = await api('POST', `/beatforge/collab/rooms/${code}/join`, { offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }, name });
      peer.name = r.host || 'Host';
      let answer = null;
      for (let i = 0; i < 90 && !answer && C.role === 'guest'; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        answer = (await api('GET', `/beatforge/collab/rooms/${code}/answer/${r.joinId}`)).answer;
      }
      if (!answer) throw new Error('The host did not answer. Is their BeatForge open with the session running?');
      await pc.setRemoteDescription(answer);
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('Could not connect directly to the host (a router or network is blocking it).')), 20000);
        const ok = () => { if (peer.dc && peer.dc.readyState === 'open') { clearTimeout(t); res(); } };
        peer.dc.addEventListener('open', ok);
        ok();
      });
    } catch (e) {
      BF.ui.toast(`Could not join: ${e.message || e}`, true);
      reset();
    } finally { BF.ui.busy(null); }
  };

  /** Host: end the session for everyone; friend: leave it. */
  C.leave = async function () {
    if (!C.role) return;
    broadcast({ t: 'bye' });
    if (C.role === 'host') api('DELETE', `/beatforge/collab/rooms/${C.code}?token=${C.token}`).catch(() => {});
    setTimeout(reset, 200);
    BF.ui.toast(C.role === 'host' ? 'Session ended.' : 'You left the session. You keep a copy of the project.');
  };

  // ---------- UI ----------
  C.render = function () {
    const b = document.getElementById('collabBtn');
    if (!b) return;
    const n = C.role === 'host' ? C.peers.size : C.role === 'guest' ? 1 : 0;
    b.setAttribute('aria-pressed', String(!!C.role));
    b.querySelector('.collab-n').textContent = C.role ? String(n + 1) : '';
    b.title = !C.role ? 'Make music together live (host or join a session)' : C.role === 'host' ? `Hosting session ${C.code}: ${[...C.peers.values()].map((p) => p.name).join(', ') || 'waiting for friends'}` : `In ${C.hostName || 'the host'}'s session`;
  };

  C.open = function () {
    const d = document.createElement('dialog');
    d.className = 'dlg collab-dlg';
    const h = document.createElement('h2');
    const body = document.createElement('div');
    const actions = document.createElement('div'); actions.className = 'dlg-actions';
    const btn = (label, cls, fn) => { const x = document.createElement('button'); x.className = `btn ${cls}`; x.textContent = label; x.addEventListener('click', fn); return x; };
    const p = (text) => { const e = document.createElement('p'); e.textContent = text; return e; };
    if (!C.role) {
      h.textContent = 'Make music together';
      body.append(p('Work on one project with a friend, live: you both see every change right away. The host\'s computer holds the project and your friend connects straight to it (encrypted); grbnstudios.com only introduces the two apps.'));
      const row = document.createElement('div'); row.className = 'collab-join';
      const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'Code'; inp.maxLength = 7; inp.setAttribute('aria-label', 'Session code'); inp.className = 'prompt-input';
      row.append(inp, btn('Join', 'accent', () => { d.close(); C.join(inp.value); }));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { d.close(); C.join(inp.value); } });
      body.append(row);
      actions.append(btn('Cancel', '', () => d.close()), btn('Host a session with this project', 'accent', () => { d.close(); C.host(); }));
    } else if (C.role === 'host') {
      h.textContent = 'Your session';
      const code = document.createElement('div'); code.className = 'collab-code'; code.textContent = C.code;
      body.append(p('Send your friend the invite link: it opens BeatForge (app or browser) and joins. Or give them the code to type in after clicking 👥.'), code);
      const people = [...C.peers.values()].filter((x) => x.dc && x.dc.readyState === 'open').map((x) => x.name);
      body.append(p(people.length ? `Connected: ${people.join(', ')}` : 'Waiting for friends to join… (keep BeatForge open)'));
      body.append(p('Ctrl+Z undoes changes in the whole project, also the ones your friend made.'));
      actions.append(btn('Copy invite link', '', () => { navigator.clipboard?.writeText(C.inviteLink()).then(() => BF.ui.toast('Invite link copied. Send it to your friend (Discord etc.).'), () => BF.ui.prompt('Copy this link', C.inviteLink())); }), btn('End session', 'danger', () => { d.close(); C.leave(); }), btn('Close', 'accent', () => d.close()));
    } else {
      h.textContent = `${C.hostName || 'Host'}'s session`;
      body.append(p(`You're connected. Changes from everyone show up right away. People: ${(C.people || [C.hostName, C.name]).join(', ')}.`));
      actions.append(btn('Leave session', 'danger', () => { d.close(); C.leave(); }), btn('Close', 'accent', () => d.close()));
    }
    d.append(h, body, actions);
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
  };

  // a link like ...beatforge-web/?join=ABC123 (website version) opens the join flow
  C.fromLink = function () {
    const m = /[?&]join=([A-Za-z0-9]{6})/.exec(location.search);
    if (m) setTimeout(() => C.join(m[1]), 600);
    // desktop app opened from an invite link (beatforge://join/CODE)
    if (window.beatforgeDesktop && window.beatforgeDesktop.onJoin) window.beatforgeDesktop.onJoin(async (code) => {
      if (C.role && C.code === code) return;
      if (C.role && !confirm('You are in a session already. Leave it and join the new one?')) return;
      if (C.role) { await C.leave(); await new Promise((r) => setTimeout(r, 300)); }
      C.join(code);
    });
  };
  /** The app updated itself, but its desktop part is older than live sessions: explain and offer the download. */
  C.needDesktopUpdate = function () {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    const inDesktop = !!window.beatforgeDesktop;
    d.innerHTML = inDesktop
      ? '<h2>One download needed</h2><p>Live sessions and invite links need the new desktop part of BeatForge. The automatic update only updates the inside of the app, so please download and install BeatForge once more (your projects, templates and packs stay).</p><p>After that, updates are automatic again.</p>'
      : '<h2>Live sessions</h2><p>Live sessions work in the BeatForge desktop app and on grbnstudios.com/beatforge-web.</p>';
    const actions = document.createElement('div'); actions.className = 'dlg-actions';
    const close = document.createElement('button'); close.className = 'btn'; close.textContent = 'Later';
    close.addEventListener('click', () => d.close());
    const dl = document.createElement('button'); dl.className = 'btn accent'; dl.textContent = 'Download BeatForge';
    dl.addEventListener('click', () => { window.open('https://grbnstudios.com/beatforge', '_blank', 'noopener'); d.close(); });
    actions.append(close, dl);
    d.append(actions);
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
  };
  C.inviteLink = () => `https://grbnstudios.com/beatforge-join?c=${C.code}`;

  // desktop app with an older desktop part (the in-app update can't replace it): say so once per version
  setTimeout(() => {
    if (!window.beatforgeDesktop || typeof window.beatforgeDesktop.collab === 'function') return;
    const key = `beatforge.shellNotice.${window.BF_VERSION}`;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch { return; }
    BF.ui.toast('New in this version: live sessions (👥). They need a one-time download of BeatForge from grbnstudios.com/beatforge; click 👥 for the link.');
  }, 4000);

  C._test = { diff, applyOp, strip };
})();
