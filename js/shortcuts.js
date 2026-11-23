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
      ['Numpad + / −', 'Next / previous pattern'], ['F4', 'Next empty pattern'],
    ]],
    ['Windows', [
      ['F5', 'Playlist'], ['F6', 'Channel rack'], ['F7', 'Piano roll'], ['F8', 'Plugin picker'], ['Alt+F8', 'Browser'], ['F9', 'Mixer'],
      ['F10', 'Settings (MIDI, recording, updates)'], ['F11', 'Project info'], ['F12', 'Close all windows'], ['Tab', 'Next window'], ['Esc', 'Close the focused window'], ['F1', 'This list'],
    ]],
    ['File', [
      ['Ctrl+N', 'New project'], ['Ctrl+O', 'Open'], ['Ctrl+S', 'Save'], ['Ctrl+Shift+S', 'Save as'],
      ['Ctrl+R', 'Export WAV'], ['Ctrl+Shift+R', 'Export MP3'], ['Ctrl+Shift+M', 'Export MIDI file'],
    ]],
    ['Editing', [
      ['Ctrl+Z', 'Undo / redo the last change (press again to redo)'], ['Ctrl+Alt+Z', 'Undo (step back)'], ['Ctrl+Shift+Z / Ctrl+Y', 'Redo (step forward)'],
      ['F2', 'Rename (channel, insert or pattern)'], ['Ctrl+T', 'Typing keyboard to piano'], ['Ctrl+F', 'Search the browser'],
      ['Ctrl+L (channel rack)', 'Route the selected channel to a free mixer insert'], ['Ctrl+L (mixer)', 'Route the selected channel to this insert'],
      ['↑ ↓ (channel rack)', 'Select channel'], ['Alt+↑ ↓ (channel rack)', 'Move channel up / down'], ['Alt+Del (channel rack)', 'Delete channel'],
    ]],
    ['Piano roll and playlist tools', [
      ['P · B · D · T · C · E', 'Draw · Paint · Delete · Mute · Slice · Select'], ['Right-click', 'Delete a note, clip or step'],
      ['Ctrl+drag', 'Box select'], ['Shift+drag', 'Duplicate while dragging'], ['Shift+drag clip edge', 'Stretch audio'],
      ['Ctrl+A · Ctrl+D', 'Select all · deselect'], ['Ctrl+C · Ctrl+X · Ctrl+V', 'Copy · cut · paste'], ['Ctrl+B', 'Duplicate selection'],
      ['↑ ↓ · Ctrl+↑ ↓', 'Transpose a semitone · an octave'], ['← →', 'Move by the snap'], ['Ctrl+Q · Alt+Q', 'Quick quantize · quantize'],
      ['Ctrl+L', 'Quick legato'], ['Alt+A · Alt+S · Alt+R', 'Arpeggiate · strum · randomize'], ['Alt+U · Alt+G · Alt+Y', 'Chop · glue · flip'],
      ['Ctrl+Insert · Ctrl+Delete', 'Insert / delete time at the loop region (playlist)'], ['Ctrl+wheel', 'Zoom'],
    ]],
  ];

  // ---------- Ctrl+Z works like a toggle: undo, then the same key redoes ----------
  let lastToggle = null; // 'undo' | 'redo'
  BF.onChange((r) => { if (r !== 'undo' && r !== 'redo' && r !== 'view' && r !== 'select' && r !== 'pattern' && r !== 'transport' && r !== 'windows' && r !== 'midi') lastToggle = null; });
  function undoToggle() {
    if (lastToggle === 'undo' && BF.canRedo()) { BF.redo(); lastToggle = 'redo'; }
    else if (BF.undo()) lastToggle = 'undo';
  }

  function rename() {
    const W = BF.win, p = BF.project;
    if (W.focused === 'mixer') {
      const i = BF.mixer.selected, n = BF.ui.prompt('Insert name', p.mixer[i].name);
      if (n) BF.commit((q) => { q.mixer[i].name = n; });
    } else if (W.focused === 'rack' && BF.channel()) {
      const ch = BF.channel(), n = BF.ui.prompt('Channel name', ch.name);
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

  function rackKeys(e, k) {
    const p = BF.project;
    const i = p.channels.findIndex((c) => c.id === p.selectedChannel);
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
    if (mod && k === 'h') { stop(); panic(); return; }
    if (mod && k === 'f') { stop(); BF.browser.toggle(true); document.querySelector('.br-head input')?.focus(); return; }
    if (e.key === 'F8') { stop(); if (e.altKey) W.toggle('browser'); else W.toggle('picker'); return; }
    if (['F5', 'F6', 'F7', 'F9'].includes(e.key)) { stop(); W.toggle({ F5: 'playlist', F6: 'rack', F7: 'piano', F9: 'mixer' }[e.key]); return; }
    if (e.key === 'F1') { stop(); ctx.showHelp(); return; }
    if (e.key === 'F2') { stop(); rename(); return; }
    if (e.key === 'F4') { stop(); BF.patterns.add(); return; }
    if (e.key === 'F10') { stop(); K.settings(); return; }
    if (e.key === 'F11') { stop(); K.projectInfo(); return; }
    if (e.key === 'F12') { stop(); [...W.all.keys()].forEach((id) => { if (id !== 'playlist') W.toggle(id, false); }); return; }
    if (typing) return;
    if (BF.piano.typing && !mod && !e.altKey && BF.piano.typingKey(e, true)) return;
    if (mod && k === 't') { stop(); document.querySelector('.piano .pr-tools button[title*="computer keyboard"]')?.click(); return; }
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
    if (W.focused === 'rack' && !mod && rackKeys(e, k)) { stop(); return; }
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
      b.append(row('Name', name), row('Minimum song length (bars)', bars), stats);
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
