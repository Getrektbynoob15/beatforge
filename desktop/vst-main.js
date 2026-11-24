// VST3 support for the desktop app: starts the BeatForge Plugin Host (vsthost/bfvsthost.cpp, a separate process so a
// crashing plugin can't take BeatForge down) and passes messages between it and the page.
//   - commands (scan, load, state, knobs, plugin windows) go through ipcMain.handle('vst:call')
//   - audio for live playback goes through a MessagePort per instrument, straight from the page's audio thread
// Safety: the page can only load plugin files that a scan of the standard VST3 folders (or a folder the user picked
// in a dialog) found, so a project or a session guest can never make BeatForge load some other file.
'use strict';
const { ipcMain, dialog, MessageChannelMain, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const exe = () => {
  const name = process.platform === 'win32' ? 'bfvsthost.exe' : 'bfvsthost';
  const packed = path.join(process.resourcesPath || '', name);
  if (fs.existsSync(packed)) return packed;
  const dev = path.join(__dirname, '..', 'vsthost', 'build', name);
  return fs.existsSync(dev) ? dev : null;
};
const cfgFile = () => path.join(app.getPath('userData'), 'vst.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return { folders: [] }; } };
const writeCfg = (c) => fs.writeFileSync(cfgFile(), JSON.stringify(c));

let proc = null, buf = Buffer.alloc(0), seq = 0, win = null;
const waits = new Map();     // helper request id -> resolve
const scanned = new Set();   // plugin files the page may load
const loaded = new Set();    // instance ids alive in the helper

function frame(fields, bin) {
  const head = Buffer.from(fields.join('\t'));
  const hd = Buffer.alloc(8);
  if (bin && !Buffer.isBuffer(bin)) bin = Buffer.from(bin.buffer ? new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength) : bin);
  hd.writeUInt32LE(head.length, 0); hd.writeUInt32LE(bin ? bin.length : 0, 4);
  return bin && bin.length ? Buffer.concat([hd, head, bin]) : Buffer.concat([hd, head]);
}

function start() {
  if (proc) return true;
  const file = exe();
  if (!file) return false;
  proc = spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  buf = Buffer.alloc(0);
  proc.stdout.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      if (buf.length < 8) break;
      const hl = buf.readUInt32LE(0), bl = buf.readUInt32LE(4);
      if (buf.length < 8 + hl + bl) break;
      let h = null;
      try { h = JSON.parse(buf.subarray(8, 8 + hl).toString('utf8')); } catch { /* skip */ }
      const b = Buffer.from(buf.subarray(8 + hl, 8 + hl + bl));
      buf = buf.subarray(8 + hl + bl);
      if (!h) continue;
      if (h.ev) { if (h.ev !== 'log' && win && !win.isDestroyed()) win.webContents.send('vst:event', h); continue; }
      const w = waits.get(h.id);
      if (w) { waits.delete(h.id); w(h, b); }
    }
  });
  proc.on('exit', () => {
    proc = null;
    waits.forEach((w) => w({ error: 'The plugin host stopped (a plugin may have crashed).' }, Buffer.alloc(0)));
    waits.clear();
    const had = loaded.size > 0;
    loaded.clear();
    if (had && win && !win.isDestroyed()) win.webContents.send('vst:event', { ev: 'crashed' });
  });
  proc.stdin.on('error', () => {});
  return true;
}

function call(fields, bin) {
  return new Promise((resolve) => {
    if (!start()) return resolve({ h: { error: 'VST plugins need the BeatForge Plugin Host, which is not part of this version for this computer.' }, b: null });
    const id = `m${++seq}`;
    waits.set(id, (h, b) => resolve({ h, b }));
    proc.stdin.write(frame([id, ...fields], bin));
  });
}

const INST = /^[A-Za-z0-9_-]{1,64}$/;
const num = (v) => String(Number.isFinite(+v) ? +v : 0);

async function scan() {
  const { folders } = readCfg();
  const r = await call(['scan', ...folders.filter((f) => typeof f === 'string' && fs.existsSync(f))]);
  if (r.h.error) return { error: r.h.error };
  scanned.clear();
  (r.h.plugins || []).forEach((p) => scanned.add(p.path));
  return { plugins: r.h.plugins || [], folders };
}

function setup(getWin) {
  ipcMain.handle('vst:call', async (_e, cmd, a = {}) => {
    win = getWin();
    try {
      switch (cmd) {
        case 'available': return { ok: !!exe(), platform: process.platform };
        case 'scan': return await scan();
        case 'addFolder': {
          const r = await dialog.showOpenDialog(win, { title: 'Add a folder with VST3 plugins', properties: ['openDirectory'] });
          if (r.canceled || !r.filePaths[0]) return { canceled: true };
          const c = readCfg();
          if (!c.folders.includes(r.filePaths[0])) c.folders.push(r.filePaths[0]);
          writeCfg(c);
          return await scan();
        }
        case 'removeFolder': { const c = readCfg(); c.folders = c.folders.filter((f) => f !== a.folder); writeCfg(c); return await scan(); }
        case 'load': {
          if (!INST.test(a.inst) || !/^[0-9A-F]{32}$/i.test(a.cid)) return { error: 'Bad request.' };
          if (!scanned.size) await scan();
          if (!scanned.has(a.path)) return { error: 'That plugin was not found in your VST3 folders.' };
          const r = await call(['load', a.inst, a.path, a.cid, num(a.rate), num(a.block || 512)]);
          if (!r.h.error) loaded.add(a.inst);
          return r.h;
        }
        case 'unload': if (!INST.test(a.inst)) return { error: 'Bad request.' }; loaded.delete(a.inst); return (await call(['unload', a.inst])).h;
        case 'getState': { if (!INST.test(a.inst)) return { error: 'Bad request.' }; const r = await call(['getstate', a.inst]); return r.h.error ? r.h : { state: r.b }; }
        case 'setState': { if (!INST.test(a.inst) || !a.state) return { error: 'Bad request.' }; return (await call(['setstate', a.inst], Buffer.from(a.state))).h; }
        case 'setParam': if (!INST.test(a.inst)) return { error: 'Bad request.' }; return (await call(['setparam', a.inst, String(a.id >>> 0), num(Math.min(1, Math.max(0, a.value)))])).h;
        case 'edit': if (!INST.test(a.inst)) return { error: 'Bad request.' }; return (await call(['edit', a.inst, String(a.title || 'Plugin').replace(/[\t\r\n]/g, ' ').slice(0, 120)])).h;
        case 'closeEdit': if (!INST.test(a.inst)) return { error: 'Bad request.' }; return (await call(['closeedit', a.inst])).h;
        case 'render': { // offline export: a whole block at once
          if (!INST.test(a.inst)) return { error: 'Bad request.' };
          const r = await call(['render', a.inst, num(a.frames), num(a.nEv), num(a.nPar), num(a.tempo), '1', num(a.pos)], a.events ? Buffer.from(a.events) : null);
          return r.h.error ? r.h : { audio: r.b };
        }
        default: return { error: 'Unknown command.' };
      }
    } catch (e) { return { error: String(e.message || e) }; }
  });

  // live audio: one port per instrument node; the page hands it to its AudioWorklet
  ipcMain.on('vst:port', (e) => {
    win = getWin();
    const { port1, port2 } = new MessageChannelMain();
    port1.on('message', (m) => {
      const d = m.data || {};
      if (d.type !== 'render' || !INST.test(d.inst) || !proc) { port1.postMessage({ rid: d.rid, error: true }); return; }
      const id = `r${++seq}`;
      waits.set(id, (h, b) => port1.postMessage({ rid: d.rid, error: !!h.error, audio: b && b.length ? new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice() : null }));
      proc.stdin.write(frame([id, 'render', d.inst, num(d.frames), num(d.nEv), num(d.nPar), num(d.tempo), d.playing ? '1' : '0', num(d.pos)], d.events ? Buffer.from(d.events) : null));
    });
    port1.start();
    e.sender.postMessage('vst:port', null, [port2]);
  });

  app.on('will-quit', () => { if (proc) { try { proc.stdin.write(frame(['0', 'quit'])); } catch { /* */ } } });
}

module.exports = { setup };
