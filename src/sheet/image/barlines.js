// Taktstriche einer Notenzeile im Scan: senkrechte Striche genau von der obersten bis zur untersten Linie.
import { binarize } from './raster.js';

// Rückgabe: x-Positionen (Pixel, Mitte), aufsteigend; Doppelstriche/Schlusstriche werden zu einer Position
export function detectBarlines(img, staff) {
  const b = img.bin ? img : binarize(img);
  const { width: w, height: h, bin } = b;
  const sp = staff.space;
  const top = Math.round(staff.top);
  const bottom = Math.round(staff.bottom);
  const span = bottom - top + 1;
  const above = Math.max(1, Math.round(sp * 0.6));
  const x0 = Math.max(0, Math.floor(staff.x0 - 2));
  const x1 = Math.min(w - 1, Math.ceil(staff.x1 + 2));
  const cand = [];
  // Taktartziffern („4“ über „4“) bilden eine durchgehende senkrechte Spalte: im Zeilenkopf (Schlüssel, Vorzeichen,
  // Taktart) gibt es keine Taktstriche
  const headerEnd = staff.x0 + sp * 7;
  for (let x = Math.max(x0, Math.ceil(headerEnd)); x <= x1; x++) {
    let ink = 0;
    for (let y = top; y <= bottom; y++) if (bin[y * w + x]) ink++;
    if (ink < span * 0.96) continue;
    // endet der Strich ungefähr an den Linien? (Hälse laufen weiter nach oben/unten)
    let beyond = 0;
    for (let k = 1; k <= above; k++) {
      if (top - k >= 0 && bin[(top - k) * w + x]) beyond++;
      if (bottom + k < h && bin[(bottom + k) * w + x]) beyond++;
    }
    if (beyond > Math.max(2, Math.round(above * 0.5))) continue;
    cand.push(x);
  }
  // Hälse, die genau an den Linien enden, tragen einen Notenkopf oder Balken daneben: in den Zwischenräumen
  // neben einem Taktstrich (0,25–0,75 Linienabstände) ist keine „massive“ Tinte (Pixel mit voller 3×3-Umgebung;
  // dünne Bögen, Wiederholungspunkte und Buchstaben zählen nicht). Partnerstriche (Doppel-/Schlussstrich) zählen nicht.
  const candSet = new Set(cand);
  const lineRows = new Uint8Array(h);
  const half = Math.ceil((staff.thickness || 1) / 2) + 1;
  for (const ly of staff.lines || []) for (let y = Math.max(0, Math.floor(ly - half)); y <= Math.min(h - 1, Math.ceil(ly + half)); y++) lineRows[y] = 1;
  const n0 = Math.max(1, Math.round(sp * 0.25));
  const n1 = Math.max(n0 + 1, Math.round(sp * 0.75));
  const limit = 0.05 * sp * sp;
  // „massiv“: ein Quadrat von etwa einem Drittel Linienabstand ist ganz Tinte (Notenkopf, Balken – kein dünner Bogen)
  const k = Math.max(3, Math.round(sp * 0.33));
  const lo = Math.floor((k - 1) / 2);
  const hi = Math.ceil((k - 1) / 2);
  const solid = (x, y) => {
    if (x < lo || y < lo || x >= w - hi || y >= h - hi) return false;
    for (let dy = -lo; dy <= hi; dy++) for (let dx = -lo; dx <= hi; dx++) if (!bin[(y + dy) * w + x + dx]) return false;
    return true;
  };
  const hits = cand.filter((x) => {
    let ink = 0;
    for (let y = top; y <= bottom; y++) {
      if (lineRows[y]) continue;
      for (let d = n0; d <= n1; d++) {
        if (!candSet.has(x - d) && solid(x - d, y)) ink++;
        if (!candSet.has(x + d) && solid(x + d, y)) ink++;
      }
    }
    return ink <= limit;
  });
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
