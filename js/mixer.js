/* mixer.js: two tabs.
 *  - Inserts: Master + 32 inserts. Each strip: meter, fader, pan, mute, solo. The selected insert's effect slots
 *    (up to 10, processed top to bottom) are shown on the right: add, open, bypass, reorder, remove.
 *  - Patterns & audio: one fader + mute per pattern (scales its notes' velocity, 0-100%) and per audio file
 *    (gain for every clip that plays it, 0-200%), to balance parts of the song without touching the inserts. */
(function () {
  'use strict';
  const BF = window.BF;
  const M = (BF.mixer = { selected: 0, tab: 'inserts' });
  let root, stripsEl, slotsEl, meters = [], insertsEl, srcEl, tabBtns = {};
  const MAX_FX = 10;

  M.build = function () {
    root = document.createElement('div');
    root.className = 'mx-wrap';
    const tabs = document.createElement('div');
    tabs.className = 'mx-tabs'; tabs.setAttribute('role', 'tablist');
    [['inserts', 'Inserts'], ['sources', 'Patterns & audio']].forEach(([id, label]) => {
      const b = document.createElement('button');
      b.className = 'mx-tab'; b.textContent = label; b.setAttribute('role', 'tab');
      b.addEventListener('click', () => { M.tab = id; try { localStorage.setItem('bf-mixer-tab', id); } catch { /* */ } M.render(); });
      tabBtns[id] = b; tabs.append(b);
    });
    try { const t = localStorage.getItem('bf-mixer-tab'); if (t === 'sources' || t === 'inserts') M.tab = t; } catch { /* */ }
    insertsEl = document.createElement('div');
    insertsEl.className = 'mx';
    stripsEl = document.createElement('div');
    stripsEl.className = 'mx-strips';
    slotsEl = document.createElement('div');
    slotsEl.className = 'mx-slots';
    insertsEl.append(stripsEl, slotsEl);
    srcEl = document.createElement('div');
    srcEl.className = 'mx-strips mx-src';
    root.append(tabs, insertsEl, srcEl);
    return root;
  };

  // ---------- Patterns & audio tab ----------
  function srcStrip({ key, label, color, vol, max, mute, title, set, toggle, cls = '', done = null }) {
    const el = document.createElement('div');
    el.className = `mx-strip mx-srcstrip${cls ? ` ${cls}` : ''}`;
    el.dataset.key = key;
    el.style.setProperty('--c', color);
    const kind = document.createElement('div'); kind.className = 'mx-num'; kind.textContent = title;
    const name = document.createElement('div'); name.className = 'mx-name mx-srcname'; name.textContent = label; name.title = label;
    const body = document.createElement('div'); body.className = 'mx-body';
    const fader = document.createElement('input');
    fader.type = 'range'; fader.min = 0; fader.max = max; fader.value = Math.round(vol * 100);
    fader.className = 'mx-fader';
    fader.setAttribute('aria-label', `${label} volume`);
    fader.setAttribute('aria-valuetext', `${Math.round(vol * 100)}%`);
    fader.title = 'Volume (double-click: 100%)';
    fader.addEventListener('input', () => set(fader.value / 100, `src-${key}`));
    fader.addEventListener('dblclick', () => set(1, null));
    if (done) fader.addEventListener('change', done); // released: let the playlist show the new volume
    body.append(fader);
    const v = document.createElement('div'); v.className = 'mx-vol'; v.textContent = `${Math.round(vol * 100)}%`;
    const ms = document.createElement('div'); ms.className = 'ms';
    const m = document.createElement('button');
    m.className = 'mute'; m.textContent = 'M'; m.title = 'Mute';
    m.setAttribute('aria-pressed', String(!!mute)); m.setAttribute('aria-label', `Mute ${label}`);
    m.addEventListener('click', toggle);
    ms.append(m);
    el.append(kind, name, body, v, ms);
    return el;
  }
  function sources() {
    const p = BF.project, sl = srcEl.scrollLeft;
    srcEl.textContent = '';
    // the clips selected in the playlist: their own volume, so one part of the song can be quieter than another
    const sel = BF.playlist && BF.playlist.sel ? p.clips.filter((c) => BF.playlist.sel.has(c.id) && (c.kind === 'pattern' || c.kind === 'audio')).sort((a, b) => a.start - b.start).slice(0, 12) : [];
    const bar = (c) => `bar ${Math.floor(c.start / BF.barBeats()) + 1}`;
    sel.forEach((c) => {
      const pt = c.kind === 'pattern' ? p.patterns.find((x) => x.id === c.patternId) : null;
      const label = pt ? pt.name : (p.samples[c.sampleId]?.name || 'Audio');
      const field = c.kind === 'pattern' ? 'vol' : 'gain';
      srcEl.append(srcStrip({
        key: `c:${c.id}`, label: `${label} · ${bar(c)}`, color: pt ? pt.color : '#8fd3ff', vol: c[field] ?? 1, max: c.kind === 'pattern' ? 100 : 200, mute: c.muted, title: 'Selected clip', cls: 'clip', done: () => BF.emit('clips'),
        set: (v, k) => BF.commit((q) => { const x = q.clips.find((y) => y.id === c.id); if (!x) return; if (field === 'vol' && Math.abs(v - 1) < 0.004) delete x.vol; else x[field] = v; }, k, 'mix'),
        toggle: () => BF.commit((q) => { const x = q.clips.find((y) => y.id === c.id); if (x) { if (x.muted) delete x.muted; else x.muted = true; } }, null, 'clips'),
      }));
    });
    if (sel.length) { const d = document.createElement('div'); d.className = 'mx-srcsep'; d.title = 'Left: only the selected clips. Right: every clip of a pattern / audio file.'; srcEl.append(d); }
    else { const h = document.createElement('div'); h.className = 'mx-srchint'; h.textContent = 'Tip: select clips in the playlist to change only those clips here.'; srcEl.append(h); }
    p.patterns.forEach((pt) => srcEl.append(srcStrip({
      key: `p:${pt.id}`, label: pt.name, color: pt.color, vol: pt.vol ?? 1, max: 100, mute: pt.mute, title: 'Pattern',
      set: (v, k) => BF.commit((q) => { const x = q.patterns.find((y) => y.id === pt.id); if (x) { if (v === 1) delete x.vol; else x.vol = v; } }, k, 'mix'),
      toggle: () => BF.commit((q) => { const x = q.patterns.find((y) => y.id === pt.id); if (x) { if (x.mute) delete x.mute; else x.mute = true; } }),
    })));
    // audio files used in the playlist (or imported), in order of first use
    const used = [...new Set(p.clips.filter((c) => c.kind === 'audio').sort((a, b) => a.start - b.start).flatMap((c) => [c.sampleId, ...(c.takes || [])]))];
    const ids = [...used, ...Object.keys(p.samples).filter((id) => !used.includes(id))].filter((id) => p.samples[id]);
    const mixOf = (q, id) => (q.audioMix = q.audioMix || {}, q.audioMix[id] = q.audioMix[id] || { vol: 1 });
    const tidy = (q, id) => { const m = q.audioMix[id]; if (m && (m.vol ?? 1) === 1 && !m.mute) delete q.audioMix[id]; };
    ids.forEach((id) => { const am = (p.audioMix || {})[id] || {}; srcEl.append(srcStrip({
      key: `a:${id}`, label: p.samples[id].name, color: '#8fd3ff', vol: am.vol ?? 1, max: 200, mute: am.mute, title: 'Audio',
      set: (v, k) => BF.commit((q) => { mixOf(q, id).vol = v; tidy(q, id); }, k, 'mix'),
      toggle: () => BF.commit((q) => { const m = mixOf(q, id); if (m.mute) delete m.mute; else m.mute = true; tidy(q, id); }),
    })); });
    if (!p.patterns.length && !Object.keys(p.samples).length) { const e = document.createElement('p'); e.className = 'empty'; e.textContent = 'No patterns or audio yet.'; srcEl.append(e); }
    srcEl.scrollLeft = sl;
  }

  function strip(i) {
    const p = BF.project, m = p.mixer[i];
    const el = document.createElement('div');
    el.className = 'mx-strip' + (i === 0 ? ' master' : '') + (M.selected === i ? ' sel' : '');
    el.addEventListener('pointerdown', (e) => { if (M.selected !== i && !e.target.closest('input,.knob')) { M.selected = i; M.render(); } });
    el.addEventListener('dragover', (e) => { if (BF.browser.isDrag(e)) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drop'); const pl = BF.browser.payload(e); if (pl && pl.kind === 'effect') BF.browser.addEffect(i, pl.plugin); });
    const num = document.createElement('div');
    num.className = 'mx-num';
    num.textContent = i === 0 ? 'M' : String(i);
    const name = document.createElement('button');
    name.className = 'mx-name';
    name.textContent = m.name;
    name.title = `${m.name}: click to show its effects, double-click to rename`;
    name.addEventListener('click', () => { M.selected = i; M.render(); });
    name.addEventListener('dblclick', async () => { const n = await BF.ui.prompt('Insert name', m.name); if (n) BF.commit((q) => { q.mixer[i].name = n; }); });
    const fxDot = document.createElement('div');
    fxDot.className = 'mx-fxcount';
    const sends = i > 0 ? (m.route?.sends || []).map((x) => x.to) : [];
    fxDot.textContent = [m.fx.length ? `${m.fx.length} fx` : '', sends.length ? `→${sends.join(',')}` : '', i > 0 && m.route && !m.route.master ? '⊘M' : ''].filter(Boolean).join(' ');
    fxDot.title = i > 0 ? `${m.fx.length} effects. Sends to: ${sends.length ? sends.join(', ') : 'none'}. ${m.route && !m.route.master ? 'Not routed to Master.' : 'Routed to Master.'}` : '';
    const pan = BF.ui.knob({ param: { name: 'Pan', min: -1, max: 1, default: 0, fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) }, value: m.pan, compact: true, label: `${m.name} pan`, target: { kind: 'mx', insert: i, field: 'pan' }, onInput: (v) => BF.commit((q) => { q.mixer[i].pan = v; }, `mxpan-${i}`, 'mix') });
    const body = document.createElement('div');
    body.className = 'mx-body';
    const meter = document.createElement('canvas');
    meter.className = 'mx-meter';
    meter.width = 8; meter.height = 120;
    meters[i] = { cv: meter, hold: 0 };
    const fader = document.createElement('input');
    fader.type = 'range'; fader.min = 0; fader.max = 125; fader.value = Math.round(m.volume * 100);
    fader.className = 'mx-fader';
    fader.setAttribute('aria-label', `${m.name} volume`);
    fader.setAttribute('aria-valuetext', `${Math.round(m.volume * 100)}%`);
    fader.title = 'Volume (double-click: 80%)';
    fader.addEventListener('input', () => BF.commit((q) => { q.mixer[i].volume = fader.value / 100; }, `mxvol-${i}`, 'mix'));
    fader.addEventListener('dblclick', () => BF.commit((q) => { q.mixer[i].volume = 0.8; }));
    fader.addEventListener('contextmenu', (e) => { e.preventDefault(); BF.auto.menu(e.clientX, e.clientY, { kind: 'mx', insert: i, field: 'volume' }, () => BF.commit((q) => { q.mixer[i].volume = 0.8; })); });
    body.append(meter, fader);
    const vol = document.createElement('div');
    vol.className = 'mx-vol';
    vol.textContent = `${Math.round(m.volume * 100)}%`;
    const ms = document.createElement('div');
    ms.className = 'ms';
    const mute = document.createElement('button');
    mute.className = 'mute'; mute.textContent = 'M'; mute.title = 'Mute';
    mute.setAttribute('aria-pressed', String(m.mute));
    mute.setAttribute('aria-label', `Mute ${m.name}`);
    mute.addEventListener('click', () => BF.commit((q) => { q.mixer[i].mute = !q.mixer[i].mute; }));
    ms.append(mute);
    if (i > 0) {
      const solo = document.createElement('button');
      solo.className = 'solo'; solo.textContent = 'S'; solo.title = 'Solo';
      solo.setAttribute('aria-pressed', String(m.solo));
      solo.setAttribute('aria-label', `Solo ${m.name}`);
      solo.addEventListener('click', () => BF.commit((q) => { q.mixer[i].solo = !q.mixer[i].solo; }));
      ms.append(solo);
    }
    el.append(num, name, fxDot, pan.el, body, vol, ms);
    return el;
  }

  function slots() {
    const p = BF.project, i = M.selected, m = p.mixer[i];
    slotsEl.textContent = '';
    const h = document.createElement('div');
    h.className = 'mx-slots-h';
    h.textContent = `${i === 0 ? 'Master' : `Insert ${i}`}: ${m.name}`;
    slotsEl.append(h);
    const routed = p.channels.filter((c) => c.insert === i).map((c) => c.name);
    const info = document.createElement('div');
    info.className = 'hint';
    info.textContent = i === 0 ? 'Everything ends up here.' : routed.length ? `Channels: ${routed.join(', ')}` : 'No channels routed here yet (set the number in the channel rack).';
    slotsEl.append(info);
    m.fx.forEach((f, k) => {
      const row = document.createElement('div');
      row.className = 'slot' + (f.bypass ? ' off' : '');
      const on = document.createElement('button');
      on.className = 'led';
      on.setAttribute('aria-pressed', String(!f.bypass));
      on.setAttribute('aria-label', `${BF.plugins.get(f.plugin).name} on/off`);
      on.title = 'On / bypass';
      on.addEventListener('click', () => BF.commit((q) => { q.mixer[i].fx[k].bypass = !q.mixer[i].fx[k].bypass; }));
      const open = document.createElement('button');
      open.className = 'slot-name';
      open.textContent = `${k + 1}. ${BF.plugins.get(f.plugin).name}`;
      open.title = 'Open effect';
      open.addEventListener('click', () => BF.editor.openEffect(i, f.id));
      const up = document.createElement('button'); up.className = 'btn small icon'; up.textContent = '↑'; up.disabled = k === 0; up.setAttribute('aria-label', 'Move up');
      const dn = document.createElement('button'); dn.className = 'btn small icon'; dn.textContent = '↓'; dn.disabled = k === m.fx.length - 1; dn.setAttribute('aria-label', 'Move down');
      const rm = document.createElement('button'); rm.className = 'btn small icon danger'; rm.textContent = '×'; rm.setAttribute('aria-label', 'Remove effect'); rm.title = 'Remove';
      const swap = (a, b) => BF.commit((q) => { const fx = q.mixer[i].fx; [fx[a], fx[b]] = [fx[b], fx[a]]; });
      up.addEventListener('click', () => swap(k, k - 1));
      dn.addEventListener('click', () => swap(k, k + 1));
      rm.addEventListener('click', () => { BF.commit((q) => { q.mixer[i].fx.splice(k, 1); }); BF.editor.closeIf(f.id); });
      row.append(on, open, up, dn, rm);
      slotsEl.append(row);
    });
    if (m.fx.length < MAX_FX) {
      const add = document.createElement('select');
      add.className = 'slot-add';
      add.setAttribute('aria-label', 'Add an effect');
      add.add(new Option('+ Add effect…', ''));
      BF.plugins.list('effect').filter((d) => !d.vst).forEach((d) => add.add(new Option(d.name, d.id)));
      if (BF.vst && BF.vst.available()) add.add(new Option('VST effects (OTT, Valhalla…)…', '__vst'));
      add.addEventListener('change', () => {
        if (!add.value) return;
        if (add.value === '__vst') { add.value = ''; BF.vst.open('effect', i); return; }
        const fx = { id: BF.uid('fx'), plugin: add.value, params: BF.plugins.defaults(add.value), bypass: false };
        BF.commit((q) => { q.mixer[i].fx.push(fx); });
        BF.editor.openEffect(i, fx.id);
      });
      slotsEl.append(add);
    }
  }

  /** Would routing insert `from` into insert `to` create a feedback loop? */
  M.wouldLoop = function (from, to) {
    const p = BF.project;
    const seen = new Set();
    const walk = (i) => {
      if (i === from) return true;
      if (seen.has(i) || i === 0) return false;
      seen.add(i);
      return (p.mixer[i].route?.sends || []).some((s) => walk(s.to));
    };
    return walk(to);
  };

  function routing(i) {
    const p = BF.project, m = p.mixer[i];
    const box = document.createElement('div');
    box.className = 'mx-route';
    const h = document.createElement('div'); h.className = 'mx-slots-h'; h.textContent = 'Routing';
    box.append(h);
    if (i === 0) { const t = document.createElement('div'); t.className = 'hint'; t.textContent = 'Master goes to your speakers.'; box.append(t); return box; }
    const r = m.route;
    const ml = document.createElement('label'); ml.className = 'route-row';
    const mc = document.createElement('input'); mc.type = 'checkbox'; mc.checked = r.master;
    mc.addEventListener('change', () => BF.commit((q) => { q.mixer[i].route.master = mc.checked; }));
    ml.append(mc, document.createTextNode(' → Master'));
    box.append(ml);
    r.sends.forEach((s, k) => {
      const row = document.createElement('div'); row.className = 'route-row';
      const lab = document.createElement('span'); lab.textContent = `→ ${p.mixer[s.to].name} (${s.to})`;
      const lv = BF.ui.knob({ param: { name: 'Send', min: 0, max: 1.25, default: 1, fmt: BF.plugins.util.pct }, value: s.level, compact: true, label: `Send level to ${p.mixer[s.to].name}`, onInput: (v) => BF.commit((q) => { q.mixer[i].route.sends[k].level = v; }, `send-${i}-${k}`, 'mix') });
      const rm = document.createElement('button'); rm.className = 'btn small icon danger'; rm.textContent = '×'; rm.setAttribute('aria-label', 'Remove send');
      rm.addEventListener('click', () => BF.commit((q) => { q.mixer[i].route.sends.splice(k, 1); }));
      row.append(lab, lv.el, rm);
      box.append(row);
    });
    const add = document.createElement('select');
    add.setAttribute('aria-label', 'Add a send to another insert');
    add.add(new Option('+ Send to insert…', ''));
    for (let j = 1; j <= BF.INSERTS; j++) {
      if (j === i || r.sends.some((s) => s.to === j)) continue;
      const o = new Option(`${j}. ${p.mixer[j].name}`, j);
      if (M.wouldLoop(i, j)) { o.disabled = true; o.text += ' (would loop)'; }
      add.add(o);
    }
    add.addEventListener('change', () => { const j = +add.value; if (j) BF.commit((q) => { q.mixer[i].route.sends.push({ to: j, level: 1 }); }); });
    box.append(add);
    return box;
  }

  M.render = function () {
    if (!root) return;
    Object.entries(tabBtns).forEach(([id, b]) => { b.setAttribute('aria-selected', String(M.tab === id)); b.classList.toggle('on', M.tab === id); });
    insertsEl.hidden = M.tab !== 'inserts';
    srcEl.hidden = M.tab !== 'sources';
    if (M.tab === 'sources') { sources(); return; }
    const sl = stripsEl.scrollLeft;
    stripsEl.textContent = '';
    meters = [];
    for (let i = 0; i <= BF.INSERTS; i++) stripsEl.append(strip(i));
    stripsEl.scrollLeft = sl;
    slots();
    slotsEl.append(routing(M.selected));
  };

  /** Update fader/pan labels after a 'mix' change without rebuilding (so drags continue). */
  M.syncLabels = function () {
    if (!root) return;
    if (M.tab === 'sources') { // labels only, so a fader drag continues
      const p = BF.project;
      srcEl.querySelectorAll('.mx-srcstrip').forEach((el) => {
        const [k, id] = [el.dataset.key.slice(0, 1), el.dataset.key.slice(2)];
        const c = k === 'c' ? p.clips.find((x) => x.id === id) : null;
        const v = k === 'p' ? (p.patterns.find((x) => x.id === id)?.vol ?? 1) : k === 'c' ? ((c && (c.kind === 'pattern' ? c.vol : c.gain)) ?? 1) : (p.audioMix?.[id]?.vol ?? 1);
        el.querySelector('.mx-vol').textContent = `${Math.round(v * 100)}%`;
        el.querySelector('.mx-fader').setAttribute('aria-valuetext', `${Math.round(v * 100)}%`);
      });
      return;
    }
    stripsEl.querySelectorAll('.mx-strip').forEach((el, i) => {
      const m = BF.project.mixer[i];
      el.querySelector('.mx-vol').textContent = `${Math.round(m.volume * 100)}%`;
      el.querySelector('.mx-fader').setAttribute('aria-valuetext', `${Math.round(m.volume * 100)}%`);
    });
  };

  /** Called every animation frame while the mixer is visible. */
  M.meters = function () {
    if (!root || !BF.audio.graph) return;
    meters.forEach((mt, i) => {
      if (!mt) return;
      const pk = BF.audio.peak(i);
      mt.hold = Math.max(pk, mt.hold * 0.92);
      const g = mt.cv.getContext('2d');
      const H = mt.cv.height;
      g.clearRect(0, 0, 8, H);
      g.fillStyle = '#0b0d10';
      g.fillRect(0, 0, 8, H);
      const db = 20 * Math.log10(Math.max(1e-5, mt.hold));
      const n = Math.max(0, Math.min(1, (db + 48) / 54)); // -48..+6 dB
      g.fillStyle = mt.hold >= 1 ? '#ff6b6b' : db > -6 ? '#ffd24a' : '#3ddc84';
      g.fillRect(0, H - n * H, 8, n * H);
      g.fillStyle = 'rgba(255,255,255,.35)';
      g.fillRect(0, H - ((0 + 48) / 54) * H, 8, 1); // 0 dB mark
    });
  };
})();
