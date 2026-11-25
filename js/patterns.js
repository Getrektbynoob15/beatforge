/* patterns.js: pattern list actions (new, clone, rename, delete, next/previous) and the pattern selector. */
(function () {
  'use strict';
  const BF = window.BF;
  const PT = (BF.patterns = {});

  PT.add = function () {
    BF.commit((p) => {
      const n = p.patterns.length + 1;
      const pt = BF.newPattern(n);
      let k = n;
      while (p.patterns.some((x) => x.name === pt.name)) pt.name = `Pattern ${++k}`;
      p.patterns.push(pt);
      p.currentPattern = pt.id;
    });
    BF.playlist.pick = { kind: 'pattern' };
  };

  PT.clone = function (id) {
    BF.commit((p) => {
      const src = p.patterns.find((x) => x.id === id);
      const c = JSON.parse(JSON.stringify(src));
      c.id = BF.uid('p');
      c.name = `${src.name} (copy)`;
      Object.values(c.notes).forEach((arr) => arr.forEach((n) => { n.id = BF.uid('n'); }));
      c.color = BF.PATTERN_COLORS[p.patterns.length % BF.PATTERN_COLORS.length];
      p.patterns.splice(p.patterns.indexOf(src) + 1, 0, c);
      p.currentPattern = c.id;
    });
  };

  PT.rename = async function (id) {
    const pt = BF.project.patterns.find((x) => x.id === id);
    const n = await BF.ui.prompt('Pattern name', pt.name);
    if (n) BF.commit(() => { BF.project.patterns.find((x) => x.id === id).name = n; });
  };

  PT.del = function (id) {
    if (BF.project.patterns.length <= 1) { BF.ui.toast('A project needs at least one pattern.'); return; }
    BF.commit((p) => {
      p.patterns = p.patterns.filter((x) => x.id !== id);
      p.clips = p.clips.filter((c) => c.patternId !== id);
      if (p.currentPattern === id) p.currentPattern = p.patterns[0].id;
    });
  };

  PT.color = function (id) {
    BF.commit((p) => {
      const pt = p.patterns.find((x) => x.id === id);
      const i = BF.PATTERN_COLORS.indexOf(pt.color);
      pt.color = BF.PATTERN_COLORS[(i + 1) % BF.PATTERN_COLORS.length];
    });
  };

  /** Split a pattern into one pattern per channel, each on its own playlist track (like a classic DAW's
   *  "split by channel"). Every playlist clip of the pattern becomes one clip per channel, on tracks next to each other;
   *  the original pattern stays in the list. */
  PT.splitByChannel = function (id) {
    const p0 = BF.project, src = p0.patterns.find((x) => x.id === id);
    if (!src) return;
    const used = p0.channels.filter((ch) => (src.steps[ch.id] || []).some(Boolean) || (src.notes[ch.id] || []).length);
    if (used.length < 2) { BF.ui.toast('This pattern uses only one channel: nothing to split.'); return; }
    const parts = used.slice(0, BF.TRACKS);
    BF.commit((p) => {
      const pt = p.patterns.find((x) => x.id === id);
      const made = parts.map((ch) => {
        const np = { id: BF.uid('p'), name: `${pt.name} · ${ch.name}`, color: pt.color, length: pt.length, steps: {}, notes: {} };
        if (pt.steps[ch.id]) np.steps[ch.id] = [...pt.steps[ch.id]];
        if (pt.notes[ch.id]) np.notes[ch.id] = pt.notes[ch.id].map((n) => ({ ...n, id: BF.uid('n') }));
        return { np, ch };
      });
      p.patterns.splice(p.patterns.indexOf(pt) + 1, 0, ...made.map((m) => m.np));
      const old = p.clips.filter((c) => c.kind === 'pattern' && c.patternId === id);
      if (old.length) {
        // the first block of free tracks (no other clip where these clips are), starting at the top clip's track
        const others = p.clips.filter((c) => !old.includes(c));
        const busy = (tr) => others.some((o) => o.track === tr && old.some((c) => o.start < c.start + c.len && c.start < o.start + BF.audio.clipBeats(o, p.bpm)));
        const first = Math.min(...old.map((c) => c.track));
        let base = -1;
        for (let b = first; b + made.length <= BF.TRACKS && base < 0; b++) if (made.every((_, i) => !busy(b + i))) base = b;
        if (base < 0) for (let b = 0; b + made.length <= BF.TRACKS && base < 0; b++) if (made.every((_, i) => !busy(b + i))) base = b;
        if (base < 0) base = Math.max(0, Math.min(first, BF.TRACKS - made.length));
        old.forEach((c) => made.forEach((m, i) => p.clips.push({ ...c, id: BF.uid('c'), track: Math.min(BF.TRACKS - 1, base + i), patternId: m.np.id })));
        p.clips = p.clips.filter((c) => !old.includes(c));
        made.forEach((m, i) => { const t = p.tracks[base + i]; if (t && /^Track \d+$/.test(t.name)) t.name = m.ch.name; });
      }
      p.currentPattern = made[0].np.id;
    });
    BF.ui.toast(`Split into ${parts.length} patterns, one per channel, each on its own track.`);
  };

  PT.menu = (id) => [
    { label: 'Rename…', action: () => PT.rename(id) },
    { label: 'Clone', action: () => PT.clone(id) },
    { label: 'Split by channel', action: () => PT.splitByChannel(id) },
    { label: 'Next colour', action: () => PT.color(id) },
    { label: 'Delete pattern', action: () => PT.del(id) },
  ];

  /** Move to the next/previous pattern (FL-style numpad +/-). Going past the last one makes a new pattern. */
  PT.step = function (d) {
    const p = BF.project;
    const i = p.patterns.findIndex((x) => x.id === p.currentPattern);
    const j = i + d;
    if (j >= p.patterns.length) { PT.add(); return; }
    if (j < 0) return;
    BF.setView((q) => { q.currentPattern = q.patterns[j].id; }, 'pattern');
  };

  /** A copy of `pt` that starts `off` steps later (used when slicing a pattern clip). */
  PT.sliceCopy = function (p, pt, off) {
    const np = { id: BF.uid('p'), name: `${pt.name} (part)`, color: pt.color, length: Math.max(4, pt.length - off), steps: {}, notes: {} };
    for (const [cid, arr] of Object.entries(pt.steps)) np.steps[cid] = arr.slice(off);
    for (const [cid, arr] of Object.entries(pt.notes)) {
      const kept = arr.filter((n) => n.start >= off).map((n) => ({ ...n, id: BF.uid('n'), start: n.start - off }));
      if (kept.length) np.notes[cid] = kept;
    }
    p.patterns.splice(p.patterns.indexOf(pt) + 1, 0, np);
    return np;
  };

  /** The pattern drop-down in the top bar. */
  PT.syncSelect = function (sel) {
    const p = BF.project;
    sel.textContent = '';
    p.patterns.forEach((pt) => sel.add(new Option(pt.name, pt.id)));
    sel.add(new Option('+ New pattern', '__new'));
    sel.value = p.currentPattern;
  };
})();
