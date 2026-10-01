const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  lashCrack: () => ipcRenderer.send('lash-crack'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  getForegroundState: () => ipcRenderer.invoke('get-foreground-state'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  onSpawnLash: (fn) => ipcRenderer.on('spawn-lash', () => fn()),
  onDropLash: (fn) => ipcRenderer.on('drop-lash', () => fn()),
  onCursor: (fn) => ipcRenderer.on('cursor', (e, x, y) => fn(x, y)),
  onCursorDown: (fn) => ipcRenderer.on('cursor-down', () => fn()),
});
