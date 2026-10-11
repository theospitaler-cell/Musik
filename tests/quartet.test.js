// Quartett-Satz: spielbare Stimmführung (höchstens Oktavsprung), eigenständige Rhythmen der
// Mittelstimmen, keine Stille mitten im Stück.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capLeaps } from '../src/arrange/voicing.js';
import { arrange } from '../src/arrange/engine.js';
import { getInstrument } from '../src/arrange/instruments.js';
import { demoSong } from './helpers.js';

const ev = (start, dur, midi) => ({ start, dur, pitches: [midi], art: [], fx: [], role: 'melody' });
const leaps = (events, restGap = 96) => {
  const s = [...events].filter((e) => e.pitches && e.pitches.length).sort((a, b) => a.start - b.start);
  let n = 0;
  for (let i = 1; i < s.length; i++) if (s[i].start - (s[i - 1].start + s[i - 1].dur) < restGap && Math.abs(s[i].pitches[0] - s[i - 1].pitches[0]) > 12) n++;
  return n;
};

test('Sprünge: ein Ausreißer wird allein um Oktaven versetzt, die Phrase bleibt in ihrer Lage', () => {
  const inst = getInstrument('trumpet');
  const line = [ev(0, 12, 64), ev(12, 12, 66), ev(24, 12, 90), ev(36, 12, 67), ev(48, 12, 69)];
  const moved = capLeaps(line, inst);
  assert.equal(moved, 1);
  assert.deepEqual(line.map((e) => e.pitches[0]), [64, 66, 78, 67, 69], 'F#6 steht eine Oktave tiefer (Sprung genau eine Oktave) – der Rest bleibt');
  assert.equal(leaps(line), 0, 'keine Sprünge über eine Oktave');
});

test('Sprünge: ein dauerhafter Registerwechsel wird mit möglichst wenigen Oktavversetzungen aufgelöst, nach langer Pause ist jede Lage erlaubt', () => {
  const inst = getInstrument('trumpet');
  const phrase = [ev(0, 12, 60), ev(12, 12, 62), ev(24, 12, 86), ev(36, 12, 88), ev(48, 12, 90), ev(60, 12, 88)];
  const before = phrase.map((e) => e.pitches[0] % 12);
  const moved = capLeaps(phrase, inst);
  assert.equal(leaps(phrase), 0);
  assert.deepEqual(phrase.map((e) => e.pitches[0] % 12), before, 'Tonklassen bleiben, nur die Oktavlage ändert sich');
  assert.ok(moved >= 1 && moved <= 4, `versetzte Töne: ${moved}`);
  // nach einer Pause von zwei Takten: neue Phrase, kein Eingriff
  const rest = [ev(0, 12, 60), ev(12, 12, 62), ev(12 + 12 + 192, 12, 90)];
  assert.equal(capLeaps(rest, inst), 0);
  assert.equal(rest[2].pitches[0], 90);
  // nur im Umfang des Instruments: kein Ausweichen aus dem Tonumfang
  const tiny = { ...inst, range: [60, 72] };
  const edge = [ev(0, 12, 60), ev(12, 12, 72)];
  capLeaps(edge, tiny);
  assert.ok(edge.every((e) => e.pitches[0] >= 60 && e.pitches[0] <= 72));
});

// Vorlage mit Begleitung: zwei Akkordtöne im Viertel-Rhythmus (4 Einwürfe je Takt) und Bass
function bandSong() {
  const s = demoSong('ode');
  const mt = 96;
  const bars = s.measureCount;
  const tone = (pcOff) => Array.from({ length: bars * 4 }, (_, i) => ({ start: i * 24, dur: 12, midi: 60 + pcOff + (Math.floor(i / 4) % 2 ? 2 : 0) }));
  const bass = Array.from({ length: bars * 2 }, (_, i) => ({ start: i * 48, dur: 36, midi: 36 + (Math.floor(i / 2) % 2 ? 2 : 0) }));
  void mt;
  return { ...s, source: 'midi', tracks: [{ id: 'm', name: 'Gesang', mel: true, notes: s.melody }, { id: 'ai-bass', name: 'Bass', role: 'bass', notes: bass }, { id: 'ai-inner1', name: 'Gitarre', notes: tone(7) }, { id: 'ai-inner2', name: 'Keys', notes: tone(4) }], drumNotes: [] };
}

const attackSet = (v) => new Set(v.events.filter((e) => e.pitches && e.pitches.length).map((e) => e.start));
const jaccard = (a, b) => {
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / Math.max(1, a.size + b.size - both);
};

test('Quartett (Original übernehmen): die dritte Stimme hält, die zweite spielt das Einwurf-Muster', () => {
  const a = arrange(bandSong(), { voices: ['trumpet', 'trumpet', 'trombone', 'sousaphone'], original: true });
  const [, v2, v3] = a.voices;
  const n2 = attackSet(v2).size;
  const n3 = attackSet(v3).size;
  assert.ok(n2 > 0 && n3 > 0, 'beide Mittelstimmen spielen');
  assert.ok(n3 <= 0.6 * n2, `dritte Stimme hat weniger Anschläge: ${n3} gegenüber ${n2}`);
  assert.ok(jaccard(attackSet(v2), attackSet(v3)) < 0.7, 'eigenständiger Rhythmus');
});

test('Quartett: keine Stimme springt mehr als eine Oktave (Original, nah am Original, frei)', () => {
  const s = demoSong('saints');
  // Melodie mit zwei Sprüngen über eine Oktave und Registerwechsel
  const melody = s.melody.map((n, i) => (i % 9 === 4 ? { ...n, midi: n.midi + 24 } : n));
  const song = { ...s, melody };
  for (const opts of [{ original: true }, {}, { adapt: 2 }]) {
    const a = arrange(song, { voices: ['trumpet', 'trumpet', 'trombone', 'sousaphone'], style: 'funk', seed: 3, ...opts });
    let total = 0;
    let bad = 0;
    for (const v of a.voices) {
      total += v.events.length;
      bad += leaps(v.events, 4 * a.beat);
    }
    assert.ok(bad <= 0.01 * total, `Sprünge über eine Oktave: ${bad} von ${total} (${JSON.stringify(opts)})`);
  }
});

test('Quartett (Original übernehmen): keine Stille, in der alle Stimmen zugleich schweigen', () => {
  const s = demoSong('ode');
  const bars = s.measureCount;
  // Begleitung läuft mit der Melodie (Terzen/Sexten), Bass in Vierteln; mitten im vierten Takt
  // setzen alle zwei Schläge aus – die Pause von zwei Schlägen darf nicht in totaler Stille enden
  const from = 3 * 96 + 24;
  const to = 3 * 96 + 72;
  const cut = (n) => !(n.start >= from && n.start < to);
  const trim = (n) => (n.start < from && n.start + n.dur > from ? { ...n, dur: from - n.start } : n);
  const mel = s.melody.filter(cut).map(trim);
  const par = (d) => mel.map((n) => ({ ...n, midi: n.midi - d }));
  const bass = Array.from({ length: bars * 4 }, (_, i) => ({ start: i * 24, dur: 12, midi: 36 + (Math.floor(i / 4) % 2 ? 2 : 0) }));
  const song = {
    ...s,
    source: 'midi',
    melody: mel,
    tracks: [
      { id: 'm', name: 'Gesang', mel: true, notes: mel },
      { id: 'ai-bass', name: 'Bass', role: 'bass', notes: bass.filter(cut).map(trim) },
      { id: 'ai-inner1', name: 'Gitarre', notes: par(4) },
      { id: 'ai-inner2', name: 'Keys', notes: par(9) },
    ],
    drumNotes: [],
  };
  const a = arrange(song, { voices: ['trumpet', 'trumpet', 'trombone', 'sousaphone'], original: true });
  const total = a.totalBars * a.mt;
  const covered = new Uint8Array(Math.ceil(total / 6));
  for (const v of a.voices) for (const e of v.events) if (e.pitches && e.pitches.length) for (let k = Math.floor(e.start / 6); k < Math.ceil((e.start + e.dur) / 6) && k < covered.length; k++) covered[k] = 1;
  let run = 0;
  let worst = 0;
  for (let k = covered.indexOf(1); k <= covered.lastIndexOf(1); k++) {
    run = covered[k] ? 0 : run + 1;
    worst = Math.max(worst, run);
  }
  assert.ok(worst * 6 < 24, `längste Stille mitten im Stück: ${worst * 6} Ticks`);
});
