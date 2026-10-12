// Orchestrierung auf der Kommandozeile:
//   node scripts/orchestrate.mjs <Eingabe> [--voices=N] [--out=Datei.musicxml] [--title=Text] [--concert] [--bpm=N]
//
//   Eingabe: Ordner mit vocals.wav, bass.wav, other.wav, drums.wav (Ausgabe von Demucs v4)
//            oder eine Datei: .abc, .mid, .musicxml, .mxl
//   N: 1 … 15 Stimmen (Standard 4): Lead Sheet … Quartett … Blasorchester
// Die Ausgabe nennt die Regelprüfung (Sprünge, Parallelen, Reibungen, Atem …); „Alle Satzregeln
// erfüllt“ heißt: kein Verstoß.
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('Aufruf: node scripts/orchestrate.mjs <Ordner mit Stems | Datei> [--voices=N] [--out=Datei.musicxml] [--title=…] [--concert] [--bpm=N]');
  process.exit(2);
}
const voices = Number(flag('voices', 4));
const { orchestrate, stemsFromWavs, routeStems } = await imp('src/engine/index.js');
const { loadSong } = await imp('src/input/index.js');

let source;
let title = flag('title');
if (statSync(input).isDirectory()) {
  const files = {};
  for (const name of ['vocals', 'bass', 'other', 'drums']) {
    const p = join(input, `${name}.wav`);
    if (existsSync(p)) files[name] = new Uint8Array(readFileSync(p));
  }
  console.log(`Stems: ${Object.keys(files).join(', ')} – Basic Pitch läuft lokal (kann einige Minuten dauern) …`);
  const notes = await stemsFromWavs(files);
  title = title || basename(input);
  source = routeStems(notes, { title, bpm: flag('bpm') ? Number(flag('bpm')) : null });
} else {
  const data = readFileSync(input);
  const isText = /\.(abc|txt)$/i.test(input);
  source = await loadSong({ name: basename(input), data: isText ? data.toString('utf8') : new Uint8Array(data) });
  title = title || source.title;
}
const r = orchestrate(source, { voices, title });
const out = flag('out', `${basename(input, extname(input))}-${voices}-stimmen.musicxml`);
writeFileSync(out, r.xml({ concert: args.includes('--concert') }));
console.log(`${r.report.ensemble} (${voices} Stimmen): ${r.arr.totalBars} Takte, ${r.arr.meta.tempo} BPM, ${r.arr.meta.keyNameDe}`);
console.log(`  Korrekturen: ${JSON.stringify(r.report.repairs)}  Atemstellen: ${r.report.breaths}  Melodieübernahmen: ${r.report.fills}`);
for (const n of r.report.notes) console.log(`  Hinweis: ${n}`);
const viol = Object.entries(r.report.violations);
console.log(viol.length ? `  Regelverstöße: ${viol.map(([k, n]) => `${k} ×${n}`).join(', ')}` : '  Alle Satzregeln erfüllt.');
console.log(`Geschrieben: ${out}`);
