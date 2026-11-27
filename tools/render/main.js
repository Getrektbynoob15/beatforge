// tools/render/main.js: render a BeatForge song on a server, without a screen (used by the ADHW Discord bot).
//   electron tools/render --app <dir with index.html> --plan plan.json --out song.wav --project song.bfp
//   electron tools/render --app <dir> --catalog            (prints the instruments / kits a plan may use, as JSON)
// The page is the normal BeatForge app (usually the published web copy), loaded in a hidden window. The plan is
// built into a project by js/aisong.js (BF.aiSong.build), rendered offline (BF.renderSong) and written as a WAV.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const has = (name) => process.argv.includes(`--${name}`);
const fail = (msg) => { fs.writeSync(2, `render: ${msg}\n`); app.exit(1); }; // sync: app.exit does not wait for streams

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const dir = arg('app');
  if (!dir || !fs.existsSync(path.join(dir, 'index.html'))) return fail('--app must be a folder with BeatForge (index.html)');
  const timer = setTimeout(() => fail('timed out'), Number(arg('timeout') || 120) * 1000);
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(path.join(dir, 'index.html'));
  const run = (code) => win.webContents.executeJavaScript(code, true);
  try {
    await run(`new Promise((ok, no) => { const t0 = Date.now(); (function wait() { if (window.BF && BF.aiSong && BF.renderSong && BF.plugins.get('drum')) ok(); else if (Date.now() - t0 > 20000) no(new Error('BeatForge did not start')); else setTimeout(wait, 100); })(); })`);
    if (has('catalog')) {
      fs.writeSync(1, JSON.stringify(await run('BF.aiSong.catalog()')) + '\n');
    } else {
      const planFile = arg('plan'), out = arg('out');
      if (!planFile || !out) throw new Error('--plan and --out are needed');
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      const res = await run(`(async () => {
        const plan = ${JSON.stringify(plan)};
        const { project, warnings } = BF.aiSong.build(plan);
        await BF.io.load(project, project.name);
        // the first offline render after start can wait for the audio engine; a tiny warm-up avoids that
        const warm = new OfflineAudioContext(2, 4410, 44100); await BF.audio.loadWorklets(warm).catch(() => {});
        const buf = await BF.renderSong('song', 44100);
        const wav = new Uint8Array(await BF.encodeWav(buf).arrayBuffer());
        let s = ''; for (let i = 0; i < wav.length; i += 32768) s += String.fromCharCode.apply(null, wav.subarray(i, i + 32768));
        return { wav: btoa(s), seconds: buf.length / buf.sampleRate, warnings, project: JSON.stringify(BF.io.serialize(BF.project)) };
      })()`);
      fs.writeFileSync(out, Buffer.from(res.wav, 'base64'));
      if (arg('project')) fs.writeFileSync(arg('project'), res.project);
      fs.writeSync(1, JSON.stringify({ ok: true, seconds: res.seconds, warnings: res.warnings }) + '\n');
    }
    clearTimeout(timer);
    app.exit(0);
  } catch (e) {
    clearTimeout(timer);
    fail(e && e.message ? e.message : String(e));
  }
});
