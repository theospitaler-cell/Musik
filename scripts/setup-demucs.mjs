// Spurentrennung einrichten: Python-Umgebung mit Demucs v4 und PyTorch (mit CUDA, falls eine
// NVIDIA-Grafikkarte da ist) unter ~/.notecode/demucs – dort findet die Desktop-App sie selbst.
//
//   node scripts/setup-demucs.mjs [--cuda cu128|cu126|cu124|cu121|cpu] [--python <pfad>] [--dry-run] [--no-warmup]
//
// Ablauf: Python suchen -> venv anlegen -> PyTorch + torchaudio vom passenden CUDA-Index
// (https://download.pytorch.org/whl/<cuXXX>) -> demucs -> Prüfung: torch.cuda.is_available() UND
// eine echte Rechnung auf der Grafikkarte (ein „CUDA verfügbar“ mit falschem Index scheitert sonst
// erst beim ersten Lauf: „no kernel image is available“) -> Demucs-Modell vorab laden (2 s Probe).
// Es werden mehrere GB geladen (PyTorch mit CUDA ~2,5 GB, Modell ~80 MB).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VENV = join(homedir(), '.notecode', 'demucs');
const venvPython = () => (process.platform === 'win32' ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python'));

// Welcher PyTorch-Index passt zur Grafikkarte? computeCap: "12.0" (RTX 50xx, Blackwell), "8.9" (RTX 40xx) …
//  - Blackwell (>= 12.0) braucht CUDA 12.8 (cu128, PyTorch >= 2.7): kleinere Indizes haben keine Kerne
//    für diese Karten („no kernel image is available“), obwohl torch.cuda.is_available() True liefert
//  - sonst cu124 (CUDA 12.4); sehr alte Karten/Treiber: cu121
//  - ohne NVIDIA-Karte: cpu
export function chooseTorchIndex({ gpu = null, computeCap = null, driverMajor = null } = {}) {
  if (!gpu) return { tag: 'cpu', index: 'https://download.pytorch.org/whl/cpu', pins: [] };
  const cc = Number(computeCap);
  if (cc >= 12) return { tag: 'cu128', index: 'https://download.pytorch.org/whl/cu128', pins: ['torch>=2.7,<2.9', 'torchaudio>=2.7,<2.9'] };
  if (driverMajor !== null && driverMajor < 525) return { tag: 'cu121', index: 'https://download.pytorch.org/whl/cu121', pins: [] };
  return { tag: 'cu124', index: 'https://download.pytorch.org/whl/cu124', pins: [] };
}

export function parseNvidiaSmi(text) {
  const line = String(text || '').split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const [name, driver, cap, mem] = line.split(',').map((s) => s.trim());
  if (!name) return null;
  return { name, driver: driver || null, driverMajor: driver ? Number(driver.split('.')[0]) : null, computeCap: cap || null, memoryMB: Number(mem) || null };
}

function run(cmd, args, { show = true, ...opts } = {}) {
  if (show) console.log(`  > ${cmd} ${args.join(' ')}`);
  return spawnSync(cmd, args, { encoding: 'utf8', stdio: show ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'], ...opts });
}
const quiet = (cmd, args, opts = {}) => run(cmd, args, { show: false, ...opts });

function findPython(explicit) {
  const cands = explicit ? [[explicit]] : [['py', '-3.12'], ['py', '-3.11'], ['py', '-3.10'], ['python'], ['python3']];
  for (const [cmd, ...pre] of cands) {
    const r = quiet(cmd, [...pre, '-c', 'import sys;print(sys.version_info[0],sys.version_info[1])']);
    if (r.status !== 0) continue;
    const m = /^(\d+) (\d+)/.exec(r.stdout.trim());
    if (!m) continue;
    const [maj, min] = [Number(m[1]), Number(m[2])];
    if (maj === 3 && min >= 9 && min <= 13) return { cmd, pre, version: `${maj}.${min}` };
  }
  return null;
}

const CHECK = [
  'import json,sys',
  'import torch',
  'r={"torch":torch.__version__,"cuda_build":torch.version.cuda,"available":bool(torch.cuda.is_available()),"ok":False,"device":None,"error":None}',
  'if r["available"]:',
  ' try:',
  '  r["device"]=torch.cuda.get_device_name(0)',
  '  a=torch.randn(512,512,device="cuda"); b=(a@a).sum().item()',
  '  r["ok"]=True',
  ' except Exception as e:',
  '  r["error"]=str(e)[:300]',
  'print("NOTECODE_CHECK "+json.dumps(r))',
].join('\n');

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (f) => process.argv.includes(f);

async function main() {
  const dry = has('--dry-run');
  console.log('NoteCode – Spurentrennung (Demucs v4) einrichten\n');
  // Grafikkarte
  const smi = quiet('nvidia-smi', ['--query-gpu=name,driver_version,compute_cap,memory.total', '--format=csv,noheader,nounits']);
  const gpu = smi.status === 0 ? parseNvidiaSmi(smi.stdout) : null;
  console.log(gpu ? `Grafikkarte: ${gpu.name} (Treiber ${gpu.driver}, Compute ${gpu.computeCap}, ${gpu.memoryMB} MB)` : 'Keine NVIDIA-Grafikkarte erkannt – Demucs läuft auf dem Prozessor (langsam).');
  let pick = chooseTorchIndex(gpu ? { gpu: gpu.name, computeCap: gpu.computeCap, driverMajor: gpu.driverMajor } : {});
  const force = arg('--cuda');
  if (has('--cpu')) pick = chooseTorchIndex({});
  else if (force) pick = { tag: force, index: `https://download.pytorch.org/whl/${force}`, pins: [] };
  console.log(`PyTorch-Quelle: ${pick.tag} (${pick.index})${pick.pins.length ? ' – ' + pick.pins.join(' ') : ''}`);
  const py = findPython(arg('--python'));
  if (!py) {
    console.error('\nPython 3.9–3.13 wurde nicht gefunden. Bitte installieren (https://www.python.org/downloads/, „Add python.exe to PATH“) oder mit --python <pfad> angeben.');
    process.exit(2);
  }
  console.log(`Python: ${py.cmd} ${py.pre.join(' ')} (${py.version})`);
  console.log(`Umgebung: ${VENV}`);
  if (dry) {
    console.log('\n--dry-run: nichts wird installiert.');
    return;
  }
  console.log('\nEs werden mehrere GB geladen (PyTorch mit CUDA ~2,5 GB, Demucs-Modell ~80 MB).\n');
  mkdirSync(VENV, { recursive: true });
  if (!existsSync(venvPython())) {
    const r = run(py.cmd, [...py.pre, '-m', 'venv', VENV]);
    if (r.status !== 0) throw new Error('venv konnte nicht angelegt werden');
  }
  const pip = (args) => {
    const r = run(venvPython(), ['-m', 'pip', ...args]);
    if (r.status !== 0) throw new Error('pip ' + args.slice(0, 3).join(' ') + ' fehlgeschlagen');
  };
  pip(['install', '--upgrade', 'pip']);
  // 1) PyTorch vom CUDA-Index – vor demucs, damit pip nicht die CPU-Variante aus PyPI zieht
  pip(['install', ...(pick.pins.length ? pick.pins : ['torch', 'torchaudio']), '--index-url', pick.index]);
  // 2) Demucs (+ soundfile als Rückfall zum WAV-Lesen/Schreiben)
  pip(['install', 'demucs', 'soundfile']);
  // 3) Prüfung: CUDA wirklich nutzbar?
  const chk = quiet(venvPython(), ['-c', CHECK]);
  const m = /NOTECODE_CHECK (\{.*\})/.exec(chk.stdout || '');
  const info = m ? JSON.parse(m[1]) : null;
  console.log('\nPrüfung:');
  if (!info) {
    console.error('  PyTorch lässt sich nicht laden:', (chk.stderr || '').split(/\r?\n/).slice(-3).join(' '));
    process.exit(3);
  }
  console.log(`  PyTorch ${info.torch} (CUDA-Build: ${info.cuda_build || 'keiner'})`);
  console.log(`  torch.cuda.is_available(): ${info.available}`);
  let device = 'cpu';
  if (info.available && info.ok) {
    device = 'cuda';
    console.log(`  GPU einsatzbereit: ${info.device} – Rechnung auf der Grafikkarte gelungen.`);
  } else if (info.available) {
    console.warn(`  CUDA gemeldet, aber die Rechnung scheitert: ${info.error}`);
    console.warn('  -> Meist passt der PyTorch-Build nicht zur Karte. Mit --cuda cu128 (RTX 50xx) bzw. --cuda cu124 erneut versuchen.');
  } else if (gpu) {
    console.warn('  Eine Grafikkarte ist da, PyTorch sieht sie aber nicht (CPU-Build oder Treiber zu alt).');
    console.warn(`  -> Treiber aktualisieren und erneut: node scripts/setup-demucs.mjs --cuda ${pick.tag === 'cpu' ? 'cu128' : pick.tag}`);
  } else console.log('  Nur Prozessor – Demucs funktioniert, ist aber langsam.');
  // 4) Modell vorab laden (2 Sekunden Ton) – so ist der erste echte Lauf nicht langsam
  if (!has('--no-warmup')) {
    const dir = mkdtempSync(join(tmpdir(), 'notecode-warm-'));
    try {
      const sr = 44100;
      const n = sr * 2;
      const buf = Buffer.alloc(44 + n * 4);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(36 + n * 4, 4);
      buf.write('WAVEfmt ', 8);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(1, 20);
      buf.writeUInt16LE(2, 22);
      buf.writeUInt32LE(sr, 24);
      buf.writeUInt32LE(sr * 4, 28);
      buf.writeUInt16LE(4, 32);
      buf.writeUInt16LE(16, 34);
      buf.write('data', 36);
      buf.writeUInt32LE(n * 4, 40);
      for (let i = 0; i < n; i++) {
        const v = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / sr));
        buf.writeInt16LE(v, 44 + i * 4);
        buf.writeInt16LE(v, 46 + i * 4);
      }
      const wav = join(dir, 'probe.wav');
      writeFileSync(wav, buf);
      console.log(`\nDemucs-Modell wird geladen und geprüft (${device}) …`);
      const r = run(venvPython(), ['-m', 'demucs.separate', '-n', 'htdemucs', '-d', device, '--float32', '-o', join(dir, 'out'), wav]);
      if (r.status !== 0) throw new Error('Demucs-Probe fehlgeschlagen');
      console.log('  Demucs läuft.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`\nFertig. NoteCode findet die Umgebung selbst (Einstellungen → Audio-Vorverarbeitung → „Hardware erneut prüfen“).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('\nEinrichtung fehlgeschlagen:', e.message);
    process.exit(1);
  });
}
