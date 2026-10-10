import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseABC } from '../src/input/abc.js';
import { demoSong } from './helpers.js';
import { DEMOS } from '../src/demos.js';

test('ABC: Auftakt, Tonart, Akkorde, Abschnitte', () => {
  const s = demoSong('saints');
  assert.equal(s.pickup, 72, 'Auftakt = 3 Viertel');
  assert.equal(s.key.fifths, -1, 'F-Dur');
  assert.equal(s.meter.beats, 4);
  assert.ok(s.melody[0].start < 0, 'erste Note liegt im Auftakt');
  assert.ok(s.chords.length >= 8);
  assert.ok(s.sections.length >= 2);
});

test('ABC: Wiederholungen mit 1./2. Klammer werden ausgeschrieben', () => {
  const s = parseABC(`X:1
T:Rep
M:4/4
L:1/4
K:C
|:"C"C D E F|1"G"G4:|2"C"c4|]`);
  // C D E F | G | C D E F | c  -> 4 Takte
  assert.equal(s.measureCount, 4);
  const pitches = s.melody.map((n) => n.midi);
  assert.deepEqual(pitches, [60, 62, 64, 65, 67, 60, 62, 64, 65, 72]);
});

test('ABC: Triolen, punktierte Rhythmen und Vorzeichen im Takt', () => {
  const s = parseABC(`X:1
T:T
M:4/4
L:1/8
K:C
(3CDE F>G ^F F z2|]`);
  const d = s.melody.map((n) => n.dur);
  assert.deepEqual(d.slice(0, 3), [8, 8, 8], 'Achteltriolen');
  assert.equal(d[3], 18, 'punktierte Achtel');
  assert.equal(d[4], 6, '16tel');
  assert.equal(s.melody[5].midi, 66, '^F');
  assert.equal(s.melody[6].midi, 66, 'Vorzeichen gilt im ganzen Takt');
});

test('Alle Demos lassen sich lesen', () => {
  for (const d of DEMOS) {
    const s = parseABC(d.abc);
    assert.ok(s.melody.length > 10, d.id);
    assert.ok(s.measureCount >= 8, d.id);
  }
});
