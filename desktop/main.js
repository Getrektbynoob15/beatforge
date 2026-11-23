// BeatForge desktop shell: opens the app in a window. The page itself has no network access.
// The main process can check GitHub for updates. An update is only the app's web files, signed with Ed25519;
// it is installed next to the bundled copy (never over it), and if it fails to start we fall back to the bundled copy.
'use strict';
const { app, BrowserWindow, Menu, session, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const SHELL_API = 2; // bump when the desktop shell gains features an update needs (2: plugin store)
const REPO = 'Getrektbynoob15/beatforge';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAEVeewGzZ2Xthyx2YqibvO8vpwJie7J22oq9C1sjeQcM=
-----END PUBLIC KEY-----`;
// Community plugin store (grbnstudios.com). The catalog is signed by the website with this key after the Owner
// approves a plugin; every plugin file must match the SHA-256 in that signed catalog.
const PLUGIN_STORE = 'https://grbnstudios.com/api/main/beatforge/plugins';
const PLUGIN_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZaO89JxiC4i4uWh/rMNv9jwHcEDA4vDGYLth2UqWLMw=
-----END PUBLIC KEY-----`;
const BUNDLED_DIR = __dirname;
const BUNDLED_VERSION = require('./package.json').version;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const userDir = () => app.getPath('userData');
const versionsDir = () => path.join(userDir(), 'app-versions');
const currentFile = () => path.join(userDir(), 'app-current.json');
const settingsFile = () => path.join(userDir(), 'settings.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJsonAtomic = (f, v) => { fs.writeFileSync(`${f}.tmp`, JSON.stringify(v)); fs.renameSync(`${f}.tmp`, f); };

function cmpVer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0), pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Which copy of the app to load: an installed update if it is newer and healthy, otherwise the bundled one. */
function pickAppDir() {
  const cur = readJson(currentFile(), null);
  if (cur && !cur.bad && cmpVer(cur.version, BUNDLED_VERSION) > 0) {
    const dir = path.join(versionsDir(), cur.version);
    if (fs.existsSync(path.join(dir, 'index.html'))) return { dir, version: cur.version, updated: true };
  }
  return { dir: BUNDLED_DIR, version: BUNDLED_VERSION, updated: false };
}

let win = null;
let loaded = null;
let bootTimer = null;

function createWindow() {
  loaded = pickAppDir();
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0d0f13',
    title: 'BeatForge',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(loaded.dir, 'index.html'));
  if (loaded.updated) {
    // the update must say "booted" within 20 s, otherwise it is marked bad and the bundled copy is used
    bootTimer = setTimeout(() => fallBack('did not start'), 20000);
    win.webContents.once('did-fail-load', () => fallBack('failed to load'));
    win.webContents.once('render-process-gone', () => fallBack('crashed'));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  win.on('close', onClose);
}

function fallBack(why) {
  clearTimeout(bootTimer);
  if (!loaded || !loaded.updated) return;
  const cur = readJson(currentFile(), {});
  writeJsonAtomic(currentFile(), { ...cur, bad: true, why });
  loaded = { dir: BUNDLED_DIR, version: BUNDLED_VERSION, updated: false };
  if (win && !win.isDestroyed()) win.loadFile(path.join(BUNDLED_DIR, 'index.html'));
}

// ---------- unsaved changes on close ----------
let closingOk = false;
async function onClose(e) {
  if (closingOk) return;
  e.preventDefault();
  let dirty = false;
  try { dirty = await win.webContents.executeJavaScript('!!(window.BF && window.BF.dirty)', true); } catch { dirty = false; }
  if (!dirty) { closingOk = true; win.close(); return; }
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Save…', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2,
    title: 'BeatForge', message: 'Save changes to this project before closing?',
  });
  if (r.response === 0) win.webContents.send('app:save');
  else if (r.response === 1) { closingOk = true; win.close(); }
}

// ---------- updates ----------
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'BeatForge-Updater', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return r.json();
}
async function getBytes(url, max) {
  const r = await fetch(url, { headers: { 'User-Agent': 'BeatForge-Updater' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length > max) throw new Error('Download is too large');
  return b;
}

async function checkUpdate() {
  const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  const version = String(rel.tag_name || '').replace(/^v/, '');
  const bundle = (rel.assets || []).find((a) => a.name === `beatforge-app-${version}.json.gz`);
  const sig = (rel.assets || []).find((a) => a.name === `beatforge-app-${version}.json.gz.sig`);
  const newer = cmpVer(version, loaded.version) > 0;
  return { current: loaded.version, latest: version, newer, installable: newer && !!bundle && !!sig, notes: String(rel.body || '').slice(0, 2000), page: rel.html_url, bundleUrl: bundle?.browser_download_url, sigUrl: sig?.browser_download_url };
}

const SAFE_PATH = /^(index\.html|style\.css|app\.js|LICENSE|js\/[A-Za-z0-9_\-/]+\.js)$/;

async function installUpdate() {
  const info = await checkUpdate();
  if (!info.newer) return { ok: false, message: 'You already have the newest version.' };
  if (!info.installable) return { ok: false, message: 'This version needs a full download.', page: info.page };
  const gz = await getBytes(info.bundleUrl, 20 * 1024 * 1024);
  const sig = await getBytes(info.sigUrl, 1024);
  const okSig = crypto.verify(null, gz, crypto.createPublicKey(PUBLIC_KEY), Buffer.from(sig.toString('utf8').trim(), 'base64'));
  if (!okSig) throw new Error('The update is not signed by BeatForge. It was not installed.');
  const pkg = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  if (pkg.app !== 'BeatForge' || pkg.version !== info.latest) throw new Error('The update package does not match the release.');
  if ((pkg.shellApi || 1) > SHELL_API) return { ok: false, message: 'This version needs a full download (the desktop part changed).', page: info.page };
  const files = Object.entries(pkg.files || {});
  if (!files.some(([p]) => p === 'index.html')) throw new Error('The update package is incomplete.');
  for (const [p] of files) if (!SAFE_PATH.test(p) || p.includes('..')) throw new Error(`Unsafe file in update: ${p}`);
  fs.mkdirSync(versionsDir(), { recursive: true });
  const target = path.join(versionsDir(), pkg.version);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [p, b64] of files) {
    const out = path.join(tmp, p);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(tmp, target);
  writeJsonAtomic(currentFile(), { version: pkg.version, installedAt: new Date().toISOString() });
  // keep only the newest two installed versions
  const keep = new Set([pkg.version, loaded.version]);
  for (const d of fs.readdirSync(versionsDir())) if (!keep.has(d)) fs.rmSync(path.join(versionsDir(), d), { recursive: true, force: true });
  return { ok: true, version: pkg.version };
}

// ---------- plugin store ----------
let verifiedCatalog = null;
async function pluginCatalog() {
  const r = await fetch(`${PLUGIN_STORE}/catalog`, { headers: { 'User-Agent': 'BeatForge' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`The plugin store answered ${r.status}`);
  const body = await r.json();
  if (typeof body.catalog !== 'string' || typeof body.signature !== 'string' || body.catalog.length > 2 * 1024 * 1024) throw new Error('The plugin store sent something unexpected.');
  const ok = crypto.verify(null, Buffer.from(body.catalog, 'utf8'), crypto.createPublicKey(PLUGIN_KEY), Buffer.from(body.signature, 'base64'));
  if (!ok) throw new Error('The plugin list is not signed by GRBN Studios. Nothing was loaded.');
  const cat = JSON.parse(body.catalog);
  if (cat.format !== 1 || !Array.isArray(cat.plugins)) throw new Error('The plugin list has an unknown format. Update BeatForge.');
  verifiedCatalog = cat;
  return cat;
}
async function pluginSource(id, version) {
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(String(id)) || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(version))) throw new Error('Invalid plugin.');
  if (!verifiedCatalog) await pluginCatalog();
  let item = verifiedCatalog.plugins.find((p) => p.id === id && p.version === version);
  if (!item) { await pluginCatalog(); item = verifiedCatalog.plugins.find((p) => p.id === id && p.version === version); }
  if (!item) throw new Error('That plugin version is not in the store (any more).');
  const b = await getBytes(`${PLUGIN_STORE}/code/${id}/${version}.js`, 256 * 1024);
  const sha = crypto.createHash('sha256').update(b).digest('hex');
  if (sha !== item.sha256) throw new Error('The downloaded plugin does not match the signed list. It was not installed.');
  return b.toString('utf8');
}
ipcMain.handle('plugins:catalog', async () => { try { return { catalog: await pluginCatalog() }; } catch (e) { return { error: String(e.message || e) }; } });
ipcMain.handle('plugins:source', async (_e, id, version) => { try { return { source: await pluginSource(id, version) }; } catch (e) { return { error: String(e.message || e) }; } });

ipcMain.handle('app:info', () => ({ version: loaded.version, bundled: BUNDLED_VERSION, shellApi: SHELL_API, updated: loaded.updated, settings: readJson(settingsFile(), { autoUpdate: true }) }));
ipcMain.handle('app:booted', () => { clearTimeout(bootTimer); return true; });
ipcMain.handle('update:check', async () => { try { return await checkUpdate(); } catch (e) { return { error: String(e.message || e) }; } });
ipcMain.handle('update:install', async () => { try { return await installUpdate(); } catch (e) { return { ok: false, message: String(e.message || e) }; } });
ipcMain.handle('update:restart', () => { closingOk = true; app.relaunch(); app.exit(0); });
ipcMain.handle('settings:set', (_e, patch) => {
  const s = { ...readJson(settingsFile(), { autoUpdate: true }), ...(patch && typeof patch === 'object' ? { autoUpdate: !!patch.autoUpdate } : {}) };
  writeJsonAtomic(settingsFile(), s);
  return s;
});
ipcMain.handle('update:auto-due', () => {
  const s = readJson(settingsFile(), { autoUpdate: true });
  if (!s.autoUpdate) return false;
  const last = s.lastCheck || 0;
  if (Date.now() - last < 6 * 3600 * 1000) return false;
  writeJsonAtomic(settingsFile(), { ...s, lastCheck: Date.now() });
  return true;
});

app.whenReady().then(() => {
  // Windows/Linux: no menu bar (the app has its own). macOS always shows one: keep just the app menu (Quit, Hide).
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }]) : null);
  // The page may only load its own files, data: and blob: URLs. (Update checks run in this main process.)
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: !/^(file|data|blob|devtools):/.test(details.url) });
  });
    // Allowed: MIDI keyboards, and the microphone/line input for audio recording (audio only, never the camera).
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => {
    if (perm === 'midi') return cb(true);
    if (perm === 'media') return cb(Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio'));
    cb(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm, _origin, details) => perm === 'midi' || (perm === 'media' && details && details.mediaType === 'audio'));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
