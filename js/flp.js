/* flp.js: read FL Studio project files (.flp) and plugin state files (.fst) so they can be brought into BeatForge.
 *
 * Own code, written from the community's public description of the file layout (for example the PyFLP project's
 * documentation). FL Studio is not decompiled or copied; this only reads the user's own files for interoperability.
 *
 * Layout: "FLhd" (u32 6, i16 format, u16 channels, u16 ppq) then "FLdt" (u32 length) and a stream of events.
 * An event is one id byte and a value: ids 0-63 = 1 byte, 64-127 = 2 bytes, 128-191 = 4 bytes, 192-255 = a LEB128
 * length followed by that many bytes (text or a binary structure).
 *
 * What is used: tempo, title, channels (name, type, sample file, plugin name, volume, pan, mute, mixer insert), patterns
 * (name, notes incl. pan/fine pitch/velocity/slide), the playlist (pattern and audio clips on tracks), track names,
 * mixer insert names and the effects in their slots (by plugin name). Plugin sounds and settings cannot be used:
 * FL's own plugins and VSTs (Serum etc.) are replaced by the closest BeatForge instrument / effect. */
(function () {
  'use strict';
  const BF = window.BF;
  const F = (BF.flp = {});

  const EV = {
    ENABLED: 0, ZIPPED: 15, TIMESIG_NUM: 17, TIMESIG_BEAT: 18, CH_TYPE: 21, CH_ROUTED: 22,
    CH_NEW: 64, PAT_NEW: 65, TEMPO_COARSE: 66, PITCH: 80, TEMPO_FINE: 93, SLOT_INDEX: 98, ARR_NEW: 99, ARR_CURRENT: 100,
    PAT_COLOR: 150, TEMPO: 156,
    CH_NAME: 192, PAT_NAME: 193, TITLE: 194, SAMPLE_PATH: 196, VERSION: 199, PLUGIN_INTERNAL: 201, PLUGIN_NAME: 203,
    INSERT_NAME: 204, TRACK_NAME: 239, ARR_NAME: 241,
    WRAPPER: 212, CH_LEVELS: 219, NOTES: 224, PLAYLIST: 233, INSERT_FLAGS: 236, TRACK_DATA: 238,
  };
  const PATTERN_BASE = 20480;

  function header(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (bytes.length < 22 || tag(0) !== 'FLhd') throw new Error('This is not an FL Studio file (no FLhd header).');
    const hlen = v.getUint32(4, true);
    const ppq = v.getUint16(12, true) || 96;
    const d = 8 + hlen;
    if (tag(d) !== 'FLdt') throw new Error('The FL Studio file is damaged (no FLdt block).');
    const len = v.getUint32(d + 4, true);
    return { ppq, start: d + 8, end: Math.min(bytes.length, d + 8 + len), view: v };
  }

  /** All events in order: [{ id, value (number) | data (Uint8Array) }]. */
  F.events = function (bytes) {
    const h = header(bytes);
    const v = h.view;
    const out = [];
    let p = h.start;
    while (p < h.end) {
      const id = bytes[p++];
      if (id < 64) { out.push({ id, value: bytes[p] }); p += 1; }
      else if (id < 128) { out.push({ id, value: v.getUint16(p, true) }); p += 2; }
      else if (id < 192) { out.push({ id, value: v.getUint32(p, true), s32: v.getInt32(p, true) }); p += 4; }
      else {
        let len = 0, shift = 0, b;
        do { b = bytes[p++]; len += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80 && p < h.end);
        if (p + len > h.end) break; // truncated file: keep what we have
        out.push({ id, data: bytes.subarray(p, p + len) });
        p += len;
      }
    }
    return { ppq: h.ppq, events: out };
  };

  function text(data, utf16) {
    if (!data || !data.length) return '';
    let s;
    if (utf16 && data.length % 2 === 0) s = new TextDecoder('utf-16le').decode(data);
    else s = new TextDecoder('latin1').decode(data);
    return s.replace(/\u0000+$/g, '').replace(/[\u0000-\u001f]/g, ' ').trim();
  }
  const looksUtf16 = (data) => data.length >= 4 && data.length % 2 === 0 && data[1] === 0 && data[3] === 0;

  /** The VST name inside a "Fruity Wrapper" plugin (record 54), or ''. */
  function wrapperName(data) {
    try {
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      let p = 4;
      while (p + 12 <= data.length) {
        const id = v.getUint32(p, true);
        const len = Number(v.getBigUint64(p + 4, true));
        p += 12;
        if (len < 0 || p + len > data.length) break;
        if (id === 54) return new TextDecoder().decode(data.subarray(p, p + len)).replace(/\u0000+$/, '').trim();
        p += len;
      }
    } catch { /* not a wrapper */ }
    return '';
  }

  /** Parse an .flp into a plain description of the project. */
  F.parse = function (bytes) {
    const { ppq, events } = F.events(bytes);
    const P = { ppq, tempo: null, title: '', version: '', timeSig: [4, 4], channels: [], patterns: new Map(), arrangements: [], tracks: new Map(), inserts: [] };
    let utf16 = true;
    let ctx = null, cur = null, curArr = null, curTrack = null, curInsert = null, curSlot = null;
    let insertCount = -1;
    const plugin = (target, e) => {
      if (e.id === EV.PLUGIN_INTERNAL) target.internal = text(e.data, utf16);
      else if (e.id === EV.PLUGIN_NAME) target.pluginName = text(e.data, utf16);
      else if (e.id === EV.WRAPPER) target.vst = wrapperName(e.data) || target.vst;
    };
    for (const e of events) {
      switch (e.id) {
        case EV.VERSION: P.version = text(e.data, false); utf16 = !/^([0-9]|10|11\.[0-4])\./.test(P.version); continue;
        case EV.TEMPO: P.tempo = e.value / 1000; continue;
        case EV.TEMPO_COARSE: if (!P.tempo) P.tempo = e.value; continue;
        case EV.TEMPO_FINE: if (P.tempo && P.tempo === Math.round(P.tempo)) P.tempo += e.value / 1000; continue;
        case EV.TITLE: P.title = text(e.data, utf16 || looksUtf16(e.data)); continue;
        case EV.TIMESIG_NUM: P.timeSig[0] = e.value || 4; continue;
        case EV.TIMESIG_BEAT: P.timeSig[1] = e.value || 4; continue;
        case EV.CH_NEW: ctx = 'ch'; cur = { iid: e.value, type: 2, name: '', enabled: true, insert: -1 }; P.channels.push(cur); continue;
        case EV.PAT_NEW: ctx = 'pat'; cur = P.patterns.get(e.value) || { iid: e.value, name: '', notes: [] }; P.patterns.set(e.value, cur); continue;
        case EV.ARR_NEW: ctx = 'arr'; curArr = { iid: e.value, name: '', items: [] }; P.arrangements.push(curArr); continue;
        case EV.INSERT_FLAGS: ctx = 'mix'; insertCount++; curInsert = { index: insertCount, name: '', slots: [] }; P.inserts.push(curInsert); curSlot = null; continue;
        case EV.SLOT_INDEX:
          ctx = 'mix';
          if (!curInsert) { insertCount++; curInsert = { index: insertCount, name: '', slots: [] }; P.inserts.push(curInsert); } // a saved mixer state has no flags event first
          curSlot = { index: e.value }; curInsert.slots.push(curSlot);
          continue;
        default: break;
      }
      if (e.id === EV.PAT_NAME && ctx === 'pat') { cur.name = text(e.data, utf16); continue; }
      if (e.id === EV.PAT_COLOR && ctx === 'pat') { cur.color = e.value; continue; }
      if (e.id === EV.NOTES && cur && ctx === 'pat') {
        const d = e.data, v = new DataView(d.buffer, d.byteOffset, d.byteLength);
        for (let o = 0; o + 24 <= d.length; o += 24) {
          cur.notes.push({
            pos: v.getUint32(o, true), flags: v.getUint16(o + 4, true), ch: v.getUint16(o + 6, true), len: v.getUint32(o + 8, true),
            key: v.getUint16(o + 12, true), fine: d[o + 16], pan: d[o + 20], vel: d[o + 21], color: d[o + 19] & 0x0f,
          });
        }
        continue;
      }
      if (ctx === 'ch' && cur) {
        if (e.id === EV.CH_TYPE) cur.type = e.value;
        else if (e.id === EV.ENABLED) cur.enabled = !!e.value;
        else if (e.id === EV.ZIPPED) cur.zipped = !!e.value;
        else if (e.id === EV.CH_ROUTED) cur.insert = e.value > 127 ? e.value - 256 : e.value;
        else if (e.id === EV.CH_NAME) cur.name = text(e.data, utf16);
        else if (e.id === EV.SAMPLE_PATH) cur.sample = text(e.data, utf16);
        else if (e.id === EV.CH_LEVELS && e.data.length >= 12) {
          const v = new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength);
          cur.pan = v.getInt32(0, true); cur.volume = v.getUint32(4, true); cur.pitch = v.getInt32(8, true);
        } else plugin(cur, e);
        continue;
      }
      if (ctx === 'arr' && curArr) {
        if (e.id === EV.ARR_NAME) curArr.name = text(e.data, utf16);
        else if (e.id === EV.PLAYLIST) {
          const d = e.data, v = new DataView(d.buffer, d.byteOffset, d.byteLength);
          const size = d.length % 60 === 0 && d.length % 32 !== 0 ? 60 : d.length % 32 === 0 && d.length % 60 !== 0 ? 32
            : (v.getUint16(4 + 60, true) === PATTERN_BASE ? 60 : 32);
          for (let o = 0; o + size <= d.length; o += size) {
            curArr.items.push({ pos: v.getUint32(o, true), base: v.getUint16(o + 4, true), index: v.getUint16(o + 6, true), len: v.getUint32(o + 8, true), rv: v.getUint16(o + 12, true), flags: v.getUint16(o + 18, true), startOff: v.getFloat32(o + 24, true) });
          }
        } else if (e.id === EV.TRACK_DATA && e.data.length >= 4) {
          const v = new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength);
          curTrack = { iid: v.getUint32(0, true), name: '' };
          P.tracks.set(curTrack.iid, curTrack);
        } else if (e.id === EV.TRACK_NAME && curTrack) curTrack.name = text(e.data, utf16);
        continue;
      }
      if (ctx === 'mix' && curInsert) {
        if (e.id === EV.INSERT_NAME) curInsert.name = text(e.data, utf16);
        else if (curSlot && (e.id === EV.PLUGIN_INTERNAL || e.id === EV.PLUGIN_NAME || e.id === EV.WRAPPER)) plugin(curSlot, e);
      }
    }
    return P;
  };

  // ---------- mapping FL things to BeatForge ----------
  const FX_MAP = [
    [/maximus|multiband|\bott\b/i, 'multiband'], [/limiter|soft ?clip|clipper/i, 'limiter'], [/compress|glue/i, 'compressor'],
    [/eq|equali[sz]er|parametric/i, 'eq'], [/reverb|reeverb|valhalla|room|hall/i, 'reverb'], [/delay|echo/i, 'delay'],
    [/chorus/i, 'chorus'], [/flang/i, 'flanger'], [/phas/i, 'phaser'], [/dist|blood|wave ?shap|satur|overdrive|fast ?dist|decimator|bitcrush/i, 'distortion'],
    [/filter|love ?philter|passive/i, 'filter'], [/stereo|width|shaper/i, 'width'], [/peak ?controller|sidechain|kickstart|lfo ?tool|volume ?shaper/i, 'shaper'],
    [/balance|gain|utility|fruity ?send/i, 'utility'],
  ];
  F.effectFor = (name) => { for (const [re, id] of FX_MAP) if (re.test(name || '')) return BF.plugins.has(id) ? id : null; return null; };

  const DRUM_WORDS = [[/808/i, 'bass808'], [/kick|bd\b|bassdrum/i, 'kick'], [/snare|sd\b/i, 'snare'], [/clap/i, 'clap'], [/open ?hat|oh\b/i, 'openhat'], [/hat|hh\b|hihat/i, 'hihat'], [/rim/i, 'rim'], [/crash|cymbal|ride/i, 'crash'], [/tom/i, 'tom'], [/cowbell/i, 'cowbell'], [/perc|shaker|tamb/i, 'perc']];
  function instrumentFor(c, label) {
    const all = `${label} ${c.pluginName || ''} ${c.internal || ''} ${c.vst || ''}`;
    if (/drumsynth|fpc|drum/i.test(all)) { for (const [re, s] of DRUM_WORDS) if (re.test(label)) return ['drum', { sound: s }]; }
    for (const [re, s] of DRUM_WORDS) if (re.test(label) && !/bass(?!drum)|lead|pad|synth/i.test(label.replace(/808/, ''))) return ['drum', { sound: s }];
    if (/808|sub|bass/i.test(all)) return ['synth', /808/i.test(all) ? '808 glide' : 'Sub bass'];
    if (/pad|string|choir|ambient|atmos/i.test(all)) return ['synth', 'Soft pad'];
    if (/piano|keys|rhodes|e-?piano|epiano/i.test(all)) return ['fm', 'E-piano'];
    if (/bell/i.test(all)) return ['fm', 'Glass bell'];
    if (/pluck|guitar|harp|koto/i.test(all)) return ['pluck', /guitar/i.test(all) ? 'Steel' : 'Harp'];
    if (/organ/i.test(all)) return ['organ', undefined];
    if (/supersaw|saw|serum|sylenth|spire|vital|massive|lead|voice|rave|hoover/i.test(all)) return ['synth', /rave|hoover|supersaw|saw/i.test(all) ? 'Supersaw' : 'Bright lead'];
    return ['synth', 'Bright lead'];
  }

  const baseName = (p) => (p || '').split(/[\\/]/).pop();
  const flVol = (v) => (v == null ? 0.78 : Math.max(0, Math.min(1.25, 0.78 * (v / 10000))));
  const flPan = (p) => (p == null ? 0 : Math.max(-1, Math.min(1, (p - 6400) / 6400)));

  /**
   * Build a BeatForge project from a parsed .flp.
   * findSample(basename) -> File | null : audio from a pack / folder the user gave (matched by file name).
   * Returns { project, report: { missingSamples[], replaced[], effects[], skipped[] } }.
   */
  F.toProject = async function (P, findSample) {
    const report = { missingSamples: [], replaced: [], effects: [], skipped: [] };
    const p = BF.newProject(false);
    p.name = P.title || 'FL Studio project';
    p.bpm = Math.round(BF.clamp(P.tempo || 130, 40, 300, 130) * 100) / 100;
    p.timeSig = { num: P.timeSig[0] || 4, den: P.timeSig[1] || 4 };
    p.channels = [];
    p.patterns = [];
    p.clips = [];
    const stepTicks = P.ppq / 4;
    // ---- mixer inserts (FL insert 0 = master) ----
    p.mixer.forEach((m, i) => { if (i) { m.name = `Insert ${i}`; m.fx = []; } });
    const flInserts = P.inserts.slice(0, BF.INSERTS + 1);
    flInserts.forEach((ins, i) => {
      const m = p.mixer[i];
      if (!m) return;
      if (ins.name) m.name = ins.name.slice(0, 40);
      ins.slots.forEach((s) => {
        const label = s.vst || s.pluginName || s.internal;
        if (!label) return;
        const id = F.effectFor(`${s.internal || ''} ${s.pluginName || ''} ${s.vst || ''}`);
        if (id && m.fx.length < 10) { m.fx.push({ id: BF.uid('fx'), plugin: id, params: BF.plugins.defaults(id), bypass: false }); report.effects.push(`${label} → ${BF.plugins.get(id).name} (insert ${i})`); }
        else report.skipped.push(`effect "${label}" on insert ${i}`);
      });
    });
    if (!p.mixer[0].fx.some((f) => f.plugin === 'limiter')) p.mixer[0].fx.push({ id: BF.uid('fx'), plugin: 'limiter', params: BF.plugins.defaults('limiter'), bypass: false });
    // ---- channels ----
    const byIid = new Map();
    const sampleIds = new Map(); // fl channel iid -> sampleId
    for (const c of P.channels) {
      if (c.type === 5) { report.skipped.push(`automation clip "${c.name || c.pluginName || c.iid}"`); continue; }
      if (c.type === 3) { report.skipped.push(`layer channel "${c.name || c.pluginName}"`); continue; }
      const file = c.sample ? baseName(c.sample) : '';
      const label = (c.pluginName || c.name || file.replace(/\.[^.]+$/, '') || `Channel ${c.iid + 1}`).slice(0, 40);
      let ch;
      if (c.type === 0 && file) {
        let f = findSample ? findSample(file) : null;
        if (f && f.lazy) f = await BF.files.resolve(f.lazy).catch(() => null); // a file kept in a browser pack
        const id = f ? await BF.io.addSample(f) : null;
        if (id) { p.samples[id] = BF.project.samples[id]; ch = BF.newChannel('sampler', label, { preset: { sample: id } }); sampleIds.set(c.iid, id); }
        else {
          report.missingSamples.push(file);
          const [plugin, preset] = instrumentFor(c, label);
          ch = BF.newChannel(plugin, label, { preset });
          report.replaced.push(`${label}: sample "${file}" not found → ${BF.plugins.get(plugin).name}`);
        }
      } else {
        const [plugin, preset] = instrumentFor(c, label);
        ch = BF.newChannel(plugin, label, { preset });
        const what = c.vst || c.internal || c.pluginName || 'plugin';
        report.replaced.push(`${label} (${what}) → ${BF.plugins.get(plugin).name}${typeof preset === 'string' ? ` "${preset}"` : ''}`);
      }
      ch.volume = flVol(c.volume);
      ch.pan = flPan(c.pan);
      ch.mute = c.enabled === false;
      if (c.zipped) ch.zip = true;
      ch.insert = c.insert > 0 && c.insert <= BF.INSERTS ? c.insert : BF.rack.freeInsert(p);
      if (ch.insert && !P.inserts[ch.insert]?.name) p.mixer[ch.insert].name = ch.name;
      p.channels.push(ch);
      byIid.set(c.iid, ch);
    }
    // ---- patterns ----
    const patByIid = new Map();
    [...P.patterns.values()].sort((a, b) => a.iid - b.iid).forEach((fp, k) => {
      const pt = BF.newPattern(k + 1);
      if (fp.name) pt.name = fp.name.slice(0, 40);
      let end = 0;
      fp.notes.forEach((n) => {
        const ch = byIid.get(n.ch);
        if (!ch) return;
        const start = Math.round((n.pos / stepTicks) * 100) / 100, len = Math.max(0.05, Math.round((n.len / stepTicks) * 100) / 100);
        end = Math.max(end, start + Math.max(len, 1));
        const note = { id: BF.uid('n'), start, len, key: Math.min(127, n.key), vel: Math.max(0.02, Math.min(1, (n.vel || 100) / 128)) };
        if (n.flags & 8) note.slide = true;
        if (n.pan !== 64 && n.pan <= 128) note.pan = Math.max(-1, Math.min(1, (n.pan - 64) / 64));
        if (n.fine !== 120 && n.fine <= 240) note.fine = Math.max(-100, Math.min(100, Math.round(((n.fine - 120) / 120) * 100)));
        if (n.color) note.color = n.color;
        (pt.notes[ch.id] || (pt.notes[ch.id] = [])).push(note);
      });
      pt.length = Math.min(256, Math.max(16, Math.ceil(end / 16) * 16));
      // drum channels with only short C5 notes on whole steps: show them as steps in the channel rack
      for (const [chId, list] of Object.entries(pt.notes)) {
        const ch = p.channels.find((c) => c.id === chId);
        if (ch.plugin !== 'drum' && ch.plugin !== 'sampler') continue;
        if (list.every((n) => n.key === 60 && Number.isInteger(n.start) && n.len <= 1.01 && !n.pan && !n.fine) && list.every((n) => n.start < pt.length)) {
          pt.steps[chId] = Array.from({ length: pt.length }, (_, i) => list.some((n) => n.start === i));
          delete pt.notes[chId];
        }
      }
      p.patterns.push(pt);
      patByIid.set(fp.iid, pt);
    });
    if (!p.patterns.length) p.patterns.push(BF.newPattern(1));
    // ---- playlist ----
    const arr = P.arrangements[0];
    const maxRv = /^(\d+)\.(\d+)\.(\d+)/.test(P.version) && (() => { const [, a, b, c] = /^(\d+)\.(\d+)\.(\d+)/.exec(P.version).map(Number); return a > 12 || (a === 12 && (b > 9 || (b === 9 && c >= 1))); })() ? 499 : 198;
    if (arr) {
      const flTracks = [...new Set(arr.items.map((it) => maxRv - it.rv))].sort((a, b) => a - b);
      if (flTracks.length > BF.TRACKS) report.skipped.push(`${flTracks.length - BF.TRACKS} playlist tracks beyond ${BF.TRACKS} (their clips go on the last track)`);
      const trackOf = (it) => Math.min(BF.TRACKS - 1, flTracks.indexOf(maxRv - it.rv));
      flTracks.slice(0, BF.TRACKS).forEach((flt, i) => { const t = P.tracks.get(flt + 1) || P.tracks.get(flt); if (t && t.name) p.tracks[i].name = t.name.slice(0, 40); });
      arr.items.forEach((it) => {
        const start = it.pos / P.ppq, len = Math.max(0.25, it.len / P.ppq);
        if (it.index > PATTERN_BASE) {
          const pt = patByIid.get(it.index - PATTERN_BASE);
          if (pt) p.clips.push({ id: BF.uid('c'), kind: 'pattern', track: trackOf(it), start, len, patternId: pt.id });
        } else {
          const sid = sampleIds.get(it.index);
          if (sid) p.clips.push({ id: BF.uid('c'), kind: 'audio', track: trackOf(it), start, len, sampleId: sid, mode: 'resample', speed: 1, pitch: 0, srcBpm: p.bpm, gain: 1 });
          else report.skipped.push('an audio clip whose sample was not found');
        }
      });
    }
    p.currentPattern = p.patterns[0].id;
    p.selectedChannel = p.channels[0]?.id || null;
    p.songBars = Math.max(4, Math.ceil(Math.max(0, ...p.clips.map((c) => c.start + c.len)) / 4));
    report.skipped = [...new Set(report.skipped)];
    return { project: p, report };
  };

  // ---------- importing ----------
  function reportDialog(title, rep, onFolder) {
    const d = document.createElement('dialog');
    d.className = 'dlg flp-dlg';
    const h = document.createElement('h2'); h.textContent = title;
    const body = document.createElement('div'); body.className = 'flp-report';
    const sec = (t, list, cls) => {
      if (!list.length) return;
      const h3 = document.createElement('h3'); h3.textContent = `${t} (${list.length})`;
      const ul = document.createElement('ul'); if (cls) ul.className = cls;
      list.slice(0, 80).forEach((x) => { const li = document.createElement('li'); li.textContent = x; ul.append(li); });
      if (list.length > 80) { const li = document.createElement('li'); li.textContent = `… and ${list.length - 80} more`; ul.append(li); }
      body.append(h3, ul);
    };
    const intro = document.createElement('p');
    intro.textContent = 'The notes, patterns, playlist, tempo and mixer names came over. FL Studio\'s own plugins and VSTs (like Serum) cannot run in BeatForge, so those channels use the closest BeatForge sound. Pick better presets by clicking a channel name.';
    body.append(intro);
    sec('Sounds replaced', rep.replaced);
    sec('Effects added (default settings)', rep.effects);
    sec('Samples not found', rep.missingSamples, 'warn');
    sec('Not imported', rep.skipped);
    const actions = document.createElement('div'); actions.className = 'dlg-actions';
    if (rep.missingSamples.length && onFolder) {
      const f = document.createElement('button'); f.className = 'btn'; f.textContent = 'Find samples in a folder…';
      f.title = 'Pick the folder with the samples (for example the template pack folder); they are matched by file name';
      f.addEventListener('click', () => { d.close(); onFolder(); });
      actions.append(f);
    }
    const ok = document.createElement('button'); ok.className = 'btn accent'; ok.textContent = 'OK';
    ok.addEventListener('click', () => d.close());
    actions.append(ok);
    d.append(h, body, actions);
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
  }

  F.showReport = (title, rep, stems) => reportDialog(title + (stems ? ` (+${stems} stems as muted reference tracks)` : ''), rep, null);

  /** Open an .flp. `files`: other files to look for samples in ({ path, file }[]), e.g. the rest of a template pack. */
  F.importFile = async function (file, files = [], { confirmReplace = true, quiet = false } = {}) {
    if (confirmReplace && BF.dirty && !confirm('Open this FL Studio project? Unsaved changes in the current project are lost.')) return null;
    BF.ui.busy(`Reading ${file.name}…`);
    try {
      const P = F.parse(new Uint8Array(await file.arrayBuffer()));
      const byName = new Map();
      files.forEach((x) => { if (x.file && /\.(wav|mp3|ogg|flac|aif|aiff|m4a)$/i.test(x.file.name)) byName.set(x.file.name.toLowerCase(), x.file); });
      BF.transport.stop();
      BF.audio.buffers.clear();
      const { project, report } = await F.toProject(P, (name) => byName.get(name.toLowerCase()) || null);
      if (!project.name || project.name === 'FL Studio project') project.name = file.name.replace(/\.flp$/i, '');
      BF.replaceProject(BF.normalizeProject(project));
      BF.dirty = true;
      BF.transport.setMode(project.clips.length ? 'song' : 'pattern');
      if (!quiet) reportDialog(`Imported ${file.name}`, report, () => F.pickSampleFolder(file));
      return report;
    } catch (e) {
      BF.ui.toast(`Could not read this FL Studio file: ${e.message || e}`, true);
      return null;
    } finally { BF.ui.busy(null); }
  };

  F.pickSampleFolder = function (flpFile) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.webkitdirectory = true; inp.multiple = true;
    inp.addEventListener('change', () => {
      const files = [...inp.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
      F.importFile(flpFile, files, { confirmReplace: false });
    });
    inp.click();
  };

  /** An .fst: mixer state -> matching effects on the selected insert; instrument preset -> a channel named after it. */
  F.importState = async function (file) {
    try {
      const st = F.parseState(new Uint8Array(await file.arrayBuffer()));
      const label = file.name.replace(/\.fst$/i, '');
      if (st.kind === 'mixer' || (st.kind === 'effect' && st.names.length)) {
        const ins = BF.mixer.selected || 1;
        const added = [], skipped = [];
        BF.commit((q) => st.names.forEach((n) => {
          const id = F.effectFor(n);
          if (id && q.mixer[ins].fx.length < 10) { q.mixer[ins].fx.push({ id: BF.uid('fx'), plugin: id, params: BF.plugins.defaults(id), bypass: false }); added.push(`${n} → ${BF.plugins.get(id).name}`); }
          else skipped.push(n);
        }));
        BF.win.toggle('mixer', true);
        BF.ui.toast(`${label}: ${added.length ? `added to insert ${ins}: ${added.join(', ')}` : 'no matching BeatForge effects'}${skipped.length ? `. Not available: ${skipped.join(', ')}` : ''}. Settings start at default (FL stores them in its own format).`);
        return;
      }
      const name = st.names[0] || 'plugin';
      const [plugin, preset] = instrumentFor({ vst: st.vst, pluginName: name }, label);
      BF.rack.addChannel(plugin, preset, label.slice(0, 40));
      BF.ui.toast(`${label} is a ${name} preset. ${name} itself can't run in BeatForge, so this added a "${label}" channel with the closest BeatForge sound (${BF.plugins.get(plugin).name}).`);
    } catch (e) {
      BF.ui.toast(`Could not read ${file.name}: ${e.message || e}`, true);
    }
  };

  /** .fst: a saved plugin or mixer-insert state. Returns { kind: 'mixer'|'instrument'|'effect', names[], vst }. */
  F.parseState = function (bytes) {
    const P = F.parse(bytes);
    const names = [];
    P.inserts.forEach((ins) => ins.slots.forEach((s) => { const n = s.vst || s.pluginName || s.internal; if (n) names.push(n); }));
    const ch = P.channels[0];
    if (!names.length && ch) return { kind: 'instrument', names: [ch.vst || ch.pluginName || ch.internal || ch.name].filter(Boolean), vst: ch.vst, channel: ch };
    // a plugin state saved on its own: the plugin events come before any channel/insert
    if (!names.length) {
      const { events } = F.events(bytes);
      const t = {};
      events.forEach((e) => { if (e.id === EV.PLUGIN_INTERNAL) t.internal = text(e.data, true); else if (e.id === EV.PLUGIN_NAME) t.pluginName = text(e.data, true); else if (e.id === EV.WRAPPER) t.vst = wrapperName(e.data) || t.vst; });
      const n = t.vst || t.pluginName || t.internal;
      // a known effect (limiter, EQ, reverb…) goes on the mixer; anything else (Serum presets, synths) is an instrument
      const isFx = !/serum|sylenth|vital|spire|massive|nexus|omnisphere|keyscape|kontakt|synth|lead|bass|pad|pluck|voice/i.test(n || '') && !!F.effectFor(n || '');
      return { kind: isFx ? 'effect' : 'instrument', names: n ? [n] : [], vst: t.vst };
    }
    return { kind: 'mixer', names };
  };
})();
