import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange } from '../src/arrange/engine.js';
import { demoSong } from './helpers.js';

// Anteil schneller Noten (Sechzehntel und kürzer) über alle Stimmen
function fastShare(a) {
  let fast = 0;
  let all = 0;
  for (const v of a.voices) {
    for (const e of v.events) {
      if (e.role === 'rest') continue;
      all++;
      if (e.dur <= 6) fast++;
    }
  }
  return all ? fast / all : 0;
}

test('Profi: deutlich mehr schnelle Noten als Fortgeschritten, Stimmen bleiben gültig', () => {
  for (const id of ['saints', 'ode']) {
    const song = demoSong(id);
    const base = { voices: ['trumpet', 'trumpet', 'trombone', 'sousaphone'], style: 'funk', seed: 3, adapt: 2 };
    const adv = arrange(song, { ...base, difficulty: 4 });
    const pro = arrange(song, { ...base, difficulty: 5 });
    const a = fastShare(adv);
    const p = fastShare(pro);
    assert.ok(p > a + 0.02, `${id}: Profi ${p.toFixed(3)} vs Fortgeschritten ${a.toFixed(3)}`);
    assert.ok(pro.voices.every((v) => v.events.length > 0));
    for (const v of pro.voices) {
      const ev = [...v.events].sort((x, y) => x.start - y.start);
      for (let i = 1; i < ev.length; i++) assert.ok(ev[i].start >= ev[i - 1].start + 1, 'keine Überlappung am Anfang');
      assert.ok(ev.every((e) => e.dur > 0), 'keine Null-Dauern');
    }
  }
});
