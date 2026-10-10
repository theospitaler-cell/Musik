// Seitenformate für Druck/PDF/Bild-Export (MusicXML-Tenths & Verovio).
export const PAPERS = {
  A4: { wMm: 210, hMm: 297, name: 'A4 Hochformat' },
  Letter: { wMm: 215.9, hMm: 279.4, name: 'US-Letter Hochformat' },
};

// staffMm: Höhe eines Fünfliniensystems in mm (7.0 = Stimmen, ~5.6 = Partitur)
export function pageLayout(paper = 'A4', staffMm = 7.0) {
  const p = PAPERS[paper] || PAPERS.A4;
  const tpm = 40 / staffMm; // tenths pro mm
  return {
    paper,
    staffMm,
    width: p.wMm * tpm,
    height: p.hMm * tpm,
    left: Math.round(15 * tpm),
    right: Math.round(15 * tpm),
    top: Math.round(18 * tpm),
    bottom: Math.round(15 * tpm),
    wMm: p.wMm,
    hMm: p.hMm,
  };
}

// Verovio-Optionen. Interne Einheit = 1/10 mm bei Notengröße 100 %.
// zoom < 1 verkleinert die Noten auf der Seite (Partitur), scale bestimmt nur
// die Pixelgröße der SVG-Ausgabe (100 = 1 px pro 1/10 mm).
export function verovioOptions(paper = 'A4', { scale = 100, part = true, zoom = null } = {}) {
  const p = PAPERS[paper] || PAPERS.A4;
  const z = zoom ?? (part ? 1 : 0.78);
  return {
    pageWidth: Math.round((p.wMm * 10) / z),
    pageHeight: Math.round((p.hMm * 10) / z),
    pageMarginLeft: 120,
    pageMarginRight: 120,
    pageMarginTop: 100,
    pageMarginBottom: 100,
    scale,
    adjustPageHeight: false,
    breaks: 'line',
    footer: 'none',
    header: 'auto',
    spacingSystem: part ? 12 : 16,
    spacingStaff: part ? 8 : 6,
    mnumInterval: 0,
    multiRestStyle: 'block', // klassischer H-Balken mit Zahl darüber
    multiRestThickness: 2.4,
  };
}
