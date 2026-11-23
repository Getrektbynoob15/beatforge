/* state.js: the project data model (single source of truth), undo/redo and change events.
 *
 * Project v2 (JSON):
 *   channels[]  channel rack: { id, name, plugin, params{}, volume, pan, pitch, mute, insert }
 *   patterns[]  { id, name, color, length (steps), steps{chId: bool[]}, notes{chId: [{id,start,len,key,vel}]} }
 *               start/len are in 16th steps; key is a MIDI note number; vel 0..1
 *   tracks[]    16 playlist tracks { id, name, mute }
 *   clips[]     playlist: { id, kind:'pattern'|'audio', track, start (beats), len (beats), patternId | sampleId, speed }
 *   mixer[]     0 = Master, 1..16 = inserts: { id, name, volume, pan, mute, solo, fx:[{id, plugin, params{}, bypass}] }
 *   samples{}   sampleId -> { name, mime, base64 }
 * Decoded audio lives in BF.audio.buffers, never in the project. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});

  const HISTORY_LIMIT = 100;
  BF.TRACKS = 16;
  BF.INSERTS = 16;
  BF.PATTERN_COLORS = ['#2fd4ff', '#ff7a59', '#9b7bff', '#3ddc84', '#ffcc33', '#ff5c8a', '#4dd0e1', '#c0ca33'];

  let counter = 0;
  BF.uid = (prefix) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  BF.clamp = clamp;

  // ---------- factories ----------
  BF.newChannel = function (plugin, name, extra = {}) {
    const def = BF.plugins.get(plugin);
    return {
      id: BF.uid('ch'),
      name: name || def.name,
      plugin,
      params: BF.plugins.defaults(plugin, extra.preset),
      volume: 0.78,
      pan: 0,
      pitch: 0,
      mute: false,
      insert: 0,
      ...extra.fields,
    };
  };

  BF.newPattern = function (n) {
    return { id: BF.uid('p'), name: `Pattern ${n}`, color: BF.PATTERN_COLORS[(n - 1) % BF.PATTERN_COLORS.length], length: 16, steps: {}, notes: {} };
  };

  BF.newInsert = (i) => ({ id: BF.uid('m'), name: i === 0 ? 'Master' : `Insert ${i}`, volume: 0.8, pan: 0, mute: false, solo: false, ...(i ? { route: { master: true, sends: [] } } : {}), fx: [] });

  BF.newProject = function (withDemo = true) {
    const drums = [['Kick', 'kick'], ['Clap', 'clap'], ['Hat', 'hihat'], ['Snare', 'snare']];
    const channels = drums.map(([name, sound], i) => BF.newChannel('drum', name, { fields: { insert: i + 1 }, preset: { sound } }));
    channels.push(BF.newChannel('synth', 'Bass', { preset: 'Sub bass', fields: { insert: 5 } }));
    channels.push(BF.newChannel('synth', 'Lead', { preset: 'Bright lead', fields: { insert: 6 } }));
    const p1 = BF.newPattern(1);
    const mixer = Array.from({ length: BF.INSERTS + 1 }, (_, i) => BF.newInsert(i));
    channels.forEach((c) => { mixer[c.insert].name = c.name; });
    mixer[0].fx.push({ id: BF.uid('fx'), plugin: 'limiter', params: BF.plugins.defaults('limiter'), bypass: false });
    const p = {
      app: 'BeatForge',
      version: 2,
      name: 'Untitled',
      bpm: 130,
      swing: 0,
      songBars: 4,
      channels,
      patterns: [p1],
      currentPattern: p1.id,
      selectedChannel: channels[0].id,
      tracks: Array.from({ length: BF.TRACKS }, (_, i) => ({ id: BF.uid('t'), name: `Track ${i + 1}`, mute: false, insert: 0 })),
      clips: [],
      mixer,
      samples: {},
    };
    if (withDemo) {
      const on = (ch, idx) => { p1.steps[ch.id] = Array.from({ length: 16 }, (_, i) => idx.includes(i)); };
      on(channels[0], [0, 4, 8, 12]);
      on(channels[1], [4, 12]);
      on(channels[2], [2, 6, 10, 14]);
      on(channels[3], []);
      p1.notes[channels[4].id] = [0, 3, 6, 8, 11, 14].map((s, i) => ({ id: BF.uid('n'), start: s, len: 2, key: [36, 36, 39, 41, 41, 43][i], vel: 0.8 }));
      p.clips.push({ id: BF.uid('c'), kind: 'pattern', track: 0, start: 0, len: 4, patternId: p1.id });
      p.clips.push({ id: BF.uid('c'), kind: 'pattern', track: 0, start: 4, len: 4, patternId: p1.id });
    }
    return p;
  };

  // ---------- load / migrate / validate ----------
  /** Turn a v1 project (fixed 8 tracks, 8 lanes) into v2. */
  function migrateV1(raw) {
    const p = BF.newProject(false);
    p.name = raw.name || p.name;
    p.bpm = raw.bpm || 120;
    p.songBars = raw.songBars || 8;
    p.channels = [];
    const pat = p.patterns[0];
    (raw.tracks || []).forEach((t, i) => {
      const tonal = t.sound === 'bass' || t.sound === 'lead';
      const ch = tonal
        ? BF.newChannel('synth', t.name, { preset: t.sound === 'bass' ? 'Sub bass' : 'Bright lead' })
        : BF.newChannel('drum', t.name, { preset: { sound: t.sound } });
      Object.assign(ch, { volume: t.volume ?? 0.8, pan: t.pan ?? 0, mute: !!t.mute, insert: Math.min(BF.INSERTS, i + 1), pitch: t.pitch || 0 });
      if (tonal) {
        const key = (t.sound === 'bass' ? 36 : 72) + (t.pitch || 0);
        pat.notes[ch.id] = (t.steps || []).map((on, s) => (on ? { id: BF.uid('n'), start: s, len: 1.8, key, vel: 0.8 } : null)).filter(Boolean);
        ch.pitch = 0;
      } else {
        pat.steps[ch.id] = (t.steps || []).slice(0, 16).map(Boolean);
      }
      p.mixer[ch.insert].name = ch.name;
      p.channels.push(ch);
    });
    p.mixer[0].volume = raw.masterVolume ?? 0.8;
    (raw.patternBars || []).forEach((on, bar) => { if (on) p.clips.push({ id: BF.uid('c'), kind: 'pattern', track: 0, start: bar * 4, len: 4, patternId: pat.id }); });
    p.samples = raw.samples || {};
    (raw.clips || []).forEach((c) => p.clips.push({ id: c.id || BF.uid('c'), kind: 'audio', track: Math.min(BF.TRACKS - 1, (c.lane || 0) + 1), start: c.startBeat || 0, len: 0, sampleId: c.sampleId, mode: 'stretch', speed: c.speed || 1, pitch: 0, srcBpm: raw.bpm || 120, gain: 1 }));
    return p;
  }

  /** Check and repair a project loaded from a file. Throws a friendly Error if it is not a BeatForge project. */
  BF.normalizeProject = function (raw) {
    if (!raw || typeof raw !== 'object' || raw.app !== 'BeatForge') throw new Error('This is not a BeatForge project file.');
    if (raw.version > 2) throw new Error('This project was saved by a newer BeatForge version.');
    if (!raw.version || raw.version === 1) raw = migrateV1(raw);
    const str = (v, d, n = 60) => (typeof v === 'string' ? v.slice(0, n) : d);
    const p = BF.newProject(false);
    p.name = str(raw.name, 'Untitled', 120);
    p.bpm = Math.round(clamp(raw.bpm, 40, 300, 130) * 100) / 100;
    p.swing = clamp(raw.swing, 0, 1, 0);
    p.songBars = Math.round(clamp(raw.songBars, 1, 512, 16));
    p.markers = (Array.isArray(raw.markers) ? raw.markers : []).slice(0, 200).filter((m) => m && Number.isFinite(+m.beat))
      .map((m) => ({ beat: clamp(m.beat, 0, 4096, 0), name: str(m.name, 'Marker', 40) })).sort((a, b) => a.beat - b.beat);

    p.samples = {};
    if (raw.samples && typeof raw.samples === 'object') {
      for (const [id, s] of Object.entries(raw.samples)) {
        if (s && typeof s.base64 === 'string' && s.base64.length) p.samples[id] = { name: str(s.name, 'audio', 120), mime: str(s.mime, 'audio/wav'), base64: s.base64 };
      }
    }
    // community plugins this computer does not have: keep them as silent placeholders
    const ensureExt = (id, kind) => { if (typeof id === 'string' && /^ext:[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(id) && !BF.plugins.has(id) && BF.community) BF.community.placeholder(id, kind); };
    (Array.isArray(raw.channels) ? raw.channels : []).forEach((c) => c && ensureExt(c.plugin, 'instrument'));
    (Array.isArray(raw.mixer) ? raw.mixer : []).forEach((m) => m && Array.isArray(m.fx) && m.fx.forEach((f) => f && ensureExt(f.plugin, 'effect')));
    p.channels = (Array.isArray(raw.channels) ? raw.channels : []).slice(0, 128).filter((c) => c && BF.plugins.has(c.plugin) && BF.plugins.get(c.plugin).kind === 'instrument').map((c) => ({
      id: str(c.id, BF.uid('ch')),
      name: str(c.name, 'Channel'),
      plugin: c.plugin,
      params: BF.plugins.sanitize(c.plugin, c.params, p.samples),
      volume: clamp(c.volume, 0, 1.25, 0.78),
      pan: clamp(c.pan, -1, 1, 0),
      pitch: Math.round(clamp(c.pitch, -24, 24, 0)),
      mute: !!c.mute,
      insert: Math.round(clamp(c.insert, 0, BF.INSERTS, 0)),
    }));
    const chIds = new Set(p.channels.map((c) => c.id));
    p.patterns = (Array.isArray(raw.patterns) ? raw.patterns : []).slice(0, 999).map((pt, i) => {
      const length = Math.round(clamp(pt.length, 4, 256, 16));
      const steps = {};
      const notes = {};
      for (const [cid, arr] of Object.entries(pt.steps || {})) if (chIds.has(cid) && Array.isArray(arr)) steps[cid] = arr.slice(0, 256).map(Boolean);
      for (const [cid, arr] of Object.entries(pt.notes || {})) {
        if (!chIds.has(cid) || !Array.isArray(arr)) continue;
        notes[cid] = arr.slice(0, 20000).filter((n) => n && Number.isFinite(+n.start)).map((n) => ({
          id: str(n.id, BF.uid('n')),
          start: clamp(n.start, 0, 4096, 0),
          len: clamp(n.len, 0.05, 4096, 1),
          key: Math.round(clamp(n.key, 0, 127, 60)),
          vel: clamp(n.vel, 0, 1, 0.8),
          ...(n.mute ? { mute: true } : {}),
        }));
      }
      return { id: str(pt.id, BF.uid('p')), name: str(pt.name, `Pattern ${i + 1}`), color: /^#[0-9a-f]{6}$/i.test(pt.color) ? pt.color : BF.PATTERN_COLORS[i % 8], length, steps, notes };
    });
    if (!p.patterns.length) p.patterns = [BF.newPattern(1)];
    const patIds = new Set(p.patterns.map((x) => x.id));
    p.currentPattern = patIds.has(raw.currentPattern) ? raw.currentPattern : p.patterns[0].id;
    p.selectedChannel = chIds.has(raw.selectedChannel) ? raw.selectedChannel : p.channels[0]?.id || null;
    p.tracks = p.tracks.map((def, i) => {
      const t = (raw.tracks || [])[i] || {};
      return { id: str(t.id, def.id), name: str(t.name, def.name), mute: !!t.mute, insert: Math.round(clamp(t.insert, 0, BF.INSERTS, 0)) };
    });
    p.mixer = p.mixer.map((def, i) => {
      const m = (raw.mixer || [])[i] || {};
      return {
        id: str(m.id, def.id),
        name: str(m.name, def.name),
        volume: clamp(m.volume, 0, 1.25, 0.8),
        pan: clamp(m.pan, -1, 1, 0),
        mute: !!m.mute,
        solo: !!m.solo,
        route: i === 0 ? undefined : {
          master: m.route ? m.route.master !== false : true,
          sends: (m.route && Array.isArray(m.route.sends) ? m.route.sends : [])
            .filter((s) => s && Number.isInteger(s.to) && s.to >= 1 && s.to <= BF.INSERTS && s.to !== i)
            .slice(0, 16).map((s) => ({ to: s.to, level: clamp(s.level, 0, 1.25, 1) })),
        },
        fx: (Array.isArray(m.fx) ? m.fx : []).slice(0, 10).filter((f) => f && BF.plugins.has(f.plugin) && BF.plugins.get(f.plugin).kind === 'effect')
          .map((f) => ({ id: str(f.id, BF.uid('fx')), plugin: f.plugin, params: BF.plugins.sanitize(f.plugin, f.params), bypass: !!f.bypass })),
      };
    });
    const autoClips = (Array.isArray(raw.clips) ? raw.clips : []).filter((c) => c && c.kind === 'auto' && c.target && Array.isArray(c.points)).slice(0, 2000).map((c) => ({
      id: str(c.id, BF.uid('c')),
      kind: 'auto',
      track: Math.round(clamp(c.track, 0, BF.TRACKS - 1, 0)),
      start: clamp(c.start, 0, 4096, 0),
      len: clamp(c.len, 0.25, 4096, 16),
      target: {
        kind: ['ch', 'chp', 'mx', 'fx'].includes(c.target.kind) ? c.target.kind : 'mx',
        ...(typeof c.target.id === 'string' ? { id: c.target.id } : {}),
        ...(typeof c.target.field === 'string' ? { field: c.target.field === 'pan' ? 'pan' : 'volume' } : {}),
        ...(typeof c.target.param === 'string' ? { param: c.target.param } : {}),
        ...(Number.isFinite(c.target.insert) ? { insert: Math.round(clamp(c.target.insert, 0, BF.INSERTS, 0)) } : {}),
        ...(typeof c.target.fxId === 'string' ? { fxId: c.target.fxId } : {}),
      },
      points: c.points.slice(0, 5000).filter((pt) => pt && Number.isFinite(+pt.t)).map((pt) => ({ t: clamp(pt.t, 0, 4096, 0), v: clamp(pt.v, 0, 1, 0.5) })).sort((a, b) => a.t - b.t),
    })).filter((c) => c.points.length && BF.auto.describe(c.target, p));
    p.clips = (Array.isArray(raw.clips) ? raw.clips : []).slice(0, 20000).filter((c) => c && c.kind !== 'auto' && (c.kind === 'pattern' ? patIds.has(c.patternId) : p.samples[c.sampleId])).map((c) => ({
      id: str(c.id, BF.uid('c')),
      ...(c.muted ? { muted: true } : {}),
      kind: c.kind === 'pattern' ? 'pattern' : 'audio',
      track: Math.round(clamp(c.track, 0, BF.TRACKS - 1, 0)),
      start: clamp(c.start, 0, 4096, 0),
      len: clamp(c.len, 0, 4096, 0),
      ...(c.kind === 'pattern' ? { patternId: c.patternId } : {
        sampleId: c.sampleId,
        mode: ['stretch', 'resample', 'fit'].includes(c.mode) ? c.mode : 'stretch',
        speed: clamp(c.speed, 0.25, 4, 1),
        pitch: Math.round(clamp(c.pitch, -24, 24, 0)),
        srcBpm: clamp(c.srcBpm, 40, 300, 120),
        gain: clamp(c.gain, 0, 2, 1),
        ...(c.reverse ? { reverse: true } : {}),
      }),
    })).concat(autoClips);
    return p;
  };

  // ---------- helpers on the current project ----------
  BF.pattern = (id = BF.project.currentPattern) => BF.project.patterns.find((x) => x.id === id);
  BF.channel = (id = BF.project.selectedChannel) => BF.project.channels.find((x) => x.id === id);
  BF.patternBeats = (pt) => pt.length / 4;

  /** Is a mixer insert audible, taking solo into account? (Master is always "audible"; solo applies to inserts 1..16.) */
  BF.insertAudible = function (i, p = BF.project) {
    const m = p.mixer[i];
    if (m.mute) return false;
    if (i === 0) return true;
    const anySolo = p.mixer.some((x, j) => j > 0 && x.solo);
    return anySolo ? m.solo : true;
  };

  // ---------- store with undo/redo ----------
  // Snapshots leave out `samples` (big base64). Samples are only added, never edited, so snapshots share the live object.
  const listeners = new Set();
  let undoStack = [];
  let redoStack = [];
  let lastKey = null;
  let lastTime = 0;
  BF.dirty = false;

  const snap = (p) => JSON.stringify({ ...p, samples: undefined });
  const restore = (json) => {
    const samples = BF.project.samples;
    BF.project = { ...JSON.parse(json), samples };
  };

  BF.onChange = (fn) => listeners.add(fn);
  function emit(reason) { listeners.forEach((fn) => { try { fn(reason); } catch (e) { console.error(e); } }); }
  BF.emit = emit;

  /** Change the project. `mutate(project)` edits it in place. `key` merges rapid edits (dragging a knob) into one undo step. */
  BF.commit = function (mutate, key = null, reason = 'edit') {
    const now = performance.now();
    const merge = key && key === lastKey && now - lastTime < 900;
    if (!merge) {
      undoStack.push(snap(BF.project));
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack = [];
    }
    lastKey = key;
    lastTime = now;
    mutate(BF.project);
    BF.dirty = true;
    emit(reason);
  };

  /** UI-only changes (selected pattern/channel) that should not be undo steps. */
  BF.setView = function (mutate, reason = 'view') { mutate(BF.project); emit(reason); };

  BF.undo = function () {
    if (!undoStack.length) return false;
    redoStack.push(snap(BF.project));
    restore(undoStack.pop());
    lastKey = null;
    emit('undo');
    return true;
  };
  BF.redo = function () {
    if (!redoStack.length) return false;
    undoStack.push(snap(BF.project));
    restore(redoStack.pop());
    lastKey = null;
    emit('redo');
    return true;
  };
  BF.canUndo = () => undoStack.length > 0;
  BF.canRedo = () => redoStack.length > 0;

  BF.replaceProject = function (p) {
    BF.project = p;
    undoStack = [];
    redoStack = [];
    lastKey = null;
    BF.dirty = false;
    emit('load');
  };
})();
