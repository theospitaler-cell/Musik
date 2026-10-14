// Notenerkennung einrichten: Python-Umgebung mit homr (Notenblatt-Bild -> MusicXML) unter ~/.notecode/omr –
// dort findet die Desktop-App sie selbst.
//
//   node scripts/setup-omr.mjs [--python <pfad>] [--dry-run] [--test <bild.png>]
//
// Ablauf: Python suchen -> venv anlegen -> pip install homr -> Prüfung (homr --help). Beim ersten Lauf lädt
// homr seine Modelle selbst nach (einige hundert MB). Es wird kein PyTorch benötigt (onnxruntime).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VENV = join(homedir(), '.notecode', 'omr');
const isWin = process.platform === 'win32';
export const venvPython = () => (isWin ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python'));
export const venvHomr = () => (isWin ? join(VENV, 'Scripts', 'homr.exe') : join(VENV, 'bin', 'homr'));

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
    if (maj === 3 && min >= 10 && min <= 13) return { cmd, pre, version: `${maj}.${min}` };
  }
  return null;
}

export function main(argv = process.argv.slice(2)) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const dry = argv.includes('--dry-run');
  const py = findPython(opt('--python'));
  if (!py) {
    console.error('Kein passendes Python (3.10–3.13) gefunden. Bitte Python installieren (python.org) und erneut starten.');
    return 1;
  }
  console.log(`Python ${py.version} gefunden (${py.cmd}).`);
  if (dry) {
    console.log(`Würde ${VENV} anlegen und homr installieren.`);
    return 0;
  }
  mkdirSync(join(homedir(), '.notecode'), { recursive: true });
  if (!existsSync(venvPython())) {
    console.log('Umgebung wird angelegt …');
    const r = run(py.cmd, [...py.pre, '-m', 'venv', VENV]);
    if (r.status !== 0) return 2;
  }
  console.log('pip wird aktualisiert und homr installiert (einige hundert MB) …');
  run(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip']);
  const inst = run(venvPython(), ['-m', 'pip', 'install', 'homr']);
  if (inst.status !== 0) return 3;
  const chk = quiet(venvHomr(), ['--help']);
  if (chk.status !== 0 && !/usage|homr/i.test(chk.stdout + chk.stderr)) {
    console.error('homr läuft nicht:', (chk.stderr || '').trim().split('\n').slice(-3).join(' | '));
    return 4;
  }
  console.log('Notenerkennung ist eingerichtet. Die Modelle lädt homr beim ersten Lauf.');
  const test = opt('--test');
  if (test) {
    console.log(`Testlauf mit ${test} …`);
    run(venvHomr(), [test]);
  }
  return 0;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('setup-omr.mjs')) process.exit(main());
