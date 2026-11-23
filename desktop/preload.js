// Gives the page a tiny, fixed API for the desktop app (version, updates, save-on-close). Nothing else.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('beatforgeDesktop', {
  info: () => ipcRenderer.invoke('app:info'),
  booted: () => ipcRenderer.invoke('app:booted'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  restart: () => ipcRenderer.invoke('update:restart'),
  autoCheckDue: () => ipcRenderer.invoke('update:auto-due'),
  setAutoUpdate: (on) => ipcRenderer.invoke('settings:set', { autoUpdate: !!on }),
  onSaveRequest: (fn) => ipcRenderer.on('app:save', () => fn()),
});
