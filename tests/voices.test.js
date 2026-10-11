import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPoly, separateVoices, simplifyLine } from '../src/input/voices.js';
import { repairBeats, dominantPeriod } from '../src/input/audio.js';
import { audioSections, barFeatures } from '../src/input/form.js';
import { buildOriginalEnsemble, movesTogether } from '../src/arrange/original.js';
import { voiceSlots } from '../src/arrange/planner.js';
import { getInstrument } from '../src/arrange/instruments.js';
import { arrange } from '../src/arrange/engine.js';
import { STYLE_LIST, autoStyle, getStyle } from '../src/arrange/styles.js';
import { shiftDownbeat, scaleNoteValues } from '../src/model/retime.js';
import { buildChord } from '../src/theory/chords.js';
import { demoSong } from './helpers.js';

// Dreistimmiger Satz wie in einem Chiptune: Melodie, Parallelstimme eine Terz/Sexte darunter, Bass
function threeVoices(bars = 8) {
  const mel = [72, 74, 76, 77, 79, 77, 76, 74];
  const notes = [];
  for (let b = 0; b < bars; b++) {
    mel.forEach((m, k) => {
      const start = b * 96 + k * 12;
      notes.push({ start, dur: 12, midi: m + (b % 2), amp: 0.7 });
      notes.push({ start, dur: 12, midi: m + (b % 2) - (k % 2 ? 3 : 4), amp: 0.6 });
    });
    for (const k of [0, 3, 6]) notes.push({ start: b * 96 + k * 12, dur: 12, midi: 48 + (k ? 7 : 0), amp: 0.65 });
  }
  return notes;
}

test('Stimmen aus KI-Noten: Melodie oben, Parallelstimme in der Mitte, Bass unten', () => {
  const poly = cleanPoly(threeVoices());
  const vs = separateVoices(poly, { beat: 24, mt: 96 });
  assert.equal(vs.melody.length, 64, 'jeder Melodieton');
  assert.ok(vs.melody.every((n) => n.midi >= 72), 'Melodie ist die Oberstimme');
  assert.equal(vs.bass.length, 24);
  assert.ok(vs.bass.every((n) => n.midi <= 55), 'Bass ist die Unterstimme');
  assert.ok(vs.inner[0].length >= 60, `Parallelstimme vollständig: ${vs.inner[0].length}`);
  assert.ok(movesTogether(vs.inner[0], vs.melody), 'läuft mit der Melodie mit');
});

test('Stimmen aus KI-Noten: Oberton-Geister und leise Splitter werden entfernt', () => {
  const poly = cleanPoly([
    { start: 0, dur: 24, midi: 60, amp: 0.8 },
    { start: 0, dur: 24, midi: 72, amp: 0.3 }, // leise Oktave = Oberton
    { start: 0, dur: 24, midi: 79, amp: 0.2 }, // leise Duodezime = Oberton
    { start: 24, dur: 6, midi: 64, amp: 0.05 }, // Splitter
    { start: 48, dur: 24, midi: 60, amp: 0.8 },
    { start: 48, dur: 24, midi: 72, amp: 0.75 }, // echte Oktave bleibt
  ]);
  assert.deepEqual(poly.map((n) => `${n.start}:${n.midi}`), ['0:60', '48:60', '48:72']);
});

test('Lesbarkeit: Achtel-Raster, nur echte Synkopen bleiben', () => {
  const line = simplifyLine(
    [
      { start: 6, dur: 6, midi: 60 }, // knapp nach der Zählzeit -> auf die Zählzeit
      { start: 18, dur: 30, midi: 62 }, // vorgezogen und gehalten -> bleibt (Synkope)
      { start: 48, dur: 6, midi: 64 },
      { start: 54, dur: 6, midi: 65 }, // Splitter zwischen zwei Achteln -> entfällt
      { start: 60, dur: 12, midi: 67 },
    ],
    { beat: 24, allowPush: true },
  );
  assert.deepEqual(line.map((n) => n.start), [0, 18, 48, 60]);
  assert.ok(line.every((n) => n.dur >= 6));
  // ohne erlaubte Synkopen (Bass/Begleitung): alles auf Achteln
  const bass = simplifyLine([{ start: 18, dur: 30, midi: 36 }, { start: 54, dur: 12, midi: 36 }], { beat: 24 });
  assert.ok(bass.every((n) => n.start % 12 === 0), bass.map((n) => n.start).join());
});

test('Beat-Reparatur: ein eingeschobener Schlag wird entfernt, ein rit. bleibt', () => {
  const even = Array.from({ length: 40 }, (_, i) => i * 30);
  const extra = [...even.slice(0, 20), 585, ...even.slice(20)].sort((a, b) => a - b); // Zusatzschlag bei 585
  const fixed = repairBeats([...extra]);
  assert.equal(fixed.length, 40, 'Zusatzschlag entfernt');
  assert.ok(fixed.every((b, i) => !i || Math.abs(b - fixed[i - 1] - 30) <= 4));
  // stetig langsamer am Schluss: unverändert
  const rit = [...even];
  let t = rit[rit.length - 1];
  for (let k = 1; k <= 6; k++) rit.push((t += 30 + 4 * k));
  assert.deepEqual(repairBeats([...rit]), rit);
});

test('Tempo: eine deutliche Takt-Periode schließt Schein-Tempi aus', () => {
  // Autokorrelation mit klarer Spitze bei 150 Frames (3 s = ein Takt bei Tempo 80)
  const A = (lag) => Math.exp(-0.5 * ((lag - 150) / 2) ** 2) + 0.3 * Math.exp(-0.5 * ((lag - 84) / 2) ** 2);
  const bar = dominantPeriod(A, 12000);
  assert.ok(Math.abs(bar - 150) < 1, `Takt-Periode ${bar}`);
  // zwei gleich starke, nicht verwandte Perioden: keine Entscheidung
  const B = (lag) => Math.exp(-0.5 * ((lag - 150) / 2) ** 2) + 0.95 * Math.exp(-0.5 * ((lag - 110) / 2) ** 2);
  assert.equal(dominantPeriod(B, 12000), null);
});

test('Formteile aus Takt-Merkmalen: leise Strophe, lauter Refrain, Wiederholungen gleich benannt', () => {
  const bars = [];
  const part = (n, energy, pcs, reg) => {
    for (let i = 0; i < n; i++) {
      const chroma = new Array(12).fill(0);
      pcs[i % pcs.length].forEach((p) => (chroma[p] = 1));
      const mel = new Array(12).fill(0);
      mel[pcs[i % pcs.length][0]] = 1;
      bars.push({ chroma, mel, energy, register: reg, density: 10 + 20 * energy, drums: 8 + 20 * energy, sung: 0.8 });
    }
  };
  const verse = [[0, 4, 7], [9, 0, 4], [5, 9, 0], [7, 11, 2]];
  const chorus = [[5, 9, 0], [7, 11, 2], [0, 4, 7], [0, 4, 7]];
  part(8, -30, verse, 62);
  part(8, -18, chorus, 69);
  part(8, -30, verse, 62);
  part(8, -18, chorus, 69);
  const secs = audioSections(bars);
  assert.equal(secs.length, 4, secs.map((s) => `${s.label}${s.length}`).join(' '));
  assert.deepEqual(secs.map((s) => s.label), ['A', 'B', 'A', 'B']);
  assert.ok(secs[1].energy > secs[0].energy + 0.3, 'Refrain lauter als Strophe');
  void barFeatures;
});

function trackSong() {
  const s = demoSong('ode');
  const mt = 96;
  const bass = [];
  const inner = [];
  for (let b = 0; b < s.measureCount; b++) {
    for (const k of [0, 2, 4, 6]) bass.push({ start: b * mt + k * 12, dur: 12, midi: 36 + (k === 4 ? 7 : 0), vel: 90 });
    for (const k of [2, 6]) inner.push({ start: b * mt + k * 12, dur: 12, midi: 64, vel: 70 }, { start: b * mt + k * 12, dur: 12, midi: 60, vel: 70 });
  }
  return {
    ...s,
    pickup: 0,
    melody: s.melody.filter((n) => n.start >= 0),
    source: 'midi',
    tracks: [
      { id: 'mel', name: 'Melodie', mel: true, notes: s.melody.filter((n) => n.start >= 0).map((n) => ({ ...n, vel: 90 })) },
      { id: 'bass', name: 'Bass', role: 'bass', mel: false, notes: bass },
      { id: 'in1', name: 'Gitarre', mel: false, notes: inner.filter((n) => n.midi === 64) },
      { id: 'in2', name: 'Klavier', mel: false, notes: inner.filter((n) => n.midi === 60) },
    ],
  };
}

test('Original übernehmen: voller Satz – Melodie oben, Bass der Vorlage unten, Mittelstimmen im Rhythmus der Begleitung', () => {
  const song = trackSong();
  const ids = ['trumpet', 'trumpet', 'trombone', 'tuba'];
  const insts = ids.map(getInstrument);
  const ens = buildOriginalEnsemble(song, insts, voiceSlots(insts));
  assert.equal(ens.lines[0], null, 'Stimme 1 = Melodie (wird direkt gesetzt)');
  for (const v of [1, 2, 3]) assert.ok(ens.lines[v].length >= song.measureCount, `Stimme ${v + 1} spielt durchgehend`);
  // Bass: Rhythmus der Vorlage (Achtel-Positionen 0,2,4,6), im Umfang der Tuba
  assert.ok(ens.lines[3].every((n) => n.midi >= insts[3].range[0] && n.midi <= insts[3].range[1]));
  assert.ok(ens.lines[3].filter((n) => n.start % 24 === 0).length >= 4 * song.measureCount - 2);
  // Mittelstimmen: Akkordtöne zum Einwurf-Rhythmus, unter der Melodie, über dem Bass
  const a = arrange(song, { voices: ids, original: true });
  assert.equal(a.voices.length, 4);
  assert.ok(a.originalEnsemble);
  for (const v of [1, 2]) {
    const hits = a.voices[v].events.filter((e) => e.start % 96 === 24 || e.start % 96 === 72).length;
    assert.ok(hits >= song.measureCount, `Stimme ${v + 1}: Einwürfe auf 2 und 4 (${hits})`);
  }
  const avg = (v) => a.voices[v].events.reduce((s, e) => s + e.pitches[0], 0) / a.voices[v].events.length;
  assert.ok(avg(0) > avg(1) && avg(1) > avg(2) && avg(2) > avg(3), 'Lagen von oben nach unten');
});

test('Neu arrangieren: Bass und Begleit-Rhythmus der Vorlage bleiben, Tempo des Liedes bleibt', () => {
  const song = { ...trackSong(), tempo: 150 };
  const a = arrange(song, { voices: ['trumpet', 'trumpet', 'trombone', 'tuba'], style: 'funk', seed: 1, solo: 'none', transpose: 0 });
  assert.equal(a.tempo, 150, 'Tempo der Vorlage, nicht des Stils');
  // im ersten Thema spielt der Bass die Achtel-Figur der Vorlage (nicht das 16tel-Riff des Stils)
  const theme = a.blocks.find((b) => b.type === 'theme');
  const t0 = theme.startBar * a.mt;
  const bass = a.voices[3].events.filter((e) => e.start >= t0 && e.start < t0 + theme.measures * a.mt);
  assert.ok(bass.length >= 3 * theme.measures, `Basslinie der Vorlage: ${bass.length} Töne`);
  assert.ok(bass.every((e) => e.start % 12 === 0), 'keine Sechzehntel-Figuren des Stils');
});

test('Stile: alle wählbar, „Automatisch“ wählt aus allen', () => {
  const keys = STYLE_LIST.map((s) => s.id);
  for (const k of ['pop', 'rock', 'soul', 'latin', 'reggae', 'disco', 'blues', 'march', 'waltz']) assert.ok(keys.includes(k), k);
  const base = demoSong('ode');
  for (const k of keys) {
    const a = arrange(base, { style: k, seed: 1 });
    assert.equal(a.style.key, k);
    assert.equal(a.voices.length, 4);
    assert.ok(a.voices.every((v) => v.events.length > 0), `${k}: alle Stimmen spielen`);
    assert.ok(getStyle(k).name);
  }
  const s = { ...base, composer: null, title: 'Lied', parts: [], tracks: [] };
  assert.equal(autoStyle({ ...s, tempo: 60 }), 'ballad');
  assert.equal(autoStyle({ ...s, tempo: 110 }), 'pop');
  assert.equal(autoStyle({ ...s, tempo: 170 }), 'rock');
  assert.equal(autoStyle({ ...s, tempo: 96, swing: true }), 'blues');
  assert.equal(autoStyle({ ...s, tempo: 140, swing: true }), 'swing');
  assert.equal(autoStyle({ ...s, tempo: 110, title: 'Samba de Janeiro' }), 'latin');
  assert.equal(autoStyle({ ...s, tempo: 160, meter: { beats: 3, beatType: 4 } }), 'waltz');
  // Bass Drum auf allen vier Zählzeiten bei Tempo 120 -> Disco
  const kicks = [];
  for (let b = 0; b < base.measureCount; b++) for (let q = 0; q < 4; q++) kicks.push({ start: b * 96 + q * 24, dur: 6, midi: 36 });
  assert.equal(autoStyle({ ...s, tempo: 120, drumNotes: kicks }), 'disco');
  // viele Sechzehntel-Synkopen bei Tempo 100 -> Funk
  const sync = base.melody.filter((n) => n.start >= 0).map((n, i) => ({ ...n, start: n.start + (i % 2 ? 6 : 0) }));
  assert.equal(autoStyle({ ...s, tempo: 100, melody: sync }), 'funk');
});

test('Aufnahme von Hand korrigieren: Taktanfang verschieben, Notenwerte verdoppeln/halbieren', () => {
  const s = trackSong();
  const beatSec = Array.from({ length: s.measureCount * 4 + 2 }, (_, i) => 0.5 + i * 0.6);
  const song = { ...s, source: 'audio', timing: { beatSec, firstBeat: 0, beatTicks: 24 }, tempoMarks: [{ bar: 0, kind: 'tempo', bpm: 100 }], tempo: 100, drumNotes: [] };
  const first = song.melody[0];
  // „1“ einen Schlag später: der erste Ton wird zum Auftakt
  const later = shiftDownbeat(song, 1);
  assert.equal(later.timing.firstBeat, 1);
  assert.equal(later.melody[0].start, first.start - 24);
  assert.equal(later.pickup, 24);
  assert.ok(later.chords.length > 0 && later.sections[0].start === 0);
  // zurück: wie vorher
  const back = shiftDownbeat(later, -1);
  assert.equal(back.melody[0].start, first.start);
  assert.equal(back.measureCount, song.measureCount);
  // doppeltes Tempo: doppelte Notenwerte, doppelt so viele Takte, gleiche Zeit in der Aufnahme
  const dbl = scaleNoteValues(song, 2);
  assert.equal(dbl.tempo, 200);
  assert.equal(dbl.measureCount, song.measureCount * 2);
  assert.equal(dbl.melody[1].start, song.melody[1].start * 2);
  assert.equal(dbl.timing.beatSec.length, beatSec.length * 2 - 1);
  assert.ok(Math.abs(dbl.timing.beatSec[2] - beatSec[1]) < 1e-9);
  const half = scaleNoteValues(dbl, 0.5);
  assert.equal(half.tempo, 100);
  assert.equal(half.measureCount, song.measureCount);
  assert.equal(half.timing.beatSec.length, beatSec.length);
});

test('Akkordtöne ohne Doppel-Vorzeichen (Ges-Moll: A statt Heses)', () => {
  const gbm = buildChord(-6, 'minor');
  assert.ok(gbm.tones.every((t) => t.lof > -9 && t.lof < 13));
  assert.equal(gbm.tones.find((t) => t.role === 'third').pc, 9);
});
