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
  pluginCatalog: () => ipcRenderer.invoke('plugins:catalog'),
  pluginSource: (id, version) => ipcRenderer.invoke('plugins:source', String(id), String(version)),
  collab: (method, path, body) => ipcRenderer.invoke('collab:request', String(method), String(path), body),
  onJoin: (fn) => ipcRenderer.on('collab:join', (_e, code) => fn(String(code))),
  // VST3 plugins (through the separate BeatForge Plugin Host)
  vst: (cmd, args) => ipcRenderer.invoke('vst:call', String(cmd), args || {}),
  onVstEvent: (fn) => ipcRenderer.on('vst:event', (_e, ev) => fn(ev)),
  // a MessagePort for one instrument's live audio; it arrives as a window message {bfVstPort: tag} with the port
  vstPort: (tag) => { portTags.push(String(tag)); ipcRenderer.send('vst:port'); },
});
const portTags = []; // replies come back in order
ipcRenderer.on('vst:port', (e) => window.postMessage({ bfVstPort: portTags.shift() || '' }, '*', e.ports));
