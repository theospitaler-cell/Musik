// Instrumentenerkennung einrichten: Instrumenten-Spurentrennung „MVSep Mega 53 Stems“ (BS-Roformer, MIT-Lizenz,
// https://github.com/ZFTurbo/Music-Source-Separation-Training, Release v1.0.21) in der Python-Umgebung der
// Spurentrennung (~/.notecode/demucs, zuerst scripts/setup-demucs.mjs). Modell und Code liegen unter
// ~/.notecode/instruments – dort findet die Desktop-App sie selbst.
//
//   node scripts/setup-instruments.mjs [--dry-run] [--no-warmup]
//
// Geladen werden ~1,4 GB (Modell) und einige Python-Pakete. Die Erkennung braucht eine NVIDIA-Grafikkarte
// (gemessen: RTX 5060 mit 8 GB, 3 Minuten Musik in ~80 s; auf dem Prozessor viel zu langsam).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VENV } from './setup-demucs.mjs';

export const HOME = join(homedir(), '.notecode', 'instruments');
// Code-Stand der Inferenz (fest, damit Modell und Code zusammenpassen)
export const COMMIT = '1d4b3c431b37de696b3795ed2018493aacba946f';
const REL = 'https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.21/';
export const FILES = [
  { url: REL + 'mvsep_mega_model_bs_roformer_53_stems.yaml', name: 'mega53.yaml' },
  { url: REL + 'mvsep_mega_model_bs_roformer_53_stems_v1.ckpt', name: 'mega53.ckpt', size: 1368919887 },
];
// Pakete, die der Modellcode beim Laden braucht (PyTorch, numpy, soundfile, omegaconf hat die Umgebung schon)
export const PACKAGES = ['ml_collections', 'beartype==0.14.1', 'rotary_embedding_torch==0.3.5', 'hyper_connections==0.1.11', 'librosa', 'tqdm'];

const venvPython = () => (process.platform === 'win32' ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python'));
const has = (f) => process.argv.includes(f);
function run(cmd, args, { show = true } = {}) {
  if (show) console.log(`  > ${cmd} ${args.map((a) => (a.length > 80 ? a.slice(0, 77) + '…' : a)).join(' ')}`);
  return spawnSync(cmd, args, { encoding: 'utf8', stdio: show ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
}

// Herunterladen mit Python (urllib) – Fortschritt in Prozent, Teil-Datei erst am Ende umbenannt
const DOWNLOAD = [
  'import sys, urllib.request, os',
  'url, out = sys.argv[1], sys.argv[2]',
  'tmp = out + ".part"',
  'with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:',
  ' total = int(r.headers.get("Content-Length") or 0); done = 0; last = -1',
  ' while True:',
  '  b = r.read(1 << 20)',
  '  if not b: break',
  '  f.write(b); done += len(b)',
  '  p = int(100 * done / total) if total else -1',
  '  if p != last and p % 5 == 0: print(f"    {p} %", flush=True); last = p',
  'os.replace(tmp, out)',
].join('\n');

// Quellcode (nur models/, utils/, LICENSE) aus dem GitHub-Archiv des festen Stands
const UNZIP = [
  'import sys, io, zipfile, urllib.request, os, shutil',
  'url, dest = sys.argv[1], sys.argv[2]',
  'data = urllib.request.urlopen(url).read()',
  'z = zipfile.ZipFile(io.BytesIO(data))',
  'root = z.namelist()[0].split("/")[0]',
  'shutil.rmtree(dest, ignore_errors=True)',
  'n = 0',
  'for name in z.namelist():',
  ' rel = name[len(root) + 1:]',
  ' if not rel or not (rel.startswith("models/") or rel.startswith("utils/") or rel == "LICENSE"): continue',
  ' p = os.path.join(dest, rel)',
  ' if name.endswith("/"): os.makedirs(p, exist_ok=True); continue',
  ' os.makedirs(os.path.dirname(p), exist_ok=True)',
  ' open(p, "wb").write(z.read(name)); n += 1',
  'print(f"    {n} Dateien", flush=True)',
].join('\n');

const PROBE = 'import ml_collections, omegaconf, beartype, rotary_embedding_torch, einops, soundfile, librosa, hyper_connections, torch; print("NOTECODE_OK", torch.cuda.is_available())';

async function main() {
  console.log('NoteCode – Instrumentenerkennung (MVSep Mega 53 Stems) einrichten\n');
  if (!existsSync(venvPython())) {
    console.error(`Die Python-Umgebung der Spurentrennung fehlt (${VENV}). Zuerst: node scripts/setup-demucs.mjs`);
    process.exit(2);
  }
  console.log(`Umgebung: ${VENV}\nModell und Code: ${HOME}`);
  if (has('--dry-run')) {
    console.log('\n--dry-run: nichts wird installiert.');
    return;
  }
  mkdirSync(HOME, { recursive: true });
  // 1) Pakete – PyTorch der Umgebung bleibt unverändert (Constraint auf die installierte Version)
  const tv = run(venvPython(), ['-c', 'import torch, torchaudio; print(torch.__version__); print(torchaudio.__version__)'], { show: false });
  const [torchV, audioV] = (tv.stdout || '').trim().split(/\r?\n/);
  const dir = mkdtempSync(join(tmpdir(), 'notecode-instr-setup-'));
  try {
    const cons = join(dir, 'constraints.txt');
    writeFileSync(cons, [torchV && `torch==${torchV}`, audioV && `torchaudio==${audioV}`].filter(Boolean).join('\n') + '\n');
    console.log('\n1) Python-Pakete');
    const pip = run(venvPython(), ['-m', 'pip', 'install', '-c', cons, ...PACKAGES]);
    if (pip.status !== 0) throw new Error('pip install fehlgeschlagen');
    // 2) Quellcode der Inferenz
    console.log('\n2) Modellcode (Stand ' + COMMIT.slice(0, 7) + ')');
    const z = run(venvPython(), ['-c', UNZIP, `https://codeload.github.com/ZFTurbo/Music-Source-Separation-Training/zip/${COMMIT}`, join(HOME, 'msst')]);
    if (z.status !== 0) throw new Error('Modellcode konnte nicht geladen werden');
    // 3) Modell
    console.log('\n3) Modell (~1,4 GB)');
    for (const f of FILES) {
      const out = join(HOME, f.name);
      if (existsSync(out)) {
        console.log(`  ${f.name} ist schon da`);
        continue;
      }
      const r = run(venvPython(), ['-c', DOWNLOAD, f.url, out]);
      if (r.status !== 0) throw new Error(`${f.name} konnte nicht geladen werden`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 4) Prüfung
  console.log('\n4) Prüfung');
  const p = run(venvPython(), ['-c', PROBE], { show: false });
  const ok = /NOTECODE_OK (True|False)/.exec(p.stdout || '');
  if (!ok) {
    console.error('  Pakete lassen sich nicht laden:', (p.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' '));
    process.exit(3);
  }
  console.log(`  Pakete da, Grafikkarte nutzbar: ${ok[1] === 'True' ? 'ja' : 'NEIN – die Erkennung läuft nur mit NVIDIA-Grafikkarte'}`);
  if (ok[1] === 'True' && !has('--no-warmup')) {
    // 5) Probelauf mit 6 Sekunden Ton (lädt das Modell einmal auf die Grafikkarte)
    const tmp = mkdtempSync(join(tmpdir(), 'notecode-instr-warm-'));
    try {
      const sr = 44100;
      const n = sr * 6;
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
        const v = Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / sr) + 3000 * Math.sin((2 * Math.PI * 880 * i) / sr));
        buf.writeInt16LE(v, 44 + i * 4);
        buf.writeInt16LE(v, 46 + i * 4);
      }
      const wav = join(tmp, 'probe.wav');
      writeFileSync(wav, buf);
      const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'instruments.py');
      const r = run(venvPython(), [script, '--home', HOME, '--input', wav], { show: false });
      if (!/NOTECODE_RESULT/.test(r.stdout || '')) throw new Error('Probelauf fehlgeschlagen: ' + (r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' | '));
      console.log('  Probelauf gelungen.');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log('\nFertig. NoteCode erkennt die Instrumente bei neuen Analysen (Einstellungen → Audio-Vorverarbeitung → „Hardware erneut prüfen“).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('\nEinrichtung fehlgeschlagen:', e.message);
    process.exit(1);
  });
}
