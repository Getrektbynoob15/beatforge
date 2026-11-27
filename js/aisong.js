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
  // "cutoff 40-18000", "osc1 sine|square|sawtooth|triangle": what a plan may set on a plugin
  const brief = (d) => (d.params || []).filter((x) => x.type !== 'sample').map((x) => (x.type === 'select' ? `${x.id} ${x.options.map((o) => o[0]).join('|')}` : x.type === 'toggle' ? `${x.id} true|false` : `${x.id} ${+x.min.toFixed(3)}-${+x.max.toFixed(3)}`));
  A.catalog = function () {
    const drum = BF.plugins.get('drum');
    const sounds = drum ? drum.params[0].options.map(([v]) => v) : [];
    const instruments = [];
    BF.plugins.list('instrument').forEach((d) => {
      if (d.id === 'drum' || d.vst || d.ext) return;
      if ((d.params || []).some((p) => p.type === 'sample')) return; // needs an audio file
      instruments.push({ plugin: d.id, name: d.name, presets: Object.keys(d.presets || {}), params: brief(d) });
    });
    const effects = {};
    Object.entries(FX).forEach(([name, id]) => { const d = BF.plugins.get(id); if (d && !Object.values(effects).some((e) => e.plugin === id)) effects[name] = { plugin: id, params: brief(d) }; });
    return { kits: Object.keys(BF.KITS || {}), drumSounds: sounds, drumParams: drum ? brief(drum).filter((x) => !x.startsWith('sound')) : [], instruments, effects };
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

  // ---- chords: "Am", "F#m7", "Bbmaj7", "Csus4", "G7", "Ddim", "E5", "Fadd9" ----
  const QUAL = [
    ['maj7', [0, 4, 7, 11]], ['m7b5', [0, 3, 6, 10]], ['m7', [0, 3, 7, 10]], ['mmaj7', [0, 3, 7, 11]], ['7', [0, 4, 7, 10]],
    ['madd9', [0, 3, 7, 14]], ['add9', [0, 4, 7, 14]], ['m9', [0, 3, 7, 10, 14]], ['9', [0, 4, 7, 10, 14]],
    ['sus2', [0, 2, 7]], ['sus4', [0, 5, 7]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]], ['5', [0, 7]], ['m', [0, 3, 7]], ['', [0, 4, 7]],
  ];
  A.chord = function (name) {
    const m = /^\s*([A-Ga-g])([#b♯♭]?)(.*?)\s*$/.exec(String(name || ''));
    if (!m) return null;
    const root = NOTE[m[1].toLowerCase()] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0);
    const q = m[3].replace(/^min/, 'm').replace(/^maj$/, '').replace(/^M7/, 'maj7').toLowerCase();
    const hit = QUAL.find(([k]) => k === q) || QUAL.find(([k]) => k && q.startsWith(k)) || QUAL[QUAL.length - 1];
    return { root: ((root % 12) + 12) % 12, tones: hit[1] };
  };

  // note patterns for a chord progression. step 0..len; each chord lasts `each` steps
  const STYLES = {
    sustain: (each) => [[0, each]],
    half: (each) => [[0, each / 2], [each / 2, each / 2]],
    stabs: (each) => Array.from({ length: each / 4 }, (_, k) => [k * 4, 1.5]),            // on every beat
    offbeat: (each) => Array.from({ length: each / 4 }, (_, k) => [k * 4 + 2, 1.5]),      // between the beats
    stabs8: (each) => Array.from({ length: each / 2 }, (_, k) => [k * 2, 1]),
    syncopated: (each) => [0, 3, 6, 10, 12, 14].filter((x) => x < each).flatMap((x) => (each > 16 ? [x, x + 16] : [x])).filter((x) => x < each).map((x) => [x, 1.5]),
    pluck16: (each) => Array.from({ length: each }, (_, k) => [k, 0.75]),
  };
  const BASS_STYLES = {
    root: (each) => [[0, each, 0]],
    beats: (each) => Array.from({ length: each / 4 }, (_, k) => [k * 4, 3, 0]),
    offbeat: (each) => Array.from({ length: each / 4 }, (_, k) => [k * 4 + 2, 2, 0]),            // house / hardstyle "reverse bass" offbeats
    hardstyle: (each) => Array.from({ length: each / 4 }, (_, k) => [k * 4 + 1, 3, 0]),          // the tail after every kick
    rolling: (each) => Array.from({ length: each / 4 }, (_, k) => [[k * 4 + 1, 1, 0], [k * 4 + 2, 1, 0], [k * 4 + 3, 1, 0]]).flat(), // psy / rolling bass, kick on the beat
    eighths: (each) => Array.from({ length: each / 2 }, (_, k) => [k * 2, 1.5, k % 4 === 3 ? 12 : 0]),
    octaves: (each) => Array.from({ length: each / 2 }, (_, k) => [k * 2, 1.5, k % 2 ? 12 : 0]),
    trap: (each) => [[0, 6, 0], [7, 3, 0], [10, Math.max(2, each - 10), 0]].filter(([s]) => s < each),
    dnb: (each) => [[0, 3, 0], [6, 2, 0], [10, 4, 0]].filter(([s]) => s < each),
  };
  const ARPS = {
    up: (t) => t, down: (t) => t.slice().reverse(), updown: (t) => t.concat(t.slice(1, -1).reverse()), random: (t) => t,
  };

  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const text = (v, d, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d);

  // effect names the plan may use → plugin ids
  const FX = { distortion: 'distortion', drive: 'distortion', reverb: 'reverb', delay: 'delay', echo: 'delay', compressor: 'compressor', comp: 'compressor',
    filter: 'filter', eq: 'eq', chorus: 'chorus', phaser: 'phaser', flanger: 'flanger', width: 'width', stereo: 'width', sidechain: 'ducker', ducker: 'ducker',
    limiter: 'limiter', pump: 'shaper', shaper: 'shaper', multiband: 'multiband', utility: 'utility' };
  A.effects = () => Object.keys(FX);
  function overrides(plugin, wanted, warnings, what) { // only real parameters of that plugin, clamped
    const def = BF.plugins.get(plugin);
    if (!def || !wanted || typeof wanted !== 'object') return {};
    const out = {};
    Object.entries(wanted).forEach(([k, v]) => {
      if (v === undefined || k === 'sound') return;
      const pd = def.params.find((x) => x.id === k);
      if (!pd) { if (!['type', 'name', 'id'].includes(k)) warnings.push(`${what}: no setting "${k}".`); return; }
      if (pd.type === 'select') { const o = pd.options.find((x) => String(x[0]) === String(v) || String(x[1]).toLowerCase() === String(v).toLowerCase()); if (o) out[k] = o[0]; }
      else if (pd.type === 'toggle') out[k] = !!v;
      else if (pd.type !== 'sample' && Number.isFinite(Number(v))) out[k] = Math.min(pd.max, Math.max(pd.min, Number(v)));
    });
    return out;
  }

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
    const fxWanted = []; // [channel, fx list] → effects on that channel's insert (after everything exists, for sidechains)
    (Array.isArray(plan.instruments) ? plan.instruments : []).slice(0, 12).forEach((it, i) => {
      if (!it || typeof it !== 'object') return;
      const id = text(it.id, `inst${i + 1}`, 30);
      let def = cat.instruments.find((d) => d.plugin === it.plugin);
      if (!def) { def = cat.instruments.find((d) => d.presets.includes(it.preset)) || cat.instruments.find((d) => d.plugin === 'synth') || cat.instruments[0]; if (def) warnings.push(`Unknown instrument "${it.plugin}" for ${id}, used ${def.name}.`); }
      if (!def) return;
      const preset = def.presets.includes(it.preset) ? it.preset : undefined;
      if (it.preset && !preset) warnings.push(`Unknown preset "${it.preset}" for ${def.name}.`);
      const ch = add(def.plugin, preset, text(it.name, preset || def.name, 40), { volume: num(it.volume, 0, 1.25, 0.78), pan: num(it.pan, -1, 1, 0) });
      Object.assign(ch.params, overrides(def.plugin, it.params, warnings, `${id} params`));
      fxWanted.push([ch, it.fx]);
      insts.set(id, ch);
    });

    // ---- drums: one channel per sound used anywhere ----
    const drums = new Map();
    const drumOpts = new Map((BF.plugins.get('drum')?.params[0].options || []).map(([v, l]) => [v, l]));
    const drumSet = plan.drumSettings && typeof plan.drumSettings === 'object' ? plan.drumSettings : {};
    const drumCh = (sound) => {
      if (!drums.has(sound)) {
        const set = drumSet[sound] && typeof drumSet[sound] === 'object' ? drumSet[sound] : {};
        const ch = add('drum', { sound, ...((BF.KITS[kit] || {})[sound] || {}), ...overrides('drum', { ...set, fx: undefined, volume: undefined }, warnings, `${sound} settings`) }, drumOpts.get(sound) || sound);
        if (Number.isFinite(Number(set.volume))) ch.volume = num(set.volume, 0, 1.25, 0.78);
        fxWanted.push([ch, set.fx]);
        drums.set(sound, ch);
      }
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
      // generated parts: chords / bass / arps from a chord progression (so harmony and rhythm are right without
      // writing every note)
      const parts = [].concat(sec.chords || [], sec.bass || [], sec.arp || []).filter((x) => x && typeof x === 'object');
      const kindOf = (x) => (sec.bass === x || (Array.isArray(sec.bass) && sec.bass.includes(x)) ? 'bass' : sec.arp === x || (Array.isArray(sec.arp) && sec.arp.includes(x)) ? 'arp' : 'chords');
      parts.forEach((part) => {
        const ch = insts.get(part.inst || part.instrument);
        if (!ch) { warnings.push(`A ${kindOf(part)} part uses unknown instrument "${part.inst || part.instrument}".`); return; }
        const prog = (Array.isArray(part.prog) ? part.prog : Array.isArray(plan.prog) ? plan.prog : []).map(A.chord).filter(Boolean);
        if (!prog.length) { warnings.push(`A ${kindOf(part)} part has no chord progression.`); return; }
        const each = [4, 8, 16, 32, 64].includes(Number(part.each)) ? Number(part.each) : 16; // steps per chord
        const oct = Math.round(num(part.octave, 0, 7, kindOf(part) === 'bass' ? 2 : 4));
        const vel = num(part.vel, 0.05, 1, 0.8);
        const out = [];
        for (let at = 0, ci = 0; at < len; at += each, ci++) {
          const c = prog[ci % prog.length], base = (oct + 1) * 12 + c.root;
          const room = Math.min(each, len - at);
          if (kindOf(part) === 'bass') {
            const st = BASS_STYLES[part.style] || BASS_STYLES.root;
            st(each).forEach(([s, l, up]) => { if (s < room) out.push([at + s, Math.min(l, room - s), base + (up || 0), vel]); });
          } else if (kindOf(part) === 'arp') {
            const tones = (ARPS[part.style] || ARPS.up)(c.tones.concat(c.tones.map((t) => t + 12)).slice(0, Math.round(num(part.notes, 3, 8, 4))));
            const rate = [1, 2, 4].includes(Number(part.rate)) ? Number(part.rate) : 1; // steps per arp note
            for (let s = 0, k = 0; s < room; s += rate, k++) out.push([at + s, rate * 0.9, base + (part.style === 'random' ? tones[Math.floor(Math.random() * tones.length)] : tones[k % tones.length]), vel]);
          } else {
            const st = STYLES[part.style] || STYLES.sustain;
            const tones = c.tones.slice(0, 4).map((t) => base + t);
            if (part.bassNote) tones.unshift(base - 12);
            st(each).forEach(([s, l]) => { if (s < room) tones.forEach((k) => out.push([at + s, Math.min(l, room - s), k, vel])); });
          }
        }
        const list = out.filter(([, , k]) => k >= 12 && k <= 108).slice(0, Math.max(0, notesLeft)).map(([s, l, k, v]) => ({ id: BF.uid('n'), start: s, len: Math.max(0.25, l), key: k, vel: v }));
        notesLeft -= list.length;
        if (list.length) pt.notes[ch.id] = (pt.notes[ch.id] || []).concat(list);
      });
      p.patterns.push(pt);
      if (!byName.has(pt.name.toLowerCase())) byName.set(pt.name.toLowerCase(), pt);
    });
    if (!p.patterns.length) throw new Error('The song plan has no sections.');
    if (notesLeft <= 0) warnings.push(`Only the first ${MAX_NOTES} notes were used.`);

    // ---- effects on the channels' inserts (sidechain listens to the kick's insert) ----
    const kickIns = drums.get('kick')?.insert || drums.get('bass808')?.insert || 0;
    fxWanted.forEach(([ch, list]) => {
      if (!ch.insert || !Array.isArray(list)) return;
      list.slice(0, 6).forEach((f) => {
        const spec = typeof f === 'string' ? { type: f } : f && typeof f === 'object' ? f : null;
        const plugin = spec && FX[String(spec.type || '').toLowerCase()];
        if (!plugin || !BF.plugins.get(plugin)) { warnings.push(`Unknown effect "${spec && spec.type}".`); return; }
        const params = { ...BF.plugins.defaults(plugin), ...overrides(plugin, spec, warnings, `${ch.name} ${plugin}`) };
        if (plugin === 'ducker' && kickIns && kickIns !== ch.insert) params.source = String(kickIns);
        p.mixer[ch.insert].fx.push({ id: BF.uid('fx'), plugin, params, bypass: false });
      });
    });
    // master: glue and loudness (a limiter so nothing clips; louder for club genres when the plan asks)
    const loud = num(plan.loudness, 0, 12, 4);
    const lim = p.mixer[0].fx.find((f) => f.plugin === 'limiter'); // a new project already has one
    if (lim) Object.assign(lim.params, { gain: loud, ceiling: -0.8 });
    else p.mixer[0].fx.push({ id: BF.uid('fx'), plugin: 'limiter', params: { ...BF.plugins.defaults('limiter'), gain: loud, ceiling: -0.8 }, bypass: false });

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
