// Neu gestochene Notenzeilen für „Original-Seite behalten“: jede Zeile der Vorlage wird einzeln mit Verovio
// gesetzt – gleiche Takte, gleicher Linienabstand, gleiche Breite wie im Scan – und danach ins Bild gelegt.
import { XNode } from '../../core/xml.js';
import { readScore, writeScore, el, cloneNode, partsOf, measuresOf, removeChildren } from '../xml.js';
import { stretchSvg, warpSvg, piecewise, svgBarlines, contentStart } from './stretch.js';

// ---- MusicXML in Zeilen zerlegen --------------------------------------------------------------------
// counts: Takte je Zeile (z. B. aus den Taktstrichen des Scans); sonst nach <print new-system>/new-page
export function systemBreaks(xmlText) {
  const root = readScore(xmlText);
  const part = partsOf(root)[0];
  const ms = measuresOf(part);
  const starts = [0];
  ms.forEach((m, i) => {
    if (i === 0) return;
    if (m.all('print').some((p) => p.attrs['new-system'] === 'yes' || p.attrs['new-page'] === 'yes')) starts.push(i);
  });
  return { measures: ms.length, starts, counts: starts.map((s, k) => (starts[k + 1] ?? ms.length) - s) };
}

const ATTR_ORDER = ['divisions', 'key', 'time', 'staves', 'part-symbol', 'instruments', 'clef', 'staff-details', 'transpose'];

// Je Zeile ein eigenständiges MusicXML (Schlüssel, Vorzeichen, Taktart werden aus den Takten davor übernommen)
export function sliceSystems(xmlText, counts = null) {
  const root = readScore(xmlText);
  const part = partsOf(root)[0];
  if (!part) throw new Error('Keine Stimme im Blatt');
  const ms = measuresOf(part);
  const sizes = counts && counts.length ? counts : systemBreaks(xmlText).counts;
  const total = sizes.reduce((a, c) => a + c, 0);
  if (total !== ms.length) throw new Error(`Taktzahl passt nicht: ${total} in den Zeilen, ${ms.length} im Blatt`);
  const header = [];
  for (const name of ['work', 'identification', 'defaults']) for (const c of root.all(name)) header.push(c);
  const list = root.get('part-list');
  const cur = {}; // Name -> Knoten (Schlüssel je Nummer)
  const out = [];
  let idx = 0;
  for (const size of sizes) {
    // Attribute dieser Zeile: Zustand am Anfang = alles bisher Gesetzte
    const first = ms[idx];
    const state = { ...cur };
    // Attribute im ersten Takt der Zeile überschreiben
    const nodes = [];
    for (const [k, v] of Object.entries(state)) nodes.push([k, v]);
    // Takte der Zeile
    const slice = ms.slice(idx, idx + size).map((m) => cloneNode(m));
    for (const m of slice) {
      // Nur die Musik wird neu gesetzt. Text, Dynamik und Akkordsymbole stehen unverändert im Scan (sie werden
      // nicht gelöscht) und würden doppelt erscheinen.
      for (const name of ['print', 'direction', 'harmony', 'figured-bass', 'sound']) removeChildren(m, name);
      for (const n of m.all('note')) removeChildren(n, 'lyric');
    }
    // Merge: die Attribute des ersten Takts ergänzen den Stand davor
    const firstAttrs = slice[0].all('attributes');
    const merged = new XNode('attributes', {});
    const map = new Map(nodes);
    for (const at of firstAttrs) {
      for (const c of at.children) {
        const key = c.name === 'clef' ? `clef#${c.attrs.number || 1}` : c.name;
        map.set(key, c);
      }
    }
    const keys = [...map.keys()].sort((a, b) => ATTR_ORDER.indexOf(a.split('#')[0]) - ATTR_ORDER.indexOf(b.split('#')[0]));
    for (const k of keys) merged.children.push(cloneNode(map.get(k)));
    slice[0].children = slice[0].children.filter((c) => c.name !== 'attributes');
    slice[0].children.unshift(merged);
    // Zustand über die Takte der Zeile fortschreiben (alle Attribute, auch spätere Wechsel)
    for (let j = idx; j < idx + size; j++) {
      for (const at of ms[j].all('attributes')) {
        for (const c of at.children) {
          const key = c.name === 'clef' ? `clef#${c.attrs.number || 1}` : c.name;
          cur[key] = c;
        }
      }
    }
    void first;
    // Dokument
    const doc = new XNode('score-partwise', { version: '4.0' });
    for (const h of header) if (h.name !== 'defaults') doc.children.push(cloneNode(h));
    const pl = list ? cloneNode(list) : el('part-list');
    // keine Stimmennamen vor der Zeile (der Name steht schon im Scan)
    for (const sp of pl.all('score-part')) {
      for (const n of ['part-name', 'part-abbreviation', 'part-name-display', 'part-abbreviation-display']) removeChildren(sp, n);
      sp.children.unshift(el('part-name', ''));
    }
    doc.children.push(pl);
    const p = new XNode('part', { id: part.attrs.id });
    slice.forEach((m, j) => {
      m.attrs = { ...m.attrs, number: String(j + 1) };
      p.children.push(m);
    });
    doc.children.push(p);
    out.push({ xml: writeScore(doc), firstMeasure: idx, measures: size });
    idx += size;
  }
  return out;
}

// ---- Geometrie aus dem Verovio-SVG ---------------------------------------------------------------------
// Verovio-Einheiten im SVG: 1 px bei scale 100 = 10 Einheiten; Notenlinienabstand = 180 Einheiten (unit 9).
const LINE_RE = /<path d="M\s*([\d.]+)[ ,]+([\d.]+)\s*L\s*([\d.]+)[ ,]+([\d.]+)"[^>]*?(?:stroke-width="([\d.]+)")?[^>]*?\/>\s*/;
const STAFF_RE = new RegExp('<g[^>]*class="staff"[^>]*>\\s*((?:' + LINE_RE.source + '){5})', 'g');

export function svgGeometry(svgText) {
  const vb = /<svg[^>]*class="definition-scale"[^>]*viewBox="0 0 (\d+) (\d+)"/.exec(svgText) || /viewBox="0 0 (\d+) (\d+)"/.exec(svgText);
  const outer = /<svg width="([\d.]+)px" height="([\d.]+)px"/.exec(svgText);
  if (!vb) return null;
  // Jeder Takt hat eine eigene Gruppe class="staff" mit fünf Linien-Pfaden; die Zeile reicht vom ersten bis zum letzten
  let x0 = Infinity;
  let x1 = -Infinity;
  let lines = null;
  for (const m of svgText.matchAll(STAFF_RE)) {
    const ls = [...m[1].matchAll(new RegExp(LINE_RE.source, 'g'))].map((p) => ({ x0: Number(p[1]), y: Number(p[2]), x1: Number(p[3]), y1: Number(p[4]), t: Number(p[5] || 0) }));
    if (ls.length < 5 || !ls.every((l) => l.y === l.y1)) continue;
    if (!lines) lines = ls;
    // nur Takte derselben Zeile (gleiche Lage der obersten Linie)
    if (Math.abs(ls[0].y - lines[0].y) > 2) continue;
    x0 = Math.min(x0, ls[0].x0);
    x1 = Math.max(x1, ls[0].x1);
  }
  if (!lines) return null;
  const space = (lines[4].y - lines[0].y) / 4;
  return {
    viewW: Number(vb[1]),
    viewH: Number(vb[2]),
    pxW: outer ? Number(outer[1]) : Number(vb[1]) / 10,
    pxH: outer ? Number(outer[2]) : Number(vb[2]) / 10,
    x0,
    x1,
    top: lines[0].y,
    bottom: lines[4].y,
    space,
    thickness: lines[0].t,
    lines: lines.map((l) => l.y),
  };
}

const BASE_OPTIONS = {
  scale: 100,
  pageWidth: 60000,
  pageHeight: 60000,
  adjustPageHeight: true,
  adjustPageWidth: true,
  breaks: 'none',
  pageMarginLeft: 0,
  pageMarginRight: 0,
  pageMarginTop: 0,
  pageMarginBottom: 0,
  footer: 'none',
  header: 'none',
  spacingStaff: 0,
};

function renderOnce(tk, xml, spacingLinear, spacingNonLinear, extra = {}) {
  tk.setOptions({ ...BASE_OPTIONS, ...extra, spacingLinear, spacingNonLinear });
  if (!tk.loadData(xml)) throw new Error('Verovio konnte die Zeile nicht lesen');
  const svg = tk.renderToSVG(1);
  const g = svgGeometry(svg);
  if (!g) throw new Error('Notenzeile im Verovio-Ergebnis nicht gefunden');
  return { svg, g };
}

// Eine Zeile auf die Breite und die Taktstriche des Scans bringen: Verovio setzt die Zeile natürlich, danach
// werden nur die Positionen gedehnt (stretch.js). barSpaces: Taktstriche des Scans in Zeilenabständen ab
// Zeilenanfang (aufsteigend, letzter = Zeilenende). Passen die Anzahlen, liegt jeder Taktstrich genau auf dem
// des Scans; sonst wird gleichmäßig auf widthSpaces gedehnt.
// Rückgabe: { svg, g, factor, natural, mode }
export function engraveSystem(tk, systemXml, { widthSpaces, barSpaces = null, extra = {} }) {
  const r = renderOnce(tk, systemXml, 0.25, 0.6, extra);
  const target = widthSpaces * 180;
  const anchor = contentStart(r.svg);
  const natural = r.g.x1 - r.g.x0;
  let mode = 'gleichmäßig';
  let svg;
  const engravedBars = svgBarlines(r.svg).filter((x) => x > r.g.x0 + 90);
  if (barSpaces && barSpaces.length && barSpaces.length === engravedBars.length) {
    const pairs = [[r.g.x0, r.g.x0]];
    engravedBars.forEach((x, i) => pairs.push([x, r.g.x0 + barSpaces[i] * 180]));
    // der Anker (Ende von Schlüssel/Vorzeichen/Taktart) bleibt stehen
    const fx = piecewise([[r.g.x0, r.g.x0], [Math.min(anchor, engravedBars[0] - 90), Math.min(anchor, engravedBars[0] - 90)], ...pairs.slice(1)]);
    svg = warpSvg(r.svg, fx);
    mode = 'taktgenau';
  } else {
    let factor = (target - anchor) / (r.g.x1 - anchor);
    // eine sehr enge Vorlage nicht zusammenstauchen (Zeichen würden sich berühren)
    if (!Number.isFinite(factor)) factor = 1;
    factor = Math.max(0.8, factor);
    svg = Math.abs(factor - 1) < 0.005 ? r.svg : stretchSvg(r.svg, { anchor, factor });
  }
  const g = svgGeometry(svg) || r.g;
  return { svg, g, natural: natural / 180, mode, widthError: Math.abs(g.x1 - g.x0 - target) / 180 };
}

// SVG-Text auf Pixelmaße des Scans bringen: pxPerUnit = space_px / 180
export function scaleSvg(svgText, g, pxPerUnit) {
  const w = (g.viewW * pxPerUnit).toFixed(2);
  const h = (g.viewH * pxPerUnit).toFixed(2);
  return svgText.replace(/<svg width="[\d.]+px" height="[\d.]+px"/, `<svg width="${w}px" height="${h}px"`);
}
