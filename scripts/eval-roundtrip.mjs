// Genauigkeit der Notenerkennung an bekannter Wahrheit messen (Rundreise):
//   node scripts/eval-roundtrip.mjs [Lied] [Stil] [--original] [--reverb] [--nodrums] [--noai] [--passes=N] [--pitch=M]
//   --passes/--pitch: mehrere KI-Durchgänge (Fensterversatz) bzw. Tonhöhen-Ansichten, Aktivierungen gemittelt
//   Lieder: saints | ode | grace | groove (Demo-Lieder), Stile: funk | swing | ballad | …
// Ablauf: Demo-Lied -> Quartett-Partitur (Wahrheit) -> Audio (Blechbläser-Klänge + Schlagzeug) ->
// lokale KI (Basic Pitch) + komplette Erkennung -> Note für Note vergleichen (gleiche Tonhöhe,
// Einsatz ±60 ms). Die KI-Rohnoten werden zwischengespeichert (Rechenzeit ~1× Länge des Stücks).
// Die Zahlen gelten für saubere Instrumentalsätze – echte Aufnahmen sind schwieriger.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const demo = args[0] || 'saints';
const style = args[1] || 'funk';
const SR = 22050;
const { arrange } = await imp('src/arrange/engine.js');
const { transcribe } = await imp('src/input/audio.js');
const { demoSong } = await imp('tests/helpers.js');
const { synthSong } = await imp('tests/synth-audio.js');

const a = arrange(demoSong(demo), { voices: ['trumpet', 'trumpet', 'trombone', 'sousaphone'], style, length: 'short', seed: 1, drums: false, original: flags.includes('--original') });
const tempo = a.tempo;
const spt = 60 / tempo / 24;
const LEAD = 0.5;
const total = a.totalBars * a.mt;
const secOf = (tick) => LEAD + tick * spt;
let x;
if (flags.includes('--nodrums')) x = new Float32Array(Math.ceil((secOf(total) + 2) * SR));
else {
  const s = synthSong({ groove: 'rock8', bars: a.totalBars, bpm: tempo, lead: LEAD, band: false, fills: false, crashEvery: 0, seed: 3 });
  x = new Float32Array(Math.max(s.audio.length, Math.ceil((secOf(total) + 2) * SR)));
  x.set(s.audio);
}
const add = (t0, len, fn) => {
  const a0 = Math.floor(t0 * SR);
  const n = Math.floor(len * SR);
  for (let i = 0; i < n && a0 + i < x.length; i++) if (a0 + i >= 0) x[a0 + i] += fn(i / SR);
};
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const TIMBRE = {
  trumpet: { harm: 9, roll: 0.75, amp: 0.16, att: 0.025 },
  trombone: { harm: 6, roll: 1.0, amp: 0.2, att: 0.03 },
  sousaphone: { harm: 4, roll: 1.2, amp: 0.3, att: 0.03 },
};
const truth = [];
a.voices.forEach((v, vi) => {
  const tb = TIMBRE[v.inst.id] || TIMBRE.trumpet;
  for (const e of v.events) {
    if (!e.pitches || !e.pitches.length || e.drum) continue;
    for (const midi of e.pitches) {
      const t0 = secOf(e.start);
      const len = Math.max(0.05, e.dur * spt * (e.art?.includes('staccato') ? 0.55 : 0.92));
      const f = hz(midi);
      const ph = (truth.length * 1.7) % 6;
      add(t0, len, (s) => {
        const env = Math.min(1, s / tb.att) * Math.min(1, (len - s) / 0.03);
        const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * s + ph);
        let y = 0;
        for (let h = 1; h <= tb.harm; h++) y += Math.sin(2 * Math.PI * f * h * s * vib) / Math.pow(h, tb.roll);
        return tb.amp * env * y;
      });
      truth.push({ sec: t0, end: t0 + e.dur * spt, midi, voice: vi });
    }
  }
});
if (flags.includes('--reverb')) {
  const y = new Float32Array(x.length);
  for (const [d, g] of [[0.045, 0.35], [0.093, 0.25], [0.17, 0.15], [0.29, 0.1]]) {
    const o = Math.floor(d * SR);
    for (let i = o; i < x.length; i++) y[i] += g * x[i - o];
  }
  for (let i = 0; i < x.length; i++) x[i] += y[i];
}
let ai = null;
if (!flags.includes('--noai')) {
  const dir = join(tmpdir(), 'notecode-eval');
  mkdirSync(dir, { recursive: true });
  const flagNum = (k, d) => Number((flags.find((f) => f.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=')[1]);
  const passes = flagNum('passes', 1);
  const pitch = flagNum('pitch', 0);
  const cache = join(dir, `${demo}_${style}${flags.includes('--nodrums') ? '_nd' : ''}${flags.includes('--reverb') ? '_rv' : ''}${flags.includes('--original') ? '_or' : ''}${passes > 1 ? `_p${passes}_${pitch}` : ''}.ai.json`);
  if (existsSync(cache)) ai = JSON.parse(readFileSync(cache, 'utf8'));
  else {
    const { runBasicPitch, aiNotes, loadAi, runEnsemble } = await imp('src/input/ai-pitch.js');
    await loadAi();
    if (passes > 1) ai = (await runEnsemble([{ audio: x, name: 'orig' }], { passes, pitchViews: pitch, budgetMs: 0, minPasses: passes })).notes;
    else ai = aiNotes(await runBasicPitch(x));
    writeFileSync(cache, JSON.stringify(ai));
  }
}
const song = transcribe(x, { title: demo, ai });
const { beatSec, firstBeat, beatTicks } = song.timing;
const tickSec = (tick) => {
  const idx = firstBeat + tick / beatTicks;
  const i = Math.max(0, Math.min(beatSec.length - 2, Math.floor(idx)));
  return beatSec[i] + (idx - i) * (beatSec[i + 1] - beatSec[i]);
};
const out = [];
for (const n of song.melody) out.push({ sec: tickSec(n.start), midi: n.midi, src: 'melody' });
for (const t of song.tracks || []) if (t.id !== 'ai-melody') for (const n of t.notes) out.push({ sec: tickSec(n.start), midi: n.midi, src: t.id });
const TOL = 0.06;
const has = (list, n) => list.some((m) => Math.abs(m.sec - n.sec) <= TOL && m.midi === n.midi);
const rep = (name, tr, os) => {
  const r = tr.length ? tr.filter((n) => has(os, n)).length / tr.length : NaN;
  const p = os.length ? os.filter((n) => has(tr, n)).length / os.length : NaN;
  console.log(`  ${name.padEnd(22)} Wahrheit ${String(tr.length).padStart(4)} | erkannt ${(100 * r).toFixed(1).padStart(5)} % | Ausgabe ${String(os.length).padStart(4)}, richtig ${(100 * p).toFixed(1).padStart(5)} % | F1 ${((200 * r * p) / (r + p || 1)).toFixed(1)} %`);
};
console.log(`${demo} [${style}] ${a.totalBars} Takte, Tempo ${tempo} -> erkannt ${song.tempo} ${song.meter.beats}/${song.meter.beatType}${ai ? `, KI-Noten ${ai.length}` : ' (ohne KI)'}`);
rep('alle Noten', truth, out);
rep('Melodie (Stimme 1)', truth.filter((n) => n.voice === 0), out.filter((n) => n.src === 'melody'));
rep('Bass (Stimme 4)', truth.filter((n) => n.voice === 3), out.filter((n) => n.src === 'ai-bass'));
rep('Mittelstimmen (2+3)', truth.filter((n) => n.voice === 1 || n.voice === 2), out.filter((n) => n.src.startsWith('ai-inner')));
if (ai) {
  const raw = ai.map((n) => ({ sec: n.start, midi: n.midi }));
  const r = truth.filter((n) => has(raw, n)).length / truth.length;
  const p = raw.filter((n) => has(truth, n)).length / raw.length;
  console.log(`  (KI roh, ohne Nachbearbeitung: erkannt ${(100 * r).toFixed(1)} %, richtig ${(100 * p).toFixed(1)} % von ${raw.length} Noten)`);
}
