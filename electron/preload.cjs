// Brücke zwischen App (Renderer) und Desktop-Hauptprozess: In-App-Updates.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notecodeDesktop', {
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  onUpdateProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('update:progress', fn);
    return () => ipcRenderer.removeListener('update:progress', fn);
  },
});
