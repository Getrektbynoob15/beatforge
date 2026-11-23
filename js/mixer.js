/* mixer.js: Master + 32 inserts. Each strip: meter, fader, pan, mute, solo. The selected insert's effect slots
 * (up to 10, processed top to bottom) are shown on the right: add, open, bypass, reorder, remove. */
(function () {
  'use strict';
  const BF = window.BF;
  const M = (BF.mixer = { selected: 0 });
  let root, stripsEl, slotsEl, meters = [];
  const MAX_FX = 10;

  M.build = function () {
    root = document.createElement('div');
    root.className = 'mx';
    stripsEl = document.createElement('div');
    stripsEl.className = 'mx-strips';
    slotsEl = document.createElement('div');
    slotsEl.className = 'mx-slots';
    root.append(stripsEl, slotsEl);
    return root;
  };

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
      BF.plugins.list('effect').forEach((d) => add.add(new Option(d.name, d.id)));
      add.addEventListener('change', () => {
        if (!add.value) return;
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
