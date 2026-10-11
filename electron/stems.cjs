// Spurentrennung mit Demucs v4 im Desktop-Hauptprozess: Hardware-/Python-Erkennung, Demucs-Lauf
// (GPU/CPU), Stems zurück als Mono-Signale bei 22,05 kHz (die Analyse rechnet dort).
// Reine Node-Datei (CommonJS) ohne Electron-Abhängigkeit – dadurch in Tests mit einer Attrappe
// statt echtem Python prüfbar (python-Option).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MODEL = 'htdemucs';

// Aufruf eines Befehls; liefert { code, stdout, stderr } (nie ein Fehler: code -1 bei Startfehler)
function run(cmd, args, { timeout = 15000, onStderr = null, signal = null, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let child;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    try {
      child = spawn(cmd, args, { windowsHide: true, cwd });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e.message || e) });
      return;
    }
    const timer = timeout
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* schon beendet */
          }
          finish({ code: -2, stdout: out, stderr: err + '\nZeitüberschreitung' });
        }, timeout)
      : null;
    if (signal) {
      const onAbort = () => {
        try {
          child.kill();
        } catch {
          /* schon beendet */
        }
        finish({ code: -3, stdout: out, stderr: err + '\nAbgebrochen' });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => {
      const s = String(d);
      err += s;
      if (err.length > 20000) err = err.slice(-10000);
      if (onStderr) onStderr(s);
    });
    child.on('error', (e) => finish({ code: -1, stdout: out, stderr: String(e.message || e) }));
    child.on('close', (code) => finish({ code, stdout: out, stderr: err }));
  });
}

// ---- Grafikkarte (NVIDIA)
async function detectGpu() {
  const r = await run('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'], { timeout: 8000 });
  if (r.code !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const [name, driver, mem] = line.split(',').map((s) => s.trim());
  if (!name) return null;
  return { name, driver: driver || null, memoryMB: Number(mem) || null };
}

// ---- Python mit Demucs: Kandidaten in dieser Reihenfolge
//   1. NOTECODE_PYTHON (Pfad), 2. die eingerichtete Umgebung (setup-demucs: ~/.notecode/demucs),
//   3. py -3, python, python3 (der Microsoft-Store-Platzhalter ohne Python wird erkannt und übersprungen)
function pythonCandidates() {
  const list = [];
  if (process.env.NOTECODE_PYTHON) list.push({ cmd: process.env.NOTECODE_PYTHON, args: [] });
  const venv = path.join(os.homedir(), '.notecode', 'demucs');
  const exe = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  if (fs.existsSync(exe)) list.push({ cmd: exe, args: [] });
  if (process.platform === 'win32') list.push({ cmd: 'py', args: ['-3'] });
  list.push({ cmd: 'python', args: [] }, { cmd: 'python3', args: [] });
  return list;
}

// Sonde: läuft dieses Python, ist Demucs da, kann PyTorch CUDA?
const PROBE = [
  'import json,sys',
  'r={"python":sys.version.split()[0],"demucs":None,"torch":None,"cuda":False,"device":None}',
  'try:',
  ' import torch',
  ' r["torch"]=torch.__version__',
  ' r["cuda"]=bool(torch.cuda.is_available())',
  ' r["device"]=torch.cuda.get_device_name(0) if r["cuda"] else None',
  'except Exception as e:',
  ' r["torch_error"]=str(e)[:200]',
  'try:',
  ' import demucs',
  ' r["demucs"]=getattr(demucs,"__version__","4")',
  'except Exception as e:',
  ' r["demucs_error"]=str(e)[:200]',
  'print("NOTECODE_PROBE "+json.dumps(r))',
].join('\n');

async function probePython(py) {
  const r = await run(py.cmd, [...py.args, '-c', PROBE], { timeout: 60000 });
  const m = /NOTECODE_PROBE (\{.*\})/.exec(r.stdout);
  if (r.code !== 0 || !m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Zustand für die Einstellungen: { desktop: true, gpu, python, demucs: {version} | null, cuda, device }
async function status({ python = null } = {}) {
  const gpu = await detectGpu();
  const cands = python ? [python] : pythonCandidates();
  let found = null;
  let info = null;
  for (const c of cands) {
    const p = await probePython(c);
    if (!p) continue;
    // das erste Python mit Demucs gewinnt, sonst das erste lauffähige
    if (p.demucs) {
      found = c;
      info = p;
      break;
    }
    if (!found) {
      found = c;
      info = p;
    }
  }
  return {
    desktop: true,
    gpu,
    python: info ? info.python : null,
    pythonCmd: found ? [found.cmd, ...found.args] : null,
    demucs: info && info.demucs ? { version: info.demucs } : null,
    torch: info ? info.torch : null,
    cuda: !!(info && info.cuda),
    device: info && info.cuda ? info.device : null,
    error: info && !info.demucs ? info.demucs_error || null : null,
  };
}

// Demucs-Fortschritt steht als tqdm-Balken auf stderr („ 45%|████ …“)
function progressFrom(text) {
  const all = [...text.matchAll(/(\d{1,3})%\|/g)];
  if (!all.length) return null;
  return Math.min(1, Number(all[all.length - 1][1]) / 100);
}

// wav: Uint8Array (Stereo-WAV der dekodierten Aufnahme). Ergebnis:
//   { sampleRate: 22050, stems: { vocals, bass, other }, device, ms }  (Mono-Float32Array)
// device: 'cuda' | 'cpu'; scheitert CUDA (Speicher, Treiber), läuft derselbe Aufruf auf dem Prozessor.
async function separate(wav, { device = 'cpu', python, onProgress = () => {}, signal = null, model = MODEL, keepFiles = false } = {}) {
  const t0 = Date.now();
  const py = python || (await status()).pythonCmd;
  if (!py) throw new Error('Python mit Demucs wurde nicht gefunden');
  const cmd = Array.isArray(py) ? { cmd: py[0], args: py.slice(1) } : py;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notecode-stems-'));
  const input = path.join(dir, 'song.wav');
  fs.writeFileSync(input, Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
  const out = path.join(dir, 'out');
  const attempt = async (dev) => {
    const args = [...cmd.args, '-m', 'demucs.separate', '-n', model, '-d', dev, '--float32', '-o', out, input];
    onProgress(0, dev === 'cuda' ? 'Spuren werden getrennt (Grafikkarte)' : 'Spuren werden getrennt (Prozessor)');
    return run(cmd.cmd, args, {
      timeout: 0,
      signal,
      onStderr: (s) => {
        const f = progressFrom(s);
        if (f !== null) onProgress(f, dev === 'cuda' ? 'Spuren werden getrennt (Grafikkarte)' : 'Spuren werden getrennt (Prozessor)');
      },
    });
  };
  try {
    let used = device;
    let r = await attempt(device);
    if (r.code === -3) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
    if (r.code !== 0 && device === 'cuda') {
      // z. B. zu wenig Grafikspeicher: derselbe Lauf auf dem Prozessor
      used = 'cpu';
      fs.rmSync(out, { recursive: true, force: true });
      r = await attempt('cpu');
      if (r.code === -3) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
    }
    if (r.code !== 0) throw new Error('Demucs ist fehlgeschlagen: ' + (r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | '));
    const sub = path.join(out, model, 'song');
    if (!fs.existsSync(sub)) throw new Error('Demucs hat keine Spuren geliefert');
    const { parseWav } = await import(pathToFileURL(path.join(ROOT, 'src', 'input', 'stems.js')).href);
    const { resampleMono } = await import(pathToFileURL(path.join(ROOT, 'src', 'input', 'audio.js')).href);
    const stems = {};
    for (const name of ['vocals', 'bass', 'other']) {
      const f = path.join(sub, name + '.wav');
      if (!fs.existsSync(f)) throw new Error(`Spur „${name}“ fehlt`);
      const w = parseWav(fs.readFileSync(f));
      stems[name] = resampleMono(w.channels, w.sampleRate);
    }
    onProgress(1, '');
    return { sampleRate: 22050, stems, device: used, ms: Date.now() - t0 };
  } finally {
    if (!keepFiles) fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run, detectGpu, pythonCandidates, probePython, status, separate, progressFrom, MODEL };
