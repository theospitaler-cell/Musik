// Eine eingescannte Seite umschreiben („Original-Seite behalten“): Hintergrund perfekt weiß, Titel/Texte
// unverändert, die Notenzeilen werden mit den geänderten Noten neu gesetzt und an derselben Stelle eingefügt.
import { binarize, toGray, whiten, estimateSkew, rotate, estimateStaffSpace, estimateLineGray, scaleGray, darken } from './raster.js';
import { detectStaves } from './staff.js';
import { detectBarlines } from './barlines.js';
import { musicMask, applyErase, overlay } from './erase.js';
import { sliceSystems, systemBreaks, engraveSystem } from './engrave.js';
import { findChordSymbols, applyChordShift, shiftIsIdentity } from './chords.js';

// Seite vorbereiten: Graustufen, Beleuchtung ausgleichen, bei kleiner Auflösung vergrößern, gerade drehen,
// Hintergrund weiß. Bildschirmfotos und kleine Drucke (Notenlinienabstand unter ~8 px) werden auf etwa 11 px
// hochgerechnet und nachgedunkelt, damit die dünnen, blassen Linien als Linien erkannt werden.
const TARGET_SPACE = 11;
const MIN_SPACE = 8.5;
const MAX_SIDE = 4200;
export function preparePage(img, { deskew = true, upscale = true } = {}) {
  let page = whiten(toGray(img));
  let skew = 0;
  if (deskew) {
    skew = estimateSkew(page);
    if (Math.abs(skew) >= 0.15) page = rotate(page, skew);
    else skew = 0;
  }
  let scale = 1;
  if (upscale) {
    // erst gerade, dann messen (schräge Linien verwischen das Zeilenmuster)
    const est = estimateStaffSpace(page);
    if (est && est.strength >= 0.1 && est.space < MIN_SPACE) {
      const f = Math.min(4, TARGET_SPACE / est.space, MAX_SIDE / Math.max(page.width, page.height));
      if (f > 1.15) {
        const scaled = scaleGray(page, f);
        // Linien so weit nachdunkeln, dass auch die blassesten Zeilen Tinte werden
        const L = estimateLineGray(scaled);
        const black = Math.max(150, Math.min(235, L + 0.3 * (255 - L)));
        const big = darken(scaled, { black, white: Math.min(252, black + 45) });
        // nur übernehmen, wenn danach Notenzeilen zu finden sind (sonst bleibt das Original)
        if (detectStaves(binarize(big)).length >= detectStaves(binarize(page)).length) {
          page = big;
          scale = f;
        }
      }
    }
  }
  return { page, skew, scale };
}

// Notenzeilen der Seite samt Taktstrichen
export function analyzePage(page) {
  const bin = binarize(page);
  const staves = detectStaves(bin);
  return staves.map((s) => ({ ...s, barlines: detectBarlines(bin, s) }));
}

// Takte je Zeile: bevorzugt die Zeilenumbrüche der Erkennung (<print new-system>), sonst die Taktstriche
export function planSystems(xmlText, staves) {
  const br = systemBreaks(xmlText);
  const total = br.measures;
  const notes = [];
  // Taktstriche je Zeile (ohne Anfangsstrich am Zeilenrand)
  const perStaff = staves.map((s) => s.barlines.filter((x) => x > s.x0 + s.space * 1.5).length);
  if (br.counts.length === staves.length) {
    const agree = perStaff.every((n, i) => n === br.counts[i]);
    if (!agree) notes.push('Taktstriche im Bild und erkannte Takte je Zeile weichen ab – Positionen werden gleichmäßig verteilt');
    return { counts: br.counts, exact: agree, notes };
  }
  const sum = perStaff.reduce((a, c) => a + c, 0);
  if (sum === total) return { counts: perStaff, exact: true, notes: ['Zeilenumbrüche aus den Taktstrichen im Bild'] };
  throw new Error(`Seite passt nicht zur Erkennung: ${staves.length} Notenzeilen im Bild, ${br.counts.length} Zeilen und ${total} Takte in den erkannten Noten`);
}

// Akkordsymbole je Notenzeile (einmal je Seite; die vorbereitete Seite ändert sich nicht)
export function findPageChords(page, staves) {
  return staves.map((s) => {
    try {
      return findChordSymbols(page, s);
    } catch {
      return [];
    }
  });
}

// opts: { toolkit: Verovio, rasterize(svg, { scale, dx, dy, width, height }) -> { width, height, gray } (weiß = 255) }
// xml: die (geänderten) Noten dieser Seite; counts: Takte je Zeile (aus planSystems)
// chords: { symbols: Ergebnis von findPageChords, shift: { diatonic, chromatic }, drawText } – Akkordsymbole im Bild mitändern
export async function rewritePage(page, staves, xml, { toolkit, rasterize, counts, chords = null }) {
  const slices = sliceSystems(xml, counts);
  if (slices.length !== staves.length) throw new Error(`Zeilenzahl passt nicht (${slices.length} ≠ ${staves.length})`);
  const warnings = [];
  const systems = [];
  // erst alles löschen (Text bleibt), dann die gesetzten Zeilen einfügen
  const masks = staves.map((s) => musicMask(page, s));
  masks.forEach((m) => applyErase(page, m));
  // Akkordsymbole: Grundton (und Bass) im Bild durch den transponierten Namen ersetzen, der Rest wird verschoben
  let chordsChanged = 0;
  if (chords && chords.drawText && chords.shift && !shiftIsIdentity(chords.shift)) {
    for (const symbols of chords.symbols || []) chordsChanged += applyChordShift(page, symbols, chords.shift, chords.drawText);
  }
  for (let i = 0; i < staves.length; i++) {
    const s = staves[i];
    const barSpaces = s.barlines.filter((x) => x > s.x0 + s.space * 1.5).map((x) => (x - s.x0) / s.space);
    const widthSpaces = (s.x1 - s.x0) / s.space;
    const r = engraveSystem(toolkit, slices[i].xml, { widthSpaces, barSpaces: barSpaces.length === slices[i].measures ? barSpaces : null });
    const k = s.space / 180; // Pixel je Verovio-Einheit
    const g = r.g;
    // Ursprung der gesetzten Zeile im Seitenbild (Linie oben/links ausgerichtet)
    const ox = s.x0 - g.x0 * k;
    const oy = s.lines[0] - g.top * k;
    const ix = Math.floor(ox);
    const iy = Math.floor(oy);
    const band = await rasterize(r.svg, { scale: k, dx: ox - ix, dy: oy - iy, width: Math.ceil(g.viewW * k) + 2, height: Math.ceil(g.viewH * k) + 2 });
    overlay(page, band, ix, iy);
    systems.push({ index: i, measures: slices[i].measures, mode: r.mode, natural: r.natural, widthError: r.widthError });
    if (r.mode !== 'taktgenau') warnings.push(`Zeile ${i + 1}: Takte gleichmäßig verteilt`);
  }
  return { page, systems, warnings, music: masks.map((m) => m.stats), chords: chordsChanged };
}
