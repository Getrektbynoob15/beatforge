/* midi.js: live playing (MIDI keyboard and the computer "typing keyboard") with real note-off, and note recording.
 * Notes play on the selected channel. With Record (R) on and the transport running, every note you play is written
 * into the current pattern for that channel (start times snapped to 1/16 when "Quantize" is on). */
(function () {
  'use strict';
  const BF = window.BF;
  const LV = (BF.live = { held: new Map(), devices: [] });
  BF.rec = { armed: false, quantize: true, precount: false, stepEdit: false };

  /** A note that sounds until released. Drums and one-shot samples ignore the release and ring out. */
  BF.audio.liveNote = function (ch, key, vel) {
    const ctx = BF.audio.ensure();
    const g = BF.audio.graph;
    const def = BF.plugins.get(ch.plugin);
    if (def.ext) { // community instruments get a real note-off (their own release)
      const h = BF.community.note(g, ch, ctx.currentTime + 0.004, key + ch.pitch, vel, null, 'live', null);
      return { release() { if (h) h.release(); } };
    }
    const gate = ctx.createGain();
    const pan = ctx.createStereoPanner();
    gate.gain.value = ch.volume;
    pan.pan.value = ch.pan;
    gate.connect(pan).connect(g.inserts[ch.insert].preview);
    const t = ctx.currentTime + 0.004;
    def.play(ctx, gate, ch.params, t, key + ch.pitch, vel, 8);
    const oneShot = ch.plugin === 'drum' || (ch.plugin === 'sampler' && ch.params.oneshot);
    return {
      release() {
        const now = ctx.currentTime;
        const rel = oneShot ? 8 : Math.min(3, Math.max(0.02, ch.params.release ?? 0.1));
        if (!oneShot) {
          gate.gain.cancelScheduledValues(now);
          gate.gain.setValueAtTime(gate.gain.value, now);
          gate.gain.setTargetAtTime(0, now, rel / 4);
        }
        setTimeout(() => { try { pan.disconnect(); } catch { /* */ } }, (rel * 1.6 + 0.2) * 1000);
      },
    };
  };

  function stepNow() {
    const T = BF.transport;
    const pt = BF.pattern();
    let beat = T.position();
    if (T.mode === 'song') {
      const c = BF.project.clips.find((x) => x.kind === 'pattern' && x.patternId === pt.id && beat >= x.start && beat < x.start + x.len);
      beat = c ? beat - c.start : beat;
    }
    return ((beat * 4) % pt.length + pt.length) % pt.length;
  }

  LV.on = function (src, key, vel = 0.8) {
    const ch = BF.channel();
    if (!ch) return;
    const id = `${src}:${key}`;
    if (LV.held.has(id)) LV.off(src, key);
    const entry = { handle: BF.audio.liveNote(ch, key, vel), key, vel, chId: ch.id };
    if (BF.rec.armed && BF.transport.playing) entry.start = stepNow();
    else if (BF.rec.stepEdit && !BF.transport.playing) { // step edit (Ctrl+E): write at the piano roll's edit cursor
      const len = BF.piano.snap || 1;
      const at = BF.piano.cursor || 0;
      BF.commit(() => { const q = BF.pattern(); (q.notes[ch.id] || (q.notes[ch.id] = [])).push({ id: BF.uid('n'), start: at, len, key, vel }); }, null, 'notes');
      entry.stepEdit = true;
    }
    LV.held.set(id, entry);
    BF.piano.flash?.(key, true);
  };

  LV.off = function (src, key) {
    const id = `${src}:${key}`;
    const e = LV.held.get(id);
    if (!e) return;
    LV.held.delete(id);
    e.handle.release();
    BF.piano.flash?.(key, false);
    if (e.stepEdit && ![...LV.held.values()].some((x) => x.stepEdit)) { // all keys up: move the cursor on
      BF.piano.cursor = ((BF.piano.cursor || 0) + (BF.piano.snap || 1)) % BF.pattern().length;
      BF.piano.draw();
    }
    if (e.start === undefined || !BF.transport.playing) return;
    const pt = BF.pattern();
    let end = stepNow();
    let len = end - e.start;
    if (len <= 0) len += pt.length;
    let start = e.start;
    if (BF.rec.quantize) start = Math.round(start) % pt.length;
    else start = Math.round(start * 100) / 100;
    len = Math.max(0.25, Math.round(len * 4) / 4);
    const note = { id: BF.uid('n'), start, len: Math.min(len, pt.length), key: e.key, vel: e.vel };
    BF.commit(() => {
      const q = BF.pattern();
      (q.notes[e.chId] || (q.notes[e.chId] = [])).push(note);
    }, null, 'notes');
  };

  LV.allOff = function () { [...LV.held.keys()].forEach((id) => { const [src, key] = id.split(':'); LV.off(src, +key); }); };

  // ---------- Web MIDI ----------
  function onMessage(ev) {
    const [st, d1, d2] = ev.data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) LV.on('midi', d1, Math.max(0.05, d2 / 127));
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) LV.off('midi', d1);
    else if (cmd === 0xb0 && d1 === 123) LV.allOff(); // all notes off
  }
  function scan(access) {
    LV.devices = [];
    access.inputs.forEach((inp) => { inp.onmidimessage = onMessage; LV.devices.push(inp.name || 'MIDI input'); });
    BF.emit('midi');
  }
  LV.start = async function (userAsked = false) {
    if (!navigator.requestMIDIAccess) { if (userAsked) BF.ui.toast('This browser has no Web MIDI. Use Chrome, Edge or the desktop app.', true); return; }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      scan(access);
      access.onstatechange = () => scan(access);
      if (userAsked || LV.devices.length) BF.ui.toast(LV.devices.length ? `MIDI: ${LV.devices.join(', ')}` : 'No MIDI keyboard found. Plug one in; it is picked up automatically.');
    } catch {
      if (userAsked) BF.ui.toast('MIDI access was blocked.', true);
    }
  };

  // ---------- computer typing keyboard (two octaves) ----------
  const LOWER = 'zsxdcvgbhnjm,l.;/';
  const UPPER = 'q2w3er5t6y7ui9o0p';
  LV.typingNote = function (e) {
    const c = e.key.toLowerCase();
    let i = LOWER.indexOf(c), base = 60;
    if (i < 0) { i = UPPER.indexOf(c); base = 72; }
    return i < 0 ? null : base + i + (LV.octave || 0) * 12;
  };
  LV.octave = 0;
  window.addEventListener('keyup', (e) => {
    if (!BF.piano.typing) return;
    const n = LV.typingNote(e);
    if (n !== null) LV.off('key', n);
  });
  window.addEventListener('blur', () => LV.allOff());
})();
