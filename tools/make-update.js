#!/usr/bin/env node
// Packs the web app into dist/beatforge-app-<ver>.json.gz and signs it (Ed25519) for the desktop auto-updater.
// The private key lives outside the repo: $BEATFORGE_SIGNING_KEY or ~/.config/beatforge/update-signing-key.pem
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const os = require('node:os');
const root = path.join(__dirname, '..');
const version = require('../desktop/package.json').version;
const files = {};
const add = (rel) => { files[rel] = fs.readFileSync(path.join(root, rel)).toString('base64'); };
['index.html', 'style.css', 'app.js', 'LICENSE'].forEach(add);
const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).forEach((d) => {
  const rel = `${dir}/${d.name}`;
  if (d.isDirectory()) walk(rel); else if (d.name.endsWith('.js')) add(rel);
});
walk('js');
// the desktop part this version needs (SHELL_API in desktop/main.js) and, for Windows, the installer that brings it
const shellApi = Number((/const SHELL_API = (\d+);/.exec(fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')) || [0, 1])[1]);
const setupName = `BeatForge-${version}-Setup.exe`;
const setupFile = path.join(root, 'dist', setupName);
const setup = fs.existsSync(setupFile) ? { name: setupName, size: fs.statSync(setupFile).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(setupFile)).digest('hex') } : null;
const pkg = { app: 'BeatForge', version, shellApi, setup, builtAt: new Date().toISOString(), files };
const gz = zlib.gzipSync(Buffer.from(JSON.stringify(pkg)), { level: 9 });
const keyFile = process.env.BEATFORGE_SIGNING_KEY || path.join(os.homedir(), '.config', 'beatforge', 'update-signing-key.pem');
const sig = crypto.sign(null, gz, crypto.createPrivateKey(fs.readFileSync(keyFile)));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `beatforge-app-${version}.json.gz`);
fs.writeFileSync(out, gz);
fs.writeFileSync(`${out}.sig`, sig.toString('base64'));
console.log(`update bundle ${path.basename(out)}: ${Object.keys(files).length} files, ${(gz.length / 1024).toFixed(0)} KB, shellApi ${shellApi}${setup ? `, Windows setup ${setup.sha256.slice(0, 12)}…` : ''}, signed`);
