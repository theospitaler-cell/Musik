import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseABC } from '../src/input/abc.js';
import { demoSong } from './helpers.js';
import { DEMOS } from './fixtures/songs.js';

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

// ---- Lead-Erkennung (Hauptmelodie) ----
import { makeMidi } from './helpers.js';
import { songFromMidi } from '../src/input/midi.js';

function saintsEvents(ch) {
  const s = demoSong('saints');
  return s.melody.map((n) => ({ t: ((n.start + 72) * 96) / 24, d: (n.dur * 96) / 24 - 4, key: n.midi, ch }));
}
const bars = 16;
const chordsTrack = (ch, top = false) => {
  const ev = [];
  for (let b = 0; b < bars; b++) for (let q = 0; q < 4; q++) for (const k of top ? [72, 76, 79] : [60, 64, 67]) ev.push({ t: (b * 4 + q) * 96, d: 90, key: k, ch, vel: 70 });
  return ev;
};
const bassTrack = (ch) => Array.from({ length: bars * 2 }, (_, i) => ({ t: i * 192, d: 180, key: i % 2 ? 41 : 36, ch }));
const arpTrack = (ch) => Array.from({ length: bars * 16 }, (_, i) => ({ t: i * 24, d: 22, key: [72, 76, 79, 84][i % 4], ch, vel: 60 }));
const melodyOf = (song) => song.melody.map((n) => n.midi).join(',');
const saintsKeys = saintsEvents(0).map((n) => n.key).join(',');

test('Lead-Erkennung MIDI: Gesangsspur neben Klavier-Akkorden und Bass', () => {
  const mid = makeMidi([
    { name: 'Spur 1', programs: { 0: 0 }, events: chordsTrack(0, true) },
    { name: 'Bass', programs: { 1: 33 }, events: bassTrack(1) },
    { name: 'Track 3', programs: { 2: 52 }, events: saintsEvents(2) },
  ]);
  const s = songFromMidi(mid);
  assert.equal(melodyOf(s), saintsKeys);
});

test('Lead-Erkennung MIDI Typ 0: Melodie-Kanal statt hoher Arpeggio-Begleitung', () => {
  const ev = [...arpTrack(0), ...saintsEvents(1), ...bassTrack(2)];
  const mid = makeMidi([{ name: 'Song', programs: { 0: 0, 1: 65, 2: 33 }, events: ev }]);
  const s = songFromMidi(mid);
  assert.equal(s.parts.length, 3, 'Kanäle werden als eigene Stimmen erkannt');
  assert.equal(melodyOf(s), saintsKeys);
});

test('Lead-Erkennung MIDI: Melodie in Mittellage unter einem hohen Pad', () => {
  const pad = [];
  for (let b = 0; b < bars; b++) for (const k of [76, 79, 83]) pad.push({ t: b * 384, d: 380, key: k, ch: 0, vel: 50 });
  const mid = makeMidi([
    { name: 'Spur 1', programs: { 0: 89 }, events: pad },
    { name: 'Spur 2', programs: { 1: 56 }, events: saintsEvents(1) },
  ]);
  assert.equal(melodyOf(songFromMidi(mid)), saintsKeys);
});

test('MIDI mit Tempowechseln: neues Tempo und rit. landen in Noten & Wiedergabe', async () => {
  const { arrange } = await import('../src/arrange/engine.js');
  const { performArrangement } = await import('../src/output/performance.js');
  const { exportMusicXML } = await import('../src/output/musicxml.js');
  // 16 Takte Melodie in Vierteln; Takt 9: Tempo 140; Takt 15–16: rit. in kleinen Schritten
  const events = [];
  for (let q = 0; q < 64; q++) events.push({ t: q * 96, d: 90, ch: 0, key: 72 + ((q * 5) % 7) });
  const tempos = [{ t: 0, bpm: 100 }, { t: 8 * 384, bpm: 140 }];
  for (let k = 0; k < 6; k++) tempos.push({ t: 14 * 384 + k * 96, bpm: 140 - (k + 1) * 10 });
  const bytes = makeMidi([{ name: 'Melodie', events }], { tempos });
  const song = songFromMidi(bytes);
  assert.equal(song.tempo, 100);
  assert.deepEqual(song.tempoMarks.map((m) => `${m.bar}:${m.kind}`), ['0:tempo', '8:tempo', '14:rit']);
  const a = arrange(song, { ensemble: 'solo', soloInstrument: 'trumpet', playback: true });
  const perf = performArrangement(a);
  // Takt 9 beginnt nach 8 Takten à 2,4 s; danach 140 BPM
  const off = a.sourceOffset / a.mt;
  assert.ok(Math.abs(perf.barToSec(off + 8) - perf.barToSec(off) - 19.2) < 0.01);
  assert.ok(Math.abs(perf.barToSec(off + 9) - perf.barToSec(off + 8) - (4 * 60) / 140) < 0.01);
  const xml = exportMusicXML(a);
  assert.ok(/<per-minute>140<\/per-minute>/.test(xml), 'Metronomangabe ♩ = 140');
  assert.ok(/>rit\.</.test(xml), 'rit. in den Noten');
});

test('Taktartwechsel (4/4 → 3/4 → 4/4) bleiben im Play-along, in den Noten und in der Wiedergabe erhalten', async () => {
  const { arrange } = await import('../src/arrange/engine.js');
  const { performArrangement } = await import('../src/output/performance.js');
  const { exportMusicXML } = await import('../src/output/musicxml.js');
  // 4 Takte 4/4, 4 Takte 3/4, 4 Takte 4/4 – jede Taktart-"1" mit langem Ton, Rest Viertel
  const events = [];
  const drums = [];
  let t = 0;
  const bars = [4, 4, 4, 4, 3, 3, 3, 3, 4, 4, 4, 4];
  for (const beats of bars) {
    for (let q = 0; q < beats; q++) {
      events.push({ t: t + q * 96, d: 90, ch: 0, key: q === 0 ? 72 : 76 });
      drums.push({ t: t + q * 96, d: 20, ch: 9, key: q === 0 ? 36 : 42 });
    }
    t += beats * 96;
  }
  const bytes = makeMidi([{ name: 'Melodie', events }, { name: 'Drums', events: drums }], {
    tempo: 120,
    timeSigs: [{ t: 0, beats: 4, beatType: 4 }, { t: 16 * 96, beats: 3, beatType: 4 }, { t: 28 * 96, beats: 4, beatType: 4 }],
  });
  const song = songFromMidi(bytes);
  assert.deepEqual(song.meterMap.map((x) => `${x.bar}:${x.meter.beats}/${x.meter.beatType}`), ['0:4/4', '4:3/4', '8:4/4']);
  assert.equal(song.measureCount, 12);
  for (const opts of [{ ensemble: 'solo', soloInstrument: 'trumpet', playback: true }, { ensemble: 'drums' }]) {
    const a = arrange(song, opts);
    assert.ok(a.grid, 'Taktraster mit Wechseln');
    const xml = exportMusicXML(a);
    const times = [...xml.matchAll(/<time>\s*<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>\s*<\/time>/g)].map((m) => `${m[1]}/${m[2]}`);
    // jede Stimme: Anfang + zwei Wechsel
    assert.ok(times.join(',').startsWith('4/4,3/4,4/4'), times.join(','));
    // jeder Takt beginnt mit der "1" (langer Ton bzw. Bass Drum) – Taktstriche sitzen richtig
    const perf = performArrangement(a);
    const off = (a.sourceOffset || 0) / a.mt;
    assert.ok(Math.abs(perf.barToSec(off + 5) - perf.barToSec(off + 4) - 1.5) < 0.01, '3/4-Takt dauert 1,5 s bei 120');
    assert.ok(Math.abs(perf.barToSec(off + 9) - perf.barToSec(off + 8) - 2.0) < 0.01, '4/4-Takt dauert 2 s');
  }
});
