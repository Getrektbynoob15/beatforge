/* desktop.js: only active inside the desktop app. Update checks, the update dialog, and save-before-close. */
(function () {
  'use strict';
  const BF = window.BF;
  const D = window.beatforgeDesktop;
  BF.desktop = { available: !!D, info: null };
  if (!D) return;

  const dlg = document.getElementById('updateDlg');
  const body = document.getElementById('updateBody');
  const go = document.getElementById('updateGo');
  const later = document.getElementById('updateLater');

  function show(html, goLabel, onGo) {
    body.textContent = '';
    html.forEach((n) => body.append(n));
    go.hidden = !onGo;
    go.textContent = goLabel || 'OK';
    go.onclick = onGo || null;
    if (!dlg.open) dlg.showModal();
  }
  const p = (text) => Object.assign(document.createElement('p'), { textContent: text });

  async function install() {
    if (BF.dirty && confirm('Save your project first? (The app restarts after the update.)')) BF.io.save();
    go.disabled = true;
    show([p('Downloading and checking the update…')], 'Working…', () => {});
    const r = await D.installUpdate();
    go.disabled = false;
    if (r.ok && r.shell) show([p(`BeatForge ${r.version} is downloaded, including a new desktop part. Restart: BeatForge closes, installs the update and opens again by itself (about 20 seconds).`)], 'Restart and install', () => D.restart());
    else if (r.ok) show([p(`BeatForge ${r.version} is installed. Restart to use it.`)], 'Restart now', () => D.restart());
    else if (r.page) show([p(`${r.message || 'This update needs a download.'} Get the installer, run it, and start BeatForge again. Your projects, templates and packs stay.`)], 'Download installer', () => { window.open('https://grbnstudios.com/beatforge', '_blank', 'noopener'); dlg.close(); });
    else show([p(r.message || 'The update failed.')], null, null);
  }

  BF.desktop.check = async function (manual) {
    const r = await D.checkUpdate();
    if (r.error) { if (manual) BF.ui.toast(`Could not check for updates: ${r.error}`, true); return; }
    if (!r.newer) { if (manual) BF.ui.toast(`You have the newest version (${r.current}).`); return; }
    const notes = document.createElement('pre');
    notes.className = 'upd-notes';
    notes.textContent = r.notes || '';
    if (r.installable) show([p(`BeatForge ${r.latest} is available (you have ${r.current}).`), notes], 'Update now', install);
    else show([p(`BeatForge ${r.latest} is available (you have ${r.current}). This version has a new desktop part, so it needs one download: get the installer, run it, and start BeatForge again. Your projects, templates and packs stay.`)], 'Download installer', () => { window.open('https://grbnstudios.com/beatforge', '_blank', 'noopener'); dlg.close(); });
  };

  later.addEventListener('click', () => dlg.close());
  D.onSaveRequest(() => BF.io.save());

  (async () => {
    BF.desktop.info = await D.info();
    if (BF.ready) D.booted(); // a broken update never reaches this, so the shell falls back to the bundled copy
    if (await D.autoCheckDue()) setTimeout(() => BF.desktop.check(false), 4000);
  })();
})();
