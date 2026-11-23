/* packimport.js: import a "template pack" (a .zip or a folder like the ones sold/shared for other DAWs) into a new project.
 *  - stems (audio in a folder called stems, or long audio files) -> one playlist track + mixer insert each, all from bar 1
 *  - MIDI files -> channels with notes, also from bar 1 (their tempo is used)
 *  - short audio (kicks, one-shots, loops) -> added to the project, ready in the browser under "Project · Audio"
 *  - DAW project files (.flp, .als…) and plugin presets (.fst, .fxp…) cannot be used and are listed as skipped
 * Zip files are read here (stored and deflate entries) with the browser's own DecompressionStream. */
(function () {
  'use strict';
  const BF = window.BF;
  const PI = (BF.packImport = {});
  const AUDIO = /\.(wav|mp3|ogg|flac|m4a|aif|aiff)$/i;
  const MIDI = /\.midi?$/i;
  const STEM_SEC = 30; // audio longer than this is treated as a stem
  const MAX_PACK = 1500 * 1024 * 1024;

  // ---------- zip ----------
  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(out);
  }
  /** Files in a zip as [{ path, file }] (folders and macOS junk skipped). */
  PI.readZip = async function (zipFile) {
    const buf = new Uint8Array(await zipFile.arrayBuffer());
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This is not a zip file (or it is damaged).');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error('This zip is too big (zip64). Unzip it first and import the folder.');
    const dec = new TextDecoder();
    const out = [];
    for (let n = 0; n < count; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file is damaged.');
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true), elen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true);
      const path = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      if (path.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store)/.test(path)) continue;
      if (v.getUint32(local, true) !== 0x04034b50) throw new Error('The zip file is damaged.');
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = buf.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = await inflate(raw);
      else { out.push({ path, file: null, why: 'unsupported compression' }); continue; }
      out.push({ path, file: new File([data], path.split('/').pop()) });
    }
    return out;
  };

  /** Files from a dropped folder (DataTransferItem entries). */
  PI.readEntries = async function (entries) {
    const out = [];
    const walk = async (entry, base) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ path: base + entry.name, file });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const e of batch) await walk(e, `${base}${entry.name}/`);
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e, '');
    return out;
  };

  const audioSeconds = (id) => BF.audio.buffers.get(id)?.duration || 0;
  const pretty = (name) => name.replace(/\.[^.]+$/, '').replace(/^.*? - /, '').trim().slice(0, 40) || name;

  /** Build a new project from a list of { path, file }. */
  PI.importFiles = async function (items, packName) {
    if (BF.dirty && !confirm('Import the pack as a new project? Unsaved changes in this one are lost.')) return;
    const total = items.reduce((a, x) => a + (x.file?.size || 0), 0);
    if (total > MAX_PACK) { BF.ui.toast(`This pack is ${(total / 1048576).toFixed(0)} MB; the limit is 1500 MB.`, true); return; }
    BF.transport.stop();
    const p = BF.newProject(false);
    p.name = packName || 'Imported pack';
    p.channels = [];
    p.patterns[0].steps = {}; p.patterns[0].notes = {};
    BF.audio.buffers.clear();
    BF.replaceProject(p);
    const skipped = [], stems = [], shots = [], midis = [];
    for (const it of items) {
      const name = it.path.split('/').pop();
      if (!it.file) { skipped.push(`${name} (${it.why})`); continue; }
      if (MIDI.test(name)) midis.push(it);
      else if (AUDIO.test(name)) (/(^|\/)stems?\//i.test(it.path) ? stems : shots).push(it);
      else if (/\.(flp|als|logicx|ptx|cpr|rpp|song)$/i.test(name)) skipped.push(`${name} (another DAW's project file)`);
      else if (/\.(fst|fxp|fxb|vstpreset|nmsv|h2p|serumpreset)$/i.test(name)) skipped.push(`${name} (a plugin preset; needs that plugin)`);
      else if (!/\.(txt|pdf|png|jpe?g|nfo|url|ds_store)$/i.test(name)) skipped.push(name);
    }
    let tempo = null;
    // 1. MIDI first (it can set the tempo), each file as its own channel(s), all from bar 1
    for (const it of midis) {
      try {
        BF.ui.busy(`Importing ${it.file.name}…`);
        const r = await BF.midiImport(it.file, { at: 0, quiet: true, name: pretty(it.file.name), setTempo: !tempo });
        if (r && r.tempo && !tempo) tempo = r.tempo;
      } catch (e) { skipped.push(`${it.file.name} (${e.message || e})`); }
    }
    // 2. audio: decode, then decide stem (long or in a stems folder) or one-shot
    const decoded = [];
    for (const it of [...stems, ...shots]) {
      BF.ui.busy(`Loading ${it.file.name}…`);
      const id = await BF.io.addSample(it.file);
      if (!id) { skipped.push(`${it.file.name} (could not be decoded)`); continue; }
      const isStem = stems.includes(it) || (audioSeconds(id) > STEM_SEC && !/full|master|mixdown|preview|demo/i.test(it.file.name));
      decoded.push({ id, it, isStem });
    }
    const stemList = decoded.filter((d) => d.isStem);
    let placed = 0;
    BF.commit((q) => {
      stemList.forEach((d) => {
        const used = new Set(q.clips.map((c) => c.track));
        const t = q.tracks.findIndex((_, k) => !used.has(k));
        if (t < 0) { skipped.push(`${d.it.file.name} (all ${BF.TRACKS} playlist tracks are full)`); return; }
        const name = pretty(d.it.file.name);
        q.tracks[t].name = name;
        const taken = new Set([...q.channels.map((c) => c.insert), ...q.tracks.map((x) => x.insert || 0)]);
        let ins = 0;
        for (let i = 1; i <= BF.INSERTS; i++) if (!taken.has(i)) { ins = i; break; }
        if (ins) { q.tracks[t].insert = ins; q.mixer[ins].name = name; }
        q.clips.push({ id: BF.uid('c'), kind: 'audio', track: t, start: 0, len: 0, sampleId: d.id, mode: 'stretch', speed: 1, pitch: 0, srcBpm: q.bpm, gain: 1 });
        placed++;
      });
      q.songBars = Math.max(q.songBars, Math.ceil(Math.max(0, ...q.clips.map((c) => c.start + BF.audio.clipBeats(c))) / 4));
    });
    BF.ui.busy(null);
    if (BF.transport.mode !== 'song') BF.transport.setMode('song');
    BF.dirty = true;
    BF.browser.render();
    const shotsN = decoded.length - stemList.length;
    BF.ui.toast(`Imported "${p.name}": ${placed} stem${placed === 1 ? '' : 's'} on the playlist, ${midis.length} MIDI file${midis.length === 1 ? '' : 's'}, ${shotsN} sound${shotsN === 1 ? '' : 's'} in the browser (Project · Audio)${tempo ? `, ${Math.round(tempo)} BPM` : ''}.${skipped.length ? ` Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'} BeatForge can't use (Help → Last import: skipped files).` : ''} Save it with File → Save as template.`);
    PI.lastSkipped = skipped;
  };

  /** File menu: pick a .zip (or a folder) and import it. */
  PI.pick = function (folder = false) {
    const inp = document.createElement('input');
    inp.type = 'file';
    if (folder) { inp.webkitdirectory = true; inp.multiple = true; } else inp.accept = '.zip,application/zip';
    inp.addEventListener('change', async () => {
      const files = [...inp.files];
      if (!files.length) return;
      try {
        if (!folder) {
          BF.ui.busy(`Unpacking ${files[0].name}…`);
          const items = await PI.readZip(files[0]);
          await PI.importFiles(items, files[0].name.replace(/\.zip$/i, ''));
        } else {
          const items = files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
          await PI.importFiles(items, (files[0].webkitRelativePath || '').split('/')[0] || 'Imported pack');
        }
      } catch (e) {
        BF.ui.toast(`Import failed: ${e.message || e}`, true);
      } finally { BF.ui.busy(null); }
    });
    inp.click();
  };

  PI.showSkipped = function () {
    const list = PI.lastSkipped || [];
    BF.ui.toast(list.length ? `Not imported: ${list.slice(0, 12).join(' · ')}${list.length > 12 ? ` … and ${list.length - 12} more` : ''}` : 'The last import used every file.');
  };
})();
