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
const pkg = { app: 'BeatForge', version, shellApi: 1, builtAt: new Date().toISOString(), files };
const gz = zlib.gzipSync(Buffer.from(JSON.stringify(pkg)), { level: 9 });
const keyFile = process.env.BEATFORGE_SIGNING_KEY || path.join(os.homedir(), '.config', 'beatforge', 'update-signing-key.pem');
const sig = crypto.sign(null, gz, crypto.createPrivateKey(fs.readFileSync(keyFile)));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `beatforge-app-${version}.json.gz`);
fs.writeFileSync(out, gz);
fs.writeFileSync(`${out}.sig`, sig.toString('base64'));
console.log(`update bundle ${path.basename(out)}: ${Object.keys(files).length} files, ${(gz.length / 1024).toFixed(0)} KB, signed`);
