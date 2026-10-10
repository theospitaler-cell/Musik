// Notendarstellung im Browser (Verovio) + Export als PDF und PNG-Bilder.
import { verovioOptions, PAPERS } from '../output/layout.js';

// Mitgeliefert (offline-fähig), mit CDN als Rückfall
const VEROVIO_URLS = ['vendor/verovio-toolkit-wasm.js', 'https://cdn.jsdelivr.net/npm/verovio@4.5.1/dist/verovio-toolkit-wasm.js'];
const JSPDF_URLS = ['vendor/jspdf.umd.min.js', 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'];

let tkPromise = null;
let jspdfPromise = null;

async function loadFirst(urls) {
  let err;
  for (const u of urls) {
    try {
      return await loadScript(u);
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Konnte nicht geladen werden: ' + src));
    document.head.appendChild(s);
  });
}

export function loadVerovio() {
  if (!tkPromise) {
    tkPromise = loadFirst(VEROVIO_URLS).then(
      () =>
        new Promise((resolve) => {
          const mod = window.verovio.module;
          const done = () => resolve(new window.verovio.toolkit());
          if (mod.calledRun) done();
          else mod.onRuntimeInitialized = done;
        }),
    );
  }
  return tkPromise;
}

async function loadJsPdf() {
  if (!jspdfPromise) jspdfPromise = loadFirst(JSPDF_URLS).then(() => window.jspdf.jsPDF);
  return jspdfPromise;
}

// MusicXML -> SVG-Seiten. Der Umweg über MEI übernimmt Titel/Komponist/
// Stimmenname aus den MusicXML-Credits in den Seitenkopf.
// onProgress(text, anteil 0..1) – zwischen den Seiten wird kurz an den Browser abgegeben,
// damit die Fortschrittsanzeige sichtbar weiterläuft.
const tick = () => new Promise((r) => setTimeout(r, 0));
export async function renderPages(xml, { paper = 'A4', part = true, zoom = 1, scale = 100, onProgress = null } = {}) {
  onProgress?.('Notensatz wird geladen', 0.02);
  const tk = await loadVerovio();
  const opts = verovioOptions(paper, { scale, part, zoom: (part ? 1 : 0.78) * zoom });
  tk.setOptions(opts);
  onProgress?.('Noten werden gesetzt', 0.08);
  await tick();
  tk.loadData(xml);
  tk.loadData(tk.getMEI({}));
  const n = tk.getPageCount();
  const pages = [];
  for (let p = 1; p <= n; p++) {
    onProgress?.(`Seite ${p} von ${n} wird gezeichnet`, 0.15 + (0.85 * (p - 1)) / n);
    await tick();
    pages.push(tk.renderToSVG(p));
  }
  onProgress?.('Fertig', 1);
  return pages;
}

// SVG für responsive Anzeige vorbereiten
export function responsiveSvg(svgText) {
  const wrap = document.createElement('div');
  wrap.innerHTML = svgText;
  const svg = wrap.querySelector('svg');
  const w = parseFloat(svg.getAttribute('width'));
  const h = parseFloat(svg.getAttribute('height'));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', '100%');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
  return svg;
}

async function svgToCanvas(svgText, widthPx) {
  const wrap = document.createElement('div');
  wrap.innerHTML = svgText;
  const svg = wrap.querySelector('svg');
  const w = parseFloat(svg.getAttribute('width'));
  const h = parseFloat(svg.getAttribute('height'));
  const scale = widthPx / w;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(Math.round(w * scale)));
  svg.setAttribute('height', String(Math.round(h * scale)));
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// PNG-Bilder (eine Datei pro Seite), ~250 dpi
export async function pagesToPngs(xml, { paper = 'A4', part = true, zoom = 1, onProgress = null } = {}) {
  const pages = await renderPages(xml, { paper, part, zoom, scale: 100, onProgress: (t, f) => onProgress?.(t, f * 0.5) });
  const widthPx = Math.round((PAPERS[paper] || PAPERS.A4).wMm * 9.84); // ≈ 250 dpi
  const out = [];
  for (const [i, svg] of pages.entries()) {
    onProgress?.(`Bild ${i + 1} von ${pages.length}`, 0.5 + (0.5 * i) / pages.length);
    const c = await svgToCanvas(svg, widthPx);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    out.push(new Uint8Array(await blob.arrayBuffer()));
  }
  return out;
}

// PDF (mehrere Notensätze nacheinander, z. B. alle Stimmen in einer Datei)
export async function xmlsToPdf(xmlList, { paper = 'A4', zoom = 1, title = 'NoteCode', onProgress = null } = {}) {
  const JsPDF = await loadJsPdf();
  const P = PAPERS[paper] || PAPERS.A4;
  const pdf = new JsPDF({ unit: 'mm', format: paper === 'Letter' ? 'letter' : 'a4', orientation: 'portrait', compress: true });
  pdf.setProperties({ title, creator: 'NoteCode' });
  let first = true;
  for (const [k, { xml, part, name }] of xmlList.entries()) {
    const base = k / xmlList.length;
    const span = 1 / xmlList.length;
    const label = name ? `${name}: ` : xmlList.length > 1 ? `Teil ${k + 1}/${xmlList.length}: ` : '';
    const pages = await renderPages(xml, { paper, part, zoom, scale: 100, onProgress: (t, f) => onProgress?.(label + t, base + span * f * 0.6) });
    for (const [i, svg] of pages.entries()) {
      onProgress?.(`${label}PDF-Seite ${i + 1} von ${pages.length}`, base + span * (0.6 + (0.4 * i) / pages.length));
      await tick();
      const c = await svgToCanvas(svg, Math.round(P.wMm * 9.84));
      if (!first) pdf.addPage();
      first = false;
      pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, P.wMm, P.hMm, undefined, 'FAST');
    }
  }
  return new Uint8Array(pdf.output('arraybuffer'));
}
