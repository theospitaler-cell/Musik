// „Original-Seite behalten“: im Notensystem wird nur Musik ersetzt – Titel, Texte, Akkordsymbole, Dynamik
// und alles außerhalb der Notenzeile bleiben Pixel für Pixel erhalten.
// Musik-Symbole werden als verbundene Tintenflächen erkannt (nach Entfernen der Notenlinien):
//  a) berührt die Fläche den Bereich der fünf Linien,
//  b) trägt sie Hilfslinien (kurze waagrechte Striche im Linienraster ober-/unterhalb),
//  c) ist sie ein Bogen (breit, flach, dünn) nahe der Zeile.
// Alles andere (Buchstaben, Ziffern, Überschriften) ist Text und bleibt.

// Verbundene Flächen (8er-Nachbarschaft) in einem Ausschnitt; mask: Uint8Array (1 = Tinte)
export function labelComponents(mask, w, h) {
  const label = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = comps.length + 1;
    const c = { id, x0: start % w, x1: start % w, y0: (start / w) | 0, y1: (start / w) | 0, n: 0, pixels: [] };
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p / w) | 0;
      c.n++;
      c.pixels.push(p);
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          const q = yy * w + xx;
          if (mask[q] && !label[q]) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    comps.push(c);
  }
  return { label, comps };
}

// Notenlinien aus der Tintenmaske entfernen, außer wo ein Symbol sie senkrecht durchkreuzt
export function removeStaffLines(ink, w, h, staff, ox, oy) {
  // ink: Maske des Ausschnitts (Ursprung ox, oy im Seitenbild)
  const out = Uint8Array.from(ink);
  const t = Math.max(1, Math.round(staff.thickness));
  const reach = Math.max(1, Math.ceil(t * 0.5) + 1);
  for (const ly of staff.lines) {
    const cy = Math.round(ly) - oy;
    for (let x = 0; x < w; x++) {
      // Länge der senkrechten Tintenstrecke durch die Linie in dieser Spalte
      let a = cy;
      let b = cy;
      while (a - 1 >= 0 && ink[(a - 1) * w + x]) a--;
      while (b + 1 < h && ink[(b + 1) * w + x]) b++;
      const run = b - a + 1;
      if (run <= t + 2) {
        for (let y = Math.max(0, cy - reach); y <= Math.min(h - 1, cy + reach); y++) out[y * w + x] = 0;
      } else {
        // Symbol kreuzt die Linie: nur Linienpixel außerhalb der Strecke entfernen – die Strecke bleibt
        for (let y = Math.max(0, cy - reach); y <= Math.min(h - 1, cy + reach); y++) {
          if (y < a || y > b) out[y * w + x] = 0;
        }
      }
    }
  }
  return out;
}

// Hilfslinie: waagrechter Strich ≈ 1,2–2,6 Zeilenabstände lang auf Hilfslinien-Höhe
function hasLedger(c, mask, w, staff, ox, oy) {
  const sp = staff.space;
  // Buchstaben (e, A, t …) haben Querstriche bis ≈ 1,3 Zeilenabstände – Hilfslinien sind länger
  const runMin = sp * 1.5;
  const runMax = sp * 3.2;
  const lineT = Math.max(1, Math.round(staff.thickness || 1));
  for (let y = c.y0; y <= c.y1; y++) {
    const yy = y + oy;
    // Höhe im Linienraster (k·space ober-/unterhalb der Linien)?
    const above = (staff.top - yy) / sp;
    const below = (yy - staff.bottom) / sp;
    const k = above > 0.7 ? above : below > 0.7 ? below : null;
    if (k === null || Math.abs(k - Math.round(k)) > 0.18) continue;
    let run = 0;
    let runStart = 0;
    for (let x = c.x0; x <= c.x1 + 1; x++) {
      const on = x <= c.x1 && mask[y * w + x] === 1;
      if (on) {
        if (!run) runStart = x;
        run++;
      } else {
        if (run >= runMin && run <= runMax && thinShare(mask, w, y, runStart, runStart + run - 1, lineT) >= 0.3) return true;
        run = 0;
      }
    }
  }
  return false;
}

// Anteil der Spalten eines waagrechten Strichs, durch die nur eine dünne Tintenstrecke (Linienstärke) führt: bei
// Hilfslinien außerhalb des Notenkopfs und der Hälse fast überall, in fetten Wörtern kaum (Buchstabenkörper)
function thinShare(mask, w, y, xa, xb, lineT) {
  const h = mask.length / w;
  let thin = 0;
  for (let x = xa; x <= xb; x++) {
    let a = y;
    let b = y;
    while (a - 1 >= 0 && mask[(a - 1) * w + x]) a--;
    while (b + 1 < h && mask[(b + 1) * w + x]) b++;
    if (b - a + 1 <= lineT + 3) thin++;
  }
  return thin / Math.max(1, xb - xa + 1);
}

// Entscheidet je Fläche, ob sie Musik ist (siehe Kopfkommentar). Buchstaben stehen in Zeilen aus mehreren
// gleich hohen Flächen („Textzeile“); Noten, Hilfslinien und Zeichen an Noten stehen für sich.
export function classifier(comps, mask, w, staff, ox, oy, top, bottom) {
  const sp = staff.space;
  const big = comps.filter((c) => c.n >= 2);
  const music = new Set();
  // a) liegt auf den Linien (Köpfe mit Hals, Schlüssel, Pausen, Taktstriche, Balken …)
  for (const c of big) if (Math.min(c.y1, bottom) - Math.max(c.y0, top) >= sp * 0.35) music.add(c);
  // Textzeile: andere Flächen (keine Musik) auf gemeinsamer Grundlinie in kurzem Abstand
  const sameRow = (c, o) =>
    o !== c && !(o.x0 > c.x1 + sp * 2.5 || o.x1 < c.x0 - sp * 2.5) && (Math.abs(o.y1 - c.y1) <= sp * 0.6 || Math.abs(o.y0 - c.y0) <= sp * 0.6);
  const ledgerCands = new Set(big.filter((c) => !music.has(c) && hasLedger(c, mask, w, staff, ox, oy)));
  const rowMates = (c) => big.filter((o) => !music.has(o) && !ledgerCands.has(o) && sameRow(c, o)).length;
  // b) Hilfslinien – verwachsene Buchstaben (Querstriche von e, A, 04 …) haben Nachbarn in ihrer Zeile
  for (const c of ledgerCands) if (rowMates(c) === 0) music.add(c);
  // c) Bögen und Haltebögen nahe der Zeile
  for (const c of big) {
    if (music.has(c)) continue;
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    const near = c.y1 >= top - sp * 3.2 && c.y0 <= bottom + sp * 3.2;
    if (near && cw >= sp * 2.2 && ch <= sp * 1.7 && c.n <= cw * (staff.thickness + 3) && rowMates(c) === 0) music.add(c);
  }
  // Stützen für Artikulationen: Notenköpfe/-hälse, nicht Schlüssel/Vorzeichen/Taktart am Zeilenanfang
  const headerEnd = staff.x0 - ox + sp * 7.5;
  const notes = [...music].filter((c) => c.x0 > headerEnd);
  return (c) => {
    if (music.has(c)) return true;
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    const lonely = rowMates(c) === 0;
    // d) einzelner Notenkopf (ganze Note) neben der Zeile
    const adjacent = c.y1 >= top - sp * 1.4 && c.y0 <= bottom + sp * 1.4;
    if (lonely && adjacent && cw >= sp * 0.95 && cw <= sp * 1.8 && ch >= sp * 0.8 && ch <= sp * 1.35 && c.n / (cw * ch) >= 0.5) return true;
    // e) Artikulation/Atemzeichen/Fermate über oder unter einer Note: klein, allein, nahe der Zeile
    const close = c.y1 >= top - sp * 2.6 && c.y0 <= bottom + sp * 2.6;
    if (lonely && close && cw <= sp * 2.3 && ch <= sp * 1.45) {
      const above = notes.some((o) => o.x1 >= c.x0 - sp * 1.6 && o.x0 <= c.x1 + sp * 1.6);
      const dot = cw <= sp * 0.7 && ch <= sp * 0.7;
      const dash = ch <= sp * 0.45 && cw >= sp * 0.7;
      if (above && (dot || dash || c.n / (cw * ch) < 0.55 || ch >= sp * 0.7)) return true;
    }
    // f) Versetzungszeichen direkt vor einer Note, das über/unter die Zeile ragt (b vor einer Note auf der
    //    obersten Linie): hoch und schmal, allein, unmittelbar links von einem Notenkopf mit Hals
    const near = c.y1 >= top - sp * 3.2 && c.y0 <= bottom + sp * 3.2;
    if (lonely && near && ch >= sp * 1.7 && ch <= sp * 3.4 && cw <= sp * 1.25 && cw >= sp * 0.3) {
      const cyc = (c.y0 + c.y1) / 2;
      if (notes.some((o) => o.x0 - c.x1 >= -sp * 0.15 && o.x0 - c.x1 <= sp * 1.3 && Math.abs((o.y0 + o.y1) / 2 - cyc) <= sp * 2.6)) return true;
    }
    return false;
  };
}

// Seitenbild (Graustufen, weiß = 255) + Notenzeile -> Löschmaske (Seitenkoordinaten) und Bereich.
// Rückgabe: { erase: { x0, y0, w, h, mask }, stats }
export function musicMask(page, staff, opts = {}) {
  const { width: W, height: H, gray } = page;
  const sp = staff.space;
  const margin = Math.ceil(sp * (opts.margin ?? 5));
  const x0 = Math.max(0, Math.floor(staff.x0 - sp * 0.6));
  const x1 = Math.min(W - 1, Math.ceil(staff.x1 + sp * 0.6));
  const y0 = Math.max(0, Math.floor(staff.top - margin));
  const y1 = Math.min(H - 1, Math.ceil(staff.bottom + margin));
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const thr = opts.threshold ?? 170;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ink[y * w + x] = gray[(y + y0) * W + x + x0] < thr ? 1 : 0;
  const noLines = removeStaffLines(ink, w, h, staff, x0, y0);
  const { comps } = labelComponents(noLines, w, h);
  const erase = new Uint8Array(w * h);
  const top = staff.top - y0;
  const bottom = staff.bottom - y0;
  const stats = { components: comps.length, music: 0, text: 0 };
  const isMusic = classifier(comps, noLines, w, staff, x0, y0, top, bottom);
  for (const c of comps) {
    if (c.n < 2) {
      // Staub: nur im Linienbereich mit löschen
      if (c.y1 >= top - 1 && c.y0 <= bottom + 1) for (const p of c.pixels) erase[p] = 1;
      continue;
    }
    if (isMusic(c)) {
      stats.music++;
      for (const p of c.pixels) erase[p] = 1;
    } else stats.text++;
  }
  // Linien selbst (in der Ausdehnung der Zeile) werden neu gezeichnet: ebenfalls löschen
  const t = Math.max(1, Math.round(staff.thickness));
  for (const ly of staff.lines) {
    const cy = Math.round(ly) - y0;
    for (let y = Math.max(0, cy - t - 1); y <= Math.min(h - 1, cy + t + 1); y++) {
      for (let x = Math.max(0, Math.round(staff.x0 - x0) - 1); x <= Math.min(w - 1, Math.round(staff.x1 - x0) + 1); x++) erase[y * w + x] = 1;
    }
  }
  // Rand um gelöschte Flächen (Antialiasing) mitnehmen
  const grown = new Uint8Array(erase);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!erase[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) grown[yy * w + xx] = 1;
        }
      }
    }
  }
  // Text, der im gelöschten Rand liegt, nicht anrühren: nur Pixel löschen, die nicht zu Textflächen gehören
  for (const c of comps) {
    if (c.n < 2 || isMusic(c)) continue;
    for (const p of c.pixels) if (!erase[p]) grown[p] = 0;
  }
  return { x0, y0, w, h, mask: grown, stats };
}

// Löschmaske auf das Seitenbild anwenden (weiß machen)
export function applyErase(page, m) {
  const { width: W, gray } = page;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.mask[y * m.w + x]) gray[(y + m.y0) * W + x + m.x0] = 255;
}

// Gestochene Notenzeile (Graustufen-Abdeckung 0–255, weiß = 255) auf die Seite legen: dunkelster Wert gewinnt
export function overlay(page, band, ox, oy) {
  const { width: W, height: H, gray } = page;
  for (let y = 0; y < band.height; y++) {
    const py = y + oy;
    if (py < 0 || py >= H) continue;
    for (let x = 0; x < band.width; x++) {
      const px = x + ox;
      if (px < 0 || px >= W) continue;
      const v = band.gray[y * band.width + x];
      if (v < gray[py * W + px]) gray[py * W + px] = v;
    }
  }
}
