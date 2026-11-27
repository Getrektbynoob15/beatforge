/* aisong.js: turn a small song plan (written by an AI, e.g. the ADHW Discord bot) into a normal BeatForge project.
 * The plan only says what to play; this file picks real instruments, makes one pattern per section and lays the
 * sections out in the playlist. Everything is checked and clamped, so a sloppy plan still gives a valid project.
 *
 * Plan (JSON):
 * {
 *   "title": "Night drive", "bpm": 140, "swing": 0 (0..1), "kit": "Trap kit",
 *   "instruments": [ { "id": "bass", "plugin": "synth", "preset": "808 glide", "name": "808", "volume": 0.8 } ],
 *   "sections": [
 *     { "name": "Intro", "bars": 2,
 *       "drums": { "kick": "x-------x-x-----", "hihat": "x-x-x-x-x-x-x-x-" },   // 1 char per 16th, x = hit
 *       "notes": { "bass": [[0, 6, "C2"], [8, 4, "Eb2"]] } }                       // [startStep, lengthSteps, note]
 *   ],
 *   "arrangement": ["Intro", "Verse", "Chorus", "Verse", "Chorus"]
 * }
 * Drum strings shorter than the section repeat; "X" or "!" is an accent. Notes may be names ("C#3") or MIDI numbers. */
(function () {
  'use strict';
  const BF = window.BF;
  const A = (BF.aiSong = {});
  const MAX_BARS = 16, MAX_SECTIONS = 12, MAX_CLIPS = 64, MAX_NOTES = 2000, MAX_SONG_BARS = 96; // ~3 minutes at 128 BPM

  /** What the plan may use: drum kits and sounds, instrument plugins and their presets. */
  A.catalog = function () {
    const drum = BF.plugins.get('drum');
    const sounds = drum ? drum.params[0].options.map(([v]) => v) : [];
    const instruments = [];
    BF.plugins.list('instrument').forEach((d) => {
      if (d.id === 'drum' || d.vst || d.ext) return;
      if ((d.params || []).some((p) => p.type === 'sample')) return; // needs an audio file
      instruments.push({ plugin: d.id, name: d.name, presets: Object.keys(d.presets || {}) });
    });
    return { kits: Object.keys(BF.KITS || {}), drumSounds: sounds, instruments };
  };

  const NOTE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  /** "C4" = 60 (middle C), "F#2", "Bb3", or a MIDI number. */
  A.noteNum = function (n) {
    if (typeof n === 'number' && Number.isFinite(n)) return Math.round(n);
    const m = /^\s*([a-gA-G])\s*([#b♯♭]?)\s*(-?\d)\s*$/.exec(String(n));
    if (!m) return null;
    const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
    return (Number(m[3]) + 1) * 12 + NOTE[m[1].toLowerCase()] + acc;
  };

  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const text = (v, d, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d);

  /** Build a project from a plan. Returns { project, warnings }. */
  A.build = function (plan) {
    if (!plan || typeof plan !== 'object') throw new Error('The song plan is empty.');
    const warnings = [];
    const cat = A.catalog();
    const p = BF.newProject(false);
    p.name = text(plan.title, 'AI beat');
    p.bpm = Math.round(num(plan.bpm, 50, 220, 120));
    p.swing = num(plan.swing, 0, 1, 0);
    p.channels = [];
    p.patterns = [];
    p.clips = [];
    const kit = cat.kits.includes(plan.kit) ? plan.kit : (cat.kits[0] || null);
    if (plan.kit && plan.kit !== kit) warnings.push(`Unknown kit "${plan.kit}", used ${kit}.`);

    const add = (plugin, preset, name, fields = {}) => {
      const ch = BF.newChannel(plugin, name, { preset });
      Object.assign(ch, fields);
      ch.insert = BF.rack && BF.rack.freeInsert ? BF.rack.freeInsert(p) : 0;
      if (ch.insert) p.mixer[ch.insert].name = ch.name;
      p.channels.push(ch);
      return ch;
    };

    // ---- instruments ----
    const insts = new Map();
    (Array.isArray(plan.instruments) ? plan.instruments : []).slice(0, 12).forEach((it, i) => {
      if (!it || typeof it !== 'object') return;
      const id = text(it.id, `inst${i + 1}`, 30);
      let def = cat.instruments.find((d) => d.plugin === it.plugin);
      if (!def) { def = cat.instruments.find((d) => d.presets.includes(it.preset)) || cat.instruments.find((d) => d.plugin === 'synth') || cat.instruments[0]; if (def) warnings.push(`Unknown instrument "${it.plugin}" for ${id}, used ${def.name}.`); }
      if (!def) return;
      const preset = def.presets.includes(it.preset) ? it.preset : undefined;
      if (it.preset && !preset) warnings.push(`Unknown preset "${it.preset}" for ${def.name}.`);
      const ch = add(def.plugin, preset, text(it.name, preset || def.name, 40), { volume: num(it.volume, 0, 1.25, 0.78), pan: num(it.pan, -1, 1, 0) });
      insts.set(id, ch);
    });

    // ---- drums: one channel per sound used anywhere ----
    const drums = new Map();
    const drumOpts = new Map((BF.plugins.get('drum')?.params[0].options || []).map(([v, l]) => [v, l]));
    const drumCh = (sound) => {
      if (!drums.has(sound)) drums.set(sound, add('drum', { sound, ...((BF.KITS[kit] || {})[sound] || {}) }, drumOpts.get(sound) || sound));
      return drums.get(sound);
    };

    // ---- sections → patterns ----
    const byName = new Map();
    let notesLeft = MAX_NOTES;
    (Array.isArray(plan.sections) ? plan.sections : []).slice(0, MAX_SECTIONS).forEach((sec, i) => {
      if (!sec || typeof sec !== 'object') return;
      const bars = Math.round(num(sec.bars, 1, MAX_BARS, 1));
      const len = bars * 16;
      const pt = BF.newPattern(i + 1);
      pt.name = text(sec.name, `Section ${i + 1}`, 40);
      pt.length = len;
      Object.entries(sec.drums && typeof sec.drums === 'object' ? sec.drums : {}).forEach(([sound, pat]) => {
        if (!drumOpts.has(sound)) { warnings.push(`Unknown drum sound "${sound}".`); return; }
        const s = String(Array.isArray(pat) ? '' : pat || '').replace(/\s|\|/g, '');
        let steps;
        if (Array.isArray(pat)) { const set = new Set(pat.map((x) => Math.round(Number(x)))); steps = Array.from({ length: len }, (_, k) => set.has(k) || set.has(k % 16)); }
        else if (s) steps = Array.from({ length: len }, (_, k) => /[xX!o1*]/.test(s[k % s.length]));
        else return;
        if (steps.some(Boolean)) pt.steps[drumCh(sound).id] = steps;
      });
      Object.entries(sec.notes && typeof sec.notes === 'object' ? sec.notes : {}).forEach(([id, list]) => {
        const ch = insts.get(id);
        if (!ch) { warnings.push(`Notes for unknown instrument "${id}".`); return; }
        if (!Array.isArray(list)) return;
        const out = [];
        list.forEach((n) => {
          if (notesLeft <= 0) return;
          const [start, l, key, vel] = Array.isArray(n) ? n : [n?.start, n?.len, n?.note ?? n?.key, n?.vel];
          const k = A.noteNum(key), st = Math.round(num(start, -1, len, -1)), ln = num(l, 0.25, len, 1);
          if (k === null || st < 0 || st >= len) return;
          out.push({ id: BF.uid('n'), start: st, len: Math.min(ln, len - st), key: Math.min(108, Math.max(12, k)), vel: num(vel, 0.05, 1, 0.8) });
          notesLeft--;
        });
        if (out.length) pt.notes[ch.id] = (pt.notes[ch.id] || []).concat(out);
      });
      p.patterns.push(pt);
      if (!byName.has(pt.name.toLowerCase())) byName.set(pt.name.toLowerCase(), pt);
    });
    if (!p.patterns.length) throw new Error('The song plan has no sections.');
    if (notesLeft <= 0) warnings.push(`Only the first ${MAX_NOTES} notes were used.`);

    // ---- arrangement → playlist ----
    let order = (Array.isArray(plan.arrangement) ? plan.arrangement : []).map((n) => byName.get(String(n).toLowerCase())).filter(Boolean);
    if (!order.length) order = p.patterns.slice();
    let beat = 0;
    order.slice(0, MAX_CLIPS).forEach((pt) => {
      const L = BF.patternBeats(pt);
      if (beat + L > MAX_SONG_BARS * 4) { if (!warnings.some((w) => w.startsWith('The song'))) warnings.push(`The song was cut at ${MAX_SONG_BARS} bars.`); return; }
      p.clips.push({ id: BF.uid('c'), kind: 'pattern', track: 0, start: beat, len: L, patternId: pt.id });
      beat += L;
    });
    if (!p.channels.length) throw new Error('The song plan has no drums or instruments.');
    p.selectedChannel = p.channels[0].id;
    p.currentPattern = p.patterns[0].id;
    return { project: BF.normalizeProject(JSON.parse(JSON.stringify(p))), warnings };
  };
})();
