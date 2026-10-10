// In-App-Updates: neue App-Version aus den GitHub-Releases laden – ohne Neuinstallation.
//  Desktop (Windows): Hauptprozess lädt & entpackt (window.notecodeDesktop)
//  Android: nativer Download (CapacitorHttp), Dateien ins App-Verzeichnis, WebView zeigt
//           ab dann die neue Version (WebView.setServerBasePath)
//  Web/Browser: ist immer aktuell (Service Worker lädt zuerst aus dem Netz)
import { unzip } from '../core/zip.js';

const cfg = window.NOTECODE_CONFIG || {};
const REPO = cfg.updateRepo || 'theospitaler-cell/Musik';
const LATEST = `https://github.com/${REPO}/releases/latest/download/`;

export function platform() {
  if (window.notecodeDesktop) return 'desktop';
  if (window.Capacitor?.isNativePlatform?.()) return 'android';
  return 'web';
}

export async function localVersion() {
  try {
    const r = await fetch('version.json', { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch {
    /* Entwicklungsstand ohne version.json */
  }
  return { version: 'Entwicklung', build: 0 };
}

const plug = (name) => window.Capacitor.Plugins?.[name] || window.Capacitor.registerPlugin(name);

const b64ToBytes = (b64) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
const bytesToB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function nativeGet(url, responseType) {
  const r = await plug('CapacitorHttp').get({ url, responseType, headers: { 'Cache-Control': 'no-cache' } });
  if (r.status && r.status >= 400) throw new Error('Update-Server nicht erreichbar (' + r.status + ')');
  return r.data;
}

export async function checkUpdate() {
  const p = platform();
  if (p === 'desktop') return window.notecodeDesktop.checkUpdate();
  const current = await localVersion();
  if (p === 'android') {
    let latest = await nativeGet(LATEST + 'web-version.json', 'json');
    if (typeof latest === 'string') latest = JSON.parse(latest);
    return { current, latest, available: (latest.build || 0) > (current.build || 0) };
  }
  return { current, latest: null, available: false, web: true };
}

export async function applyUpdate(onProgress = () => {}) {
  const p = platform();
  if (p === 'desktop') {
    const off = window.notecodeDesktop.onUpdateProgress((x) => onProgress(x.text, x.frac));
    try {
      await window.notecodeDesktop.applyUpdate();
    } finally {
      off();
    }
    location.reload();
    return;
  }
  if (p !== 'android') return;
  let info = await nativeGet(LATEST + 'web-version.json', 'json');
  if (typeof info === 'string') info = JSON.parse(info);
  onProgress('Update wird geladen', 0.1);
  const data = await nativeGet(LATEST + (info.zip || 'notecode-web.zip'), 'blob');
  const bytes = typeof data === 'string' ? b64ToBytes(data.replace(/^data:[^,]*,/, '')) : new Uint8Array(data);
  onProgress('Update wird entpackt', 0.45);
  const files = [...(await unzip(bytes))].filter(([name]) => !name.endsWith('/') && !name.includes('..'));
  const FS = plug('Filesystem');
  const base = `web/${info.build}`;
  let i = 0;
  for (const [name, content] of files) {
    await FS.writeFile({ path: `${base}/${name}`, data: bytesToB64(content), directory: 'DATA', recursive: true });
    i++;
    if (i % 10 === 0) onProgress('Dateien werden installiert', 0.5 + 0.45 * (i / files.length));
  }
  const { uri } = await FS.getUri({ path: base, directory: 'DATA' });
  const dir = decodeURI(uri.replace(/^file:\/\//, ''));
  onProgress('Neustart', 1);
  const WebView = plug('WebView');
  await WebView.setServerBasePath({ path: dir });
  await WebView.persistServerBasePath();
}
