/* app.js: boot, top-bar wiring, keyboard shortcuts and the playhead animation. */
(function () {
  'use strict';
  const BF = window.BF;
  const $ = (id) => document.getElementById(id);

  // ---------- small UI helpers ----------
  let toastTimer = null;
  BF.ui = {
    toast(msg, error = false) {
      const t = $('toast');
      t.textContent = msg;
      t.classList.toggle('error', !!error);
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.hidden = true; }, error ? 7000 : 3500);
    },
    busy(msg) {
      $('busy').hidden = !msg;
      if (msg) $('busyText').textContent = msg;
    },
  };

  // ---------- build ----------
  BF.sequencer.build($('sequencer'));
  BF.mixer.build($('mixer'));
  BF.playlist.build($('playlist'));

  function syncTop() {
    const p = BF.project;
    if (document.activeElement !== $('bpm')) $('bpm').value = p.bpm;
    if (document.activeElement !== $('songBars')) $('songBars').value = p.songBars;
    $('undoBtn').disabled = !BF.canUndo();
    $('redoBtn').disabled = !BF.canRedo();
    const T = BF.transport;
    $('playBtn').textContent = T.playing ? '■ Stop' : '▶ Play';
    $('playBtn').setAttribute('aria-pressed', String(T.playing));
    [['modePattern', 'pattern'], ['modeSong', 'song']].forEach(([id, m]) => {
      $(id).classList.toggle('on', T.mode === m);
      $(id).setAttribute('aria-checked', String(T.mode === m));
    });
    document.title = `${p.name} · BeatForge`;
  }

  BF.onChange((reason) => {
    const force = reason === 'undo' || reason === 'redo' || reason === 'load';
    if (BF.audio.ctx) BF.audio.updateGraph(BF.audio.graph, BF.project, BF.audio.ctx);
    BF.sequencer.sync();
    BF.mixer.sync(force);
    if (reason !== 'mix') BF.playlist.render();
    syncTop();
  });
  BF.emit('load');

  // ---------- transport ----------
  $('playBtn').addEventListener('click', () => BF.transport.toggle());
  $('modePattern').addEventListener('click', () => BF.transport.setMode('pattern'));
  $('modeSong').addEventListener('click', () => BF.transport.setMode('song'));
  $('bpm').addEventListener('change', () => {
    const v = Math.round(BF.clamp($('bpm').value, 60, 200, BF.project.bpm));
    $('bpm').value = v;
    if (v !== BF.project.bpm) BF.commit((p) => { p.bpm = v; }, 'bpm');
  });
  $('songBars').addEventListener('change', () => {
    const v = Math.round(BF.clamp($('songBars').value, 1, 64, BF.project.songBars));
    $('songBars').value = v;
    if (v !== BF.project.songBars) BF.commit((p) => { p.songBars = v; p.patternBars = BF.resizeBars(p.patternBars, v); });
  });

  // ---------- project buttons ----------
  $('undoBtn').addEventListener('click', () => BF.undo());
  $('redoBtn').addEventListener('click', () => BF.redo());
  $('newBtn').addEventListener('click', () => {
    if (!confirm('Start a new empty project? Unsaved changes are lost.')) return;
    BF.transport.stop();
    BF.audio.buffers.clear();
    BF.audio.stretched.clear();
    BF.playlist.selected = null;
    BF.transport.startBeat = 0;
    BF.replaceProject(BF.newProject(false));
  });
  $('saveBtn').addEventListener('click', () => BF.io.save());
  $('openBtn').addEventListener('click', () => $('openInput').click());
  $('openInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) BF.io.open(f);
  });
  $('exportBtn').addEventListener('click', () => { BF.transport.stop(); BF.io.exportWav(); });
  $('clearPattern').addEventListener('click', () => BF.commit((p) => p.tracks.forEach((t) => t.steps.fill(false))));
  $('importBtn').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const p = BF.project;
    const end = p.clips.filter((c) => c.lane === 0).reduce((m, c) => Math.max(m, c.startBeat + (BF.audio.clipSeconds(c) * p.bpm) / 60), 0);
    BF.io.importFiles(files, 0, Math.ceil(end / 0.25) * 0.25);
  });

  // clip panel
  const clip = () => BF.project.clips.find((c) => c.id === BF.playlist.selected);
  $('clipSpeed').addEventListener('input', () => {
    const c = clip();
    if (!c) return;
    const v = BF.clamp($('clipSpeed').value, 50, 200, 100) / 100;
    $('clipSpeedVal').textContent = `${Math.round(v * 100)}%`;
    BF.commit((p) => { const k = p.clips.find((x) => x.id === c.id); if (k) k.speed = v; }, `speed-${c.id}`);
  });
  $('clipSpeedReset').addEventListener('click', () => {
    const c = clip();
    if (c) BF.commit((p) => { const k = p.clips.find((x) => x.id === c.id); if (k) k.speed = 1; });
  });
  $('clipPreview').addEventListener('click', () => {
    const c = clip();
    if (!c) return;
    BF.ui.busy('Preparing preview…');
    setTimeout(() => { try { BF.audio.preview(c); } finally { BF.ui.busy(null); } }, 10);
  });
  $('clipDelete').addEventListener('click', () => BF.playlist.deleteSelected());

  // Dropping a file outside a lane should not navigate away from the app.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && /\.json$/i.test(f.name)) BF.io.open(f);
    else if (f) BF.ui.toast('Drop audio files on one of the playlist lanes.');
  });

  // ---------- keyboard shortcuts ----------
  window.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    const typing = el && (el.tagName === 'INPUT' && /^(number|text|search)$/.test(el.type) || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') { e.preventDefault(); BF.io.save(); return; }
    if (mod && k === 'o') { e.preventDefault(); $('openInput').click(); return; }
    if (mod && k === 'e') { e.preventDefault(); $('exportBtn').click(); return; }
    if (typing) return;
    if (mod && k === 'z' && e.shiftKey) { e.preventDefault(); BF.redo(); return; }
    if (mod && k === 'y') { e.preventDefault(); BF.redo(); return; }
    if (mod && k === 'z') { e.preventDefault(); BF.undo(); return; }
    // Space plays/stops, unless focus is on a button that Space would press
    if (e.code === 'Space' && !(el && el.tagName === 'BUTTON' && el !== $('playBtn'))) {
      e.preventDefault();
      BF.transport.toggle();
    }
  });
  // Space on the Play button itself: handled above; stop the native click from double-toggling.
  $('playBtn').addEventListener('keydown', (e) => { if (e.code === 'Space') e.preventDefault(); });
  $('playBtn').addEventListener('keyup', (e) => { if (e.code === 'Space') e.preventDefault(); });

  // ---------- playhead / position display ----------
  function frame() {
    const T = BF.transport;
    const beat = T.position();
    if (T.playing && BF.audio.ctx.currentTime >= T.anchorTime) {
      const step = Math.floor(beat * 4) % 16;
      BF.sequencer.light(step);
      if (T.mode === 'song') { BF.playlist.drawPlayhead(beat); BF.playlist.follow(beat); }
      else BF.playlist.drawPlayhead(beat % 4);
    } else {
      BF.sequencer.light(-1);
      BF.playlist.drawPlayhead(T.playing ? T.anchorBeat : T.mode === 'song' ? T.startBeat : 0);
    }
    const b = Math.max(0, T.playing ? beat : T.position());
    $('posText').textContent = `${Math.floor(b / 4) + 1}.${(Math.floor(b) % 4) + 1}.${(Math.floor(b * 4) % 4) + 1}`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Leave a hint for first-time users.
  BF.ui.toast('Press Space or ▶ Play to hear the demo beat. Click the squares to change it.');
})();
