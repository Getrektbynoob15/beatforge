/* files.js: the file side of the browser, like a DAW's sample browser.
 *  - Packs: template / sample packs you imported (.zip or folder). Their audio, MIDI and project files are kept in this
 *    computer's browser storage (IndexedDB), so they are still in the browser next time.
 *  - Folders: folders on your computer you added ("Add a folder…"), read live (File System Access).
 * Click an audio file to hear it, drag it onto the playlist or channel rack, double-click to add it as a channel. */
(function () {
  'use strict';
  const BF = window.BF;
  const F = (BF.files = { packs: [], folders: [], expanded: new Set(), listings: new Map(), handles: new Map() });
  const DB = 'beatforge-files';
  const KIND = (name) => (/\.(wav|mp3|ogg|flac|m4a|aif|aiff)$/i.test(name) ? 'audio' : /\.midi?$/i.test(name) ? 'midi' : /\.flp$/i.test(name) ? 'flp' : /\.fst$/i.test(name) ? 'fst' : /\.(bfp)$/i.test(name) ? 'bfp' : null);
  F.kindOf = KIND;

  // ---------- storage ----------
  function db() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('packs')) d.createObjectStore('packs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('Browser storage is not available.'));
    });
  }
  async function tx(stores, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let res;
      Promise.resolve(fn(t, (r) => { res = r; })).catch(reject);
      t.oncomplete = () => { d.close(); resolve(res && 'result' in res ? res.result : res); };
      t.onerror = () => { d.close(); reject(t.error); };
      t.onabort = () => { d.close(); reject(t.error || new Error('Storage is full.')); };
    });
  }
  const getAll = (store) => tx([store], 'readonly', (t, set) => set(t.objectStore(store).getAll()));

  F.init = async function () {
    try {
      F.packs = (await getAll('packs')).sort((a, b) => a.name.localeCompare(b.name));
      F.folders = await getAll('folders');
    } catch (e) { console.warn('files', e); }
    BF.browser?.render?.(true);
  };

  /** Keep a pack: items = [{ path, file }]. Only files BeatForge can use are stored. Returns the pack. */
  F.addPack = async function (name, items) {
    const usable = items.filter((x) => x.file && KIND(x.file.name));
    // drop one shared top folder ("OPS - Free Uptempo Template/...")
    const tops = new Set(usable.map((x) => x.path.split('/')[0]));
    const strip = tops.size === 1 && usable.every((x) => x.path.includes('/')) ? `${[...tops][0]}/` : '';
    const id = BF.uid('pk');
    const pack = { id, name: name.slice(0, 80), addedAt: new Date().toISOString(), files: [] };
    BF.ui.busy(`Adding ${name} to the browser…`);
    try {
      await tx(['packs', 'blobs'], 'readwrite', (t) => {
        usable.forEach((x, i) => {
          const fid = `${id}-${i}`;
          const path = x.path.startsWith(strip) ? x.path.slice(strip.length) : x.path;
          pack.files.push({ id: fid, path, name: x.file.name, size: x.file.size, kind: KIND(x.file.name) });
          t.objectStore('blobs').put({ id: fid, blob: x.file });
        });
        t.objectStore('packs').put(pack);
      });
    } finally { BF.ui.busy(null); }
    F.packs = [...F.packs.filter((p) => p.name !== pack.name || p.id === id), pack].sort((a, b) => a.name.localeCompare(b.name));
    F.expanded.add(`p/${id}`);
    BF.browser.reveal?.('Packs');
    BF.browser.render(true);
    return pack;
  };

  F.removePack = async function (id) {
    const pack = F.packs.find((p) => p.id === id);
    if (!pack || !confirm(`Remove the pack "${pack.name}" from the browser? (Projects that use its sounds keep them.)`)) return;
    await tx(['packs', 'blobs'], 'readwrite', (t) => { pack.files.forEach((f) => t.objectStore('blobs').delete(f.id)); t.objectStore('packs').delete(id); });
    F.packs = F.packs.filter((p) => p.id !== id);
    BF.browser.render(true);
  };

  // ---------- folders on this computer ----------
  F.canAddFolders = () => typeof window.showDirectoryPicker === 'function';
  F.addFolder = async function () {
    if (!F.canAddFolders()) { BF.ui.toast('Adding folders needs Chrome / Edge or the BeatForge desktop app (2.8 or newer). You can still import packs (.zip or folder).', true); return; }
    let handle;
    try { handle = await window.showDirectoryPicker({ id: 'beatforge-browser', mode: 'read' }); } catch { return; }
    const f = { id: BF.uid('fd'), name: handle.name, handle };
    try { await tx(['folders'], 'readwrite', (t) => t.objectStore('folders').put(f)); } catch { /* not stored: still works this session */ }
    F.folders.push(f);
    F.expanded.add(`f/${f.id}`);
    await F.list(`f/${f.id}`, handle);
    BF.browser.render(true);
  };
  F.removeFolder = async function (id) {
    await tx(['folders'], 'readwrite', (t) => t.objectStore('folders').delete(id)).catch(() => {});
    F.folders = F.folders.filter((x) => x.id !== id);
    BF.browser.render(true);
  };

  /** Read one folder's contents (folders first, then usable files). key = tree key. */
  F.list = async function (key, handle) {
    try {
      if (handle.queryPermission && (await handle.queryPermission({ mode: 'read' })) !== 'granted') {
        if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') throw new Error('No permission to read this folder.');
      }
      const out = [];
      for await (const [name, h] of handle.entries()) {
        if (name.startsWith('.')) continue;
        if (h.kind === 'directory') out.push({ name, dir: true, handle: h });
        else if (KIND(name)) out.push({ name, dir: false, handle: h, kind: KIND(name) });
      }
      out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
      F.listings.set(key, out);
    } catch (e) {
      F.listings.set(key, []);
      BF.ui.toast(`Could not open the folder: ${e.message || e}`, true);
    }
  };

  // ---------- using a file ----------
  /** ref: 'p:<fileId>' (a pack file) or 'h:<key>' (a file in an added folder). Resolves to a File. */
  F.resolve = async function (ref) {
    if (ref.startsWith('p:')) {
      const id = ref.slice(2);
      const meta = F.packs.flatMap((p) => p.files).find((x) => x.id === id);
      const rec = await tx(['blobs'], 'readonly', (t, set) => set(t.objectStore('blobs').get(id)));
      if (!rec) throw new Error('That file is no longer in the pack.');
      return rec.blob instanceof File ? rec.blob : new File([rec.blob], meta ? meta.name : 'audio');
    }
    const h = F.handles.get(ref.slice(2));
    if (!h) throw new Error('That file is no longer available.');
    return h.getFile();
  };

  const decoded = new Map();
  let playing = null;
  F.preview = async function (ref) {
    try {
      const ctx = BF.audio.ensure();
      let buf = decoded.get(ref);
      if (!buf) {
        const file = await F.resolve(ref);
        if (file.size > 60 * 1024 * 1024) { BF.ui.toast('That file is too big to preview.'); return; }
        buf = await BF.audio.decode(await file.arrayBuffer());
        decoded.set(ref, buf);
        if (decoded.size > 40) decoded.delete(decoded.keys().next().value);
      }
      if (playing) { try { playing.stop(); } catch { /* ended */ } }
      BF.audio.stopPreview?.();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(BF.audio.graph.inserts[0].preview);
      src.start(ctx.currentTime + 0.005, 0, Math.min(buf.duration, 30));
      playing = src;
    } catch (e) { BF.ui.toast(`Can't play this file: ${e.message || e}`, true); }
  };
  F.stopPreview = () => { if (playing) { try { playing.stop(); } catch { /* */ } playing = null; } };

  /** Double-click / Enter: audio -> Sampler channel, MIDI -> notes, .flp -> open project, .fst -> load state. */
  F.use = async function (ref, kind) {
    try {
      const file = await F.resolve(ref);
      if (kind === 'audio') { await BF.io.importToRack([file]); BF.win.toggle('rack', true); }
      else if (kind === 'midi') await BF.midiImport(file, { name: file.name.replace(/\.midi?$/i, '') });
      else if (kind === 'flp') await BF.flp.importFile(file, packItemsFor(ref));
      else if (kind === 'fst') await BF.flp.importState(file);
      else if (kind === 'bfp') await BF.io.open(file);
    } catch (e) { BF.ui.toast(e.message || String(e), true); }
  };
  // an .flp from a pack: give it the pack's other files so its samples are found
  function packItemsFor(ref) {
    if (!ref.startsWith('p:')) return [];
    const pack = F.packs.find((p) => p.files.some((f) => `p:${f.id}` === ref));
    if (!pack) return [];
    return pack.files.filter((f) => f.kind === 'audio').map((f) => ({ path: f.path, file: { name: f.name, lazy: `p:${f.id}` } }));
  }

  /** Drop target helper: a dragged browser file onto the playlist (track, beat) or the rack. */
  F.dropOnPlaylist = async function (pl, track, beat) {
    try { const file = await F.resolve(pl.ref); await BF.io.importToPlaylist([file], track, beat); } catch (e) { BF.ui.toast(e.message || String(e), true); }
  };
  F.dropOnRack = async function (pl) {
    try { const file = await F.resolve(pl.ref); if (pl.fkind === 'midi') await BF.midiImport(file, { name: file.name.replace(/\.midi?$/i, '') }); else await BF.io.importToRack([file]); } catch (e) { BF.ui.toast(e.message || String(e), true); }
  };

  // ---------- tree items for the browser ----------
  const icon = { audio: '🔊', midi: '🎼', flp: '📄', fst: '⚙', bfp: '◆' };
  const fileItem = (name, ref, kind, depth, hintExtra = '') => ({
    label: name, depth, icon: icon[kind] || '·', file: true,
    hint: kind === 'audio' ? `${name}${hintExtra}: click to hear it, drag it onto the playlist or channel rack, double-click to add it as a channel.`
      : kind === 'midi' ? `${name}: drag it onto the playlist or channel rack, or double-click to import the notes.`
        : kind === 'flp' ? `${name}: double-click to open this FL Studio project.`
          : kind === 'fst' ? `${name}: double-click to load it (mixer state -> effects on the selected insert, preset -> a channel).`
            : `${name}: double-click to open.`,
    preview: kind === 'audio' ? () => F.preview(ref) : null,
    use: () => F.use(ref, kind),
    useLabel: kind === 'audio' ? 'Add as Sampler channel' : 'Open',
    drag: kind === 'audio' || kind === 'midi' ? { kind: 'file', ref, fkind: kind, name } : null,
  });
  const folderItem = (name, key, depth, extra = {}) => ({
    label: name, depth, icon: F.expanded.has(key) ? '📂' : '📁', folder: true, open: F.expanded.has(key),
    hint: `${name}: click to open or close`,
    use: () => F.toggle(key),
    ...extra,
  });

  F.toggle = async function (key) {
    if (F.expanded.has(key)) F.expanded.delete(key);
    else {
      F.expanded.add(key);
      if (key.startsWith('f/') && !F.listings.has(key)) {
        const h = F.folderHandle(key);
        if (h) await F.list(key, h);
      }
    }
    BF.browser.render(true);
  };
  F.folderHandle = function (key) {
    const parts = key.split('/');
    const root = F.folders.find((x) => x.id === parts[1]);
    if (!root) return null;
    if (parts.length === 2) return root.handle;
    const parentKey = parts.slice(0, -1).join('/');
    const entry = (F.listings.get(parentKey) || []).find((x) => x.dir && x.name === parts[parts.length - 1]);
    return entry ? entry.handle : null;
  };

  /** Items for the "Packs" section. q = search text (shows matching files flat). */
  F.packItems = function (q) {
    const out = [];
    F.packs.forEach((pack) => {
      if (q) {
        pack.files.filter((f) => f.name.toLowerCase().includes(q)).forEach((f) => out.push(fileItem(f.name, `p:${f.id}`, f.kind, 0, ` (${pack.name})`)));
        return;
      }
      const key = `p/${pack.id}`;
      out.push(folderItem(pack.name, key, 0, { menu: [{ label: 'Remove pack from the browser', action: () => F.removePack(pack.id) }] }));
      if (!F.expanded.has(key)) return;
      // build the folder tree from the paths
      const tree = { dirs: new Map(), files: [] };
      pack.files.forEach((f) => {
        const parts = f.path.split('/');
        let node = tree;
        parts.slice(0, -1).forEach((d) => { if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] }); node = node.dirs.get(d); });
        node.files.push(f);
      });
      const walk = (node, prefix, depth) => {
        [...node.dirs.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach((d) => {
          const k = `${prefix}/${d}`;
          out.push(folderItem(d, k, depth));
          if (F.expanded.has(k)) walk(node.dirs.get(d), k, depth + 1);
        });
        node.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).forEach((f) => out.push(fileItem(f.name, `p:${f.id}`, f.kind, depth)));
      };
      walk(tree, key, 1);
    });
    return out;
  };

  /** Items for the "Folders" section. */
  F.folderItems = function (q) {
    const out = [];
    const walk = (key, depth) => {
      (F.listings.get(key) || []).forEach((x) => {
        const k = `${key}/${x.name}`;
        if (x.dir) {
          if (!q) out.push(folderItem(x.name, k, depth));
          if (F.expanded.has(k)) walk(k, depth + 1);
        } else if (!q || x.name.toLowerCase().includes(q)) {
          F.handles.set(k, x.handle);
          out.push(fileItem(x.name, `h:${k}`, x.kind, q ? 0 : depth));
        }
      });
    };
    F.folders.forEach((fd) => {
      const key = `f/${fd.id}`;
      if (!q) out.push(folderItem(fd.name, key, 0, { menu: [{ label: 'Remove folder from the browser', action: () => F.removeFolder(fd.id) }] }));
      if (F.expanded.has(key) || q) walk(key, 1);
    });
    return out;
  };
})();
