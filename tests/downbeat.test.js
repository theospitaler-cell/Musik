// Taktanfang aus Aufnahmen: Half-Time-Akzente gegen die Harmonik, Geräusch vor dem Einsatz.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findMeter, trimLeadingBars } from '../src/input/audio.js';

// Schläge mit Akkord je Takt (Wechsel bei Schlag ≡ phase mod 4) und Mittenband-Akzenten bei Schlag ≡ acc mod 4
function beats({ n = 64, phase = 1, acc = 0 } = {}) {
  const chords = [[0, 4, 7], [5, 9, 0], [7, 11, 2], [9, 0, 4]];
  const bc = [];
  const mid = [];
  for (let i = 0; i < n; i++) {
    const bar = Math.floor((i - phase + 4 * n) / 4) % 4;
    const c = new Float32Array(12);
    const b = new Float32Array(12);
    for (const p of chords[bar]) c[p] = 1;
    b[chords[bar][0]] = 1;
    bc.push({ c, b });
    mid.push(((i % 4) + 4) % 4 === acc ? 1 : 0.1);
  }
  return { bc, mid };
}

test('Taktanfang: Half-Time-Akzente nicht gegen klare Akkordwechsel (Blasorchester ohne Backbeat)', () => {
  // Akkorde wechseln auf Schlag 1, 5, 9 … (Lage 1); die Akzente im Mittenband liegen auf 0, 4, 8 … -> „Snare auf
  // der Drei“ hieße Lage 2 – genau die Lage, die zur Harmonik am wenigsten passt
  const { bc, mid } = beats({ phase: 1, acc: 0 });
  const m = findMeter(bc, { mid });
  assert.equal(m.beats, 4);
  assert.equal(m.phase, 1, `Lage ${m.phase}`);
  // passen Akzente und Harmonik zusammen (Akkordwechsel in Lage 2), bleibt die Half-Time-Lage
  const ok = beats({ phase: 2, acc: 0 });
  assert.equal(findMeter(ok.bc, { mid: ok.mid }).phase, 2);
});

const MT = 96;
const song = (melody, tracks = []) => ({ melody, tracks, measureCount: 20, timing: { beatSec: Array.from({ length: 90 }, (_, i) => i * 0.5), firstBeat: 0 }, sections: [{ label: 'A', start: 0, length: 20 }] });
const line = (from, k = 24) => Array.from({ length: k }, (_, i) => ({ start: from + i * 24, dur: 24, midi: 65 + (i % 5) }));

test('Taktanfang: ein vereinzelter Ton vor der Eins mit Stille danach ist Geräusch (Viva la Vida)', () => {
  const s = song([{ start: -30, dur: 66, midi: 62 }, ...line(MT)]);
  assert.equal(trimLeadingBars(s, MT, 4), 1);
  assert.equal(s.pickup, 0);
  assert.equal(s.melody[0].start, 0);
  // ein echter Auftakt führt ohne Pause in die Eins und bleibt
  const p = song([{ start: -24, dur: 24, midi: 62 }, ...line(0)]);
  assert.equal(trimLeadingBars(p, MT, 4), 0);
  assert.equal(p.melody[0].start, -24);
});

test('Taktanfang: Melodietöne nur auf dem letzten Schlag, die weiterführen, sind ein Auftakt (Gonna Fly Now)', () => {
  // Takt 1 hat nur eine Achtel auf 3½, dann geht es auf der Eins weiter -> Auftakt, Takt 2 wird Takt 1
  const s = song([{ start: 84, dur: 12, midi: 60 }, ...line(MT)]);
  assert.equal(trimLeadingBars(s, MT, 4), 1);
  assert.equal(s.pickup, 12);
  assert.deepEqual(s.melody.slice(0, 2).map((n) => n.start), [-12, 0]);
  // ein einzelner Ton auf dem letzten Schlag mit Pause danach (Bond-Medley: B4, dann 1½ Schläge nichts): kein Auftakt
  const b = song([{ start: 72, dur: 12, midi: 70 }, ...line(MT + 48)]);
  assert.equal(trimLeadingBars(b, MT, 4), 0);
  assert.equal(b.melody[0].start, 72);
});

test('Taktanfang: Rumpeln ganz unten vor dem Einsatz zählt nicht, ein Bass-Intro schon', () => {
  // Puttin' on the Ritz: H0, G1, Es1, F1, Cis1 in drei Takten, dann Tuba F3
  const rumble = [23, 31, 27, 29, 25].map((midi, i) => ({ start: 84 + i * 40, dur: 24, midi }));
  const s = song(line(3 * MT), [{ role: 'bass', notes: rumble }]);
  assert.equal(trimLeadingBars(s, MT, 4), 3);
  // Gonna Fly Now: F1, F1 gehalten, G1 vor dem Auftakt – auch in einer Mittelstimme; der Achtel-Auftakt der
  // Kornette (letzte Achtel des Takts, führt ohne Pause weiter) steht danach vor Takt 1
  const r = song(line(MT + 84), [{ role: 'inner', notes: [{ start: 0, dur: 36, midi: 29 }] }, { role: 'bass', notes: [{ start: 36, dur: 132, midi: 29 }, { start: 168, dur: 18, midi: 31 }] }]);
  assert.equal(trimLeadingBars(r, MT, 4), 2);
  assert.equal(r.pickup, 12);
  assert.equal(r.melody[0].start, -12);
  // Bass-Intro mit Muster (zwei Takte Achtel auf E1/A1) vor der Melodie: bleibt
  const intro = Array.from({ length: 16 }, (_, i) => ({ start: i * 12, dur: 12, midi: i % 2 ? 33 : 28 }));
  const b = song(line(2 * MT), [{ role: 'bass', notes: intro }]);
  assert.equal(trimLeadingBars(b, MT, 4), 0);
});
