/* mixer.js: one strip per sequencer track and per playlist lane, plus master. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});
  const M = (BF.mixer = {});
  const strips = [];
  let master;

  function strip(root, kind, i, label) {
    const el = document.createElement('div');
    el.className = 'strip';
    const name = document.createElement('div');
    name.className = 'name';
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = 100; vol.className = 'vol';
    const pan = document.createElement('input');
    pan.type = 'range'; pan.min = -100; pan.max = 100; pan.className = 'pan';
    const panLbl = document.createElement('div');
    panLbl.className = 'sep';
    const ms = document.createElement('div');
    ms.className = 'ms';
    const mute = document.createElement('button');
    mute.className = 'mute'; mute.textContent = 'M';
    const solo = document.createElement('button');
    solo.className = 'solo'; solo.textContent = 'S';
    ms.append(mute, solo);
    el.append(name, vol, panLbl, pan, ms);
    root.append(el);

    const ch = () => BF.project[kind][i];
    vol.addEventListener('input', () => BF.commit((p) => { p[kind][i].volume = vol.value / 100; }, `vol-${kind}-${i}`, 'mix'));
    pan.addEventListener('input', () => BF.commit((p) => { p[kind][i].pan = pan.value / 100; }, `pan-${kind}-${i}`, 'mix'));
    pan.addEventListener('dblclick', () => BF.commit((p) => { p[kind][i].pan = 0; }, null, 'mix'));
    mute.addEventListener('click', () => BF.commit((p) => { p[kind][i].mute = !p[kind][i].mute; }, null, 'mix'));
    solo.addEventListener('click', () => BF.commit((p) => { p[kind][i].solo = !p[kind][i].solo; }, null, 'mix'));
    strips.push({ kind, i, ch, name, vol, pan, panLbl, mute, solo, label });
  }

  M.build = function (root) {
    root.textContent = '';
    strips.length = 0;
    const g1 = document.createElement('div'); g1.className = 'mixer-group'; g1.textContent = 'Sequencer'; root.append(g1);
    for (let i = 0; i < 8; i++) strip(root, 'tracks', i, `Track ${i + 1}`);
    const g2 = document.createElement('div'); g2.className = 'mixer-group'; g2.textContent = 'Playlist'; root.append(g2);
    for (let i = 0; i < 8; i++) strip(root, 'lanes', i, `Lane ${i + 1}`);

    const el = document.createElement('div');
    el.className = 'strip master';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = 'Master';
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = 100; vol.className = 'vol';
    vol.setAttribute('aria-label', 'Master volume');
    const val = document.createElement('div'); val.className = 'sep';
    vol.addEventListener('input', () => BF.commit((p) => { p.masterVolume = vol.value / 100; }, 'vol-master', 'mix'));
    el.append(name, vol, val);
    root.append(el);
    master = { vol, val };
  };

  M.sync = function (force = false) {
    const p = BF.project;
    strips.forEach((s) => {
      const c = s.ch();
      const title = s.kind === 'tracks' ? `${s.i + 1} ${c.name}` : c.name;
      s.name.textContent = title;
      s.name.title = title;
      if (force || document.activeElement !== s.vol) s.vol.value = Math.round(c.volume * 100);
      if (force || document.activeElement !== s.pan) s.pan.value = Math.round(c.pan * 100);
      s.vol.setAttribute('aria-label', `${title} volume`);
      s.vol.setAttribute('aria-valuetext', `${Math.round(c.volume * 100)}%`);
      s.pan.setAttribute('aria-label', `${title} pan`);
      const pv = Math.round(c.pan * 100);
      s.panLbl.textContent = pv === 0 ? 'C' : pv < 0 ? `L${-pv}` : `R${pv}`;
      s.pan.title = 'Pan (double-click to centre)';
      s.mute.setAttribute('aria-pressed', String(c.mute));
      s.solo.setAttribute('aria-pressed', String(c.solo));
      s.mute.setAttribute('aria-label', `Mute ${title}`);
      s.solo.setAttribute('aria-label', `Solo ${title}`);
      s.mute.title = 'Mute'; s.solo.title = 'Solo';
    });
    if (force || document.activeElement !== master.vol) master.vol.value = Math.round(p.masterVolume * 100);
    master.val.textContent = `${Math.round(p.masterVolume * 100)}%`;
  };
})();
