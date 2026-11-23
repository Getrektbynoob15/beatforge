/* state.js: the project data model (single source of truth), undo/redo and change events.
 * Everything in `BF.project` is plain JSON. Decoded audio lives elsewhere (BF.audio.buffers). */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});

  const STEPS = 16;
  const TRACKS = 8;
  const LANES = 8;
  const HISTORY_LIMIT = 50;

  // Sounds the synth can make. Label is what the user sees.
  BF.SOUNDS = [
    { id: 'kick', label: 'Kick' },
    { id: 'snare', label: 'Snare' },
    { id: 'hihat', label: 'Hi-hat' },
    { id: 'openhat', label: 'Open hat' },
    { id: 'clap', label: 'Clap' },
    { id: 'tom', label: 'Tom' },
    { id: 'bass', label: 'Bass' },
    { id: 'lead', label: 'Lead' },
  ];
  BF.STEPS = STEPS;

  let counter = 0;
  BF.uid = (prefix) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  BF.clamp = clamp;

  function demoSteps(sound) {
    const s = new Array(STEPS).fill(false);
    const on = { kick: [0, 4, 8, 12], snare: [4, 12], hihat: [0, 2, 4, 6, 8, 10, 12, 14], clap: [], bass: [0, 3, 8, 11], lead: [], openhat: [], tom: [] }[sound] || [];
    on.forEach((i) => (s[i] = true));
    return s;
  }

  BF.newProject = function (withDemo = true) {
    const defaults = ['kick', 'snare', 'hihat', 'openhat', 'clap', 'tom', 'bass', 'lead'];
    return {
      app: 'BeatForge',
      version: 1,
      name: 'Untitled',
      bpm: 120,
      songBars: 8,
      masterVolume: 0.8,
      tracks: defaults.map((sound, i) => ({
        id: BF.uid('t'),
        name: BF.SOUNDS.find((x) => x.id === sound).label,
        sound,
        pitch: 0, // semitones, -12..12
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        steps: withDemo ? demoSteps(sound) : new Array(STEPS).fill(false),
      })),
      lanes: Array.from({ length: LANES }, (_, i) => ({ id: BF.uid('l'), name: `Lane ${i + 1}`, volume: 0.8, pan: 0, mute: false, solo: false })),
      patternBars: new Array(8).fill(true), // in Song mode: which bars play the step pattern
      clips: [], // { id, lane, sampleId, startBeat, speed }
      samples: {}, // sampleId -> { name, mime, base64 }
    };
  };

  /** Check and repair a project loaded from a file. Throws a friendly Error if it is not a BeatForge project. */
  BF.normalizeProject = function (raw) {
    if (!raw || typeof raw !== 'object' || raw.app !== 'BeatForge') throw new Error('This is not a BeatForge project file.');
    if (raw.version > 1) throw new Error('This project was saved by a newer BeatForge version.');
    const base = BF.newProject(false);
    const p = {
      ...base,
      name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : base.name,
      bpm: Math.round(clamp(raw.bpm, 60, 200, 120)),
      songBars: Math.round(clamp(raw.songBars, 1, 64, 8)),
      masterVolume: clamp(raw.masterVolume, 0, 1, 0.8),
    };
    const sounds = new Set(BF.SOUNDS.map((s) => s.id));
    p.tracks = base.tracks.map((def, i) => {
      const t = (raw.tracks || [])[i] || {};
      const steps = Array.isArray(t.steps) ? t.steps.slice(0, STEPS).map(Boolean) : [];
      while (steps.length < STEPS) steps.push(false);
      return {
        id: typeof t.id === 'string' ? t.id : def.id,
        name: typeof t.name === 'string' ? t.name.slice(0, 40) : def.name,
        sound: sounds.has(t.sound) ? t.sound : def.sound,
        pitch: Math.round(clamp(t.pitch, -12, 12, 0)),
        volume: clamp(t.volume, 0, 1, 0.8),
        pan: clamp(t.pan, -1, 1, 0),
        mute: !!t.mute,
        solo: !!t.solo,
        steps,
      };
    });
    p.lanes = base.lanes.map((def, i) => {
      const l = (raw.lanes || [])[i] || {};
      return {
        id: typeof l.id === 'string' ? l.id : def.id,
        name: typeof l.name === 'string' ? l.name.slice(0, 40) : def.name,
        volume: clamp(l.volume, 0, 1, 0.8),
        pan: clamp(l.pan, -1, 1, 0),
        mute: !!l.mute,
        solo: !!l.solo,
      };
    });
    p.samples = {};
    if (raw.samples && typeof raw.samples === 'object') {
      for (const [id, s] of Object.entries(raw.samples)) {
        if (s && typeof s.base64 === 'string' && s.base64.length) {
          p.samples[id] = { name: String(s.name || 'audio').slice(0, 120), mime: String(s.mime || 'audio/wav'), base64: s.base64 };
        }
      }
    }
    p.clips = (Array.isArray(raw.clips) ? raw.clips : [])
      .filter((c) => c && p.samples[c.sampleId])
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id : BF.uid('c'),
        lane: Math.round(clamp(c.lane, 0, LANES - 1, 0)),
        sampleId: c.sampleId,
        startBeat: clamp(c.startBeat, 0, 64 * 4, 0),
        speed: clamp(c.speed, 0.5, 2, 1),
      }));
    p.patternBars = resizeBars(Array.isArray(raw.patternBars) ? raw.patternBars.map(Boolean) : [], p.songBars);
    return p;
  };

  function resizeBars(bars, n) {
    const out = bars.slice(0, n);
    while (out.length < n) out.push(true);
    return out;
  }
  BF.resizeBars = resizeBars;

  // ---------- store with undo/redo ----------
  // Snapshots leave out `samples` (big base64 strings). Samples are only ever added, never edited,
  // so every snapshot can share the one live samples object.
  const listeners = new Set();
  let undoStack = [];
  let redoStack = [];
  let lastKey = null;
  let lastTime = 0;

  const snap = (p) => JSON.stringify({ ...p, samples: undefined });
  const restore = (json) => {
    const samples = BF.project.samples;
    BF.project = { ...JSON.parse(json), samples };
  };

  BF.project = BF.newProject(true);

  BF.onChange = (fn) => listeners.add(fn);
  function emit(reason) { listeners.forEach((fn) => { try { fn(reason); } catch (e) { console.error(e); } }); }
  BF.emit = emit;

  /**
   * Change the project. `mutate(project)` edits it in place.
   * `key` merges rapid edits of the same control (like dragging a slider) into one undo step.
   */
  BF.commit = function (mutate, key = null, reason = 'edit') {
    const now = performance.now();
    const merge = key && key === lastKey && now - lastTime < 800;
    if (!merge) {
      undoStack.push(snap(BF.project));
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack = [];
    }
    lastKey = key;
    lastTime = now;
    mutate(BF.project);
    emit(reason);
  };

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

  /** Replace the whole project (New / Open). Clears history. */
  BF.replaceProject = function (p) {
    BF.project = p;
    undoStack = [];
    redoStack = [];
    lastKey = null;
    emit('load');
  };

  /** Is a mixer channel audible, taking solo on any channel into account? */
  BF.audible = function (ch) {
    const p = BF.project;
    const anySolo = p.tracks.some((t) => t.solo) || p.lanes.some((l) => l.solo);
    if (ch.mute) return false;
    return anySolo ? ch.solo : true;
  };
})();
