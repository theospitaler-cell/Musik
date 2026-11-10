// Aufnahmen wie in gedruckten Sätzen (Referenz-Abgleich mit Notenvideos):
//  - Zwei-Takt-Begleitmuster (Viva la Vida „♩♩♩♪♪ | 𝄾♪𝄾♪♩♩“) wird als solches erkannt, nicht übereinandergelegt
//  - der Bass spielt das Muster mit den Tönen der Bass-Spur (keine erfundenen Riffs/Oktavsprünge)
//  - Intro ohne Gesang: die Oberstimme der Begleitung ist keine Melodie – das Muster spielt allein
//  - großer Satz: keine Mittelstimme unter dem Bass, Töne in der Lage des Instruments
//  - Pegel der Spuren: Übersprechen in einer stummen Spur liefert keine Töne
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate, defaultVoices } from '../src/engine/index.js';
import { prepare, markOstinato } from '../src/engine/compose.js';
import { mergeStemNotes, stemLevels } from '../src/input/stems.js';
import { PROFILES } from '../src/engine/profiles.js';

const MT = 96;
const PAT_B = [0, 24, 48, 72, 84]; // ♩ ♩ ♩ ♪ ♪
const PAT_A = [12, 36, 48, 72]; // 𝄾 ♪ 𝄾 ♪ ♩ ♩
const ROOTS = [49, 51, 44, 41]; // Des Es As F (wie Viva la Vida)
const CHORDS = [
  [61, 65, 68],
  [63, 67, 70],
  [60, 63, 68],
  [60, 65, 68],
];

function recording({ bars = 32, intro = 4 } = {}) {
  const compRhythm = [];
  const bass = [];
  const lead = [];
  const drums = [];
  const vocal = [];
  for (let b = 0; b < bars; b++) {
    const a0 = b * MT;
    const pat = b % 2 === 0 ? PAT_B : PAT_A;
    const ch = CHORDS[b % 4];
    for (const t of pat) for (const m of ch) compRhythm.push({ start: a0 + t, dur: 12, midi: m, vel: 80 });
    // Bass-Spur wie aus der Erkennung: Grundton, aber verschluckte Wiederholungen und ein Oktavfehler
    bass.push({ start: a0, dur: 36, midi: ROOTS[b % 4] - 12 });
    bass.push({ start: a0 + 48, dur: 24, midi: ROOTS[b % 4] - 12 + (b % 5 === 0 ? 12 : 0) });
    for (let k = 0; k < 4; k++) drums.push({ start: a0 + k * 24, kind: 'kick' });
    if (b < intro) {
      // kein Gesang: die „Melodie“ ist der oberste Begleitton im Muster
      for (const t of pat) lead.push({ start: a0 + t, dur: 12, midi: ch[2] });
      vocal.push(0);
    } else {
      // gesungene Melodie im eigenen Rhythmus
      lead.push({ start: a0 + 6, dur: 30, midi: 72 }, { start: a0 + 42, dur: 18, midi: 70 }, { start: a0 + 66, dur: 30, midi: 68 });
      vocal.push(0.8);
    }
  }
  return { title: 'Aufnahme', meter: { beats: 4, beatType: 4 }, measureCount: bars, tempo: 136, lead, bass, comp: [], compRhythm, drums, vocal, report: { notes: [] } };
}

test('Begleitmuster über zwei Takte: beide Hälften getrennt erkannt (nicht übereinandergelegt)', () => {
  const ctx = prepare(recording());
  const bars = ctx.decode.bars;
  assert.ok(bars.filter((b) => b.ostinato).length >= 28, 'fast alle Takte gehören zum Muster');
  for (let i = 4; i < 28; i++) {
    const want = i % 2 === 0 ? PAT_B : PAT_A;
    assert.deepEqual(bars[i].pattern, want, `Takt ${i + 1}: Muster der richtigen Hälfte`);
  }
  // Gegenprobe: ein echtes Ein-Takt-Muster bleibt eines
  const one = Array.from({ length: 16 }, (_, i) => ({ bar: i, hits: PAT_B.map((t) => ({ t })) }));
  const p = markOstinato(one, MT);
  assert.deepEqual(p, PAT_B);
});

test('Bass einer Aufnahme: spielt das Begleitmuster mit, ein Grundton je Takthälfte', () => {
  const r = orchestrate(recording(), { voices: 4, instruments: ['trumpet', 'horn', 'trombone', 'tuba'], transpose: 0, title: 'Aufnahme' });
  const tuba = r.arr.voices.find((v) => v.inst && /tuba/i.test(v.inst.id || v.inst.name || ''));
  assert.ok(tuba, 'Tuba vorhanden');
  for (let b = 4; b < 28; b++) {
    const evs = tuba.events.filter((e) => e.start >= b * MT && e.start < (b + 1) * MT && e.pitches.length);
    const pat = b % 2 === 0 ? PAT_B : PAT_A;
    for (const e of evs) assert.ok(pat.includes(e.start - b * MT), `Takt ${b + 1}: Basseinsatz ${e.start - b * MT} liegt im Muster`);
    assert.ok(evs.length >= 2, `Takt ${b + 1}: Bass spielt (${evs.length} Töne)`);
    // ein Ton je Takthälfte (Oktavfehler der Erkennung zählt nicht als Wechsel)
    for (const half of [0, 48]) {
      const pcs = new Set(evs.filter((e) => e.start - b * MT >= half && e.start - b * MT < half + 48).map((e) => ((e.pitches[0] % 12) + 12) % 12));
      assert.ok(pcs.size <= 1, `Takt ${b + 1}, Hälfte ${half / 48 + 1}: ein Grundton (${[...pcs]})`);
    }
  }
  assert.ok(r.report.notes.some((n) => n.includes('Begleitmuster der Vorlage')), r.report.notes.join(' | '));
  assert.deepEqual(r.report.violations, {});
});

test('Intro ohne Gesang: keine Schein-Melodie aus der Oberstimme der Begleitung', () => {
  const r = orchestrate(recording(), { voices: 4, instruments: ['trumpet', 'horn', 'trombone', 'tuba'], transpose: 0, title: 'Aufnahme' });
  const lead = r.arr.voices.find((v) => v.role === 'lead');
  const intro = lead.events.filter((e) => e.start < 4 * MT && e.pitches.length && e.role === 'melody');
  assert.equal(intro.length, 0, 'die Melodiestimme pausiert im Intro');
  assert.ok(lead.events.some((e) => e.start >= 4 * MT && e.role === 'melody'), 'ab dem Gesang spielt sie die Melodie');
  assert.ok(r.report.notes.some((n) => n.startsWith('Ohne Gesang (Takte 1–4)')), r.report.notes.join(' | '));
  // ohne Gesangsangabe bleibt alles wie gespielt
  const m = recording();
  delete m.vocal;
  const r2 = orchestrate(m, { voices: 4, instruments: ['trumpet', 'horn', 'trombone', 'tuba'], transpose: 0, title: 'Aufnahme' });
  assert.ok(r2.arr.voices.find((v) => v.role === 'lead').events.some((e) => e.start < 4 * MT && e.role === 'melody'));
});

test('Großer Satz (Blasorchester): Mittelstimmen in ihrer Lage, nie unter dem Bass, Muster mit Tonwiederholung', () => {
  const inst = defaultVoices('orchestra', 13);
  const r = orchestrate(recording(), { voices: inst.length, instruments: inst, transpose: 0, title: 'Aufnahme' });
  assert.deepEqual(r.report.violations, {});
  const bassV = r.arr.voices.find((v) => v.role === 'bass');
  const bassAt = (t) => {
    let p = null;
    for (const e of bassV.events) if (e.start <= t && e.start + e.dur > t) p = e.pitches[0];
    return p;
  };
  for (const v of r.arr.voices) {
    if (v.role !== 'inner') continue;
    const prof = PROFILES[v.profile];
    for (const e of v.events) {
      if (!e.ostinato || !e.pitches.length) continue;
      const b = bassAt(e.start);
      if (b !== null) assert.ok(e.pitches[0] >= b, `${prof.key} bei ${e.start}: ${e.pitches[0]} nicht unter dem Bass ${b}`);
      assert.ok(e.pitches[0] >= prof.range[0], `${prof.key}: im Umfang`);
    }
    // je Takthälfte ein Ton (Tonwiederholung im Muster statt Lagenwechsel)
    for (let b = 4; b < 28; b++) {
      for (const half of [0, 48]) {
        const ps = new Set(v.events.filter((e) => e.ostinato && e.start >= b * MT + half && e.start < b * MT + half + 48).map((e) => e.pitches[0]));
        assert.ok(ps.size <= 1, `${prof.key} Takt ${b + 1}: ${[...ps]}`);
      }
    }
  }
});

test('Pegel der Spuren: Töne aus Übersprechen in einer stummen Spur zählen nicht', () => {
  const sr = 22050;
  const len = sr * 4;
  const tone = (from, to, amp) => {
    const a = new Float32Array(len);
    for (let i = 0; i < len; i++) a[i] = i >= from * sr && i < to * sr ? amp * Math.sin((2 * Math.PI * 440 * i) / sr) : 1e-4 * Math.sin(i);
    return a;
  };
  const levels = { vocals: stemLevels(tone(2, 4, 0.3), sr), other: stemLevels(tone(0, 4, 0.3), sr) };
  const parts = {
    vocals: [
      { start: 0.5, end: 1.0, midi: 69, amp: 0.5 }, // Übersprechen (Spur stumm)
      { start: 2.5, end: 3.0, midi: 69, amp: 0.5 }, // gesungen
    ],
    other: [{ start: 0.5, end: 1.0, midi: 64, amp: 0.5 }],
  };
  const merged = mergeStemNotes(parts, { levels });
  assert.deepEqual(merged.filter((n) => n.stem === 'vocals').map((n) => n.start), [2.5]);
  assert.equal(merged.filter((n) => n.stem === 'other').length, 1);
  // ohne Pegel: wie bisher
  assert.equal(mergeStemNotes(parts).filter((n) => n.stem === 'vocals').length, 2);
});
