/* midiimport.js: import a Standard MIDI File (.mid) — e.g. a song exported from another DAW.
 * Each MIDI track becomes a channel (drums on MIDI channel 10 become one Drum Kit channel per drum sound).
 * The song is cut into 8-bar blocks; identical blocks share one pattern, and the blocks are placed in the playlist. */
(function () {
  'use strict';
  const BF = window.BF;
  const GM_DRUMS = { 60: 'perc', 35: 'bass808', 34: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 40: 'snare', 39: 'clap', 41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom', 42: 'hihat', 44: 'hihat', 46: 'openhat', 49: 'crash', 57: 'crash', 51: 'crash', 56: 'cowbell' };
  const BLOCK_STEPS = 64; // 4 bars of 16 steps: repeated 4-bar sections become one shared pattern

  function parse(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const str = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (bytes.length < 14 || str(0) !== 'MThd') throw new Error('This is not a MIDI file.');
    const division = v.getUint16(12);
    if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported.');
    const ntracks = v.getUint16(10);
    let o = 8 + v.getUint32(4);
    const tracks = [];
    let tempo = null;
    for (let t = 0; t < ntracks && o + 8 <= bytes.length; t++) {
      if (str(o) !== 'MTrk') throw new Error('The MIDI file is damaged.');
      const len = v.getUint32(o + 4);
      let p = o + 8;
      const end = Math.min(bytes.length, p + len);
      const tr = { name: '', notes: [], channel: null, program: null };
      const open = new Map();
      let tick = 0, status = 0;
      const vlq = () => { let n = 0, b; do { b = bytes[p++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80 && p < end); return n; };
      while (p < end) {
        tick += vlq();
        let b = bytes[p];
        if (b & 0x80) { status = b; p++; } else if (!status) break;
        const type = status & 0xf0, ch = status & 0x0f;
        if (status === 0xff) {
          const meta = bytes[p++]; const l = vlq();
          if (meta === 0x03 && !tr.name) tr.name = new TextDecoder().decode(bytes.subarray(p, p + l)).trim();
          if (meta === 0x51 && tempo === null) tempo = 60000000 / ((bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2]);
          p += l;
          if (meta === 0x2f) break;
        } else if (status === 0xf0 || status === 0xf7) { p += vlq(); }
        else if (type === 0x90 || type === 0x80) {
          const key = bytes[p++], vel = bytes[p++];
          const id = `${ch}:${key}`;
          if (type === 0x90 && vel > 0) { if (!open.has(id)) open.set(id, []); open.get(id).push({ tick, vel, ch }); }
          else { const st = open.get(id)?.shift(); if (st) tr.notes.push({ start: st.tick, end: tick, key, vel: st.vel / 127, ch }); }
          if (tr.channel === null) tr.channel = ch;
        } else if (type === 0xc0) { tr.program = bytes[p++]; }
        else if (type === 0xd0) p += 1;
        else p += 2; // 0xA0, 0xB0, 0xE0
      }
      tracks.push(tr);
      o = end;
    }
    return { division, tempo, tracks: tracks.filter((t) => t.notes.length) };
  }

  BF.midiImport = async function (file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mid = parse(bytes);
      if (!mid.tracks.length) throw new Error('This MIDI file has no notes.');
      const toStep = (tick) => (tick / mid.division) * 4;
      // build the channel list: melodic tracks -> synth, drum tracks -> one drum channel per sound
      const chans = [];
      mid.tracks.forEach((tr, ti) => {
        const isDrum = tr.notes.every((n) => n.ch === 9);
        if (isDrum) {
          const bySound = new Map();
          tr.notes.forEach((n) => { const s = GM_DRUMS[n.key] || 'perc'; if (!bySound.has(s)) bySound.set(s, []); bySound.get(s).push({ ...n, key: 60 }); });
          const label = (s) => BF.plugins.get('drum').params[0].options.find((x) => x[0] === s)[1];
          bySound.forEach((notes, sound) => chans.push({ plugin: 'drum', preset: { sound }, name: bySound.size === 1 && tr.name ? tr.name : `${tr.name || 'Drums'} ${label(sound)}`.trim(), notes }));
        } else {
          const avg = tr.notes.reduce((a, n) => a + n.key, 0) / tr.notes.length;
          chans.push({ plugin: 'synth', preset: avg < 48 ? 'Sub bass' : avg < 60 ? 'Square keys' : 'Bright lead', name: tr.name || `MIDI ${ti + 1}`, notes: tr.notes });
        }
      });
      const lastStep = Math.max(...chans.flatMap((c) => c.notes.map((n) => toStep(n.end))));
      const blocks = Math.max(1, Math.ceil(lastStep / BLOCK_STEPS));
      const base = BF.project.patterns.length;
      const startBeat = Math.ceil(Math.max(0, ...BF.project.clips.map((c) => c.start + BF.audio.clipBeats(c))) / 4) * 4;
      let made = 0;
      BF.commit((p) => {
        const ids = chans.map((c) => {
          const ch = BF.newChannel(c.plugin, c.name.slice(0, 40), { preset: c.preset });
          ch.insert = BF.rack.freeInsert(p);
          if (ch.insert) p.mixer[ch.insert].name = ch.name;
          p.channels.push(ch);
          return ch.id;
        });
        const sigToPattern = new Map();
        const track = (() => { const used = new Set(p.clips.map((c) => c.track)); const i = p.tracks.findIndex((_, k) => !used.has(k)); return i < 0 ? 0 : i; })();
        for (let b = 0; b < blocks; b++) {
          const from = b * BLOCK_STEPS, to = from + BLOCK_STEPS;
          const notes = {};
          chans.forEach((c, ci) => {
            const list = c.notes.filter((n) => toStep(n.start) >= from - 1e-6 && toStep(n.start) < to - 1e-6)
              .map((n) => ({ id: BF.uid('n'), start: Math.round((toStep(n.start) - from) * 100) / 100, len: Math.max(0.1, Math.round((toStep(n.end) - toStep(n.start)) * 100) / 100), key: n.key, vel: Math.max(0.05, n.vel) }));
            if (list.length) notes[ids[ci]] = list;
          });
          if (!Object.keys(notes).length) continue;
          const sig = JSON.stringify(Object.entries(notes).map(([k, l]) => [ids.indexOf(k), l.map((n) => [n.start, n.len, n.key, Math.round(n.vel * 100)])]));
          let pt = sigToPattern.get(sig);
          if (!pt) {
            pt = BF.newPattern(base + sigToPattern.size + 1);
            pt.name = `${file.name.replace(/\.midi?$/i, '').slice(0, 30)} ${sigToPattern.size + 1}`;
            pt.length = BLOCK_STEPS;
            pt.notes = notes;
            p.patterns.push(pt);
            sigToPattern.set(sig, pt);
          }
          p.clips.push({ id: BF.uid('c'), kind: 'pattern', track, start: startBeat + b * (BLOCK_STEPS / 4), len: BLOCK_STEPS / 4, patternId: pt.id });
          made++;
        }
        if (mid.tempo && !p.clips.some((c) => c.start < startBeat)) p.bpm = Math.round(mid.tempo * 100) / 100;
        if (sigToPattern.size) p.currentPattern = [...sigToPattern.values()][0].id;
      });
      BF.transport.setMode('song');
      BF.ui.toast(`Imported ${file.name}: ${chans.length} channels, ${made} playlist blocks${mid.tempo ? `, ${Math.round(mid.tempo)} BPM` : ''}.`);
    } catch (e) {
      BF.ui.toast(`MIDI import failed: ${e.message || e}`, true);
    }
  };
})();
