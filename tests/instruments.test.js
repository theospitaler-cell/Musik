// Instrumentenerkennung: Auswertung der Pegel je Instrumentenspur (MVSep Mega 53 Stems) und Hauptprozess-Anbindung.
// Die Pegel stammen aus echten Läufen auf sechs Aufnahmen mit bekannter Besetzung (dB relativ zur Aufnahme,
// Spuren unter −35 dB weggelassen).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { instrumentsFromLevels, groupInstruments, instrumentsBySection, instrumentName } from '../src/input/instruments.js';
import { encodeWav16 } from '../src/input/stems.js';

const require = createRequire(import.meta.url);
const instrMain = require('../electron/instruments.cjs');

const LEVELS = {
  // „Puttin' on the Ritz“, Blechbläserquintett (2 Trompeten, Horn, Posaune, Tuba)
  ritz: { bassoon: -34.6, brass: -0.1, 'double-bass': -32.9, 'french-horn': -18.6, saxophone: -30, trombone: -7.5, trumpet: -8.3, tuba: -6.7, wind: 0, woodwind: -25.5 },
  // „Gonna Fly Now“, Brass Band mit Schlagwerk
  rocky: { brass: -2, congas: -12, 'double-bass': -33.6, drums: -22.3, 'french-horn': -18.1, harmonica: -32.6, kick: -30.4, percussion: -11, snare: -22.7, tambourine: -29.1, timpani: -15.6, toms: -16.8, trombone: -10.3, trumpet: -10.6, tuba: -11.3, wind: -1.7, woodwind: -32.6 },
  // „Viva la Vida“, Blasorchester (Partitur: Flöte, Oboe, Fagott, Klarinetten, Saxophone, Trompeten, Horn, Posaune, Bariton, Tuba, Bass Line, Schlagwerk, Pauken)
  viva: { bass: -15, bassoon: -24, bells: -29.7, bowed_strings: -32.9, brass: -3.2, clarinet: -19.3, congas: -19.7, 'double-bass': -25.1, flute: -11.3, 'french-horn': -19.3, harmonica: -10.5, kick: -21.7, marimba: -32.4, oboe: -21.5, percussion: -17.2, saxophone: -17.2, timpani: -18.4, toms: -24.2, trombone: -11.6, trumpet: -12.1, tuba: -14.8, wind: -0.9, woodwind: -7.2 },
  // „Viva la Vida“ (Coldplay): Gesang, Streicher, Bass, Klavier, Pauken, Glocken
  vivaOrig: { accordion: -32.7, 'acoustic-guitar': -29.3, 'back-vocal': -14.1, banjo: -29.9, bass: -7.6, bells: -21.3, bowed_strings: -13.4, brass: -34.6, cello: -20.3, congas: -22.9, 'digital-piano': -30.4, dobro: -29.6, 'double-bass': -19.5, drums: -29.1, 'electric-guitar': -25.6, glockenspiel: -34.6, guitar: -22.5, harmonica: -27.7, harp: -32, keys: -18.2, kick: -16.2, 'lead-vocal': -0.8, marimba: -27, oboe: -28.5, organ: -33.8, percussion: -15.2, piano: -19.3, sitar: -27, strings: -11.8, synth: -31.3, timpani: -17.5, toms: -21.2, ukulele: -26.5, viola: -24.9, violin: -18, vocal: -5.9, wind: -24.5, woodwind: -25.5 },
  // „Gonna Fly Now“ (Filmaufnahme): Chor, Blech, Disco-Band mit E-Gitarre, Klavier, Streichern
  rockyOrig: { 'back-vocal': -8.9, banjo: -26.8, bass: -11.4, bowed_strings: -30, brass: -6.2, congas: -28, 'digital-piano': -26.5, 'double-bass': -24.7, drums: -23.6, 'electric-guitar': -15, 'french-horn': -16.8, guitar: -15.1, harp: -25.5, hh: -29.4, keys: -13.4, kick: -17.7, 'lead-vocal': -26.8, mandolin: -31.8, percussion: -20.9, piano: -13.5, sitar: -33.7, snare: -26.6, strings: -14.6, synth: -18.5, tambourine: -21.7, toms: -25.8, trombone: -13.5, trumpet: -15.4, tuba: -27.4, ukulele: -26.2, violin: -31.7, vocal: -8.5, wind: -6 },
};
const names = (l) => instrumentsFromLevels(l).map((x) => x.name);

test('Instrumente: Blechbläserquintett genau – Trompete, Horn, Posaune, Tuba, sonst nichts', () => {
  assert.deepEqual(names(LEVELS.ritz).sort(), ['Horn', 'Posaune', 'Trompete', 'Tuba']);
  assert.deepEqual(groupInstruments(instrumentsFromLevels(LEVELS.ritz)).map((g) => g.label), ['Blechbläser']);
});

test('Instrumente: Blasorchester mit Holzbläsern, ohne Schein-Mundharmonika', () => {
  const v = names(LEVELS.viva);
  for (const n of ['Flöte', 'Oboe', 'Klarinette', 'Saxophon', 'Trompete', 'Horn', 'Posaune', 'Tuba', 'Pauken', 'Bass']) assert.ok(v.includes(n), `${n} fehlt: ${v}`);
  assert.ok(!v.includes('Mundharmonika'), 'Mundharmonika ist eine Verwechslung mit den Holzbläsern');
  assert.ok(!v.some((n) => ['Violine', 'Gesang', 'E-Gitarre', 'Klavier'].includes(n)), `fremde Instrumente: ${v}`);
  // ohne Holzbläser bleibt eine echte Mundharmonika stehen
  assert.ok(names({ harmonica: -6, woodwind: -30 }).includes('Mundharmonika'));
});

test('Instrumente: Brass Band mit Schlagwerk, Popband mit Streichern, Filmaufnahme mit Chor', () => {
  const r = names(LEVELS.rocky);
  for (const n of ['Trompete', 'Posaune', 'Tuba', 'Horn', 'Pauken', 'Schlagzeug', 'Percussion']) assert.ok(r.includes(n), `${n} fehlt: ${r}`);
  assert.ok(!r.some((n) => ['Flöte', 'Klarinette', 'Saxophon', 'Gesang'].includes(n)), `Brass Band ohne Holzbläser: ${r}`);
  const vo = names(LEVELS.vivaOrig);
  for (const n of ['Gesang', 'Chor', 'Violine', 'Cello', 'Kontrabass', 'Klavier', 'Bass', 'Pauken', 'Glocken']) assert.ok(vo.includes(n), `${n} fehlt: ${vo}`);
  assert.ok(!vo.some((n) => ['Trompete', 'Posaune', 'Flöte'].includes(n)), `kein Blech/Holz: ${vo}`);
  const ro = names(LEVELS.rockyOrig);
  for (const n of ['Chor', 'E-Gitarre', 'Klavier', 'Bass', 'Trompete', 'Posaune', 'Streicher']) assert.ok(ro.includes(n), `${n} fehlt: ${ro}`);
});

test('Instrumente je Formteil: Pegel relativ zum Formteil, Takte über die Schlagzeiten', () => {
  // 4 Fenster à 3 s: erst nur Tuba, dann Trompete + Tuba
  const windows = { hop: 3, mix: [-20, -20, -14, -14], stems: { tuba: [-20.5, -20.5, -20, -20], trumpet: [-60, -60, -16, -16] } };
  const secs = instrumentsBySection(windows, { sections: [{ label: 'A', start: 0, length: 2 }, { label: 'B', start: 2, length: 2 }], barSec: (b) => b * 3 });
  assert.deepEqual(secs.map((s) => s.instruments), [['tuba'], ['trumpet', 'tuba']]);
  assert.equal(instrumentName('trumpet'), 'Trompete');
  assert.equal(instrumentName('drums'), 'Schlagzeug');
});

// ---- Hauptprozess: Python-Attrappe statt Modell
function fakePython(dir) {
  const script = join(dir, 'fakepy.cjs');
  writeFileSync(
    script,
    `
const a = process.argv.slice(2);
if (a.includes('--input')) {
  console.log('NOTECODE_PROGRESS 0.25'); console.log('NOTECODE_PROGRESS 1.0');
  console.log('NOTECODE_RESULT ' + JSON.stringify({ model: 'fake', device: 'cuda', sec: 1, levels: { trumpet: -8, tuba: -7, wind: 0 }, windows: { hop: 3, mix: [-20], stems: { trumpet: [-28], tuba: [-27] } } }));
  process.exit(0);
}
console.log('NOTECODE_PROBE ' + JSON.stringify({ ok: true }));
`,
  );
  return [process.execPath, script];
}

test('Hauptprozess: Zustand (eingerichtet? Grafikkarte?) und Erkennung über die Attrappe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nc-instr-'));
  const old = process.env.NOTECODE_INSTRUMENTS_HOME;
  process.env.NOTECODE_INSTRUMENTS_HOME = join(dir, 'home');
  try {
    const py = fakePython(dir);
    assert.equal((await instrMain.status({ python: py, cuda: true })).ready, false, 'ohne Modell nicht bereit');
    mkdirSync(join(dir, 'home', 'msst', 'utils'), { recursive: true });
    for (const f of ['mega53.ckpt', 'mega53.yaml', join('msst', 'utils', 'settings.py')]) writeFileSync(join(dir, 'home', f), 'x');
    assert.match((await instrMain.status({ python: py, cuda: false })).reason, /Grafikkarte/);
    assert.deepEqual(await instrMain.status({ python: py, cuda: true }), { ready: true, reason: null });
    const prog = [];
    const res = await instrMain.recognize(encodeWav16([new Float32Array(4410), new Float32Array(4410)], 44100), { python: py, onProgress: (f) => prog.push(f) });
    assert.deepEqual(res.levels, { trumpet: -8, tuba: -7, wind: 0 });
    assert.ok(prog.includes(0.25) && prog[prog.length - 1] === 1, `Fortschritt ${prog}`);
    assert.deepEqual(names(res.levels).sort(), ['Trompete', 'Tuba']);
  } finally {
    if (old === undefined) delete process.env.NOTECODE_INSTRUMENTS_HOME;
    else process.env.NOTECODE_INSTRUMENTS_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
