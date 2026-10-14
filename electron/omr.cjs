// Notenerkennung (OMR) im Desktop-Hauptprozess mit homr: Notenblatt-Bild -> MusicXML.
// Reine Node-Datei (CommonJS) ohne Electron-Abhängigkeit – in Tests mit einer Attrappe (exe-Option)
// statt dem echten homr prüfbar. Eingerichtet wird homr einmalig mit `node scripts/setup-omr.mjs`
// (eigene Python-Umgebung ~/.notecode/omr).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./stems.cjs');

const isWin = process.platform === 'win32';

// Kandidaten für das homr-Programm: NOTECODE_HOMR, die eingerichtete Umgebung, dann `homr` im Suchpfad
function homrCandidates() {
  const list = [];
  if (process.env.NOTECODE_HOMR) list.push(process.env.NOTECODE_HOMR);
  const venv = path.join(os.homedir(), '.notecode', 'omr');
  const exe = isWin ? path.join(venv, 'Scripts', 'homr.exe') : path.join(venv, 'bin', 'homr');
  if (fs.existsSync(exe)) list.push(exe);
  list.push('homr');
  return list;
}

// exe: Programm (Zeichenkette) oder [Programm, Vorargumente …] (z. B. [python, '-m', 'homr'])
const split = (exe) => (Array.isArray(exe) ? { cmd: exe[0], pre: exe.slice(1) } : { cmd: exe, pre: [] });

// Zustand für die Oberfläche: { desktop: true, available, exe, version, error }
async function status({ exe = null } = {}) {
  const cands = exe ? [exe] : homrCandidates();
  let lastErr = null;
  for (const c of cands) {
    // `homr --help` läuft ohne Modelle; die Modelle lädt homr beim ersten Lauf selbst
    const s = split(c);
    const r = await run(s.cmd, [...s.pre, '--help'], { timeout: 30000 });
    if (r.code === 0 || /usage|homr/i.test(r.stdout + r.stderr)) {
      return { desktop: true, available: true, exe: c, error: null };
    }
    lastErr = (r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] || null;
  }
  return { desktop: true, available: false, exe: null, error: lastErr };
}

// Fortschritt aus den Ausgaben von homr („Running TrOmr inference on staff image 2“ …)
function progressFrom(text) {
  const all = [...text.matchAll(/staff image (\d+)/g)];
  if (!all.length) return null;
  return { staff: Number(all[all.length - 1][1]) + 1 };
}

// image: Uint8Array (PNG/JPEG-Bytes). Ergebnis: { xml, ms, log }
async function recognize(image, { ext = 'png', exe = null, onProgress = () => {}, signal = null } = {}) {
  const t0 = Date.now();
  const bin = exe || (await status()).exe;
  if (!bin) throw new Error('Die Notenerkennung (homr) ist nicht eingerichtet – siehe Einstellungen');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notecode-omr-'));
  const input = path.join(dir, `blatt.${ext.replace(/[^a-z0-9]/gi, '') || 'png'}`);
  fs.writeFileSync(input, Buffer.from(image.buffer, image.byteOffset, image.byteLength));
  try {
    onProgress(0, 'Notenblatt wird erkannt');
    let staffs = 0;
    const sb = split(bin);
    const r = await run(sb.cmd, [...sb.pre, input], {
      timeout: 0,
      signal,
      cwd: dir,
      onStderr: (s) => {
        const p = progressFrom(s);
        if (p && p.staff > staffs) {
          staffs = p.staff;
          onProgress(Math.min(0.95, 0.1 + staffs * 0.12), `Notenzeile ${staffs} wird erkannt`);
        }
      },
    });
    if (r.code === -3) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
    const outFile = path.join(dir, path.basename(input).replace(/\.[^.]+$/, '') + '.musicxml');
    if (r.code !== 0 || !fs.existsSync(outFile)) {
      const tail = (r.stderr || r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
      throw new Error('Die Notenerkennung ist fehlgeschlagen: ' + tail);
    }
    onProgress(1, '');
    return { xml: fs.readFileSync(outFile, 'utf8'), ms: Date.now() - t0, log: (r.stdout || '').split(/\r?\n/).slice(-6).join('\n') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { homrCandidates, status, recognize, progressFrom };
