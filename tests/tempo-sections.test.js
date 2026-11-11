// Tempowechsel in Medleys (gemessen am Bond-Medley, Partitur: ♩ = 126 → „Slower“ ♩ = 104 → half time ♩ = 69 →
// Andante ♩ = 76 → Meno mosso ♩ = 66 / Double time ♩ = 132 → ♩ = 138)
import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedTempoRuns, relatedExcursions } from '../src/input/audio.js';
import { tempoMarksFromTiming } from '../src/input/tempo-marks.js';

const CANDS = [];
for (let b = 40; b <= 220; b *= 1.01) CANDS.push(b);
const idx = (bpm) => CANDS.reduce((best, c, i) => (Math.abs(Math.log(c / bpm)) < Math.abs(Math.log(CANDS[best] / bpm)) ? i : best), 0);

test('Tempokurve: langer Abschnitt im Verhältnis 3:4 ist ein Tempowechsel, eine kurze Figur nicht', () => {
  const nW = 140;
  const wins = [];
  for (let w = 0; w < nW; w++) {
    const raw = CANDS.map(() => 0.1);
    const long = w >= 30 && w < 90; // 60 s „Goldfinger“ (♩ = 104, im halben Puls 52)
    const short = w >= 110 && w < 120; // 10 s Triolen-Figur
    raw[idx(69)] = long || short ? 0.6 : 1;
    raw[idx(52)] = long || short ? 1 : 0.3;
    wins.push({ raw });
  }
  const path = new Array(nW).fill(idx(69));
  relatedTempoRuns(wins, path, CANDS);
  const bpmAt = (w) => Math.round(CANDS[path[w]]);
  for (const w of [32, 50, 70, 87]) assert.ok(Math.abs(bpmAt(w) - 52) <= 1, `Fenster ${w}: ${bpmAt(w)} statt 52`);
  for (const w of [10, 100, 112, 118, 130]) assert.ok(Math.abs(bpmAt(w) - 69) <= 1, `Fenster ${w}: ${bpmAt(w)} statt 69`);
});

test('Tempokurve: kurzer Sprung in die 4:3-Lage (Triolen) bleibt im alten Tempo, ein Wechsel ab 10 s nicht', () => {
  // Bond-Medley vor dem rit.: Viertel-Triolen bei ♩126 (halber Puls 63) ließen die Kurve 8 s auf 84 springen
  const path = [...Array(30).fill(idx(63)), ...Array(8).fill(idx(84)), ...Array(20).fill(idx(63)), ...Array(15).fill(idx(84)), ...Array(20).fill(idx(63))];
  relatedExcursions(path, CANDS);
  const bpmAt = (w) => Math.round(CANDS[path[w]]);
  for (const w of [31, 34, 37]) assert.ok(Math.abs(bpmAt(w) - 63) <= 1, `Fenster ${w}: ${bpmAt(w)} statt 63`);
  for (const w of [59, 65, 72]) assert.ok(Math.abs(bpmAt(w) - 84) <= 1, `Fenster ${w}: ${bpmAt(w)} statt 84 (echter Wechsel, 15 s)`);
  // am Stückende bleibt ein kurzer Wechsel mit Puls bis zum Schluss stehen …
  const winsOf = (pulse) => pulse.map((mx) => ({ mx }));
  const end = [...Array(30).fill(idx(96)), ...Array(6).fill(idx(128))];
  relatedExcursions(end, CANDS, winsOf(Array(36).fill(1)));
  assert.ok(Math.abs(Math.round(CANDS[end[33]]) - 128) <= 1, `Schluss: ${Math.round(CANDS[end[33]])}`);
  // … mündet der Sprung nach oben dagegen in Schlussakkorde ohne Puls, sind es Schluss-Triolen im alten Tempo
  // (Bond T. 164–166: Viertel-Triolen bei ♩138, dann ausgehaltene Akkorde – vorher „♩ = 194“)
  const fig = [...Array(40).fill(idx(69)), ...Array(11).fill(idx(92))];
  const pulse = [...Array(40).fill(1), 0.84, 0.85, 0.93, 0.72, 0.5, 0.4, 0.41, 0.38, 0.34, 0.18, 0.1];
  relatedExcursions(fig, CANDS, winsOf(pulse));
  for (const w of [41, 45, 50]) assert.ok(Math.abs(Math.round(CANDS[fig[w]]) - 69) <= 1, `Fenster ${w}: ${Math.round(CANDS[fig[w]])} statt 69`);
});

test('Tempoangaben: neues Tempo über den ganzen Abschnitt gemessen, lange Abschnitte schon ab 7 %', () => {
  // je Takt ein Tempo: 20 Takte 126, accel. (130, 140, 146), 40 Takte 138, 30 Takte 152, 20 Takte 132
  const bars = [...Array(20).fill(126), 130, 140, 146, 145, 143, ...Array(38).fill(138), ...Array(30).fill(152), ...Array(20).fill(132)];
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const beatSec = [0];
  for (const bpm of bars) for (let b = 0; b < 4; b++) beatSec.push(beatSec[beatSec.length - 1] + 60 / (bpm * (1 + 0.012 * rnd())));
  const { marks } = tempoMarksFromTiming({ beatSec, firstBeat: 0 }, 4, bars.length);
  const tempos = marks.filter((m) => m.kind === 'tempo' || m.kind === 'atempo').map((m) => m.bpm);
  assert.ok(Math.abs(tempos[0] - 126) <= 1, `Anfang ${tempos[0]}`);
  const after = marks.find((m) => m.bar >= 20 && m.bar <= 26 && (m.kind === 'tempo' || m.kind === 'atempo'));
  assert.ok(after && Math.abs(after.bpm - 138) <= 2, `nach dem accel. ${after && after.bpm} statt 138 (${JSON.stringify(marks)})`);
  assert.ok(marks.some((m) => m.kind === 'tempo' && Math.abs(m.bar - 63) <= 2 && Math.abs(m.bpm - 152) <= 2), `152 ab Takt 64 fehlt: ${JSON.stringify(marks)}`);
  assert.ok(marks.some((m) => m.kind === 'tempo' && Math.abs(m.bar - 93) <= 2 && Math.abs(m.bpm - 132) <= 2), `132 ab Takt 94 fehlt: ${JSON.stringify(marks)}`);
});

test('Tempowechsel 120 -> 96 -> 132: nach dem Wechsel das ganze Tempo, nicht das halbe', async () => {
  const { synthSong } = await import('./synth-audio.js');
  const { transcribe } = await import('../src/input/audio.js');
  const tempo = (i) => (i < 32 ? 120 : i < 80 ? 96 : 132);
  const s = synthSong({ groove: 'rock8', bars: 32, bpm: 120, tempo });
  const song = transcribe(s.audio, { title: 'Wechsel' });
  const marks = (song.tempoMarks || []).map((m) => `${m.kind}${m.bpm}@${m.bar}`);
  assert.ok(song.tempoMarks.some((m) => m.kind === 'tempo' && Math.abs(m.bpm - 132) <= 3), `132 fehlt: ${marks}`);
  const got = song.timing.beatSec;
  const hit = s.beatSec.filter((t) => got.some((g) => Math.abs(g - t) <= 0.05)).length / s.beatSec.length;
  assert.ok(hit >= 0.95, `Schläge getroffen ${hit.toFixed(2)}`);
});
