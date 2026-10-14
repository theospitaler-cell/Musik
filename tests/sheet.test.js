// Notenblatt-Editor (src/sheet): Transponieren, Schlüssel, Instrumentenwechsel, Zusammenführen, Schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readScore, writeScore, partsOf, measuresOf } from '../src/sheet/xml.js';
import { transposeXml, setClefXml, convertForInstrument, analyzeXml, chooseInterval, transposePitch, midiOf, autoClef } from '../src/sheet/transpose.js';
import { mergeScores } from '../src/sheet/merge.js';
import { normalizeSchemes, activeScheme, schemeVoices, addScheme, setSlot, removeScheme, updateScheme, SLOT_COUNT } from '../src/sheet/schemes.js';
import { INSTRUMENTS } from '../src/arrange/instruments.js';

// Blatt einer B-Trompete: D-Dur (2 Kreuze), klingend C-Dur; Titel, Komponist, Akkordsymbol, Dynamik, Artikulation
const NOTES = [
  ['D', 0, 4], ['E', 0, 4], ['F', 1, 4], ['G', 0, 4],
  ['A', 0, 4], ['B', 0, 4], ['C', 1, 5], ['D', 0, 5],
];
function sheet({ fifths = 2, clef = ['G', 2], transpose = { chromatic: -2, diatonic: -1 }, notes = NOTES, measures = 2, title = 'Mein Lied', composer = 'Max Muster' } = {}) {
  const per = Math.ceil(notes.length / measures);
  const ms = [];
  for (let m = 0; m < measures; m++) {
    const slice = notes.slice(m * per, (m + 1) * per);
    const attrs =
      m === 0
        ? `<attributes><divisions>1</divisions><key><fifths>${fifths}</fifths><mode>major</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>${clef[0]}</sign><line>${clef[1]}</line></clef>${
            transpose ? `<transpose><diatonic>${transpose.diatonic}</diatonic><chromatic>${transpose.chromatic}</chromatic></transpose>` : ''
          }</attributes>`
        : '';
    const harmony = m === 0 ? '<harmony><root><root-step>D</root-step></root><kind>major</kind></harmony>' : '';
    const dyn = m === 0 ? '<direction placement="below"><direction-type><dynamics><mf/></dynamics></direction-type></direction>' : '';
    const body = slice
      .map(
        ([s, a, o], i) =>
          `<note><pitch><step>${s}</step>${a ? `<alter>${a}</alter>` : ''}<octave>${o}</octave></pitch><duration>1</duration><type>quarter</type>${i === 0 && m === 0 ? '<notations><articulations><accent/></articulations></notations>' : ''}</note>`,
      )
      .join('');
    ms.push(`<measure number="${m + 1}">${attrs}${harmony}${dyn}${body}</measure>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><work><work-title>${title}</work-title></work><identification><creator type="composer">${composer}</creator></identification>
<part-list><score-part id="P1"><part-name>Trompete in B</part-name><midi-instrument id="P1-I1"><midi-program>57</midi-program></midi-instrument></score-part></part-list>
<part id="P1">${ms.join('')}</part></score-partwise>`;
}

const pitches = (xml, partIdx = 0) =>
  measuresOf(partsOf(readScore(xml))[partIdx]).flatMap((m) =>
    m.all('note').map((n) => {
      const p = n.child('pitch');
      return p ? `${p.val('step')}${Number(p.val('alter', 0)) > 0 ? '#' : Number(p.val('alter', 0)) < 0 ? 'b' : ''}${p.val('octave')}` : 'r';
    }),
  );
const fifthsOf = (xml) => Number(readScore(xml).find('fifths')[0].text);

test('Transponieren: Töne, Vorzeichen und Akkordsymbole folgen dem Intervall', () => {
  const src = sheet();
  // eine große Sekunde nach unten: D-Dur -> C-Dur
  const r = transposeXml(src, { chromatic: -2 });
  assert.deepEqual(pitches(r.xml), ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5']);
  assert.equal(fifthsOf(r.xml), 0);
  assert.equal(r.fifthsBefore, 2);
  assert.equal(r.fifthsAfter, 0);
  assert.match(r.xml, /<root-step>C<\/root-step>/);
  // nach oben: Quinte -> A-Dur wird zu ... D+7 = A: drei Kreuze
  const up = transposeXml(src, { chromatic: 7 });
  assert.equal(fifthsOf(up.xml), 3);
  assert.deepEqual(pitches(up.xml).slice(0, 4), ['A4', 'B4', 'C#5', 'D5']);
  // Oktave
  const oct = transposeXml(src, { chromatic: 0, octaves: 1 });
  assert.deepEqual(pitches(oct.xml).slice(0, 2), ['D5', 'E5']);
  assert.equal(fifthsOf(oct.xml), 2);
  // Titel, Komponist, Dynamik und Akzent bleiben
  assert.match(r.xml, /<work-title>Mein Lied<\/work-title>/);
  assert.match(r.xml, /<creator type="composer">Max Muster<\/creator>/);
  assert.match(r.xml, /<mf\/>/);
  assert.match(r.xml, /<accent\/>/);
  // Nullverschiebung ändert nichts
  assert.equal(transposeXml(src, { chromatic: 0 }).changed, false);
});

test('Transponieren: Zieltonart per Vorzeichenzahl, kürzester Weg', () => {
  const src = sheet(); // D-Dur
  const toF = transposeXml(src, { toFifths: -1 }); // F-Dur: von D 3 Halbtöne abwärts
  assert.equal(fifthsOf(toF.xml), -1);
  assert.equal(toF.chromatic, 3); // D-Dur (2 Kreuze) -> F-Dur (1 b): kleine Terz aufwärts
  const t = transposePitch({ step: 'F', alter: 1, octave: 4 }, 1, 2);
  assert.deepEqual(t, { step: 'G', alter: 1, octave: 4 });
});

test('Intervall-Wahl: wenige Vorzeichen, Tritonus je nach Vorliebe', () => {
  const a = chooseInterval(2, 0); // große Sekunde aufwärts: D-Dur
  assert.equal(a.fifths, 2);
  assert.equal(a.diatonic, 1);
  const b = chooseInterval(-2, 2);
  assert.equal(b.fifths, 0);
  assert.equal(b.diatonic, -1);
  // 3 Halbtöne aufwärts aus C: Es-Dur (3b) statt Dis-Dur (9#)
  const c = chooseInterval(3, 0);
  assert.equal(c.fifths, -3);
  // Oktaven ändern die Tonart nicht
  assert.equal(chooseInterval(12, 3).fifths, 3);
  assert.equal(chooseInterval(12, 3).diatonic, 7);
  assert.equal(midiOf({ step: 'C', alter: 0, octave: 4 }), 60);
});

test('Schlüssel wechseln: Töne bleiben, nur der Schlüssel ändert sich', () => {
  const src = sheet();
  const r = setClefXml(src, 'F4');
  assert.deepEqual(pitches(r), pitches(src));
  const clef = readScore(r).find('clef')[0];
  assert.equal(clef.val('sign'), 'F');
  assert.equal(clef.val('line'), '4');
  assert.equal(readScore(r).find('clef').length, 1);
  assert.equal(analyzeXml(r).parts[0].clef, 'F4');
  assert.equal(analyzeXml(setClefXml(src, 'C4')).parts[0].clef, 'C4');
  assert.equal(analyzeXml(setClefXml(src, 'G2-8')).parts[0].clef, 'G2-8');
  assert.throws(() => setClefXml(src, 'X9'), /Unbekannter Schlüssel/);
});

test('Instrument wechseln: B-Trompete -> Posaune (klingend, Bassschlüssel), Töne 1:1', () => {
  // tiefe Trompetenstimme, damit die Posaune sie bequem spielt
  const low = [['G', 0, 3], ['A', 0, 3], ['B', 0, 3], ['C', 1, 4], ['D', 0, 4], ['E', 0, 4], ['F', 1, 4], ['G', 0, 4]];
  const src = sheet({ notes: low });
  const r = convertForInstrument(src, { sourceId: 'trumpet', targetId: 'trombone' });
  // notiert (B-Trompete) -> klingend: eine große Sekunde tiefer; Posaune notiert klingend
  assert.equal(r.sourceSemis, 2);
  assert.equal(r.targetSemis, 0);
  assert.equal(r.fifthsAfter, 0);
  const out = pitches(r.xml);
  assert.equal(out.length, low.length);
  // gleicher Notenverlauf, nur transponiert: Intervalle zwischen den Tönen bleiben
  const mi = (s) => ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 })[s[0]] + (s.includes('#') ? 1 : s.includes('b') ? -1 : 0) + 12 * Number(s.slice(-1));
  const steps = (arr) => arr.slice(1).map((v, i) => mi(v) - mi(arr[i]));
  assert.deepEqual(steps(out), steps(pitches(src)));
  // Posaune-Tonumfang
  const lo = Math.min(...out.map(mi));
  const hi = Math.max(...out.map(mi));
  assert.ok(lo + 12 >= INSTRUMENTS.trombone.range[0] && hi + 12 <= INSTRUMENTS.trombone.range[1]);
  assert.equal(r.outOfRange, 0);
  assert.equal(r.clef === 'F4' || r.clef === 'C4', true);
  assert.equal(analyzeXml(r.xml).parts[0].name, 'Posaune');
  assert.equal(analyzeXml(r.xml).parts[0].transposeSemis, 0);
  // Titel bleibt
  assert.match(r.xml, /<work-title>Mein Lied<\/work-title>/);
});

test('Instrument wechseln: Oktavlage wird in den bequemen Bereich gesetzt, Horn in F notiert höher', () => {
  const high = [['C', 0, 6], ['D', 0, 6], ['E', 0, 6], ['G', 0, 6]]; // sehr hoch notiert (klingend ~ B5)
  const r = convertForInstrument(sheet({ notes: high, measures: 1 }), { sourceId: 'trumpet', targetId: 'trombone' });
  assert.ok(r.octaves < 0, `Oktavversatz ${r.octaves}`);
  assert.equal(r.outOfRange, 0);
  const h = convertForInstrument(sheet({ notes: NOTES }), { sourceId: 'trumpet', targetId: 'horn' });
  assert.equal(h.targetSemis, 7);
  assert.equal(analyzeXml(h.xml).parts[0].transposeSemis, 7);
  assert.equal(h.outOfRange, 0);
  assert.equal(h.clef, 'G2');
});

test('Instrument wechseln: Quelle „klingend“ und Quelle aus der Datei (<transpose>)', () => {
  const noT = sheet({ transpose: null, fifths: 0, notes: [['C', 0, 4], ['D', 0, 4], ['E', 0, 4], ['F', 0, 4]], measures: 1 });
  const fromConcert = convertForInstrument(noT, { sourceId: 'concert', targetId: 'trumpet', octave: 0 });
  assert.equal(fromConcert.sourceSemis, 0);
  assert.equal(fromConcert.fifthsAfter, 2); // klingend C-Dur -> B-Trompete D-Dur
  assert.deepEqual(pitches(fromConcert.xml), ['D4', 'E4', 'F#4', 'G4']);
  const fromFile = convertForInstrument(sheet(), { sourceId: null, targetId: 'trombone', octave: 0 });
  assert.equal(fromFile.sourceSemis, 2);
});

test('Auto-Schlüssel: Tenorschlüssel in hoher Posaunenlage, sonst Bassschlüssel', () => {
  assert.equal(autoClef(INSTRUMENTS.trombone, [60, 62, 64, 65, 67, 69]), 'C4');
  assert.equal(autoClef(INSTRUMENTS.trombone, [40, 43, 45, 47, 50]), 'F4');
  assert.equal(autoClef(INSTRUMENTS.trumpet, [60, 62]), 'G2');
});

test('Zusammenführen: Stimmen zu einer Partitur, kürzere werden aufgefüllt, Titel aus Angabe', () => {
  const a = sheet({ title: 'Marsch', measures: 2 });
  const b = convertForInstrument(sheet({ title: 'Marsch', measures: 1, notes: NOTES.slice(0, 4) }), { sourceId: 'trumpet', targetId: 'trombone' }).xml;
  const r = mergeScores([{ xml: a, name: 'Trompete 1' }, { xml: b, name: 'Posaune' }], { title: 'Marsch (Partitur)', composer: 'Max Muster' });
  assert.equal(r.parts, 2);
  assert.equal(r.measures, 2);
  const root = readScore(r.xml);
  assert.equal(partsOf(root).length, 2);
  assert.deepEqual(partsOf(root).map((p) => p.attrs.id), ['P1', 'P2']);
  assert.equal(measuresOf(partsOf(root)[1]).length, 2);
  assert.match(r.xml, /<work-title>Marsch \(Partitur\)<\/work-title>/);
  assert.match(r.xml, /<part-name>Posaune<\/part-name>/);
  assert.match(r.xml, /<rest measure="yes"\/>/);
  // Einzelstimmen bleiben unverändert
  assert.deepEqual(pitches(r.xml, 0), pitches(a));
  assert.equal(analyzeXml(r.xml).parts.length, 2);
  assert.throws(() => mergeScores([]), /Keine Stimmen/);
});

test('Schemas: Standard, Wechseln, Stimmen setzen, Name, Löschen', () => {
  const n = normalizeSchemes({});
  assert.ok(n.schemes.length >= 2);
  assert.equal(n.activeScheme, n.schemes[0].id);
  assert.equal(n.schemes[0].voices.length, SLOT_COUNT);
  // bisherige Standardstimmen werden zum ersten Schema
  const legacy = normalizeSchemes({ defaultVoices: ['flugelhorn', 'horn', 'trombone', 'tuba'] });
  assert.equal(legacy.schemes[0].voices[0], 'flugelhorn');
  assert.deepEqual(schemeVoices(legacy.schemes[0]), ['flugelhorn', 'horn', 'trombone', 'tuba']);
  // aktives Schema
  assert.equal(activeScheme({ schemes: n.schemes, activeScheme: n.schemes[1].id }).id, n.schemes[1].id);
  assert.equal(activeScheme({ schemes: n.schemes, activeScheme: 'gibt-es-nicht' }).id, n.schemes[0].id);
  // neues Schema aus einem bestehenden, Stimme 5 setzen, umbenennen, Maininstrument bleibt gesetzt
  let { list, id } = addScheme(n.schemes, { name: 'Probe', from: n.schemes[0].id });
  list = setSlot(list, id, 4, 'euphonium');
  list = setSlot(list, id, 0, null);
  list = updateScheme(list, id, { name: 'Probe 2' });
  const s = list.find((x) => x.id === id);
  assert.equal(s.voices[4], 'euphonium');
  assert.ok(s.voices[0]);
  assert.equal(s.name, 'Probe 2');
  // ungültiges Instrument -> keine; Löschen lässt mindestens eines übrig
  assert.equal(setSlot(list, id, 2, 'kazoo').find((x) => x.id === id).voices[2], null);
  let l = list;
  for (const x of [...l]) l = removeScheme(l, x.id);
  assert.equal(l.length, 1);
});

test('Ausgabe bleibt gültiges, wieder lesbares MusicXML (Rundlauf)', () => {
  const src = sheet();
  const once = writeScore(readScore(src));
  assert.deepEqual(pitches(once), pitches(src));
  assert.equal(analyzeXml(once).title, 'Mein Lied');
  assert.equal(analyzeXml(once).composer, 'Max Muster');
  assert.equal(analyzeXml(once).fifths, 2);
});

// ---- Projekt, Stimmen dazuschreiben ---------------------------------------------------------------------
import { newProject, projectXml, transposeProject, setClefProject, convertProject, undo, redo, concatPages, infoOf } from '../src/sheet/project.js';
import { addVoices, extractPart, listParts, toConcertXml } from '../src/sheet/addvoices.js';

test('Projekt: Änderungen wirken auf alle Seiten gleich, Rückgängig/Wiederholen', () => {
  const p1 = sheet({ notes: NOTES.slice(0, 4), measures: 1 });
  const p2 = sheet({ notes: NOTES.slice(4), measures: 1 });
  const p = newProject({ title: 'Mein Lied', pages: [{ xml: p1 }, { xml: p2 }], origin: 'scan', sourceInstrument: 'trumpet' });
  assert.equal(infoOf(p).parts[0].measures, 2);
  const r = transposeProject(p, { chromatic: -2 });
  assert.equal(r.changed, true);
  assert.equal(r.fifthsAfter, 0);
  assert.deepEqual(pitches(p.pages[0].xml), ['C4', 'D4', 'E4', 'F4']);
  assert.deepEqual(pitches(p.pages[1].xml), ['G4', 'A4', 'B4', 'C5']);
  setClefProject(p, 'F4');
  assert.equal(analyzeXml(p.pages[1].xml).parts[0].clef, 'F4');
  assert.ok(undo(p));
  assert.equal(analyzeXml(p.pages[1].xml).parts[0].clef, 'G2');
  assert.ok(undo(p));
  assert.deepEqual(pitches(p.pages[0].xml), ['D4', 'E4', 'F#4', 'G4']);
  assert.ok(redo(p));
  assert.deepEqual(pitches(p.pages[0].xml), ['C4', 'D4', 'E4', 'F4']);
  assert.equal(undo(newProject({ xml: p1 })), false);
  // Seiten als ein Blatt: Takte laufen weiter, Wiederholung von Schlüssel/Tonart entfällt
  const joined = concatPages([p1, p2]);
  assert.equal(readScore(joined).find('measure').length, 2);
  assert.equal(readScore(joined).find('clef').length, 1);
  assert.equal(readScore(joined).find('fifths').length, 1);
});

test('Projekt: für Instrument umschreiben – Oktavlage gemeinsam für alle Seiten', () => {
  const low = [['G', 0, 3], ['A', 0, 3], ['B', 0, 3], ['C', 1, 4], ['D', 0, 4], ['E', 0, 4], ['F', 1, 4], ['G', 0, 4]];
  const p = newProject({ pages: [{ xml: sheet({ notes: low.slice(0, 4), measures: 1 }) }, { xml: sheet({ notes: low.slice(4), measures: 1 }) }], sourceInstrument: 'trumpet' });
  const r = convertProject(p, { targetId: 'trombone' });
  assert.equal(r.outOfRange, 0);
  assert.equal(p.sourceInstrument, 'trombone');
  const a = analyzeXml(p.pages[0].xml).parts[0];
  const b = analyzeXml(p.pages[1].xml).parts[0];
  assert.equal(a.name, 'Posaune');
  assert.equal(a.clef, b.clef);
  assert.equal(a.transposeSemis, 0);
});

test('Stimmen dazuschreiben: Hauptstimme bleibt 1:1, die weiteren Stimmen kommen aus dem Schema', () => {
  const src = sheet({ fifths: 2, measures: 4, notes: [...NOTES, ...NOTES.map(([s, a, o]) => [s, a, o])] });
  const r = addVoices(src, { sourceId: 'trumpet', lead: 'trumpet', voices: ['horn', 'trombone', 'tuba'], mode: 'dynamic', activity: 3, title: 'Quartett' });
  const parts = listParts(r.xml);
  assert.equal(parts.length, 4);
  assert.deepEqual(r.instruments, ['trumpet', 'horn', 'trombone', 'tuba']);
  assert.equal(r.validation.violations.length, 0, JSON.stringify(r.report.violations));
  // Hauptstimme: die gleichen Töne (B-Trompete notiert), gleiche Vorzeichen
  const lead = extractPart(r.xml, parts[0].id);
  assert.deepEqual(pitches(lead).filter((x) => x !== 'r'), pitches(src).filter((x) => x !== 'r'));
  assert.equal(analyzeXml(lead).parts.length, 1);
  assert.equal(analyzeXml(lead).fifths, 2);
  // mit <transpose> übernimmt der Import die Umrechnung; ohne wird nach dem Quellinstrument verschoben
  assert.equal(toConcertXml(src, 'trumpet'), src);
  const bare = sheet({ transpose: null });
  assert.deepEqual(pitches(toConcertXml(bare, 'trumpet')).slice(0, 2), ['C4', 'D4']);
  assert.equal(toConcertXml(bare, 'concert'), bare);
  assert.throws(() => addVoices(src, { sourceId: 'trumpet', voices: [] }), /mindestens eine/);
});
