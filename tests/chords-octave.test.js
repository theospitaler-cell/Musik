// Akkordsymbole im Bild (finden, mittransponieren) und Oktavieren (Stück, Zeile/Takte, einzelne Töne).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPng } from './helpers-image.js';
import { loadVerovioNode, fakeRasterize } from './helpers-verovio.js';
import { preparePage, analyzePage, planSystems, rewritePage, findPageChords } from '../src/sheet/image/page.js';
import { findChordSymbols, shiftName, shiftIsIdentity, applyChordShift } from '../src/sheet/image/chords.js';
import { transposeXml } from '../src/sheet/transpose.js';
import { chordShiftBetween } from '../src/sheet/chordshift.js';
import { shiftOctavesXml, describeMeasure, measureCount } from '../src/sheet/octave.js';
import { newProject, shiftOctaveProject, undo, redo, projectXml } from '../src/sheet/project.js';
import { readScore, partsOf, measuresOf } from '../src/sheet/xml.js';

const FIX = new URL('./fixtures/scans/', import.meta.url);
const read = (n) => readFileSync(new URL(n, FIX), 'utf8');
const XML = read('page-clean.musicxml');

// ---- Akkordsymbole im Bild --------------------------------------------------------------------------
const rootsOf = (truthXml) => [...truthXml.matchAll(/<root-step>([A-G])<\/root-step>\s*(?:<root-alter>(-?\d)<\/root-alter>)?/g)].map((m) => m[1] + (m[2] === '1' ? '#' : m[2] === '-1' ? 'b' : ''));

// Längste gemeinsame Teilfolge (Reihenfolge zählt)
function lcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

const CASES = [
  ['page-clean', 'saints'],
  ['page-skewed', 'saints'],
  ['bass-ode', 'bass-ode'],
  ['bass-groove', 'bass-groove'],
  ['wal-grace', 'wal-grace'],
];

test('Akkordsymbole finden: keine falschen Treffer (Titel, Tempo, Taktnummern), fast alle echten', () => {
  let found = 0;
  let truth = 0;
  let ok = 0;
  for (const [img, tr] of CASES) {
    const { page } = preparePage(loadPng(new URL(`${img}.png`, FIX)));
    const staves = analyzePage(page);
    const names = findPageChords(page, staves).flat().map((c) => c.root.letter + (c.acc ? c.acc.kind : ''));
    const want = rootsOf(read(`${tr}.truth.musicxml`));
    const match = lcs(want, names);
    // nichts Falsches: jeder gefundene Grundton gehört zur Reihenfolge der echten
    assert.equal(match, names.length, `${img}: gefunden ${names.join(' ')} / erwartet ${want.join(' ')}`);
    found += names.length;
    truth += want.length;
    ok += match;
  }
  assert.ok(ok / truth >= 0.9, `Trefferquote ${ok}/${truth}`);
  assert.equal(ok, found);
});

test('Akkordsymbole: Zusätze wie „7“ gehören zum Symbol, Rehearsal-Kästchen und Tempoangabe nicht', () => {
  const { page } = preparePage(loadPng(new URL('page-clean.png', FIX)));
  const staves = analyzePage(page);
  const first = findChordSymbols(page, staves[1]);
  assert.deepEqual(first.map((c) => c.root.letter), ['G', 'D', 'G', 'G', 'C']);
  assert.deepEqual(first.map((c) => c.suffix.length), [0, 1, 0, 1, 0]); // „D7“ und „G7“
  // erste Zeile: „A“ im Kästchen und „Allegretto (♩ = 104)“ sind keine Akkorde
  assert.deepEqual(findChordSymbols(page, staves[0]).map((c) => c.root.letter), ['G', 'G']);
});

test('Namen verschieben: Stufen und Halbtöne, Vorzeichen', () => {
  assert.equal(shiftName('G', null, { diatonic: 1, chromatic: 2 }), 'A');
  assert.equal(shiftName('D', null, { diatonic: 1, chromatic: 2 }), 'E');
  assert.equal(shiftName('C', null, { diatonic: 3, chromatic: 5 }), 'F');
  assert.equal(shiftName('G', null, { diatonic: 1, chromatic: 1 }), 'Ab');
  assert.equal(shiftName('F', '#', { diatonic: 1, chromatic: 1 }), 'G'); // F♯ + kleine Sekunde
  assert.equal(shiftName('B', 'b', { diatonic: 1, chromatic: 2 }), 'C');
  assert.ok(shiftIsIdentity({ diatonic: 0, chromatic: 0 }));
  assert.ok(shiftIsIdentity({ diatonic: 7, chromatic: 12 }));
  assert.ok(!shiftIsIdentity({ diatonic: 1, chromatic: 2 }));
});

test('Verschiebung zwischen Ausgangsstand und aktuellem Stand: Oktaven zählen nicht', () => {
  assert.deepEqual(chordShiftBetween(XML, XML), { diatonic: 0, chromatic: 0 });
  const up2 = transposeXml(XML, { chromatic: 2 }).xml;
  assert.deepEqual(chordShiftBetween(XML, up2), { diatonic: 1, chromatic: 2 });
  const oct = shiftOctavesXml(XML, { octaves: 1 }).xml;
  assert.deepEqual(chordShiftBetween(XML, oct), { diatonic: 0, chromatic: 0 });
  const down3 = transposeXml(XML, { chromatic: -3 }).xml;
  const s = chordShiftBetween(XML, down3);
  assert.equal(s.chromatic, 9);
  assert.equal(shiftName('G', null, s), 'E');
});

// einfache Ersatzschrift: ein schwarzer Block von Zeichenhöhe
const fakeDraw = (text, { capH }) => {
  const width = Math.round(capH * 0.7) * text.length;
  return { width, height: capH, gray: new Uint8Array(width * capH).fill(0) };
};

test('Akkordsymbole ersetzen: Grundton neu, Zusatz verschoben, Rest der Seite unverändert', () => {
  const { page } = preparePage(loadPng(new URL('page-clean.png', FIX)));
  const staves = analyzePage(page);
  const symbols = findChordSymbols(page, staves[1]);
  const before = Uint8Array.from(page.gray);
  assert.equal(applyChordShift(page, symbols, { diatonic: 0, chromatic: 0 }, fakeDraw), 0);
  assert.deepEqual(Array.from(page.gray), Array.from(before));
  const n = applyChordShift(page, symbols, { diatonic: 1, chromatic: 2 }, fakeDraw);
  assert.equal(n, symbols.length);
  const W = page.width;
  // an jedem Grundton steht jetzt der Ersatzblock (dunkel), das „7“ des D-Akkords steht rechts daneben
  for (const s of symbols) {
    const b = s.root.box;
    const cx = b.x0 + 3;
    const cy = Math.round((b.y0 + b.y1) / 2);
    assert.ok(page.gray[cy * W + cx] < 60, 'Ersatz fehlt');
  }
  const d7 = symbols.find((s) => s.suffix.length);
  const inkRight = (() => {
    const b = d7.box;
    const w = fakeDraw('E', { capH: d7.capH }).width;
    let ink = 0;
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0 + w + 1; x <= b.x0 + w + 20; x++) if (page.gray[y * W + x] < 128) ink++;
    return ink;
  })();
  assert.ok(inkRight > 10, 'Zusatz („7“) fehlt hinter dem neuen Grundton');
  // außerhalb der Akkordzeile nichts verändert
  const boxes = symbols.map((s) => s.box);
  let outside = 0;
  for (let y = 0; y < page.height; y++) {
    if (y >= boxes[0].y0 - 3 && y <= boxes[0].y1 + 3) continue;
    for (let x = 0; x < W; x++) if (page.gray[y * W + x] !== before[y * W + x]) outside++;
  }
  assert.equal(outside, 0);
});

test('Seite umschreiben: Akkordsymbole wandern mit der Transposition mit', async () => {
  const tk = await loadVerovioNode();
  const prep = () => {
    const { page } = preparePage(loadPng(new URL('page-clean.png', FIX)));
    return { page, staves: analyzePage(page) };
  };
  const up = transposeXml(XML, { chromatic: 2 }).xml;
  const a = prep();
  const planA = planSystems(up, a.staves);
  await rewritePage(a.page, a.staves, up, { toolkit: tk, rasterize: fakeRasterize, counts: planA.counts });
  const b = prep();
  const symbols = findPageChords(b.page, b.staves);
  const shift = chordShiftBetween(XML, up);
  const r = await rewritePage(b.page, b.staves, up, { toolkit: tk, rasterize: fakeRasterize, counts: planA.counts, chords: { symbols, shift, drawText: fakeDraw } });
  assert.equal(r.chords, symbols.flat().length);
  assert.ok(r.chords >= 9);
  // ohne die Option bleibt die Akkordzeile wie im Scan, mit der Option ist sie anders
  let diff = 0;
  for (let i = 0; i < a.page.gray.length; i++) if (a.page.gray[i] !== b.page.gray[i]) diff++;
  assert.ok(diff > 200, `Unterschied ${diff}`);
});

// ---- Oktavieren -------------------------------------------------------------------------------------
const note = (s, a, o, extra = '') => `<note><pitch><step>${s}</step>${a ? `<alter>${a}</alter>` : ''}<octave>${o}</octave></pitch><duration>1</duration><type>quarter</type>${extra}</note>`;
const rest = '<note><rest/><duration>1</duration><type>quarter</type></note>';
function score(measures, { header = true } = {}) {
  const ms = measures.map((m, i) => `<measure number="${i + 1}">${i === 0 && header ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : ''}${m.join('')}</measure>`);
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Trompete</part-name></score-part></part-list><part id="P1">${ms.join('')}</part></score-partwise>`;
}
const octaves = (xml) => measuresOf(partsOf(readScore(xml))[0]).map((m) => m.all('note').map((n) => (n.child('pitch') ? Number(n.child('pitch').val('octave')) : null)));

const BASE = score([
  [note('C', 0, 4), note('D', 0, 4), note('E', 0, 4), note('F', 0, 4)],
  [note('G', 0, 4), rest, note('A', 0, 4), note('B', -1, 4)],
  [note('C', 0, 5), note('D', 0, 5), note('E', 0, 5), note('F', 1, 5)],
]);

test('Oktavieren: ganzes Stück rauf und runter, Pausen bleiben', () => {
  const up = shiftOctavesXml(BASE, { octaves: 1 });
  assert.equal(up.changed, 11);
  assert.deepEqual(octaves(up.xml), [[5, 5, 5, 5], [5, null, 5, 5], [6, 6, 6, 6]]);
  const back = shiftOctavesXml(up.xml, { octaves: -1 });
  assert.deepEqual(octaves(back.xml), octaves(BASE));
  // nichts zu tun: derselbe Text
  assert.equal(shiftOctavesXml(BASE, { octaves: 0 }).xml, BASE);
});

test('Oktavieren: nur gewählte Takte (Zeile = Taktbereich)', () => {
  const r = shiftOctavesXml(BASE, { octaves: -1, measures: [2, 3] });
  assert.equal(r.changed, 7);
  assert.deepEqual(octaves(r.xml), [[4, 4, 4, 4], [3, null, 3, 3], [4, 4, 4, 4]]);
  const one = shiftOctavesXml(BASE, { octaves: 2, measures: [1, 1] });
  assert.deepEqual(octaves(one.xml)[0], [6, 6, 6, 6]);
  assert.deepEqual(octaves(one.xml)[1], [4, null, 4, 4]);
});

test('Oktavieren: einzelne Töne (Zählung ohne Pausen), Tonnamen mit H und B', () => {
  const r = shiftOctavesXml(BASE, { octaves: 1, notes: [{ measure: 2, index: 3 }, { measure: 1, index: 1 }] });
  assert.equal(r.changed, 2);
  assert.deepEqual(octaves(r.xml), [[5, 4, 4, 4], [4, null, 4, 5], [5, 5, 5, 5]]);
  const d = describeMeasure(BASE, { measure: 2 });
  assert.equal(d.measures, 3);
  assert.deepEqual(d.notes.map((n) => n.label), ['G4', 'A4', 'B4']);
  assert.equal(describeMeasure(score([[note('B', 0, 3), note('F', 1, 4), note('E', -1, 4)]]), { measure: 1 }).notes.map((n) => n.label).join(' '), 'H3 F♯4 E♭4');
  assert.equal(measureCount(BASE), 3);
});

test('Oktavieren: am Rand des Notenbereichs wird nichts verschoben', () => {
  const high = score([[note('C', 0, 9), note('D', 0, 8)]]);
  const r = shiftOctavesXml(high, { octaves: 1 });
  assert.equal(r.changed, 1);
  assert.equal(r.clamped, 1);
  assert.deepEqual(octaves(r.xml)[0], [9, 9]);
  const same = shiftOctavesXml(score([[note('C', 0, 0)]]), { octaves: -1 });
  assert.equal(same.changed, 0);
});

test('Oktavieren: Haltebögen zu Tönen in anderer Oktave fallen weg, vollständig gewählte bleiben', () => {
  const tieStart = '<tie type="start"/><notations><tied type="start"/></notations>';
  const tieStop = '<tie type="stop"/><notations><tied type="stop"/></notations>';
  const tied = score([[note('C', 0, 4, tieStart)], [note('C', 0, 4, tieStop), note('D', 0, 4)]]);
  const partial = shiftOctavesXml(tied, { octaves: 1, measures: [1, 1] });
  assert.ok(!/<tie /.test(partial.xml) && !/<tied /.test(partial.xml), 'Haltebogen zwischen verschiedenen Oktaven');
  assert.equal(partial.ties, 1);
  const whole = shiftOctavesXml(tied, { octaves: 1 });
  assert.equal((whole.xml.match(/<tie /g) || []).length, 2);
  assert.equal((whole.xml.match(/<tied /g) || []).length, 2);
});

test('Projekt: Oktavieren über mehrere Seiten, Rückgängig', () => {
  const p1 = score([[note('C', 0, 4)], [note('D', 0, 4)]]);
  const p2 = score([[note('E', 0, 4)], [note('F', 0, 4)]], { header: false });
  const p = newProject({ pages: [{ xml: p1 }, { xml: p2 }], origin: 'scan' });
  // Takte 2–3 liegen über der Seitengrenze
  const r = shiftOctaveProject(p, { octaves: 1, measures: [2, 3] });
  assert.equal(r.changed, 2);
  assert.deepEqual(octaves(p.pages[0].xml), [[4], [5]]);
  assert.deepEqual(octaves(p.pages[1].xml), [[5], [4]]);
  assert.ok(p.history.length === 1);
  // einzelner Ton im vierten Takt (zweite Seite, Takt 2)
  const t = shiftOctaveProject(p, { octaves: -1, notes: [{ measure: 4, index: 1 }] });
  assert.equal(t.changed, 1);
  assert.deepEqual(octaves(p.pages[1].xml), [[5], [3]]);
  // ganzes Stück
  const all = shiftOctaveProject(p, { octaves: 1 });
  assert.equal(all.changed, 4);
  // nichts geändert: kein Eintrag im Verlauf
  const n = p.history.length;
  const none = shiftOctaveProject(p, { octaves: 1, measures: [9, 12] });
  assert.equal(none.changed, 0);
  assert.equal(p.history.length, n);
  assert.ok(undo(p));
  assert.deepEqual(octaves(p.pages[0].xml), [[4], [5]]);
  assert.equal(measureCount(projectXml(p)), 4);
});

test('Auf Original zurücksetzen: Töne, Schlüssel, Instrument und Stimmen; Rückgängig bringt die Änderungen zurück', async () => {
  const { resetToOriginal, isOriginal, replaceWithScore, transposeProject, setClefProject, convertProject } = await import('../src/sheet/project.js');
  const p1 = score([[note('C', 0, 4), note('D', 0, 4), note('E', 0, 4), note('F', 0, 4)], [note('G', 0, 4), rest, note('A', 0, 4), note('B', 0, 4)]]);
  const p = newProject({ pages: [{ xml: p1 }], origin: 'scan', sourceInstrument: 'trumpet' });
  assert.ok(isOriginal(p));
  assert.equal(resetToOriginal(p), false, 'nichts zu tun');
  transposeProject(p, { chromatic: 2 });
  shiftOctaveProject(p, { octaves: 1, measures: [2, 2] });
  setClefProject(p, 'F4');
  assert.ok(!isOriginal(p));
  const changed = projectXml(p);
  assert.notEqual(changed, p1);
  assert.ok(resetToOriginal(p));
  assert.ok(isOriginal(p));
  assert.equal(p.pages[0].xml, p1);
  assert.equal(p.pages[0].xml, p.pages[0].base, 'unveränderte Seite = Original-Bild');
  // der Schritt selbst ist rückgängig zu machen
  assert.ok(undo(p));
  assert.equal(projectXml(p), changed);
  assert.ok(redo(p));
  assert.ok(isOriginal(p));
  // Instrument-Wechsel setzt auch die Notierung zurück
  convertProject(p, { targetId: 'trombone' });
  assert.equal(p.sourceInstrument, 'trombone');
  resetToOriginal(p);
  assert.equal(p.sourceInstrument, 'trumpet');
  assert.equal(p.instrument, null);
  // Stimmen dazuschreiben: Rückgängig und Zurücksetzen führen zum einzelnen Blatt zurück
  const two = p1.replace('</part-list>', '</part-list>'); // anderer Text als zweite „Partitur“
  replaceWithScore(p, { xml: two.replace('Trompete', 'Trompete 2'), sourceInstrument: 'trumpet', instrument: 'trumpet' });
  assert.equal(p.origin, 'score');
  assert.ok(!isOriginal(p));
  assert.ok(undo(p));
  assert.equal(p.origin, 'scan');
  assert.ok(isOriginal(p));
  replaceWithScore(p, { xml: two.replace('Trompete', 'Trompete 2'), sourceInstrument: 'trumpet', instrument: 'trumpet' });
  assert.ok(resetToOriginal(p));
  assert.equal(p.origin, 'scan');
  assert.equal(p.pages.length, 1);
  assert.equal(p.pages[0].xml, p1);
});
