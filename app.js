/* app.js: boot, top bar, menus, windows, keyboard shortcuts, render batching and the animation loop. */
(function () {
  'use strict';
  const BF = window.BF;
  const $ = (id) => document.getElementById(id);

  // ---------- small UI helpers ----------
  let toastTimer = null;
  BF.ui.toast = function (msg, error = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!error);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, error ? 7000 : 3800);
  };
  BF.ui.busy = function (msg) {
    $('busy').hidden = !msg;
    if (msg) $('busyText').textContent = msg;
  };

  BF.project = BF.newProject(true);

  // ---------- windows ----------
  const W = BF.win;
  // Default layout follows the classic pattern-DAW arrangement: browser docked left, playlist filling the workspace,
  // channel rack floating over it; mixer (F9), piano roll (F7) and plugin windows open on demand.
  BF.browser.build();
  W.create({ id: 'playlist', title: 'Playlist - Arrangement', body: BF.playlist.build(), rect: { x: 0, y: 0, w: 1, h: 1 }, open: true, hotkey: 'F5', onShow: () => BF.playlist.render() });
  W.create({ id: 'rack', title: 'Channel rack', body: BF.rack.build(), rect: { x: 0.12, y: 0.08, w: 0.74, h: 0.55 }, open: true, hotkey: 'F6', onShow: () => BF.rack.render() });
  W.create({ id: 'piano', title: 'Piano roll', body: BF.piano.build(), rect: { x: 0.06, y: 0.04, w: 0.88, h: 0.7 }, open: false, hotkey: 'F7', onShow: () => { BF.piano.sync(); BF.piano.reveal(); } });
  W.create({ id: 'mixer', title: 'Mixer', body: BF.mixer.build(), rect: { x: 0.02, y: 0.4, w: 0.96, h: 0.58 }, open: false, hotkey: 'F9', onShow: () => BF.mixer.render() });
  W.create({ id: 'editor', title: 'Plugin', body: BF.editor.build(), rect: { x: 0.5, y: 0.06, w: 0.46, h: 0.56 }, open: false, onShow: () => BF.editor.render() });
  W.create({ id: 'picker', title: 'Plugin picker', body: BF.keys.buildPicker(), rect: { x: 0.25, y: 0.1, w: 0.5, h: 0.6 }, open: false, hotkey: 'F8' });
  W.create({ id: 'store', title: 'Plugin store', body: BF.community.build(), rect: { x: 0.15, y: 0.06, w: 0.7, h: 0.8 }, open: false, onShow: () => BF.community.render() });
  W.create({ id: 'sampleed', title: 'Audio editor', body: BF.sampleEditor.build(), rect: { x: 0.1, y: 0.2, w: 0.8, h: 0.5 }, open: false, onShow: () => BF.sampleEditor.draw(), onHide: () => BF.sampleEditor.stop() });
  W.create({ id: 'perf', title: 'Performance', body: BF.perf.build(), rect: { x: 0.12, y: 0.12, w: 0.76, h: 0.6 }, open: false, onShow: () => BF.perf.render() });
  W.create({ id: 'auto', title: 'Automation', body: BF.auto.build(), rect: { x: 0.1, y: 0.5, w: 0.8, h: 0.42 }, open: false, onShow: () => BF.auto.render() });
  W.front('rack');
  const wsToggle = W.toggle;
  W.toggle = (id, force) => (id === 'browser' ? BF.browser.toggle(force) : wsToggle(id, force));
  const wsOpen = W.isOpen;
  W.isOpen = (id) => (id === 'browser' ? BF.browser.isOpen() : wsOpen(id));

  // Hint bar: shows what the control under the mouse does (data-hint, aria-label or title).
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-hint],[title],[aria-label]');
    if (!el) return;
    const h = el.dataset.hint || el.getAttribute('title') || el.getAttribute('aria-label');
    if (h) $('hint').textContent = h;
  });

  // ---------- render batching ----------
  // Changes are collected and drawn once per frame, so dragging stays smooth.
  const dirty = new Set();
  let queued = false;
  function want(...parts) {
    parts.forEach((p) => dirty.add(p));
    if (!queued) { queued = true; requestAnimationFrame(flush); }
  }
  function flush() {
    queued = false;
    const d = new Set(dirty);
    dirty.clear();
    const knob = BF.ui.knobDrag;
    if (d.has('top')) syncTop();
    if (d.has('rack') && !knob && W.isOpen('rack')) BF.rack.render();
    if (d.has('playlist') && !knob && W.isOpen('playlist')) BF.playlist.render();
    if (d.has('piano') && W.isOpen('piano')) BF.piano.sync();
    if (d.has('mixer') && !knob && W.isOpen('mixer')) BF.mixer.render();
    if (d.has('mixlabels') && W.isOpen('mixer')) BF.mixer.syncLabels();
    if (d.has('editor') && W.isOpen('editor')) BF.editor.render();
    if (d.has('editorsync') && W.isOpen('editor')) BF.editor.sync();
    if (d.has('browser')) BF.browser.render();
    if (d.has('auto') && W.isOpen('auto')) BF.auto.render();
  }

  BF.onChange((reason) => {
    if (BF.audio.ctx && !['select', 'pattern', 'view', 'transport', 'windows'].includes(reason)) BF.audio.sync(BF.audio.graph, BF.project);
    switch (reason) {
      case 'mix': want('mixlabels', 'top'); break;
      case 'param': want('top', 'editorsync'); break;
      case 'steps': want('rack', 'playlist', 'top'); break;
      case 'notes': want('piano', 'rack', 'playlist', 'top'); break;
      case 'clips': want('playlist', 'top', 'auto'); break;
      case 'auto': want('playlist', 'auto', 'top'); break;
      case 'select': want('rack', 'piano', 'top', 'browser'); break;
      case 'pattern': want('rack', 'piano', 'playlist', 'top', 'browser'); break;
      case 'transport': want('top', 'playlist'); break;
      case 'windows': want('top', 'browser'); break;
      case 'knob-end': want('rack', 'mixer', 'playlist'); break;
      case 'undo': case 'redo': want('top', 'rack', 'playlist', 'piano', 'mixer', 'editorsync', 'browser', 'auto'); break;
      case 'load': want('top', 'rack', 'playlist', 'piano', 'mixer', 'editor', 'browser', 'auto'); break;
      default: want('top', 'rack', 'playlist', 'piano', 'mixer', 'browser', 'auto');
    }
  });

  function syncTop() {
    const p = BF.project, T = BF.transport;
    if (document.activeElement !== $('bpm')) $('bpm').value = p.bpm;
    $('undoBtn').disabled = !BF.canUndo();
    $('redoBtn').disabled = !BF.canRedo();
    $('playBtn').textContent = T.playing ? '❚❚' : '▶';
    $('playBtn').setAttribute('aria-label', T.playing ? 'Pause' : 'Play');
    $('playBtn').setAttribute('aria-pressed', String(T.playing));
    $('recBtn').setAttribute('aria-pressed', String(BF.rec.armed));
    $('metBtn').setAttribute('aria-pressed', String(BF.recorder.metronome));
    $('stepBtn').setAttribute('aria-pressed', String(!!BF.rec.stepEdit));
    $('preBtn').setAttribute('aria-pressed', String(!!BF.rec.precount));
    [['modePattern', 'pattern'], ['modeSong', 'song']].forEach(([id, m]) => {
      $(id).classList.toggle('on', T.mode === m);
      $(id).setAttribute('aria-checked', String(T.mode === m));
    });
    BF.patterns.syncSelect($('patSelect'));
    document.querySelectorAll('[data-open]').forEach((b) => b.setAttribute('aria-pressed', String(W.isOpen(b.dataset.open))));
    document.title = `${BF.dirty ? '• ' : ''}${p.name} · BeatForge ${window.BF_VERSION || ''}`;
  }

  // ---------- top bar ----------
  $('playBtn').addEventListener('click', () => BF.transport.toggle());
  $('recBtn').addEventListener('click', () => toggleRec());
  $('metBtn').addEventListener('click', () => { BF.recorder.metronome = !BF.recorder.metronome; BF.emit('transport'); });
  $('stepBtn').addEventListener('click', () => { BF.rec.stepEdit = !BF.rec.stepEdit; BF.piano.draw(); BF.emit('transport'); });
  $('preBtn').addEventListener('click', () => { BF.rec.precount = !BF.rec.precount; BF.emit('transport'); });

  // master volume (= master insert fader) and master pitch (cents), like the knobs left of a DAW's transport
  const mvol = BF.ui.knob({ param: { name: 'Master volume', min: 0, max: 1.25, default: 0.8, fmt: (v) => `${Math.round(v * 100)}%` }, value: BF.project.mixer[0].volume, compact: true,
    onInput: (v) => BF.commit((q) => { q.mixer[0].volume = v; }, 'master-vol', 'mix') });
  const mpitch = BF.ui.knob({ param: { name: 'Master pitch', min: -1200, max: 1200, default: 0, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} cents` }, value: BF.project.masterPitch || 0, compact: true,
    onInput: (v) => BF.commit((q) => { q.masterPitch = Math.round(v); }, 'master-pitch', 'param') });
  $('masterKnobs').append(mvol.el, mpitch.el);
  BF.onChange(() => { mvol.set(BF.project.mixer[0].volume); mpitch.set(BF.project.masterPitch || 0); });

  // CPU meter: how late the page's timers run (busy main thread = late timers = possible audio glitches)
  (() => {
    let last = performance.now(), load = 0;
    setInterval(() => {
      const now = performance.now();
      const late = Math.max(0, now - last - 250);
      last = now;
      load = load * 0.7 + Math.min(1, late / 120) * 0.3;
      const f = $('cpuFill');
      if (f) { f.style.width = `${Math.round(Math.max(0.04, load) * 100)}%`; f.classList.toggle('hot', load > 0.6); }
    }, 250);
  })();
  function toggleRec() {
    BF.rec.armed = !BF.rec.armed;
    if (BF.rec.armed && !BF.piano.typing && !BF.live.devices.length) BF.ui.toast('Record is on. Turn on the typing keyboard (piano roll) or plug in a MIDI keyboard, press Space and play.');
    else BF.ui.toast(BF.rec.armed ? `Recording into ${BF.channel()?.name || 'the selected channel'} · ${BF.pattern().name}. Press Space and play.` : 'Record off.');
    BF.emit('transport');
  }
  $('stopBtn').addEventListener('click', () => { BF.transport.stop(); BF.transport.startBeat = 0; BF.emit('transport'); });
  $('modePattern').addEventListener('click', () => BF.transport.setMode('pattern'));
  $('modeSong').addEventListener('click', () => BF.transport.setMode('song'));
  // right-click the tempo: tempo automation (tempo changes in the song), like a DAW's tempo track
  $('bpm').addEventListener('contextmenu', (e) => { e.preventDefault(); BF.auto.menu(e.clientX, e.clientY, { kind: 'tempo' }, () => {}); });
  $('bpm').title = 'Tempo. Right-click: tempo changes over the song (automation clip)';
  $('bpm').addEventListener('change', () => {
    const v = Math.round(BF.clamp($('bpm').value, 40, 300, BF.project.bpm) * 100) / 100;
    $('bpm').value = v;
    if (v !== BF.project.bpm) BF.commit((p) => { p.bpm = v; }, 'bpm');
  });
  $('patSelect').addEventListener('change', (e) => {
    if (e.target.value === '__new') BF.patterns.add();
    else BF.setView((p) => { p.currentPattern = e.target.value; }, 'pattern');
    BF.playlist.pick = { kind: 'pattern' };
  });
  document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => W.toggle(b.dataset.open)));
  $('undoBtn').addEventListener('click', () => BF.undo());
  $('redoBtn').addEventListener('click', () => BF.redo());
  $('openInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) BF.io.open(f); });

  function newProject() {
    if (BF.dirty && !confirm('Start a new project? Unsaved changes are lost.')) return;
    BF.transport.stop();
    BF.audio.buffers.clear(); BF.audio.stretched.clear(); BF.audio.reversedCache.clear();
    BF.playlist.sel.clear(); BF.piano.sel.clear();
    BF.transport.startBeat = 0;
    BF.editor.target = null;
    BF.replaceProject(BF.newProject(false));
  }
  const openFile = () => $('openInput').click();

  $('menuFile').addEventListener('click', (e) => BF.ui.menuAt(e.currentTarget, [
    { label: 'New', hint: 'Ctrl+N', action: newProject },
    { label: 'New from template…', action: () => BF.templates.open() },
    { label: 'Open… (.bfp project or .mid)', hint: 'Ctrl+O', action: openFile },
    { label: 'Save', hint: 'Ctrl+S', action: () => BF.io.save() },
    { label: 'Save as…', hint: 'Ctrl+Shift+S', action: () => BF.io.saveAs() },
    { label: 'Save as template…', action: () => BF.templates.saveCurrent() },
    '-',
    { label: 'Import audio to playlist…', action: () => BF.io.pickFiles((f) => BF.io.importToPlaylist(f, 0, 0)) },
    { label: 'Import audio as Sampler channels…', action: () => BF.io.pickFiles((f) => BF.io.importToRack(f)) },
    '-',
    { label: 'Import MIDI file…', action: openFile },
    { label: 'Import a pack (.zip or folder)…', action: () => BF.packImport.ask() },
    { label: 'Add a folder to the browser…', action: () => BF.files.addFolder() },
    '-',
    { label: 'Live session (make music together)…', action: () => BF.collab.open() },
    '-',
    { label: 'Export song as MP3… (small, for Discord)', hint: 'Ctrl+Shift+R', action: () => BF.exporter.export('mp3') },
    { label: 'Export song as OGG… (smallest)', action: () => BF.exporter.export('ogg') },
    { label: 'Export song as WAV… (full quality)', hint: 'Ctrl+R', action: () => BF.io.exportWav('song') },
    { label: 'Export current pattern as WAV…', action: () => BF.io.exportWav('pattern') },
    { label: 'Export MIDI file…', hint: 'Ctrl+Shift+M', action: () => BF.keys.exportMidi() },
    { label: 'Export stems (one WAV per insert)…', action: () => BF.io.exportStems() },
  ]));
  $('menuEdit').addEventListener('click', (e) => BF.ui.menuAt(e.currentTarget, [
    { label: 'Undo', hint: 'Ctrl+Z', disabled: !BF.canUndo(), action: () => BF.undo() },
    { label: 'Redo', hint: 'Ctrl+Shift+Z', disabled: !BF.canRedo(), action: () => BF.redo() },
    '-',
    { label: 'Rename project…', action: async () => { const n = await BF.ui.prompt('Project name', BF.project.name); if (n) BF.commit((p) => { p.name = n; }); } },
    { label: 'Settings…', hint: 'F10', action: () => BF.keys.settings() },
    { label: 'Project info…', hint: 'F11', action: () => BF.keys.projectInfo() },
    { label: 'Metronome', hint: 'Ctrl+M', checked: BF.recorder.metronome, action: () => { BF.recorder.metronome = !BF.recorder.metronome; BF.emit('transport'); } },
    { label: 'Quantize recorded notes to 1/16', checked: BF.rec.quantize, action: () => { BF.rec.quantize = !BF.rec.quantize; } },
    { label: 'Connect MIDI keyboard', action: () => BF.live.start(true) },
    { label: 'Typing keyboard to piano', checked: BF.piano.typing, action: () => document.querySelector('.piano .pr-tools button[aria-pressed][title*="computer keyboard"]')?.click() },
    '-',
    { label: 'Song length (bars)…', action: async () => { const n = await BF.ui.prompt('Minimum song length in bars', String(BF.project.songBars)); if (n) BF.commit((p) => { p.songBars = Math.round(BF.clamp(n, 1, 512, p.songBars)); }); } },
  ]));
  $('menuView').addEventListener('click', (e) => BF.ui.menuAt(e.currentTarget, [
    { label: 'Playlist', hint: 'F5', checked: W.isOpen('playlist'), action: () => W.toggle('playlist') },
    { label: 'Channel rack', hint: 'F6', checked: W.isOpen('rack'), action: () => W.toggle('rack') },
    { label: 'Piano roll', hint: 'F7', checked: W.isOpen('piano'), action: () => W.toggle('piano') },
    { label: 'Mixer', hint: 'F9', checked: W.isOpen('mixer'), action: () => W.toggle('mixer') },
    { label: 'Browser', hint: 'Alt+F8', checked: W.isOpen('browser'), action: () => W.toggle('browser') },
    { label: 'Plugin picker', hint: 'F8', checked: W.isOpen('picker'), action: () => W.toggle('picker') },
    { label: 'Plugin store…', checked: W.isOpen('store'), action: () => BF.community.openStore() },
    { label: 'Close all windows', hint: 'F12', action: () => [...W.all.keys()].forEach((id) => { if (id !== 'playlist') W.toggle(id, false); }) },
    { label: 'Plugin editor', checked: W.isOpen('editor'), action: () => W.toggle('editor') },
    { label: 'Performance mode', checked: W.isOpen('perf'), action: () => W.toggle('perf') },
    '-',
    { label: 'Reset window layout', action: () => W.resetLayout() },
  ]));
  $('menuHelp').addEventListener('click', (e) => BF.ui.menuAt(e.currentTarget, [
    { label: 'Keyboard shortcuts', hint: 'F1', action: showHelp },
    { label: 'Last import: skipped files', action: () => BF.packImport.showSkipped() },
    ...(BF.desktop && BF.desktop.available ? [
      { label: 'Check for updates…', action: () => BF.desktop.check(true) },
      { label: 'Check for updates automatically', checked: BF.desktop.info?.settings?.autoUpdate !== false, action: async () => { const on = BF.desktop.info?.settings?.autoUpdate === false; const s = await window.beatforgeDesktop.setAutoUpdate(on); BF.desktop.info.settings = s; BF.ui.toast(on ? 'Automatic update checks on.' : 'Automatic update checks off.'); } },
    ] : []),
    { label: 'About BeatForge', action: () => BF.ui.toast(`BeatForge ${window.BF_VERSION || ''}${BF.desktop?.info?.updated ? ' (updated)' : ''}: free, open source (MIT). Made by GRBN Studios.`) },
  ]));

  function showHelp() {
    const b = $('helpBody');
    b.textContent = '';
    BF.keys.list.forEach(([group, rows]) => {
      const h = document.createElement('h3'); h.textContent = group; b.append(h);
      const tbl = document.createElement('table');
      rows.forEach(([k, d]) => { const tr = tbl.insertRow(); tr.insertCell().append(Object.assign(document.createElement('kbd'), { textContent: k })); tr.insertCell().textContent = d; });
      b.append(tbl);
    });
    $('helpDlg').showModal();
  }

  // ---------- keyboard shortcuts (see js/shortcuts.js) ----------
  window.addEventListener('keydown', (e) => BF.keys.handle(e, { newProject, openFile, toggleRec, showHelp }));
  // stop Space from also "clicking" a focused button
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && document.activeElement?.tagName === 'BUTTON') e.preventDefault(); }, true);

  // dropping files outside a window: projects open, audio goes to the playlist
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    // a dropped folder or .zip = a template pack
    const entries = [...(e.dataTransfer?.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.some((en) => en.isDirectory)) {
      BF.packImport.readEntries(entries).then((items) => BF.packImport.handle(items, entries[0].name)).catch((err) => BF.ui.toast(`Import failed: ${err.message || err}`, true));
      return;
    }
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (/\.zip$/i.test(files[0].name)) {
      BF.ui.busy(`Unpacking ${files[0].name}…`);
      BF.packImport.readZip(files[0]).then((items) => { BF.ui.busy(null); BF.packImport.handle(items, files[0].name.replace(/\.zip$/i, '')); }).catch((err) => BF.ui.toast(`Import failed: ${err.message || err}`, true)).finally(() => BF.ui.busy(null));
      return;
    }
    if (/\.(json|bfp|midi?|flp|fst)$/i.test(files[0].name)) BF.io.open(files[0]);
    else BF.io.importToPlaylist(files, 0, 0);
  });
  window.addEventListener('beforeunload', (e) => { if (BF.dirty && !navigator.userAgent.includes('Electron')) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- animation loop: playhead, step light, meters ----------
  function frame() {
    const T = BF.transport;
    const beat = T.position();
    const ctx = BF.audio.ctx;
    if (T.playing && ctx && ctx.currentTime >= T.anchorTime - 0.001) {
      if (T.mode === 'pattern') {
        BF.rack.light(Math.floor(beat * 4) % BF.pattern().length);
        BF.playlist.drawPlayhead(beat);
      } else {
        const c = BF.project.clips.find((x) => x.kind === 'pattern' && x.patternId === BF.project.currentPattern && beat >= x.start && beat < x.start + x.len);
        BF.rack.light(c ? Math.floor((beat - c.start) * 4) : -1);
        BF.playlist.drawPlayhead(beat);
        BF.playlist.follow(beat);
      }
      if (W.isOpen('piano')) BF.piano.draw();
      if (W.isOpen('auto')) BF.auto.draw();
    } else {
      BF.rack.light(-1);
      BF.playlist.drawPlayhead(T.mode === 'song' ? T.startBeat : 0);
    }
    if (W.isOpen('mixer')) BF.mixer.meters();
    const b = Math.max(0, beat);
    const bb = BF.barBeats(), inBar = b - Math.floor(b / bb + 1e-9) * bb;
    $('posText').textContent = `${Math.floor(b / bb + 1e-9) + 1}.${Math.floor(inBar) + 1}.${(Math.floor(b * 4) % 4) + 1}`;
    requestAnimationFrame(frame);
  }

  BF.emit('load');
  requestAnimationFrame(frame);
  BF.live.start(false);
  BF.files.init();
  $('collabBtn').addEventListener('click', () => BF.collab.open());
  BF.collab.render();
  BF.collab.fromLink();
  if (BF.vst) BF.vst.init();
  BF.ready = true; // the desktop shell only accepts an update after this line ran
  BF.ui.toast('Press Space to play the demo. F6 channel rack, F7 piano roll, F9 mixer, F1 shortcuts.');
})();
