import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInstrument, fitMelodyOctave, foldIntoRange } from '../src/arrange/instruments.js';

// Melodie wie im Lied „William Tell“: meist um 66–70, selten bis 76 – für die Posaune (Umfang 40–72)
const melody = (pattern) => pattern.map((midi, i) => ({ start: i * 12, dur: 12, midi }));

test('Melodie: bleibt in der Originaloktave, wenn nur wenige Töne zu hoch sind', () => {
  const posaune = getInstrument('trombone');
  const pattern = [];
  for (let i = 0; i < 60; i++) pattern.push(i % 10 === 9 ? 75 : 66 + (i % 5));
  const m = melody(pattern); // jeder zehnte Ton über dem Umfang
  const over = m.filter((n) => n.midi > posaune.range[1]).length / m.length;
  assert.ok(over > 0 && over < 1 / 3, `Anteil zu hoch: ${over}`);
  assert.equal(fitMelodyOctave(m, posaune), 0, 'keine Oktavverschiebung der ganzen Stimme');
  const folded = m.map((n) => foldIntoRange(n.midi, posaune));
  assert.ok(folded.every((x) => x >= posaune.range[0] && x <= posaune.range[1]));
  // die übrigen Töne bleiben in der Originaloktave
  const same = folded.filter((x, i) => x === m[i].midi).length / m.length;
  assert.ok(same >= 0.85, `unveränderte Töne: ${same}`);
});

test('Melodie: wenn der Großteil nicht spielbar ist, wird die Stimme verschoben', () => {
  const posaune = getInstrument('trombone');
  const m = melody(Array.from({ length: 40 }, (_, i) => 80 + (i % 6)));
  const shift = fitMelodyOctave(m, posaune);
  assert.ok(shift <= -12, `Verschiebung: ${shift}`);
});

test('Melodie: Töne in Umfang bleiben unverändert', () => {
  assert.equal(foldIntoRange(60, getInstrument('trombone')), 60);
});
