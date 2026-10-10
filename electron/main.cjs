// NoteCode Desktop (Electron): lädt die App über ein eigenes, sicheres Protokoll
// (app://notecode/…), damit ES-Module, Web-Worker, IndexedDB und Audio wie im Browser laufen.
const { app, BrowserWindow, protocol, net, shell, Menu, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const REPO = 'theospitaler-cell/Musik';
const LATEST = process.env.NOTECODE_UPDATE_URL || `https://github.com/${REPO}/releases/latest/download/`;

// ---- In-App-Updates: neue App-Dateien landen in userData/web/<build>/ und werden
// statt der installierten Dateien ausgeliefert (keine Neuinstallation nötig).
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const bundled = () => readJson(path.join(ROOT, 'version.json')) || { version: 'dev', build: 0 };
const webRoot = () => path.join(app.getPath('userData'), 'web');
function activeUpdate() {
  const a = readJson(path.join(webRoot(), 'active.json'));
  if (!a || !a.dir || !fs.existsSync(path.join(a.dir, 'index.html'))) return null;
  // nach einer Neuinstallation mit neuerer Version gilt wieder die installierte
  if ((a.build || 0) <= (bundled().build || 0)) return null;
  return a;
}
function currentInfo() {
  const a = activeUpdate();
  return a ? { version: a.version, build: a.build, updated: true } : { ...bundled(), updated: false };
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// nur eine Instanz
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    title: 'NoteCode',
    backgroundColor: '#f6f6f3',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.loadURL('app://notecode/index.html');
  // externe Links im Standard-Browser öffnen
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname);
    // zuerst die per Update geladenen Dateien, sonst die installierten
    const upd = activeUpdate();
    if (upd) {
      const f = path.normalize(path.join(upd.dir, rel));
      if (f.startsWith(upd.dir + path.sep) && fs.existsSync(f)) return net.fetch(pathToFileURL(f).toString());
    }
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Nicht gefunden', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  ipcMain.handle('update:check', async () => {
    const cur = currentInfo();
    const res = await net.fetch(LATEST + 'web-version.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('Update-Server nicht erreichbar (' + res.status + ')');
    const latest = await res.json();
    return { current: cur, latest, available: (latest.build || 0) > (cur.build || 0) };
  });
  ipcMain.handle('update:apply', async (e) => {
    const send = (text, frac) => e.sender.send('update:progress', { text, frac });
    const info = await (await net.fetch(LATEST + 'web-version.json', { cache: 'no-store' })).json();
    send('Update wird geladen', 0.05);
    const res = await net.fetch(LATEST + (info.zip || 'notecode-web.zip'));
    if (!res.ok) throw new Error('Download fehlgeschlagen (' + res.status + ')');
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total) send('Update wird geladen', 0.05 + 0.7 * (got / total));
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    send('Update wird entpackt', 0.8);
    const { unzip } = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'zip.js')).toString());
    const files = await unzip(new Uint8Array(buf));
    const dir = path.join(webRoot(), String(info.build));
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [name, data] of files) {
      if (name.endsWith('/')) continue;
      const f = path.normalize(path.join(dir, name));
      if (!f.startsWith(dir + path.sep)) continue;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, data);
    }
    if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error('Update unvollständig');
    fs.writeFileSync(path.join(webRoot(), 'active.json'), JSON.stringify({ dir, build: info.build, version: info.version }));
    // ältere Update-Ordner aufräumen
    for (const d of fs.readdirSync(webRoot())) {
      const p = path.join(webRoot(), d);
      if (p !== dir && d !== 'active.json') fs.rmSync(p, { recursive: true, force: true });
    }
    send('Fertig', 1);
    return { ok: true, version: info.version };
  });
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
