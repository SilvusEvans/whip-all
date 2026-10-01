const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  lashCrack: () => ipcRenderer.send('lash-crack'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  getForegroundState: () => ipcRenderer.invoke('get-foreground-state'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  validateHotkey: (hk) => ipcRenderer.invoke('validate-hotkey', hk),
  // Suspend the global quit-hotkey hook while the user records a new combination.
  setHotkeyCapture: (on) => ipcRenderer.send('hotkey-capture', !!on),
  onSpawnLash: (fn) => ipcRenderer.on('spawn-lash', () => fn()),
  onDropLash: (fn) => ipcRenderer.on('drop-lash', () => fn()),
  // t is the main-process timestamp for this sample; the overlay uses it to
  // interpolate the handle position on its own animation-frame clock.
  onCursor: (fn) => ipcRenderer.on('cursor', (e, x, y, t) => fn(x, y, t)),
  onCursorDown: (fn) => ipcRenderer.on('cursor-down', () => fn()),
});
