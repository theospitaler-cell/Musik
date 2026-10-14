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
  // Spurentrennung (Demucs): Hardware-/Python-Zustand, Trennen, Abbrechen, Fortschritt
  stemsStatus: (refresh = false) => ipcRenderer.invoke('stems:status', { refresh }),
  separateStems: (wav, device) => ipcRenderer.invoke('stems:separate', { wav, device }),
  cancelStems: () => ipcRenderer.invoke('stems:cancel'),
  onStemsProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('stems:progress', fn);
    return () => ipcRenderer.removeListener('stems:progress', fn);
  },
  // Notenerkennung (homr): Notenblatt-Bild -> MusicXML
  omrStatus: (refresh = false) => ipcRenderer.invoke('omr:status', { refresh }),
  recognizeSheet: (image, ext = 'png') => ipcRenderer.invoke('omr:recognize', { image, ext }),
  cancelOmr: () => ipcRenderer.invoke('omr:cancel'),
  onOmrProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('omr:progress', fn);
    return () => ipcRenderer.removeListener('omr:progress', fn);
  },
});
