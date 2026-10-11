import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFormEdits, applyFormEdits, reformSong } from '../src/model/reform.js';
import { arrange, usesFaithful } from '../src/arrange/engine.js';
import { songMeasureTicks } from '../src/model/song.js';
import { buildChord } from '../src/theory/chords.js';

const MT = 96;

// Aufnahme-ähnliches Stück: Melodie, Bass, eine Begleitstimme, Schlagzeug; Formteile als Buchstaben
function makeSong(form, { melodyFromBar = 0 } = {}) {
  const sections = [];
  let bar = 0;
  for (const [label, len] of form) {
    sections.push({ label, start: bar, length: len });
    bar += len;
  }
  const M = bar;
  const melody = [];
  const bass = [];
  const gtr = [];
  const drums = [];
  const chords = [];
  for (let b = 0; b < M; b++) {
    const root = [48, 53, 55, 48][b % 4];
    chords.push({ start: b * MT, dur: MT, chord: buildChord([0, 5, 7, 0][b % 4], 'major') });
    for (let k = 0; k < 4; k++) {
      bass.push({ start: b * MT + k * 24, dur: 24, midi: root - 12 });
      drums.push({ start: b * MT + k * 24, dur: 6, midi: k % 2 ? 38 : 36 });
      if (b >= melodyFromBar) melody.push({ start: b * MT + k * 24, dur: 24, midi: 72 + ((b + k) % 5) });
    }
    gtr.push({ start: b * MT, dur: MT, midi: root + 7 });
    gtr.push({ start: b * MT, dur: MT, midi: root + 4 });
  }
  return {
    title: 'T',
    key: { fifths: 0, mode: 'major', tonicLof: 0 },
    meter: { beats: 4, beatType: 4 },
    tempo: 100,
    measureCount: M,
    pickup: 0,
    melody,
    chords,
    sections,
    source: 'audio',
    drumNotes: drums,
    tracks: [
      { id: 'bass', name: 'Bass', role: 'bass', notes: bass, program: 33 },
      { id: 'gtr', name: 'Begleitung', notes: gtr, program: 25 },
    ],
    tempoMarks: [],
    timing: { beatSec: Array.from({ length: M * 4 + 8 }, (_, i) => i * 0.6), firstBeat: 0, beatTicks: 24 },
    warnings: [],
  };
}

test('Neu arrangieren: kurzes Stück ohne Vorspann bekommt Vorspann und Anhang, sonst nichts', () => {
  const song = makeSong([['A', 8], ['B', 8]]);
  const p = planFormEdits(song);
  assert.deepEqual(p.segments.map((s) => s.kind), ['intro', 'main', 'main', 'tag']);
  const { song: s2, changed } = reformSong(song);
  assert.ok(changed);
  assert.equal(s2.measureCount, 16 + 2 + 2);
  // Vorspann ohne Melodie, danach alle Melodietöne der Vorlage (plus der Anhang)
  const introEnd = p.segments[0].len * MT;
  assert.ok(s2.melody.every((n) => n.start >= introEnd || n.start < 0));
  assert.equal(s2.melody.length, song.melody.length + song.melody.filter((n) => n.start >= 14 * MT).length);
  assert.equal(s2.sections[0].label, 'Intro');
  assert.equal(s2.formEdited, true);
});

test('Neu arrangieren: Stück mit Vorspann bleibt vorn unverändert; sehr kurze Stücke bleiben ganz', () => {
  const withIntro = makeSong([['A', 8], ['B', 8]], { melodyFromBar: 4 });
  const p = planFormEdits(withIntro);
  assert.ok(!p.segments.some((s) => s.kind === 'intro'));
  const tiny = makeSong([['A', 4], ['B', 4]]);
  assert.equal(planFormEdits(tiny).segments, null);
  assert.equal(reformSong(tiny).changed, false);
});

test('Neu arrangieren: viele gleiche Strophen – einzelne Wiederholungen fallen weg (erste und letzte bleiben)', () => {
  const song = makeSong([['A', 8], ['B', 8], ['A', 8], ['B', 8], ['A', 8], ['B', 8], ['A', 8], ['C', 8], ['A', 8]]);
  assert.equal(song.measureCount, 72);
  const p = planFormEdits(song);
  const mains = p.segments.filter((s) => s.kind === 'main');
  assert.ok(mains.length < 9, 'es fehlt mindestens ein Teil');
  assert.equal(mains[0].from, 0, 'der erste Teil bleibt');
  assert.equal(mains[mains.length - 1].from, 64, 'der letzte Teil bleibt');
  const dropped = 72 - mains.reduce((a, s) => a + s.len, 0);
  assert.ok(dropped > 0 && dropped <= 0.25 * 72, `weggelassen: ${dropped} Takte`);
  assert.ok(p.notes.some((n) => /Gekürzt/.test(n)));
  const s2 = applyFormEdits(song, p.segments);
  // Zeitachse bleibt lückenlos, wächst stetig
  const bs = s2.timing.beatSec;
  assert.ok(bs.every((t, i) => !i || t > bs[i - 1]));
  assert.equal(bs.length, s2.measureCount * 4 + 1);
  // Formteile lückenlos
  let pos = 0;
  for (const sec of s2.sections) {
    assert.equal(sec.start, pos);
    pos += sec.length;
  }
  assert.equal(pos, s2.measureCount);
  assert.equal(songMeasureTicks(s2), MT);
});

test('Neu arrangieren: Standard bleibt nah am Original, „Frei“ schreibt den Satz selbst', () => {
  const song = makeSong([['A', 8], ['B', 8]]);
  const voices = ['trumpet', 'trumpet', 'trombone', 'sousaphone'];
  assert.equal(usesFaithful(song, { voices }), true);
  assert.equal(usesFaithful(song, { voices, adapt: 2 }), false);
  assert.equal(usesFaithful(song, { voices, original: true }), false);
  const a = arrange(song, { voices, style: 'funk', seed: 1 });
  assert.equal(a.faithful, true);
  assert.equal(a.totalBars, 16 + 2 + 2);
  assert.ok(a.voices.every((v) => v.events.length > 0));
  // Melodie steht fast unverändert in der Führungsstimme (Tonhöhen der Vorlage, evtl. oktaviert)
  const lead = a.voices[0].events.filter((e) => e.start >= 2 * MT);
  const pcs = new Set(song.melody.map((n) => n.midi % 12));
  const same = lead.filter((e) => pcs.has(e.pitches[0] % 12)).length / lead.length;
  assert.ok(same >= 0.9, `Tonklassen der Melodie: ${same}`);
  const free = arrange(song, { voices, style: 'funk', seed: 1, adapt: 2 });
  assert.ok(!free.faithful);
  // ohne Begleit-Vorlage (nur Melodie + Akkorde) wird weiter frei arrangiert
  const sheet = { ...song, tracks: [], source: 'abc' };
  assert.equal(usesFaithful(sheet, { voices }), false);
});
