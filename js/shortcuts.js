/* shortcuts.js: keyboard shortcuts, matched to the classic pattern-DAW layout (from public manuals; own code).
 * Also: the plugin picker (F8), settings (F10), project info (F11) and MIDI file export (Ctrl+Shift+M). */
(function () {
  'use strict';
  const BF = window.BF;
  const K = (BF.keys = {});

  K.list = [
    ['Transport', [
      ['Space', 'Start / stop'], ['Ctrl+Space', 'Start / pause (keeps the position)'], ['L', 'Switch Pattern / Song mode'],
      ['R', 'Record on/off'], ['Ctrl+M', 'Metronome on/off'], ['Ctrl+H', 'Stop all sound (panic)'],
      ['Numpad + / −', 'Next / previous pattern'], ['Numpad 1–9', 'Pattern 1–9'], ['F4 · Ctrl+F4', 'Next empty pattern (and name it) · without naming'],
      ['Ctrl+E', 'Step edit on/off'], ['Ctrl+P', 'Recording precount on/off'],
      ['Numpad * / /', 'Next / previous bar (song)'], ['Alt+T', 'Add a time marker'], ['Alt+Numpad * / /', 'Jump to the next / previous marker'],
    ]],
    ['Windows', [
      ['F5', 'Playlist'], ['F6', 'Channel rack'], ['F7', 'Piano roll'], ['F8', 'Plugin picker'], ['Alt+F8', 'Browser'], ['F9', 'Mixer'],
      ['F10', 'Settings (MIDI, recording, updates)'], ['F11', 'Project info'], ['F12', 'Close all windows'], ['Ctrl+Shift+H', 'Arrange windows'],
      ['Tab', 'Next window'], ['Esc', 'Close the focused window'], ['F1', 'This list'],
    ]],
    ['File', [
      ['Ctrl+N', 'New project'], ['Ctrl+O', 'Open'], ['Ctrl+S', 'Save'], ['Ctrl+Shift+S', 'Save as'],
      ['Ctrl+R', 'Export WAV'], ['Ctrl+Shift+R', 'Export MP3'], ['Ctrl+Shift+M', 'Export MIDI file'], ['Ctrl+M (piano roll)', 'Import a MIDI file'],
    ]],
    ['Editing', [
      ['Ctrl+Z', 'Undo / redo the last change (press again to redo)'], ['Ctrl+Alt+Z', 'Undo (step back)'], ['Ctrl+Shift+Z / Ctrl+Y', 'Redo (step forward)'],
      ['F2', 'Rename (channel, insert or pattern)'], ['Ctrl+T', 'Typing keyboard to piano'], ['Ctrl+F', 'Search the browser'],
      ['Backspace', 'Snap on / off (piano roll, playlist)'], ['Page Up / Down', 'Zoom in / out'],
    ]],
    ['Channel rack', [
      ['↑ ↓', 'Select channel'], ['Alt+↑ ↓', 'Move channel up / down'], ['1–9, 0', 'Mute channel 1–10'], ['Ctrl+1–9, 0', 'Solo channel 1–10'],
      ['Alt+C', 'Clone channel'], ['Alt+G', 'Put the channel in a group'], ['Page Up / Down', 'Switch channel group'], ['Alt+Z · Alt+U', 'Zip · unzip channel'], ['Alt+Del', 'Delete channel'], ['Ctrl+C · X · V', 'Copy · cut · paste the channel\'s steps'],
      ['Ctrl+Shift+← →', 'Shift steps left / right'], ['Ctrl+L', 'Route to a free mixer insert'], ['Ctrl+Enter', 'Go to the playlist'],
    ]],
    ['Mixer', [
      ['S', 'Solo the selected insert'], ['Alt+← →', 'Move the insert left / right'], ['Ctrl+L', 'Route the selected channel to this insert'], ['Alt+L', 'Select the channel routed here'], ['Alt+R', 'Export stems'], ['F2', 'Rename insert'],
    ]],
    ['Piano roll', [
      ['P · B · D · T · C · E', 'Draw · Paint · Delete · Mute · Slice · Select'], ['Right-click', 'Delete'], ['Del', 'Delete selected'],
      ['Ctrl+A · Ctrl+D', 'Select all · deselect'], ['Shift+I', 'Invert selection'], ['Shift+R · Shift+M', 'Select notes · chords at random'], ['Shift+C', 'Select notes with the same pitch'],
      ['Ctrl+C · X · V', 'Copy · cut · paste'], ['Ctrl+B', 'Duplicate selection'], ['↑ ↓ · Ctrl+↑ ↓', 'Transpose a semitone · an octave'],
      ['← → · Alt+← →', 'Move by the snap · nudge'], ['Ctrl+Q · Alt+Q', 'Quick quantize · quantize'], ['Ctrl+L', 'Quick legato'],
      ['Alt+A · Alt+S · Alt+R · Alt+F', 'Arpeggiate · strum · randomize · flam'], ['Alt+U / Ctrl+U · Alt+G / Ctrl+G · Alt+Y', 'Chop · glue · flip'],
      ['Alt+M · Alt+Shift+M', 'Mute · unmute selected notes'], ['Shift+D', 'Discard note lengths'], ['Alt+V', 'Ghost notes on/off'],
      ['S · O', 'Slide notes · portamento (for new notes, and the selected ones)'], ['F · Shift+F', 'Next / previous event lane (velocity, pan, fine pitch)'],
      ['Double-click a note', 'Note properties'], ['Alt+C · Shift+C', 'Colour selected notes · select by colour'],
      ['G · K', 'Channel above · below'], ['H · J', 'Channel above · below with notes'], ['Shift+4', 'Zoom to the whole pattern'],
    ]],
    ['Playlist', [
      ['P · B · D · T · C · E', 'Draw · Paint · Delete · Mute · Slice · Select'], ['Ctrl+drag', 'Box select'], ['Shift+drag', 'Duplicate while dragging'],
      ['Shift+drag clip edge', 'Stretch audio'], ['Ctrl+A · Ctrl+D · Shift+I', 'Select all · deselect · invert'], ['Shift+C', 'Select all clips of the same source'],
      ['Ctrl+C · X · V', 'Copy · cut · paste (at the song position)'], ['Ctrl+B', 'Duplicate selection'], ['← → · ↑ ↓', 'Move by the snap · move to another track'],
      ['Alt+M · Alt+Shift+M', 'Mute · unmute selected clips'], ['Shift+Q', 'Quantize clip starts'], ['Shift+M', 'Switch the audio stretch mode'],
      ['7 · 8', 'Audio pitch down · up'], ['9', 'Reverse audio clips'], ['Insert', 'Slice selected clips at the song position'], ['Home', 'Back to the start'],
      ['Alt+P', 'Plugin picker'], ['Ctrl+Insert · Ctrl+Delete', 'Insert / delete time at the loop region'], ['Ctrl+wheel', 'Zoom'],
    ]],
    ['Browser', [['Click · double-click', 'Hear it · add it'], ['↑ ↓ · Shift+↑ ↓', 'Move · move and hear each sound'], ['Enter', 'Add it']]],
  ];

  // ---------- Ctrl+Z works like a toggle: undo, then the same key redoes ----------
  let lastToggle = null; // 'undo' | 'redo'
  BF.onChange((r) => { if (r !== 'undo' && r !== 'redo' && r !== 'view' && r !== 'select' && r !== 'pattern' && r !== 'transport' && r !== 'windows' && r !== 'midi') lastToggle = null; });
  function undoToggle() {
    if (lastToggle === 'undo' && BF.canRedo()) { BF.redo(); lastToggle = 'redo'; }
    else if (BF.undo()) lastToggle = 'undo';
  }

  async function rename() {
    const W = BF.win, p = BF.project;
    if (W.focused === 'mixer') {
      const i = BF.mixer.selected, n = await BF.ui.prompt('Insert name', p.mixer[i].name);
      if (n) BF.commit((q) => { q.mixer[i].name = n; });
    } else if (W.focused === 'rack' && BF.channel()) {
      const ch = BF.channel(), n = await BF.ui.prompt('Channel name', ch.name);
      if (n) BF.commit((q) => { q.channels.find((c) => c.id === ch.id).name = n; });
    } else BF.patterns.rename(p.currentPattern);
  }

  function routeChannel(toSelectedInsert) {
    const ch = BF.channel();
    if (!ch) return;
    const ins = toSelectedInsert ? BF.mixer.selected : BF.rack.freeInsert(BF.project);
    if (!ins) { BF.ui.toast('No free mixer insert left.', true); return; }
    BF.commit((q) => { const c = q.channels.find((x) => x.id === ch.id); c.insert = ins; if (q.mixer[ins].name.startsWith('Insert ')) q.mixer[ins].name = c.name; });
    BF.mixer.selected = ins;
    BF.ui.toast(`${ch.name} → mixer insert ${ins}`);
  }

  let stepClip = null;
  function rackKeys(e, k, mod) {
    const p = BF.project;
    const i = p.channels.findIndex((c) => c.id === p.selectedChannel);
    const sel = p.channels[i];
    // 1..9, 0: mute channel 1..10;  Ctrl+1..9, 0: solo it (again: unsolo)
    const dig = /^Digit(\d)$/.exec(e.code);
    if (dig && !e.altKey && !e.shiftKey) {
      const n = dig[1] === '0' ? 9 : +dig[1] - 1;
      const c = p.channels[n];
      if (!c) return true;
      if (mod) {
        const solo = !c.mute && p.channels.every((x) => x === c || x.mute);
        BF.commit((q) => q.channels.forEach((x) => { x.mute = solo ? false : x.id !== c.id; }));
        BF.ui.toast(solo ? 'All channels on' : `Solo: ${c.name}`);
      } else BF.commit((q) => { const x = q.channels[n]; x.mute = !x.mute; });
      return true;
    }
    if (mod && !e.shiftKey && !e.altKey && sel && ['c', 'x', 'v'].includes(k)) { // channel steps and notes of the current pattern
      const pt = BF.pattern();
      if (k === 'v') {
        if (!stepClip) return true;
        BF.commit(() => { const q = BF.pattern(); q.steps[sel.id] = stepClip.steps.slice(0, q.length); if (stepClip.notes.length) q.notes[sel.id] = stepClip.notes.map((n) => ({ ...n, id: BF.uid('n') })); else delete q.notes[sel.id]; });
        BF.ui.toast(`Pasted into ${sel.name}`);
      } else {
        stepClip = { steps: (pt.steps[sel.id] || []).slice(), notes: (pt.notes[sel.id] || []).map((n) => ({ ...n })) };
        if (k === 'x') BF.commit(() => { const q = BF.pattern(); delete q.steps[sel.id]; delete q.notes[sel.id]; });
        BF.ui.toast(`${k === 'x' ? 'Cut' : 'Copied'} the steps of ${sel.name}`);
      }
      return true;
    }
    if (mod && e.shiftKey && sel && (k === 'arrowleft' || k === 'arrowright')) { // shift steps (and notes) one step, wrapping around
      const d = k === 'arrowleft' ? -1 : 1;
      BF.commit(() => {
        const q = BF.pattern(), L = q.length;
        const st = q.steps[sel.id];
        if (st) q.steps[sel.id] = Array.from({ length: L }, (_, j) => !!st[((j - d) % L + L) % L]);
        (q.notes[sel.id] || []).forEach((n) => { n.start = ((n.start + d) % L + L) % L; });
      }, `shift-${sel.id}`);
      return true;
    }
    if (mod && (k === 'enter')) { BF.win.toggle('playlist', true); return true; }
    if (mod) return false;
    if (e.altKey && k === 'g' && sel) { // group the selected channel (empty name = no group)
      BF.ui.prompt('Channel group (empty = none)', sel.group || 'Drums').then((n) => {
        if (n === null) return;
        BF.commit((q) => { const c = q.channels.find((x) => x.id === sel.id); if (!c) return; if (n) c.group = n.slice(0, 20); else delete c.group; });
      });
      return true;
    }
    if (e.altKey && (k === 'z' || k === 'u') && sel) { BF.commit((q) => { if (k === 'z') q.channels[i].zip = true; else delete q.channels[i].zip; }); return true; }
    if (k === 'pageup' || k === 'pagedown') { // next / previous channel group
      const gs = ['', ...new Set(p.channels.map((c) => c.group).filter(Boolean))];
      const at = gs.indexOf(BF.rack.group || '');
      BF.rack.group = gs[(at + (k === 'pageup' ? 1 : gs.length - 1)) % gs.length];
      BF.rack.render();
      BF.ui.toast(BF.rack.group ? `Group: ${BF.rack.group}` : 'All channels');
      return true;
    }
    if (e.altKey && k === 'c' && sel) { // clone channel
      BF.commit((q) => {
        const c = JSON.parse(JSON.stringify(q.channels[i]));
        c.id = BF.uid('ch'); c.name = `${sel.name} #2`;
        q.channels.splice(i + 1, 0, c);
        q.patterns.forEach((pt) => { if (pt.steps[sel.id]) pt.steps[c.id] = pt.steps[sel.id].slice(); if (pt.notes[sel.id]) pt.notes[c.id] = pt.notes[sel.id].map((n) => ({ ...n, id: BF.uid('n') })); });
        q.selectedChannel = c.id;
      });
      return true;
    }
    if (e.altKey && (k === 'arrowup' || k === 'arrowdown')) {
      const j = i + (k === 'arrowup' ? -1 : 1);
      if (i < 0 || j < 0 || j >= p.channels.length) return true;
      BF.commit((q) => { [q.channels[i], q.channels[j]] = [q.channels[j], q.channels[i]]; });
      return true;
    }
    if (k === 'arrowup' || k === 'arrowdown') {
      const j = Math.min(p.channels.length - 1, Math.max(0, i + (k === 'arrowup' ? -1 : 1)));
      if (p.channels[j]) BF.setView((q) => { q.selectedChannel = q.channels[j].id; }, 'select');
      return true;
    }
    if (e.altKey && (k === 'delete' || k === 'backspace') && i >= 0) {
      const id = p.selectedChannel;
      BF.commit((q) => {
        q.channels = q.channels.filter((c) => c.id !== id);
        q.patterns.forEach((pt) => { delete pt.steps[id]; delete pt.notes[id]; });
        q.selectedChannel = q.channels[Math.max(0, i - 1)]?.id || null;
      });
      return true;
    }
    return false;
  }

  function mixerKeys(e, k, mod) {
    const p = BF.project, i = BF.mixer.selected;
    if (!mod && !e.altKey && !e.shiftKey && k === 's' && i > 0) { // solo the selected insert (again: unsolo)
      BF.commit((q) => { const on = !q.mixer[i].solo; q.mixer.forEach((m, j) => { m.solo = on && j === i; }); });
      return true;
    }
    if (e.altKey && !mod && k === 'l') { // select the channel(s) routed to this insert
      const c = p.channels.find((x) => x.insert === i);
      if (c) { BF.setView((q) => { q.selectedChannel = c.id; }, 'select'); BF.ui.toast(`${p.channels.filter((x) => x.insert === i).map((x) => x.name).join(', ')}`); }
      else BF.ui.toast('No channel is routed to this insert.');
      return true;
    }
    if (e.altKey && !mod && k === 'r') { BF.io.exportStems(); return true; }
    if (e.altKey && !mod && (k === 'arrowleft' || k === 'arrowright') && i > 0) { // move the insert left / right
      const j = i + (k === 'arrowleft' ? -1 : 1);
      if (j < 1 || j > BF.INSERTS) return true;
      swapInserts(i, j);
      BF.mixer.selected = j;
      return true;
    }
    return false;
  }

  /** Swap mixer inserts a and b, and everything that points at them (channels, tracks, sends, sidechains, automation). */
  function swapInserts(a, b) {
    const sw = (x) => (x === a ? b : x === b ? a : x);
    BF.commit((q) => {
      q.channels.forEach((c) => { c.insert = sw(c.insert); });
      q.tracks.forEach((t) => { t.insert = sw(t.insert || 0); });
      q.mixer.forEach((m) => {
        (m.route?.sends || []).forEach((s) => { s.to = sw(s.to); });
        m.fx.forEach((f) => { if (f.plugin === 'ducker' && f.params.source !== '0') f.params.source = String(sw(+f.params.source)); });
      });
      q.clips.forEach((c) => { if (c.kind === 'auto' && Number.isFinite(c.target.insert)) c.target.insert = sw(c.target.insert); });
      [q.mixer[a], q.mixer[b]] = [q.mixer[b], q.mixer[a]];
    });
  }
  K.swapInserts = swapInserts;

  // ---------- time markers (Alt+T adds one at the song position; Alt+* / Alt+/ jump) ----------
  async function addMarker() {
    const T = BF.transport;
    const at = Math.round((T.playing ? T.position() : T.startBeat || 0) * 4) / 4;
    const name = await BF.ui.prompt('Marker name', `Marker ${(BF.project.markers || []).length + 1}`);
    if (!name) return;
    BF.commit((q) => { q.markers = (q.markers || []).filter((m) => Math.abs(m.beat - at) > 0.01).concat({ beat: at, name: name.slice(0, 40) }).sort((a, b) => a.beat - b.beat); });
  }
  function jumpMarker(dir) {
    const T = BF.transport, ms = BF.project.markers || [];
    const now = T.playing ? T.position() : T.startBeat || 0;
    const m = dir > 0 ? ms.find((x) => x.beat > now + 0.01) : [...ms].reverse().find((x) => x.beat < now - (T.playing ? 1 : 0.01));
    if (!m) return;
    if (T.playing) { T.stop(); T.startBeat = m.beat; T.play(); } else { T.startBeat = m.beat; BF.emit('transport'); }
  }
  K.addMarker = addMarker;

  /** Playlist: insert or delete time at the loop region. */
  function shiftTime(insert) {
    const L = BF.transport.loop;
    if (!L) { BF.ui.toast('Drag on the playlist ruler to select a time range first.'); return; }
    const len = L.end - L.start;
    BF.commit((q) => {
      if (insert) q.clips.forEach((c) => { if (c.start >= L.start - 1e-9) c.start += len; });
      else {
        q.clips = q.clips.filter((c) => !(c.start >= L.start - 1e-9 && c.start < L.end - 1e-9));
        q.clips.forEach((c) => { if (c.start >= L.end - 1e-9) c.start -= len; });
      }
    });
    BF.ui.toast(insert ? `Inserted ${len} beats of space` : `Deleted ${len} beats`);
  }

  function panic() {
    BF.transport.stop();
    BF.live.allOff();
    BF.audio.stopPreview();
    const g = BF.audio.graph;
    if (g) {
      const now = g.ctx.currentTime;
      g.inserts.forEach((ins) => { ins.preview.gain.cancelScheduledValues(now); ins.preview.gain.setValueAtTime(0, now); ins.preview.gain.setValueAtTime(1, now + 0.3); });
    }
    BF.ui.toast('All sound stopped.');
  }

  function cycleWindows() {
    const W = BF.win;
    const open = [...W.all.keys()].filter((id) => W.isOpen(id));
    if (!open.length) return;
    const i = open.indexOf(W.focused);
    W.front(open[(i + 1) % open.length]);
  }

  /** The keydown handler. ctx = { newProject, openFile, toggleRec, showHelp }. Returns nothing. */
  K.handle = function (e, ctx) {
    const el = document.activeElement;
    const typing = el && ((el.tagName === 'INPUT' && /^(number|text|search)$/.test(el.type)) || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const W = BF.win;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    // ---- work everywhere, even in text boxes ----
    if (mod && !e.shiftKey && k === 's') { stop(); BF.io.save(); return; }
    if (mod && e.shiftKey && k === 's') { stop(); BF.io.saveAs(); return; }
    if (mod && k === 'o') { stop(); ctx.openFile(); return; }
    if (mod && k === 'n') { stop(); ctx.newProject(); return; }
    if (mod && !e.shiftKey && k === 'r') { stop(); BF.io.exportWav('song'); return; }
    if (mod && e.shiftKey && k === 'r') { stop(); BF.exporter.export('mp3'); return; }
    if (mod && e.shiftKey && k === 'm') { stop(); K.exportMidi(); return; }
    if (mod && !e.shiftKey && k === 'h') { stop(); panic(); return; }
    if (mod && k === 'f') { stop(); BF.browser.toggle(true); document.querySelector('.br-head input')?.focus(); return; }
    if (e.key === 'F8') { stop(); if (e.altKey) W.toggle('browser'); else W.toggle('picker'); return; }
    if (['F5', 'F6', 'F7', 'F9'].includes(e.key)) { stop(); W.toggle({ F5: 'playlist', F6: 'rack', F7: 'piano', F9: 'mixer' }[e.key]); return; }
    if (e.key === 'F1') { stop(); ctx.showHelp(); return; }
    if (e.key === 'F2') { stop(); rename(); return; }
    if (e.key === 'F4') { stop(); BF.patterns.add(); if (!mod) BF.patterns.rename(BF.project.currentPattern); return; }
    if (e.key === 'F10') { stop(); K.settings(); return; }
    if (e.key === 'F11') { stop(); K.projectInfo(); return; }
    if (e.key === 'F12') { stop(); [...W.all.keys()].forEach((id) => { if (id !== 'playlist') W.toggle(id, false); }); return; }
    if (typing) return;
    if (BF.piano.typing && !mod && !e.altKey && BF.piano.typingKey(e, true)) return;
    if (mod && k === 't') { stop(); document.querySelector('.piano .pr-tools button[title*="computer keyboard"]')?.click(); return; }
    if (mod && !e.shiftKey && k === 'e') { stop(); BF.rec.stepEdit = !BF.rec.stepEdit; BF.ui.toast(BF.rec.stepEdit ? 'Step edit on: notes you play (typing or MIDI keyboard, while stopped) are written at the yellow cursor in the piano roll and the cursor moves on. Click the piano roll ruler to move it.' : 'Step edit off'); BF.piano.draw(); BF.emit('transport'); return; }
    if (mod && !e.shiftKey && k === 'p') { stop(); BF.rec.precount = !BF.rec.precount; BF.ui.toast(`Precount ${BF.rec.precount ? 'on: one bar of clicks before recording' : 'off'}`); BF.emit('transport'); return; }
    if (mod && k === 'm') { stop(); BF.recorder.metronome = !BF.recorder.metronome; BF.ui.toast(`Metronome ${BF.recorder.metronome ? 'on' : 'off'}`); BF.emit('transport'); return; }
    if (mod && e.altKey && k === 'z') { stop(); BF.undo(); lastToggle = null; return; }
    if (mod && e.shiftKey && k === 'z') { stop(); BF.redo(); lastToggle = null; return; }
    if (mod && k === 'y') { stop(); BF.redo(); lastToggle = null; return; }
    if (mod && k === 'z') { stop(); undoToggle(); return; }
    if (mod && k === 'l' && (W.focused === 'rack' || W.focused === 'mixer')) { stop(); routeChannel(W.focused === 'mixer'); return; }
    if (mod && W.focused === 'playlist' && (e.key === 'Insert' || e.key === 'Delete')) { stop(); shiftTime(e.key === 'Insert'); return; }
    if (e.code === 'Space') {
      stop();
      if (mod) { // start / pause: keep the song position
        if (BF.transport.playing) { if (BF.transport.mode === 'song') BF.transport.startBeat = BF.transport.position(); BF.transport.stop(); BF.emit('transport'); }
        else BF.transport.play();
      } else BF.transport.toggle();
      return;
    }
    // Tab cycles windows like a DAW, but only when no control has focus, so keyboard navigation keeps working
    if (e.key === 'Tab' && !mod && !e.altKey && !e.shiftKey && (!el || el === document.body)) { stop(); cycleWindows(); return; }
    if (e.key === 'Escape') { if (W.focused && W.focused !== 'playlist' && W.isOpen(W.focused)) { stop(); W.toggle(W.focused, false); } return; }
    if (W.focused === 'rack' && rackKeys(e, k, mod)) { stop(); return; }
    if (W.focused === 'mixer' && mixerKeys(e, k, mod)) { stop(); return; }
    // numpad 1..9: pattern 1..9;  numpad * and /: next / previous bar (song mode)
    const np = /^Numpad([1-9])$/.exec(e.code);
    if (np && !mod) { stop(); const pt = BF.project.patterns[+np[1] - 1]; if (pt) BF.setView((q) => { q.currentPattern = pt.id; }, 'pattern'); return; }
    if ((e.code === 'NumpadMultiply' || e.code === 'NumpadDivide') && !mod) {
      stop();
      if (e.altKey) { jumpMarker(e.code === 'NumpadMultiply' ? 1 : -1); return; }
      const T = BF.transport, d = e.code === 'NumpadMultiply' ? 4 : -4;
      const at = Math.max(0, Math.floor(((T.playing ? T.position() : T.startBeat || 0) + d) / 4) * 4);
      if (T.playing && T.mode === 'song') { T.stop(); T.startBeat = at; T.play(); } else { T.startBeat = at; BF.emit('transport'); }
      return;
    }
    if (mod && e.shiftKey && k === 'h') { stop(); W.resetLayout(); return; }
    if (e.altKey && !mod && k === 't') { stop(); addMarker(); return; }
    if (!mod && !e.altKey && k === 'r') { stop(); ctx.toggleRec(); return; }
    if (!mod && !e.altKey && k === 'l') { stop(); BF.transport.setMode(BF.transport.mode === 'song' ? 'pattern' : 'song'); return; }
    if (e.code === 'NumpadAdd' || (e.key === '+' && !mod)) { stop(); BF.patterns.step(1); return; }
    if (e.code === 'NumpadSubtract' || (e.key === '-' && !mod)) { stop(); BF.patterns.step(-1); return; }
  };

  // ---------- F8 plugin picker ----------
  K.buildPicker = function () {
    const root = document.createElement('div');
    root.className = 'picker';
    const render = () => {
      root.textContent = '';
      [['Instruments', 'instrument'], ['Effects', 'effect']].forEach(([title, kind]) => {
        const h = document.createElement('h3'); h.textContent = title; root.append(h);
        const grid = document.createElement('div'); grid.className = 'picker-grid';
        BF.plugins.list(kind).forEach((d) => {
          const t = document.createElement('div');
          t.className = 'picker-tile';
          t.setAttribute('role', 'button');
          t.tabIndex = 0;
          t.draggable = true;
          t.dataset.hint = kind === 'instrument' ? `${d.name}: click to add a channel, or drag it onto the channel rack` : `${d.name}: click to add it to the selected mixer insert, or drag it onto a mixer strip`;
          const ic = document.createElement('span'); ic.className = 'picker-ic'; ic.textContent = kind === 'instrument' ? '🎹' : '✨';
          const nm = document.createElement('span'); nm.textContent = d.name;
          t.append(ic, nm);
          const use = () => (kind === 'instrument' ? (d.id === 'sampler' ? BF.io.pickFiles((f) => BF.io.importToRack(f)) : BF.rack.addChannel(d.id, undefined, d.name)) : BF.browser.addEffect(BF.mixer.selected, d.id));
          t.addEventListener('click', use);
          t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); use(); } });
          t.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-beatforge', JSON.stringify(kind === 'instrument' ? { kind: 'instrument', plugin: d.id, name: d.name } : { kind: 'effect', plugin: d.id })); });
          grid.append(t);
        });
        root.append(grid);
      });
    };
    render();
    return root;
  };

  // ---------- dialogs ----------
  function dialog(title, build) {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    const h = document.createElement('h2'); h.textContent = title;
    const body = document.createElement('div');
    const close = document.createElement('button'); close.className = 'btn accent'; close.textContent = 'Close';
    close.addEventListener('click', () => d.close());
    const actions = document.createElement('div'); actions.className = 'dlg-actions'; actions.append(close);
    d.append(h, body, actions);
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    build(body);
    d.showModal();
  }
  const row = (label, ctl) => { const l = document.createElement('label'); l.className = 'set-row'; const s = document.createElement('span'); s.textContent = label; l.append(s, ctl); return l; };

  K.settings = function () {
    dialog('Settings', (b) => {
      const midi = document.createElement('div');
      midi.className = 'hint';
      midi.textContent = BF.live.devices.length ? `MIDI inputs: ${BF.live.devices.join(', ')}` : 'No MIDI keyboard found.';
      const scan = document.createElement('button'); scan.className = 'btn small'; scan.textContent = 'Find MIDI keyboards';
      scan.addEventListener('click', async () => { await BF.live.start(true); midi.textContent = BF.live.devices.length ? `MIDI inputs: ${BF.live.devices.join(', ')}` : 'No MIDI keyboard found.'; });
      const mode = document.createElement('select');
      [['notes', 'Notes only'], ['audio', 'Audio only (microphone / line in)'], ['both', 'Notes and audio']].forEach(([v, l]) => mode.add(new Option(l, v)));
      mode.value = BF.recorder.mode;
      mode.addEventListener('change', async () => {
        BF.recorder.mode = mode.value;
        if (mode.value !== 'notes') { try { await BF.recorder.getInput(); BF.ui.toast('Microphone ready.'); } catch (e) { BF.ui.toast(`Microphone not available: ${e.message || e}`, true); } }
      });
      const q = document.createElement('input'); q.type = 'checkbox'; q.checked = BF.rec.quantize;
      q.addEventListener('change', () => { BF.rec.quantize = q.checked; });
      const met = document.createElement('input'); met.type = 'checkbox'; met.checked = BF.recorder.metronome;
      met.addEventListener('change', () => { BF.recorder.metronome = met.checked; BF.emit('transport'); });
      const ctx = BF.audio.ensure();
      const lat = document.createElement('div'); lat.className = 'hint';
      lat.textContent = `Audio: ${ctx.sampleRate} Hz, latency about ${Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000)} ms.`;
      b.append(row('MIDI', scan), midi, row('Record', mode), row('Quantize recorded notes to 1/16', q), row('Metronome (Ctrl+M)', met), lat);
      if (BF.desktop && BF.desktop.available) {
        const au = document.createElement('input'); au.type = 'checkbox'; au.checked = BF.desktop.info?.settings?.autoUpdate !== false;
        au.addEventListener('change', async () => { BF.desktop.info.settings = await window.beatforgeDesktop.setAutoUpdate(au.checked); });
        const chk = document.createElement('button'); chk.className = 'btn small'; chk.textContent = 'Check now';
        chk.addEventListener('click', () => BF.desktop.check(true));
        b.append(row('Check for updates automatically', au), row(`Version ${window.BF_VERSION}`, chk));
      }
    });
  };

  K.projectInfo = function () {
    dialog('Project info', (b) => {
      const p = BF.project;
      const name = document.createElement('input'); name.type = 'text'; name.value = p.name; name.maxLength = 120;
      name.addEventListener('change', () => { const v = name.value.trim(); if (v) BF.commit((q) => { q.name = v; }); });
      const bars = document.createElement('input'); bars.type = 'number'; bars.min = 1; bars.max = 512; bars.value = p.songBars;
      bars.addEventListener('change', () => BF.commit((q) => { q.songBars = Math.round(BF.clamp(bars.value, 1, 512, q.songBars)); }));
      const stats = document.createElement('div'); stats.className = 'hint';
      const notes = p.patterns.reduce((a, pt) => a + Object.values(pt.notes).reduce((x, arr) => x + arr.length, 0), 0);
      stats.textContent = `${p.channels.length} channels · ${p.patterns.length} patterns · ${notes} notes · ${p.clips.length} playlist clips · ${Object.keys(p.samples).length} audio files · song ${(BF.songEndBeat() * 60 / p.bpm).toFixed(1)} s at ${p.bpm} BPM`;
      const ts = document.createElement('select'); ts.setAttribute('aria-label', 'Time signature');
      ['2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '3/8', '5/8', '6/8', '7/8', '9/8', '12/8'].forEach((x) => ts.add(new Option(x, x)));
      ts.value = `${p.timeSig.num}/${p.timeSig.den}`;
      if (!ts.value) { ts.add(new Option(`${p.timeSig.num}/${p.timeSig.den}`, `${p.timeSig.num}/${p.timeSig.den}`)); ts.value = `${p.timeSig.num}/${p.timeSig.den}`; }
      ts.addEventListener('change', () => { const [n, d] = ts.value.split('/').map(Number); BF.commit((q) => { q.timeSig = { num: n, den: d }; }); BF.playlist && BF.playlist.render && BF.playlist.render(); });
      b.append(row('Name', name), row('Time signature', ts), row('Minimum song length (bars)', bars), stats);
    });
  };

  // ---------- MIDI file export (Standard MIDI File, type 1) ----------
  K.exportMidi = function () {
    const p = BF.project;
    const PPQ = 96;
    const events = new Map(); // channel id -> [[tick, bytes]]
    const add = (chId, tick, bytes) => { if (!events.has(chId)) events.set(chId, []); events.get(chId).push([Math.round(tick), bytes]); };
    // drums use the General MIDI drum map, so other programs (and our importer) know which sound it is
    const GM = { kick: 36, rim: 37, snare: 38, clap: 39, tom: 45, hihat: 42, openhat: 46, crash: 49, cowbell: 56, perc: 60, bass808: 35 };
    const stepKey = (ch) => (ch.plugin === 'drum' ? GM[ch.params.sound] || 60 : 60);
    const noteKey = (ch, k) => (ch.plugin === 'drum' ? stepKey(ch) : k);
    const placePattern = (pt, atBeat, cutBeat) => {
      p.channels.forEach((ch) => {
        (pt.steps[ch.id] || []).forEach((on, i) => {
          if (!on || i >= pt.length || atBeat + i / 4 >= cutBeat) return;
          const t = (atBeat + i / 4) * PPQ;
          const key = stepKey(ch);
          add(ch.id, t, [0x90, key, 100]); add(ch.id, t + PPQ / 4 - 1, [0x80, key, 0]);
        });
        (pt.notes[ch.id] || []).forEach((n) => {
          if (n.mute || n.start >= pt.length || atBeat + n.start / 4 >= cutBeat) return;
          const t = (atBeat + n.start / 4) * PPQ;
          const key = noteKey(ch, n.key);
          add(ch.id, t, [0x90, key, Math.max(1, Math.round(n.vel * 127))]);
          add(ch.id, t + Math.max(1, (Math.min(n.len, (cutBeat - atBeat) * 4 - n.start) / 4) * PPQ), [0x80, key, 0]);
        });
      });
    };
    const song = p.clips.some((c) => c.kind === 'pattern' && !c.muted);
    if (song) p.clips.forEach((c) => { if (c.kind === 'pattern' && !c.muted && !p.tracks[c.track]?.mute) { const pt = p.patterns.find((x) => x.id === c.patternId); if (pt) placePattern(pt, c.start, c.start + c.len); } });
    else placePattern(BF.pattern(), 0, Infinity);
    const vlq = (n) => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
    const str = (s) => [...new TextEncoder().encode(s)];
    const chunk = (type, data) => [...str(type), (data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...data];
    const tracks = [];
    const tempo = Math.round(60000000 / p.bpm);
    tracks.push(chunk('MTrk', [0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255, 0, 0xff, 0x58, 4, 4, 2, 24, 8, 0, 0xff, 0x2f, 0]));
    let next = 0;
    const nextCh = () => { if (next % 16 === 9) next++; return next++ % 16; }; // channel 10 (index 9) is for drums
    p.channels.forEach((ch) => {
      const ev = events.get(ch.id);
      if (!ev) return;
      const c = ch.plugin === 'drum' ? 9 : nextCh();
      ev.sort((a, b) => a[0] - b[0] || (a[1][0] === 0x80 ? -1 : 1));
      const name = str(ch.name.slice(0, 60));
      const data = [0, 0xff, 0x03, name.length, ...name];
      let last = 0;
      ev.forEach(([t, b]) => { data.push(...vlq(Math.max(0, t - last)), b[0] | c, b[1], b[2]); last = t; });
      data.push(0, 0xff, 0x2f, 0);
      tracks.push(chunk('MTrk', data));
    });
    const header = chunk('MThd', [0, 1, 0, tracks.length, 0, PPQ]);
    const bytes = new Uint8Array([...header, ...tracks.flat()]);
    const name = `${(p.name || 'project').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'project'}.mid`;
    BF.io.download(new Blob([bytes], { type: 'audio/midi' }), name);
    BF.ui.toast(`Exported ${name} (${tracks.length - 1} tracks${song ? ', from the playlist' : ', current pattern'})`);
  };
})();
