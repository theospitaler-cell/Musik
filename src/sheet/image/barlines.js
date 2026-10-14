// Taktstriche einer Notenzeile im Scan: senkrechte Striche genau von der obersten bis zur untersten Linie.
import { binarize } from './raster.js';

// Rückgabe: x-Positionen (Pixel, Mitte), aufsteigend; Doppelstriche/Schlusstriche werden zu einer Position
export function detectBarlines(img, staff) {
  const b = img.bin ? img : binarize(img);
  const { width: w, bin } = b;
  const sp = staff.space;
  const top = Math.round(staff.top);
  const bottom = Math.round(staff.bottom);
  const span = bottom - top + 1;
  const above = Math.max(1, Math.round(sp * 0.6));
  const x0 = Math.max(0, Math.floor(staff.x0 - 2));
  const x1 = Math.min(w - 1, Math.ceil(staff.x1 + 2));
  const hits = [];
  for (let x = x0; x <= x1; x++) {
    let ink = 0;
    for (let y = top; y <= bottom; y++) if (bin[y * w + x]) ink++;
    if (ink < span * 0.96) continue;
    // endet der Strich ungefähr an den Linien? (Hälse laufen weiter nach oben/unten)
    let beyond = 0;
    for (let k = 1; k <= above; k++) {
      if (top - k >= 0 && bin[(top - k) * w + x]) beyond++;
      if (bottom + k < bin.length / w && bin[(bottom + k) * w + x]) beyond++;
    }
    if (beyond > Math.max(2, Math.round(above * 0.5))) continue;
    hits.push(x);
  }
  // Spalten zu Strichen gruppieren; Doppelstrich (Abstand < 1 sp) = ein Taktstrich
  const lines = [];
  for (const x of hits) {
    const last = lines[lines.length - 1];
    if (last && x - last.x1 <= Math.max(2, sp * 1.1)) {
      last.x1 = x;
    } else lines.push({ x0: x, x1: x });
  }
  return lines.map((l) => (l.x0 + l.x1) / 2);
}
