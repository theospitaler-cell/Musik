// Instrumentenerkennung im Desktop-Hauptprozess: Instrumenten-Spurentrennung (MVSep Mega 53 Stems, BS-Roformer,
// MIT) in der Python-Umgebung der Spurentrennung (~/.notecode/demucs), Modell und Code unter
// ~/.notecode/instruments (eingerichtet mit scripts/setup-instruments.mjs). Ergebnis: Pegel je Instrumentenspur
// (ganze Aufnahme und je 3-s-Fenster) – die Auswertung (welche Instrumente spielen) macht src/input/instruments.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./stems.cjs');

const HOME = () => process.env.NOTECODE_INSTRUMENTS_HOME || path.join(os.homedir(), '.notecode', 'instruments');
const SCRIPT = path.join(__dirname, 'instruments.py');

// Sind Modell und Code da? (ohne Python zu starten)
function files(home = HOME()) {
  const need = [path.join(home, 'mega53.ckpt'), path.join(home, 'mega53.yaml'), path.join(home, 'msst', 'utils', 'settings.py')];
  return need.every((f) => fs.existsSync(f));
}

const PROBE = ['import json', 'r={"ok":True}', 'try:', ' import ml_collections, omegaconf, beartype, rotary_embedding_torch, einops, soundfile', 'except Exception as e:', ' r={"ok":False,"error":str(e)[:200]}', 'print("NOTECODE_PROBE "+json.dumps(r))'].join('\n');

// Zustand: { ready, reason } – python: [cmd, ...args] der Spurentrennungs-Umgebung, cuda: Grafikkarte nutzbar
async function status({ python = null, cuda = false } = {}) {
  if (!files()) return { ready: false, reason: 'nicht eingerichtet (node scripts/setup-instruments.mjs)' };
  if (!python) return { ready: false, reason: 'Python der Spurentrennung fehlt' };
  if (!cuda) return { ready: false, reason: 'braucht eine NVIDIA-Grafikkarte (auf dem Prozessor zu langsam)' };
  const r = await run(python[0], [...python.slice(1), '-c', PROBE], { timeout: 60000 });
  const m = /NOTECODE_PROBE (\{.*\})/.exec(r.stdout);
  let p = null;
  try {
    p = m ? JSON.parse(m[1]) : null;
  } catch {
    p = null;
  }
  if (!p || !p.ok) return { ready: false, reason: 'Python-Pakete fehlen (node scripts/setup-instruments.mjs)' + (p && p.error ? ': ' + p.error : '') };
  return { ready: true, reason: null };
}

// Fortschritt steht als „NOTECODE_PROGRESS 0.42“ auf stdout
function progressFrom(text) {
  const all = [...String(text).matchAll(/NOTECODE_PROGRESS ([0-9.]+)/g)];
  return all.length ? Math.min(1, Number(all[all.length - 1][1])) : null;
}

function resultFrom(stdout) {
  const m = /NOTECODE_RESULT (\{.*\})/.exec(stdout);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// wav: Uint8Array (WAV der Aufnahme). Ergebnis: { levels, windows, device, sec }
async function recognize(wav, { python, device = 'cuda', onProgress = () => {}, signal = null } = {}) {
  if (!python) throw new Error('Python der Spurentrennung fehlt');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notecode-instr-'));
  try {
    const input = path.join(dir, 'song.wav');
    fs.writeFileSync(input, Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
    // als Programmtext übergeben: im gepackten App-Archiv (app.asar) kann Python die Datei nicht lesen, Node schon
    const code = fs.readFileSync(SCRIPT, 'utf8');
    const args = [...python.slice(1), '-c', code, '--home', HOME(), '--input', input, '--device', device];
    onProgress(0, 'Instrumente werden erkannt (Grafikkarte)');
    const r = await run(python[0], args, {
      timeout: 0,
      signal,
      onStdout: (s) => {
        const f = progressFrom(s);
        if (f !== null) onProgress(f, 'Instrumente werden erkannt (Grafikkarte)');
      },
    });
    if (r.code === -3) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
    const res = resultFrom(r.stdout);
    if (r.code !== 0 || !res) throw new Error('Instrumentenerkennung fehlgeschlagen: ' + (r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' | '));
    onProgress(1, '');
    return res;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { HOME, files, status, recognize, progressFrom, resultFrom, SCRIPT };
