// Eingescannte Notenblätter: Hintergrund weiß, Entzerren, Notenzeilen und Taktstriche finden, Musik löschen
// (Text bleibt), Zeilen neu setzen und ausrichten. Beispielblätter: tests/fixtures/scans/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPng } from './helpers-image.js';
import { loadVerovioNode, fakeRasterize } from './helpers-verovio.js';
import { toGray, whiten, estimateSkew, rotate, whiteShare, binarize } from '../src/sheet/image/raster.js';
import { detectStaves } from '../src/sheet/image/staff.js';
import { detectBarlines } from '../src/sheet/image/barlines.js';
import { musicMask, applyErase, labelComponents } from '../src/sheet/image/erase.js';
import { systemBreaks, sliceSystems, svgGeometry, engraveSystem } from '../src/sheet/image/engrave.js';
import { stretchSvg, piecewise, svgBarlines, contentStart } from '../src/sheet/image/stretch.js';
import { preparePage, analyzePage, planSystems, rewritePage } from '../src/sheet/image/page.js';
import { analyzeXml } from '../src/sheet/transpose.js';
import { setClefXml, transposeXml } from '../src/sheet/transpose.js';

const FIX = new URL('./fixtures/scans/', import.meta.url);
const clean = loadPng(new URL('page-clean.png', FIX));
const skewed = loadPng(new URL('page-skewed.png', FIX));
const XML = readFileSync(new URL('page-clean.musicxml', FIX), 'utf8');

test('Hintergrund perfekt weiß: Papierfarbe und Schattierung verschwinden, Tinte bleibt', () => {
  const g = toGray(skewed);
  assert.ok(whiteShare(g.gray) < 0.01, 'Vorlage ist nicht weiß');
  const w = whiten(g);
  const cleanWhite = whiteShare(whiten(toGray(clean)).gray);
  assert.ok(whiteShare(w.gray) > cleanWhite - 0.03, `weiß ${whiteShare(w.gray).toFixed(3)} vs ${cleanWhite.toFixed(3)}`);
  // Tinte bleibt dunkel: Anteil sehr dunkler Pixel (< 80) ähnlich wie im sauberen Blatt
  const dark = (a) => a.filter((v) => v < 80).length / a.length;
  assert.ok(Math.abs(dark(w.gray) - dark(whiten(toGray(clean)).gray)) < 0.004);
});

test('Entzerren: Neigung wird gefunden und ausgeglichen', () => {
  const w = whiten(toGray(skewed));
  const skew = estimateSkew(w);
  assert.ok(Math.abs(skew - 0.9) < 0.25, `Neigung ${skew}`);
  assert.ok(Math.abs(estimateSkew(rotate(w, skew))) < 0.2);
  assert.equal(estimateSkew(whiten(toGray(clean))), 0);
});

test('Notenzeilen: drei Systeme mit gleichem Linienabstand, auch nach Entzerren des schiefen Scans', () => {
  const c = detectStaves(binarize(whiten(toGray(clean))));
  assert.equal(c.length, 3);
  for (const s of c) {
    assert.ok(s.space > 9 && s.space < 12, `Abstand ${s.space}`);
    assert.equal(s.lines.length, 5);
    assert.ok(s.x1 - s.x0 > 600);
  }
  const { page } = preparePage(skewed);
  const k = detectStaves(binarize(page));
  assert.equal(k.length, 3);
  assert.ok(Math.abs(k[0].space - c[0].space) < 0.6);
  // schiefer Scan ohne Entzerren findet nichts Brauchbares
  assert.ok(detectStaves(binarize(whiten(toGray(skewed)))).length < 3);
});

test('Taktstriche: 5, 7 und 4 Takte; Schlusstriche zählen einmal', () => {
  const page = whiten(toGray(clean));
  const staves = detectStaves(binarize(page));
  const counts = staves.map((s) => detectBarlines(page, s).filter((x) => x > s.x0 + s.space * 1.5).length);
  assert.deepEqual(counts, [5, 7, 4]);
});

test('Musik löschen, Text behalten: nichts außerhalb der Notenzeilen verändert, Buchstaben bleiben', () => {
  const page = whiten(toGray(clean));
  const before = Uint8Array.from(page.gray);
  const staves = detectStaves(binarize(page));
  const masks = staves.map((s) => musicMask(page, s));
  masks.forEach((m) => applyErase(page, m));
  const bands = staves.map((s) => [Math.floor(s.top - 5.5 * s.space), Math.ceil(s.bottom + 5.5 * s.space)]);
  let outside = 0;
  for (let y = 0; y < page.height; y++) {
    if (bands.some(([a, b]) => y >= a && y <= b)) continue;
    for (let x = 0; x < page.width; x++) if (page.gray[y * page.width + x] !== before[y * page.width + x]) outside++;
  }
  assert.equal(outside, 0);
  // im Bereich der Zeilen: keine Notenlinien, keine Notenhälse mehr (Zeilenmitte ist fast weiß)
  for (const s of staves) {
    let ink = 0;
    for (let y = Math.round(s.top); y <= Math.round(s.bottom); y++) for (let x = Math.round(s.x0); x <= Math.round(s.x1); x++) if (page.gray[y * page.width + x] < 128) ink++;
    assert.ok(ink / ((s.bottom - s.top) * (s.x1 - s.x0)) < 0.002, `Rest-Tinte in der Zeile: ${ink}`);
  }
  // Text bleibt: die Überschrift zwischen den Systemen hat noch Tinte (Akkordsymbole, „Teil B – Melodie“ …)
  const s2 = staves[1];
  let textInk = 0;
  for (let y = Math.round(s2.top - 5 * s2.space); y < Math.round(s2.top - 0.5 * s2.space); y++) for (let x = 0; x < page.width; x++) if (page.gray[y * page.width + x] < 128) textInk++;
  assert.ok(textInk > 300, `Text über der 2. Zeile: ${textInk} Tintenpixel`);
  // Akkordsymbole & Probenbuchstaben sind verbundene Flächen, die erhalten bleiben
  const m2 = masks[1];
  assert.ok(m2.stats.text >= 20, `Textflächen ${m2.stats.text}`);
});

test('Erkennung → Zeilen: Zeilenumbrüche der Erkennung passen zu den Notenzeilen', () => {
  const br = systemBreaks(XML);
  assert.deepEqual(br.counts, [5, 7, 4]);
  const slices = sliceSystems(XML);
  assert.equal(slices.length, 3);
  assert.deepEqual(slices.map((s) => s.measures), [5, 7, 4]);
  // jede Zeile ist ein vollständiges Blatt mit Schlüssel, Vorzeichen und Taktart
  for (const s of slices) {
    assert.match(s.xml, /<clef/);
    assert.match(s.xml, /<fifths>1<\/fifths>/);
    assert.match(s.xml, /<beats>4<\/beats>/);
  }
  assert.throws(() => sliceSystems(XML, [5, 5, 5]), /Taktzahl/);
});

test('Gedehnte Zeile: Taktstriche liegen genau auf denen des Scans, Zeichen bleiben unverzerrt', async () => {
  const tk = await loadVerovioNode();
  const slices = sliceSystems(XML);
  const page = whiten(toGray(clean));
  const s = analyzePage(page)[0];
  const barSpaces = s.barlines.filter((x) => x > s.x0 + s.space * 1.5).map((x) => (x - s.x0) / s.space);
  const r = engraveSystem(tk, slices[0].xml, { widthSpaces: (s.x1 - s.x0) / s.space, barSpaces });
  assert.equal(r.mode, 'taktgenau');
  const g = r.g;
  const bars = svgBarlines(r.svg).filter((x) => x > g.x0 + 90);
  assert.equal(bars.length, barSpaces.length);
  bars.forEach((x, i) => assert.ok(Math.abs((x - g.x0) / 180 - barSpaces[i]) < 0.12, `Taktstrich ${i}: ${(x - g.x0) / 180} vs ${barSpaces[i]}`));
  assert.ok(Math.abs((g.x1 - g.x0) / 180 - (s.x1 - s.x0) / s.space) < 0.3);
  // Glyphen (<use>) behalten ihre Größe
  const sizes = [...r.svg.matchAll(/<use[^>]*height="(\d+)px"/g)].map((m) => m[1]);
  assert.ok(sizes.length > 5 && new Set(sizes).size <= 4);
});

test('Stückweise Dehnung: Anker bleibt, Teilstücke werden linear abgebildet', () => {
  const f = piecewise([[0, 0], [100, 300], [200, 350]]);
  assert.equal(f(-10), -10);
  assert.equal(f(50), 150);
  assert.equal(f(100), 300);
  assert.equal(f(150), 325);
  assert.equal(f(300), 400);
  const svg = '<svg width="100px" height="10px"><defs></defs><svg class="definition-scale" viewBox="0 0 1000 100"><g class="staff"><path d="M0 10 L1000 10" stroke-width="13"/></g><g class="ledgerLines"><path d="M400 50 L500 50"/></g><use xlink:href="#a" x="500" y="20" height="720px" width="720px"/></svg></svg>';
  const out = stretchSvg(svg, { anchor: 100, factor: 2 });
  assert.match(out, /M 0 10 L 1900 10/);
  assert.match(out, /x="900"/); // 100 + (500-100)*2
  assert.match(out, /M\d+ 50 L\d+ 50/); // Hilfslinie: Mitte verschoben, Länge 100 bleibt
  const led = /ledgerLines[^>]*><path d="M([\d.]+) 50 L([\d.]+) 50"/.exec(out);
  assert.equal(Number(led[2]) - Number(led[1]), 100);
  assert.ok(contentStart('<defs></defs><g class="note"><use x="900" y="1"/></g>') < 900);
});

test('Seite umschreiben (Altschlüssel): Zeilen neu gesetzt, Linien an der alten Stelle, Text unverändert', async () => {
  const tk = await loadVerovioNode();
  const { page, skew } = preparePage(clean);
  assert.equal(skew, 0);
  const staves = analyzePage(page);
  const before = Uint8Array.from(page.gray);
  const edited = setClefXml(XML, 'C3'); // gleiche Töne, Altschlüssel (bleibt im Bereich der Zeile)
  const plan = planSystems(edited, staves);
  assert.deepEqual(plan.counts, [5, 7, 4]);
  assert.equal(plan.exact, true);
  const r = await rewritePage(page, staves, edited, { toolkit: tk, rasterize: fakeRasterize, counts: plan.counts });
  assert.equal(r.systems.length, 3);
  assert.ok(r.systems.every((s) => s.mode === 'taktgenau'), JSON.stringify(r.systems));
  assert.deepEqual(r.warnings, []);
  // Notenlinien wieder an derselben Stelle (Zeilenmitte hat Tinte, Abstand der Linien gleich)
  const W = page.width;
  for (const s of staves) {
    for (const ly of s.lines) {
      let ink = 0;
      const y = Math.round(ly);
      for (let x = Math.round(s.x0) + 5; x < Math.round(s.x1) - 5; x++) if (page.gray[y * W + x] < 128 || page.gray[(y + 1) * W + x] < 128 || page.gray[(y - 1) * W + x] < 128) ink++;
      assert.ok(ink / (s.x1 - s.x0 - 10) > 0.9, `Linie bei y=${y}: ${(ink / (s.x1 - s.x0 - 10)).toFixed(2)}`);
    }
  }
  // Titel und alles außerhalb der Zeilen ist unverändert
  const bands = staves.map((s) => [Math.floor(s.top - 5.5 * s.space), Math.ceil(s.bottom + 5.5 * s.space)]);
  let outside = 0;
  for (let y = 0; y < page.height; y++) {
    if (bands.some(([a, b]) => y >= a && y <= b)) continue;
    for (let x = 0; x < W; x++) if (page.gray[y * W + x] !== before[y * W + x]) outside++;
  }
  assert.equal(outside, 0, 'Pixel außerhalb der Notenzeilen verändert');
});

test('Seite umschreiben: passt die Zeilenzahl nicht, gibt es eine klare Meldung statt Unsinn', () => {
  const staves = [{ barlines: [100, 200, 300], x0: 50, space: 10 }, { barlines: [100, 200], x0: 50, space: 10 }];
  assert.throws(() => planSystems(XML, staves), /Seite passt nicht/);
  // Taktstriche abweichend, Zeilenzahl gleich: weicht ab, läuft aber gleichmäßig verteilt
  const three = [5, 7, 3].map((n) => ({ barlines: Array.from({ length: n }, (_, i) => 200 + i * 100), x0: 100, space: 10 }));
  const p = planSystems(XML, three);
  assert.equal(p.exact, false);
  assert.ok(p.notes.length > 0);
});

test('Transponieren der Seite: neue Vorzeichen stehen im Notensystem, Takte bleiben', async () => {
  const tk = await loadVerovioNode();
  const { page } = preparePage(clean);
  const staves = analyzePage(page);
  const up = transposeXml(XML, { chromatic: 2 }).xml; // G-Dur (1 #) -> A-Dur (3 #)
  assert.equal(analyzeXml(up).fifths, 3);
  const plan = planSystems(up, staves);
  const r = await rewritePage(page, staves, up, { toolkit: tk, rasterize: fakeRasterize, counts: plan.counts });
  assert.ok(r.systems.every((s) => s.mode === 'taktgenau'));
  // mehr Zeichen im Zeilenanfang (drei Kreuze statt einem): Tinte im Bereich der Vorzeichen
  const s = staves[0];
  const x0 = Math.round(s.x0 + 2.5 * s.space);
  const x1 = Math.round(s.x0 + 6 * s.space);
  let ink = 0;
  for (let y = Math.round(s.top - s.space); y <= Math.round(s.bottom + s.space); y++) for (let x = x0; x <= x1; x++) if (page.gray[y * page.width + x] < 128) ink++;
  assert.ok(ink > 0);
});

test('Verbundene Flächen: zählt getrennte Zeichen', () => {
  const w = 12;
  const h = 6;
  const m = new Uint8Array(w * h);
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [8, 3], [9, 3], [9, 4]]) m[y * w + x] = 1;
  const { comps } = labelComponents(m, w, h);
  assert.equal(comps.length, 2);
  assert.deepEqual(comps.map((c) => c.n).sort(), [3, 3]);
});

test('Geometrie aus dem Verovio-SVG', async () => {
  const tk = await loadVerovioNode();
  const x = sliceSystems(XML)[0].xml;
  tk.setOptions({ scale: 100, pageWidth: 3000, pageHeight: 3000, adjustPageHeight: true, adjustPageWidth: true, breaks: 'none', pageMarginLeft: 0, pageMarginRight: 0, pageMarginTop: 0, pageMarginBottom: 0 });
  tk.loadData(x);
  const g = svgGeometry(tk.renderToSVG(1));
  assert.equal(g.lines.length, 5);
  assert.equal(g.space, 180);
  assert.ok(g.x1 - g.x0 > 3000);
});
