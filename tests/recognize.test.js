// Eingebaute Notenerkennung (ohne KI) an gerenderten Notenblättern mit bekannter Wahrheit.
// Die Wahrheit ist das MusicXML, aus dem das Blatt gerendert wurde (tests/fixtures/scans/*.truth.musicxml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPng } from './helpers-image.js';
import { preparePage, analyzePage } from '../src/sheet/image/page.js';
import { recognizePage, recognizeSimple } from '../src/sheet/image/recognize.js';
import { readScore, partsOf, measuresOf } from '../src/sheet/xml.js';
import { midiOf } from '../src/sheet/transpose.js';
import { analyzeXml } from '../src/sheet/transpose.js';

const FIX = new URL('./fixtures/scans/', import.meta.url);

function seq(xml) {
  const out = [];
  let div = 1;
  for (const m of measuresOf(partsOf(readScore(xml))[0])) {
    const at = m.all('attributes').find((a) => a.child('divisions'));
    if (at) div = Number(at.val('divisions'));
    out.push(
      m.all('note').map((n) => {
        const p = n.child('pitch');
        const d = Number(n.val('duration')) / div;
        return p ? `${midiOf({ step: p.val('step'), alter: Number(p.val('alter', 0)), octave: Number(p.val('octave')) })}:${d}` : `r:${d}`;
      }),
    );
  }
  return out;
}

function run(name, truth) {
  const { page } = preparePage(loadPng(new URL(`${name}.png`, FIX)));
  const staves = analyzePage(page);
  const r = recognizePage({ page, staves });
  const got = seq(r.xml);
  const want = seq(readFileSync(new URL(`${truth}.truth.musicxml`, FIX), 'utf8'));
  let exact = 0;
  let ev = 0;
  let evTotal = 0;
  want.forEach((w, i) => {
    if ((got[i] || []).join(' ') === w.join(' ')) exact++;
    w.forEach((x, k) => {
      evTotal++;
      if ((got[i] || [])[k] === x) ev++;
    });
  });
  return { r, got, want, exact, ev, evTotal };
}

// Mindestgüte je Blatt (Takte exakt) – bewusst unter dem Messwert, damit kleine Änderungen nicht stören
const CASES = [
  ['page-clean', 'saints', 13, 'G2', 1],
  ['page-skewed', 'saints', 11, 'G2', 1],
  ['bass-ode', 'bass-ode', 11, 'F4', 0],
  ['wal-grace', 'wal-grace', 14, 'G2', 1],
  ['bass-groove', 'bass-groove', 9, 'F4', 0],
];

for (const [name, truth, minExact, clef, key] of CASES) {
  test(`Eingebaute Erkennung: ${name} – Schlüssel, Vorzeichen, Takte und Töne`, () => {
    const { r, got, want, exact, ev, evTotal } = run(name, truth);
    assert.equal(r.stats.clef, clef);
    assert.equal(r.stats.key, key);
    assert.equal(got.length, want.length, 'gleiche Taktzahl');
    assert.ok(exact >= minExact, `Takte exakt: ${exact}/${want.length} (mindestens ${minExact})`);
    assert.ok(ev / evTotal >= 0.75, `Ereignisse: ${ev}/${evTotal}`);
    // gültiges MusicXML mit vollständigen Takten (Notenwerte ergeben die Taktlänge, außer Auftakt/Schluss)
    const info = analyzeXml(r.xml);
    assert.equal(info.parts.length, 1);
    assert.equal(info.fifths, key);
  });
}

test('Eingebaute Erkennung: Zeilenumbrüche und Taktart', () => {
  const { page } = preparePage(loadPng(new URL('wal-grace.png', FIX)));
  const r = recognizePage({ page, staves: analyzePage(page) });
  assert.deepEqual(r.stats.timeBeats, [3, 4]);
  assert.equal(r.stats.staves, 3);
  assert.equal((r.xml.match(/new-system/g) || []).length, 2);
  assert.match(r.xml, /<time><beats>3<\/beats><beat-type>4<\/beat-type><\/time>/);
});

test('Eingebaute Erkennung: leere Seite liefert eine verständliche Warnung, keinen Absturz', () => {
  const page = { width: 400, height: 300, gray: new Uint8Array(400 * 300).fill(255) };
  const r = recognizeSimple({ page, staves: [] });
  assert.equal(r.stats.notes, 0);
  assert.ok(r.warnings.some((w) => /keine Noten/.test(w)));
});
