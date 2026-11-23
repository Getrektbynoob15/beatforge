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
  W.create({ id: 'rack', title: 'Channel rack', body: BF.rack.build(), rect: { x: 0.2, y: 0.1, w: 0.56, h: 0.52 }, open: true, hotkey: 'F6', onShow: () => BF.rack.render() });
  W.create({ id: 'piano', title: 'Piano roll', body: BF.piano.build(), rect: { x: 0.06, y: 0.04, w: 0.88, h: 0.7 }, open: false, hotkey: 'F7', onShow: () => { BF.piano.sync(); BF.piano.reveal(); } });
  W.create({ id: 'mixer', title: 'Mixer', body: BF.mixer.build(), rect: { x: 0.02, y: 0.4, w: 0.96, h: 0.58 }, open: false, hotkey: 'F9', onShow: () => BF.mixer.render() });
  W.create({ id: 'editor', title: 'Plugin', body: BF.editor.build(), rect: { x: 0.5, y: 0.06, w: 0.46, h: 0.56 }, open: false, onShow: () => BF.editor.render() });
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
  }

  BF.onChange((reason) => {
    if (BF.audio.ctx && !['select', 'pattern', 'view', 'transport', 'windows'].includes(reason)) BF.audio.sync(BF.audio.graph, BF.project);
    switch (reason) {
      case 'mix': want('mixlabels', 'top'); break;
      case 'param': want('top'); break;
      case 'steps': want('rack', 'playlist', 'top'); break;
      case 'notes': want('piano', 'rack', 'playlist', 'top'); break;
      case 'clips': want('playlist', 'top'); break;
      case 'select': want('rack', 'piano', 'top', 'browser'); break;
      case 'pattern': want('rack', 'piano', 'playlist', 'top', 'browser'); break;
      case 'transport': want('top', 'playlist'); break;
      case 'windows': want('top', 'browser'); break;
      case 'knob-end': want('rack', 'mixer', 'playlist'); break;
      case 'undo': case 'redo': want('top', 'rack', 'playlist', 'piano', 'mixer', 'editorsync', 'browser'); break;
      case 'load': want('top', 'rack', 'playlist', 'piano', 'mixer', 'editor', 'browser'); break;
      default: want('top', 'rack', 'playlist', 'piano', 'mixer', 'browser');
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
    [['modePattern', 'pattern'], ['modeSong', 'song']].forEach(([id, m]) => {
      $(id).classList.toggle('on', T.mode === m);
      $(id).setAttribute('aria-checked', String(T.mode === m));
    });
    BF.patterns.syncSelect($('patSelect'));
    document.querySelectorAll('[data-open]').forEach((b) => b.setAttribute('aria-pressed', String(W.isOpen(b.dataset.open))));
    document.title = `${BF.dirty ? '• ' : ''}${p.name} · BeatForge`;
  }

  // ---------- top bar ----------
  $('playBtn').addEventListener('click', () => BF.transport.toggle());
  $('stopBtn').addEventListener('click', () => { BF.transport.stop(); BF.transport.startBeat = 0; BF.emit('transport'); });
  $('modePattern').addEventListener('click', () => BF.transport.setMode('pattern'));
  $('modeSong').addEventListener('click', () => BF.transport.setMode('song'));
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
    { label: 'New from demo', action: () => { if (!BF.dirty || confirm('Unsaved changes are lost. Continue?')) { BF.transport.stop(); BF.replaceProject(BF.newProject(true)); } } },
    { label: 'Open…', hint: 'Ctrl+O', action: openFile },
    { label: 'Save', hint: 'Ctrl+S', action: () => BF.io.save() },
    { label: 'Save as…', hint: 'Ctrl+Shift+S', action: () => BF.io.saveAs() },
    '-',
    { label: 'Import audio to playlist…', action: () => BF.io.pickFiles((f) => BF.io.importToPlaylist(f, 0, 0)) },
    { label: 'Import audio as Sampler channels…', action: () => BF.io.pickFiles((f) => BF.io.importToRack(f)) },
    '-',
    { label: 'Export song as WAV…', hint: 'Ctrl+R', action: () => BF.io.exportWav('song') },
    { label: 'Export current pattern as WAV…', action: () => BF.io.exportWav('pattern') },
    { label: 'Export stems (one WAV per insert)…', action: () => BF.io.exportStems() },
  ]));
  $('menuEdit').addEventListener('click', (e) => BF.ui.menuAt(e.currentTarget, [
    { label: 'Undo', hint: 'Ctrl+Z', disabled: !BF.canUndo(), action: () => BF.undo() },
    { label: 'Redo', hint: 'Ctrl+Shift+Z', disabled: !BF.canRedo(), action: () => BF.redo() },
    '-',
    { label: 'Rename project…', action: () => { const n = BF.ui.prompt('Project name', BF.project.name); if (n) BF.commit((p) => { p.name = n; }); } },
    { label: 'Song length (bars)…', action: () => { const n = BF.ui.prompt('Minimum song length in bars', String(BF.project.songBars)); if (n) BF.commit((p) => { p.songBars = Math.round(BF.clamp(n, 1, 512, p.songBars)); }); } },
  ]));
  $('menuView').addEventListener('click', (e) => BF.ui.menuAt(e.currentTarget, [
    { label: 'Playlist', hint: 'F5', checked: W.isOpen('playlist'), action: () => W.toggle('playlist') },
    { label: 'Channel rack', hint: 'F6', checked: W.isOpen('rack'), action: () => W.toggle('rack') },
    { label: 'Piano roll', hint: 'F7', checked: W.isOpen('piano'), action: () => W.toggle('piano') },
    { label: 'Mixer', hint: 'F9', checked: W.isOpen('mixer'), action: () => W.toggle('mixer') },
    { label: 'Browser', hint: 'F8', checked: W.isOpen('browser'), action: () => W.toggle('browser') },
    { label: 'Plugin editor', checked: W.isOpen('editor'), action: () => W.toggle('editor') },
    '-',
    { label: 'Reset window layout', action: () => W.resetLayout() },
  ]));
  $('menuHelp').addEventListener('click', (e) => BF.ui.menuAt(e.currentTarget, [
    { label: 'Keyboard shortcuts', hint: 'F1', action: showHelp },
    { label: 'About BeatForge', action: () => BF.ui.toast('BeatForge 2: free, open source (MIT). Made by GRBN Studios.') },
  ]));

  const SHORTCUTS = [
    ['Space', 'Play / pause'], ['L', 'Switch Pattern / Song mode'], ['F5 · F6 · F7 · F8 · F9', 'Playlist · Channel rack · Piano roll · Browser · Mixer'],
    ['Numpad + / −', 'Next / previous pattern'], ['Ctrl+N · Ctrl+O · Ctrl+S', 'New · Open · Save'], ['Ctrl+Shift+S', 'Save as'], ['Ctrl+R', 'Export WAV'],
    ['Ctrl+Z · Ctrl+Alt+Z', 'Undo'], ['Ctrl+Shift+Z · Ctrl+Y', 'Redo'],
    ['P · B · D · E · C', 'Draw · Paint · Delete · Select · Slice (playlist / piano roll)'], ['Right-click', 'Delete a note, clip or step'],
    ['Ctrl+drag', 'Box select'], ['Shift+drag', 'Duplicate while dragging'], ['Shift+drag clip edge', 'Stretch audio clip'],
    ['Ctrl+A · Ctrl+D', 'Select all · none (piano roll)'], ['Ctrl+C · Ctrl+X · Ctrl+V', 'Copy · cut · paste notes'], ['Ctrl+B', 'Duplicate selected clips'],
    ['↑ ↓ / Ctrl+↑ ↓', 'Transpose a semitone / an octave'], ['← →', 'Move selection by the snap'], ['Ctrl+Q', 'Quantize notes'],
    ['Ctrl+wheel', 'Zoom'], ['Double-click a knob', 'Reset it'], ['F1', 'This list'],
  ];
  function showHelp() {
    const b = $('helpBody');
    b.textContent = '';
    const tbl = document.createElement('table');
    SHORTCUTS.forEach(([k, d]) => { const tr = tbl.insertRow(); tr.insertCell().innerHTML = ''; tr.cells[0].append(Object.assign(document.createElement('kbd'), { textContent: k })); tr.insertCell().textContent = d; });
    b.append(tbl);
    $('helpDlg').showModal();
  }

  // ---------- keyboard shortcuts (FL-style) ----------
  window.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    const typing = el && ((el.tagName === 'INPUT' && /^(number|text|search)$/.test(el.type)) || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
    if ($('helpDlg').open) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') { e.preventDefault(); if (e.shiftKey) BF.io.saveAs(); else BF.io.save(); return; }
    if (mod && k === 'o') { e.preventDefault(); openFile(); return; }
    if (mod && k === 'n') { e.preventDefault(); newProject(); return; }
    if (mod && k === 'r') { e.preventDefault(); BF.io.exportWav('song'); return; }
    if (['F5', 'F6', 'F7', 'F8', 'F9'].includes(e.key)) { e.preventDefault(); W.toggle({ F5: 'playlist', F6: 'rack', F7: 'piano', F8: 'browser', F9: 'mixer' }[e.key]); return; }
    if (e.key === 'F1') { e.preventDefault(); showHelp(); return; }
    if (typing) return;
    if (BF.piano.typing && !mod && BF.piano.typingKey(e, true)) return;
    if (mod && k === 'z' && e.shiftKey) { e.preventDefault(); BF.redo(); return; }
    if (mod && k === 'y') { e.preventDefault(); BF.redo(); return; }
    if (mod && k === 'z') { e.preventDefault(); BF.undo(); return; }
    if (e.code === 'Space') { e.preventDefault(); BF.transport.toggle(); return; }
    if (!mod && k === 'l') { e.preventDefault(); BF.transport.setMode(BF.transport.mode === 'song' ? 'pattern' : 'song'); return; }
    if (e.code === 'NumpadAdd' || (e.key === '+' && !mod)) { e.preventDefault(); BF.patterns.step(1); return; }
    if (e.code === 'NumpadSubtract' || (e.key === '-' && !mod)) { e.preventDefault(); BF.patterns.step(-1); return; }
  });
  // stop Space from also "clicking" a focused button
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && document.activeElement?.tagName === 'BUTTON') e.preventDefault(); }, true);

  // dropping files outside a window: projects open, audio goes to the playlist
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (/\.json$/i.test(files[0].name)) BF.io.open(files[0]);
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
    } else {
      BF.rack.light(-1);
      BF.playlist.drawPlayhead(T.mode === 'song' ? T.startBeat : 0);
    }
    if (W.isOpen('mixer')) BF.mixer.meters();
    const b = Math.max(0, beat);
    $('posText').textContent = `${Math.floor(b / 4) + 1}.${(Math.floor(b) % 4) + 1}.${(Math.floor(b * 4) % 4) + 1}`;
    requestAnimationFrame(frame);
  }

  BF.emit('load');
  requestAnimationFrame(frame);
  BF.ui.toast('Press Space to play the demo. F6 channel rack, F7 piano roll, F9 mixer, F1 shortcuts.');
})();
