// Notenblatt-Editor im Browser: Bilder laden, Seiten umschreiben („Original-Seite behalten“), rastern, PDF.
import { toGray, grayToRgba } from '../sheet/image/raster.js';
import { preparePage, analyzePage, planSystems, rewritePage, findPageChords } from '../sheet/image/page.js';
import { chordShiftBetween } from '../sheet/chordshift.js';
import { svgGeometry, scaleSvg } from '../sheet/image/engrave.js';
import { loadVerovio } from './render.js';

const MAX_SIDE = 3600; // größere Fotos werden verkleinert (Speicher/Zeit); Notenlinien bleiben gut erkennbar

// Datei/Blob -> { width, height, data(RGBA) }
export async function decodeImage(blob, { maxSide = MAX_SIDE } = {}) {
  const bmp = await createImageBitmap(blob);
  const f = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * f);
  const h = Math.round(bmp.height * f);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const id = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: id.data };
}

export function grayToCanvas(img) {
  const rgba = grayToRgba(img);
  const c = document.createElement('canvas');
  c.width = rgba.width;
  c.height = rgba.height;
  c.getContext('2d').putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
  return c;
}

export const canvasToBlob = (c, type = 'image/png', q = 0.92) => new Promise((r) => c.toBlob(r, type, q));

// Verovio-SVG (schon auf die Pixelmaße des Scans skaliert) -> Graustufen-Band, weiß = 255
export async function rasterizeSvg(svg, { scale, dx, dy, width, height }) {
  const g = svgGeometry(svg);
  const scaled = g ? scaleSvg(svg, g, scale) : svg;
  const blob = new Blob([scaled], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Notenzeile konnte nicht gezeichnet werden'));
      im.src = url;
    });
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, dx, dy);
    const d = ctx.getImageData(0, 0, width, height).data;
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = d[p];
    return { width, height, gray };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Eigene Verovio-Instanz (der Notensatz-Tab benutzt eine andere und ändert deren Optionen)
let ownToolkit = null;
export async function sheetToolkit() {
  if (ownToolkit) return ownToolkit;
  await loadVerovio();
  ownToolkit = new window.verovio.toolkit();
  return ownToolkit;
}

export { preparePage, analyzePage, planSystems, rewritePage, toGray };

// Akkordsymbole zeichnen: serifenlose Schrift, Höhe der Großbuchstaben = capH (Pixel). Vorzeichen (♯/♭) klein und
// hochgestellt wie in Leadsheets. Rückgabe: { width, height, gray } – Unterkante des Bildes = Grundlinie, weiß = 255.
const FONT = 'Arial, Helvetica, "Segoe UI", "Liberation Sans", "DejaVu Sans", sans-serif';
export function chordDrawer() {
  return (text, { capH, bold = false }) => {
    const weight = bold ? 'bold ' : '';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `${weight}100px ${FONT}`;
    const ratio = (probe.measureText('H').actualBoundingBoxAscent || 72) / 100;
    const size = Math.max(6, capH / ratio);
    const accSize = size * 0.68;
    const letter = text[0];
    const acc = text.slice(1).replace(/#/g, '♯').replace(/b/g, '♭');
    const pad = 4;
    probe.font = `${weight}${size}px ${FONT}`;
    const wLetter = probe.measureText(letter).width;
    probe.font = `${weight}${accSize}px ${FONT}`;
    const wAcc = acc ? probe.measureText(acc).width : 0;
    const W = Math.ceil(wLetter + wAcc + pad * 2 + 2);
    const base = pad + Math.ceil(size);
    const H = base + pad;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${weight}${size}px ${FONT}`;
    ctx.fillText(letter, pad, base);
    if (acc) {
      ctx.font = `${weight}${accSize}px ${FONT}`;
      ctx.fillText(acc, pad + wLetter + size * 0.02, base - capH * 0.42);
    }
    const d = ctx.getImageData(0, 0, W, H).data;
    let x0 = W;
    let x1 = -1;
    let y0 = H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4] < 200) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
        }
      }
    }
    if (x1 < 0) return { width: 1, height: 1, gray: new Uint8Array([255]) };
    const yb = base - 1; // letzte Zeile über der Grundlinie
    const w = x1 - x0 + 1;
    const h = yb - y0 + 1;
    const gray = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = d[((y0 + y) * W + x0 + x) * 4];
    return { width: w, height: h, gray };
  };
}

// Erkannte Akkordsymbole einer vorbereiteten Seite (einmal ermitteln, dann merken)
export function pageChords(prepared) {
  if (!prepared.chords) prepared.chords = findPageChords(prepared.page, prepared.staves);
  return prepared.chords;
}

// Eine vorbereitete Seite ({ page(gray), staves }) mit neuem MusicXML umschreiben -> Graustufenbild
// base: Ausgangsstand der Seite (MusicXML) – daraus ergibt sich, um wie viel die Akkordsymbole mitwandern
// chords: false = Akkordsymbole im Bild unverändert lassen
export async function renderScanPage(prepared, xml, { counts = null, onWarn = null, base = null, chords = true } = {}) {
  const tk = await sheetToolkit();
  const copy = { width: prepared.page.width, height: prepared.page.height, gray: Uint8Array.from(prepared.page.gray) };
  const plan = counts ? { counts } : planSystems(xml, prepared.staves);
  if (plan.notes?.length && onWarn) plan.notes.forEach(onWarn);
  let chordOpt = null;
  if (chords && base) {
    const shift = chordShiftBetween(base, xml);
    if (shift) chordOpt = { symbols: pageChords(prepared), shift, drawText: chordDrawer() };
  }
  const r = await rewritePage(copy, prepared.staves, xml, { toolkit: tk, rasterize: rasterizeSvg, counts: plan.counts, chords: chordOpt });
  r.warnings.forEach((w) => onWarn?.(w));
  return copy;
}
