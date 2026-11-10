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
import { markFigures, simplifyLine } from '../src/input/voices.js';
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
  // Instrumental-Aufnahme: Gesangsspur insgesamt 40 dB leiser als die lauteste Spur – ihre Töne bleiben, zählen
  // aber nicht als Gesang
  const quiet = { vocals: stemLevels(tone(0, 4, 0.003), sr), other: stemLevels(tone(0, 4, 0.3), sr) };
  const m2 = mergeStemNotes({ vocals: [{ start: 2.5, end: 3.0, midi: 69, amp: 0.5 }], other: [] }, { levels: quiet });
  assert.equal(m2.length, 1);
  assert.equal(m2[0].weak, true);
  assert.ok(!merged.some((n) => n.weak), 'echter Gesang ist nicht schwach');
});

test('Galopp-Figur (♪♬) bleibt im Sechzehntel-Raster, vereinzelte Splitter nicht', () => {
  // zwei Takte Galopp auf einem Ton, die Erkennung hat in zwei Schlägen eine Sechzehntel verloren
  const line = [];
  for (let b = 0; b < 8; b++) {
    const t = b * 24;
    line.push({ start: t, dur: 12, midi: 60 }, { start: t + 12, dur: 6, midi: 60 });
    if (b !== 2 && b !== 5) line.push({ start: t + 18, dur: 6, midi: 60 });
  }
  const out = simplifyLine(markFigures(line, { beat: 24 }), { beat: 24, allowPush: true });
  const sixteenths = out.filter((n) => n.start % 24 === 18);
  assert.equal(sixteenths.length, 6, 'jede gehörte Galopp-Sechzehntel bleibt');
  // wo beide Sechzehntel gehört wurden, ist auch die erste kurz (sonst wird sie zur Achtel)
  for (const s of sixteenths) assert.equal(out.find((n) => n.start === s.start - 6).dur, 6, `Schlag ${Math.floor(s.start / 24) + 1}`);
  // Gegenprobe: einzelne Sechzehntel-Splitter in einer Achtel-Melodie entfallen weiter
  const mel = [];
  for (let k = 0; k < 16; k++) mel.push({ start: k * 12, dur: 12, midi: 60 + (k % 5) });
  mel.push({ start: 18, dur: 6, midi: 70 }, { start: 90, dur: 6, midi: 71 });
  const simp = simplifyLine(markFigures(mel, { beat: 24 }), { beat: 24, allowPush: true });
  assert.equal(simp.filter((n) => n.start % 12 !== 0).length, 0);
});

test('Bass ohne Begleitmuster und Bassdrum: folgt den Vierteln der Bass-Spur, Obertöne zählen nicht', () => {
  // Begleitung ohne festes Muster, keine Bassdrum; Bass-Spur: absteigende Viertel-Linie (Two-Beat/Walking)
  const bars = 16;
  const compRhythm = [];
  const bass = [];
  const lead = [];
  const line = [53, 51, 49, 48, 46, 44, 43, 47]; // F Es Des C B As G H
  for (let b = 0; b < bars; b++) {
    const a0 = b * MT;
    for (const t of [(b * 7) % 96, (b * 13 + 30) % 96]) for (const m of [60, 64, 67]) compRhythm.push({ start: a0 + (t - (t % 6)), dur: 12, midi: m });
    for (let k = 0; k < 4; k++) bass.push({ start: a0 + k * 24, dur: 20, midi: line[(b * 4 + k) % 8] - 12 });
    // ein Oberton weit über der Basslinie (Übersprechen) mitten im Takt
    bass.push({ start: a0 + 36, dur: 12, midi: 79 });
    lead.push({ start: a0, dur: 48, midi: 72 }, { start: a0 + 48, dur: 48, midi: 74 });
  }
  const m = { title: 'Walk', meter: { beats: 4, beatType: 4 }, measureCount: bars, tempo: 120, lead, bass, comp: [], compRhythm, drums: [], report: { notes: [] } };
  const r = orchestrate(m, { voices: 4, instruments: ['trumpet', 'horn', 'trombone', 'tuba'], transpose: 0, title: 'Walk' });
  const tuba = r.arr.voices.find((v) => v.role === 'bass');
  for (let b = 2; b < 14; b++) {
    const evs = tuba.events.filter((e) => e.start >= b * MT && e.start < (b + 1) * MT);
    // Viertel auf den Schlägen (die letzte darf für eine Atemstelle fehlen)
    const ts = evs.map((e) => e.start - b * MT);
    assert.ok(ts.length >= 3 && ts.every((t, i) => t === i * 24), `Takt ${b + 1}: Viertel (${ts})`);
    evs.forEach((e, k) => assert.equal(((e.pitches[0] % 12) + 12) % 12, ((line[(b * 4 + k) % 8] % 12) + 12) % 12, `Takt ${b + 1}, Schlag ${k + 1}: Ton der Linie (ohne Oberton)`));
  }
  assert.ok(r.report.notes.some((n) => n.includes('in Vierteln wie die Bass-Spur')), r.report.notes.join(' | '));
});

test('Two-Beat: Akkorde der Vorlage zwischen den Schlägen -> Nachschläge, Bass kurz auf jedem Schlag; Intro-Bass ist keine Melodie', () => {
  const bars = 24;
  const compRhythm = [];
  const bass = [];
  const lead = [];
  const roots = [41, 36, 41, 43];
  for (let b = 0; b < bars; b++) {
    const a0 = b * MT;
    if (b >= 2) {
      // Horn und Posaune auf den „und“ – so lückenhaft gehört wie in der Aufnahme (je Platz in ~45 % der
      // Takte, zu wenig für ein festes Muster), dazu seltene Anschläge auf dem Schlag
      for (const t of [12, 36, 60, 84]) if ((b * 7 + t / 12) % 9 < 4) for (const m of [56, 60]) compRhythm.push({ start: a0 + t, dur: 12, midi: m });
      if (b % 5 === 0) for (const m of [56, 60]) compRhythm.push({ start: a0, dur: 12, midi: m });
      // Melodie in ihrer Lage
      lead.push({ start: a0, dur: 36, midi: 72 }, { start: a0 + 36, dur: 12, midi: 74 }, { start: a0 + 48, dur: 48, midi: 70 });
    } else {
      // Intro: nur die Tuba – die Erkennung hört ihre Linie (eine Oktave höher) als „Melodie“
      for (let k = 0; k < 4; k++) lead.push({ start: a0 + k * 24, dur: 12, midi: 53 - b * 4 - k });
    }
    // Bass-Spur: nur in jedem zweiten Takt erkannt (die Tuba liegt großteils in der Begleitspur)
    if (b % 2 === 0) bass.push({ start: a0, dur: 12, midi: roots[b % 4] }, { start: a0 + 48, dur: 12, midi: roots[b % 4] });
  }
  const m = { title: 'Ritz', meter: { beats: 4, beatType: 4 }, measureCount: bars, tempo: 120, lead, bass, comp: [], compRhythm, drums: [], report: { notes: [] } };
  const r = orchestrate(m, { voices: 5, instruments: ['trumpet', 'trumpet', 'horn', 'trombone', 'tuba'], transpose: 0, title: 'Ritz' });
  assert.deepEqual(r.report.violations, {});
  assert.ok(r.report.notes.some((n) => n.startsWith('Begleitung auf den Nachschlägen')), r.report.notes.join(' | '));
  assert.ok(r.report.notes.some((n) => n.startsWith('Keine Melodie in der Vorlage (Takte 1–2)')), r.report.notes.join(' | '));
  const lead0 = r.arr.voices.find((v) => v.role === 'lead');
  assert.equal(lead0.events.filter((e) => e.start < 2 * MT && e.role === 'melody').length, 0, 'Intro: keine Schein-Melodie');
  // (eine Stimme verdoppelt zeitweise die Melodie – geprüft werden die Stimmen, die begleiten)
  let accomp = 0;
  for (const v of r.arr.voices.filter((x) => x.role === 'inner')) {
    const comp = v.events.filter((e) => e.start >= 4 * MT && (e.role === 'stabs' || e.role === 'pad'));
    if (comp.length < 8) continue;
    accomp++;
    assert.ok(comp.every((e) => e.start % 24 === 12 && e.dur <= 12), `${v.profile}: Nachschläge auf den „und“`);
  }
  assert.ok(accomp >= 2, `begleitende Stimmen: ${accomp}`);
  const tuba = r.arr.voices.find((v) => v.role === 'bass');
  for (let b = 4; b < 20; b++) {
    const evs = tuba.events.filter((e) => e.start >= b * MT && e.start < (b + 1) * MT);
    assert.ok(evs.length >= 3, `Takt ${b + 1}: Bass läuft durch (${evs.length})`);
    assert.ok(evs.every((e) => e.start % 24 === 0 && e.dur <= 12), `Takt ${b + 1}: kurz auf den Schlägen`);
  }
});
