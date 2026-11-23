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
    if (r.ok) show([p(`BeatForge ${r.version} is installed. Restart to use it.`)], 'Restart now', () => D.restart());
    else show([p(r.message || 'The update failed.'), ...(r.page ? [p(`Download it from: ${r.page}`)] : [])], null, null);
  }

  BF.desktop.check = async function (manual) {
    const r = await D.checkUpdate();
    if (r.error) { if (manual) BF.ui.toast(`Could not check for updates: ${r.error}`, true); return; }
    if (!r.newer) { if (manual) BF.ui.toast(`You have the newest version (${r.current}).`); return; }
    const notes = document.createElement('pre');
    notes.className = 'upd-notes';
    notes.textContent = r.notes || '';
    if (r.installable) show([p(`BeatForge ${r.latest} is available (you have ${r.current}).`), notes], 'Update now', install);
    else show([p(`BeatForge ${r.latest} is available (you have ${r.current}). This version needs a full download:`), p(r.page)], null, null);
  };

  later.addEventListener('click', () => dlg.close());
  D.onSaveRequest(() => BF.io.save());

  (async () => {
    BF.desktop.info = await D.info();
    if (BF.ready) D.booted(); // a broken update never reaches this, so the shell falls back to the bundled copy
    if (await D.autoCheckDue()) setTimeout(() => BF.desktop.check(false), 4000);
  })();
})();
