// Akkordsymbole im Bild finden und beim Transponieren mitändern („Original-Seite behalten“).
// Gelesen werden nur Grundton (A–G), Vorzeichen (♯/♭) und ein Bass nach dem Schrägstrich – der Rest des
// Symbols (m7, maj7, sus4 …) bleibt als Bild erhalten und wird nur verschoben. Rehearsal-Marks im Kästchen,
// Tempoangaben („Allegretto“) und Text werden nicht angefasst.
import { removeStaffLines, labelComponents, classifier } from './erase.js';
import { transposePitch } from '../transpose.js';

const NAT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// ---- Merkmale einer Fläche (Maske im Kasten der Fläche) ---------------------------------------------
function maskOf(c) {
  const w = c.x1 - c.x0 + 1;
  const h = c.y1 - c.y0 + 1;
  const m = new Uint8Array(w * h);
  for (const p of c.pixels) m[p.y * w + p.x] = 1;
  return { m, w, h };
}

// c.pixels aus labelComponents sind Indizes im Ausschnitt; hier brauchen wir (x, y) im Kasten
function withXY(c, regionW) {
  return { ...c, pixels: c.pixels.map((p) => ({ x: (p % regionW) - c.x0, y: ((p / regionW) | 0) - c.y0 })) };
}

// Löcher (geschlossene Weißflächen) in der Maske, 4er-Nachbarschaft; Rückgabe: Mittelpunkte (0..1)
function holesIn({ m, w, h }) {
  const seen = new Uint8Array(w * h);
  const holes = [];
  const stack = [];
  for (let s = 0; s < m.length; s++) {
    if (m[s] || seen[s]) continue;
    let touches = false;
    let n = 0;
    let sx = 0;
    let sy = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p / w) | 0;
      n++;
      sx += x;
      sy += y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !m[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (!touches && n >= 2) holes.push({ n, cx: sx / n / w, cy: sy / n / h });
  }
  return holes;
}

const rowCover = (m, w, y, x0, x1) => {
  let n = 0;
  for (let x = x0; x <= x1; x++) if (m[y * w + x]) n++;
  return n / Math.max(1, x1 - x0 + 1);
};

// Großbuchstabe A–G (serifenlose Schrift): Löcher, Balken, linke Kante, Öffnung. null = unsicher.
export function classifyLetter(c) {
  const { m, w, h } = maskOf(c);
  if (w < 3 || h < 5) return null;
  const aspect = w / h;
  if (aspect > 1.25 || aspect < 0.42) return null;
  const holes = holesIn({ m, w, h });
  // linke Kante: Anteil der Zeilen, deren erste Tinte nahe am linken Rand liegt
  let leftRows = 0;
  let rows = 0;
  for (let y = Math.round(h * 0.1); y < Math.round(h * 0.9); y++) {
    rows++;
    let first = -1;
    for (let x = 0; x < w; x++) if (m[y * w + x]) {
      first = x;
      break;
    }
    if (first >= 0 && first <= Math.max(1, w * 0.22)) leftRows++;
  }
  const left = rows ? leftRows / rows : 0;
  const band = (a, b) => {
    // größte Zeilenüberdeckung in den Zeilen [a,b) (relativ zur Höhe)
    let best = 0;
    for (let y = Math.max(0, Math.floor(h * a)); y < Math.min(h, Math.ceil(h * b)); y++) best = Math.max(best, rowCover(m, w, y, 0, w - 1));
    return best;
  };
  const top = band(0, 0.2);
  const mid = band(0.4, 0.65);
  const bottom = band(0.82, 1);
  // Breite der Tinte in den obersten 15 % (Spitze von A vs. breite Oberkante von D)
  let tx0 = w;
  let tx1 = -1;
  for (let y = 0; y < Math.max(1, Math.round(h * 0.15)); y++) {
    for (let x = 0; x < w; x++) if (m[y * w + x]) {
      tx0 = Math.min(tx0, x);
      tx1 = Math.max(tx1, x);
    }
  }
  const topWidth = tx1 >= tx0 ? (tx1 - tx0 + 1) / w : 0;
  // Verlauf der linken Kante (Zeilen 15–85 %): D senkrecht (kaum Spreizung), A schräg (große Spreizung)
  let lmin = w;
  let lmax = 0;
  for (let y = Math.round(h * 0.15); y < Math.round(h * 0.85); y++) {
    for (let x = 0; x < w; x++) if (m[y * w + x]) {
      lmin = Math.min(lmin, x);
      lmax = Math.max(lmax, x);
      break;
    }
  }
  const leftSpread = (lmax - lmin) / w;
  if (holes.length >= 2) {
    // „8“: oben schmal und mittig, ohne gerade linke Kante; B: oben links eine Ecke
    const topLeft = tx0 === w ? 1 : tx0 / w;
    return left >= 0.75 && topLeft <= 0.12 ? 'B' : null;
  }
  if (holes.length === 1) {
    if (leftSpread >= 0.28) return 'A';
    if (left >= 0.6) return 'D';
    return topWidth <= 0.5 ? 'A' : null;
  }
  // ohne Loch (das Loch eines kleinen, fetten A ist oft zugelaufen)
  if (leftSpread >= 0.3 && topWidth <= 0.55) return 'A';
  // rechter Rand im unteren Teil (Zeilen 58–80 %): beim G steht dort der senkrechte Steg, beim E ist es offen
  let rf = 0;
  let rfN = 0;
  for (let y = Math.round(h * 0.58); y <= Math.round(h * 0.8); y++) {
    rfN++;
    let hit = 0;
    for (let x = Math.round(w * 0.8); x < w; x++) hit += m[y * w + x];
    if (hit) rf++;
  }
  const rightFill = rfN ? rf / rfN : 0;
  if (left >= 0.8 && top >= 0.6 && mid >= 0.5 && bottom >= 0.6) return rightFill >= 0.6 ? 'G' : 'E';
  if (left >= 0.8 && top >= 0.6 && mid >= 0.45 && bottom < 0.45) return 'F';
  // C oder G: G hat rechts unten einen Steg und in der Mitte rechts einen Querstrich
  let midRight = 0;
  for (let y = Math.round(h * 0.42); y <= Math.round(h * 0.62); y++) midRight = Math.max(midRight, rowCover(m, w, y, Math.round(w * 0.45), w - 1));
  if (midRight >= 0.55 && rightFill >= 0.5) return 'G';
  // Klammern „(“ und „)“ sehen ohne Loch ähnlich aus: das C ist breiter und hat oben und unten einen Bogen
  return mid < 0.5 && aspect >= 0.5 && top >= 0.45 && bottom >= 0.45 ? 'C' : null;
}

// Kreuz oder b hinter dem Grundton (klein, hochgestellt oder auf der Grundlinie)
export function classifyAccidentalGlyph(c) {
  const { m, w, h } = maskOf(c);
  if (w < 2 || h < 4) return null;
  const holes = holesIn({ m, w, h });
  // Kreuz: zwei Löcher oder zwei senkrechte Striche + Querstriche; b: ein Loch im unteren Teil, ein Strich links
  if (holes.length >= 2) return '#';
  let strokes = 0;
  let inStroke = false;
  for (let x = 0; x < w; x++) {
    let run = 0;
    let best = 0;
    for (let y = 0; y < h; y++) {
      if (m[y * w + x]) {
        run++;
        best = Math.max(best, run);
      } else run = 0;
    }
    const on = best >= h * 0.7;
    if (on && !inStroke) strokes++;
    inStroke = on;
  }
  if (strokes >= 2 && holes.length === 0 && w >= h * 0.5) return '#';
  if (holes.length === 1 && holes[0].cy >= 0.5 && w <= h * 0.9) return 'b';
  if (holes.length === 0 && strokes === 1 && w <= h * 0.5) return 'b'; // verwaschen
  return null;
}

// ---- Symbole finden --------------------------------------------------------------------------------
// Rückgabe: [{ x0, x1, y0, y1, capH, root: {letter, box}, acc: {kind, box}|null, suffix: [box…], bass: {letter, box, slash}|null }]
// (Kästen in Seitenkoordinaten)
export function findChordSymbols(page, staff, { threshold = 170, debug = null } = {}) {
  const { width: W, height: H, gray } = page;
  const sp = staff.space;
  const pad = Math.ceil(sp * 11);
  const ox = Math.max(0, Math.floor(staff.x0 - sp * 0.5));
  const oy = Math.max(0, Math.floor(staff.top - pad));
  const x1 = Math.min(W - 1, Math.ceil(staff.x1 + sp));
  const y1 = Math.min(H - 1, Math.ceil(staff.bottom + pad));
  const w = x1 - ox + 1;
  const h = y1 - oy + 1;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ink[y * w + x] = gray[(y + oy) * W + x + ox] < threshold ? 1 : 0;
  const noLines = removeStaffLines(ink, w, h, staff, ox, oy);
  const top = staff.top - oy;
  const bottom = staff.bottom - oy;
  const all = labelComponents(noLines, w, h).comps;
  const isMusic = classifier(all, noLines, w, staff, ox, oy, top, bottom);
  const text = all.filter((c) => c.n >= 3 && !isMusic(c));
  const containsOther = (c) => all.some((o) => o !== c && o.n >= 2 && o.x0 >= c.x0 + 1 && o.x1 <= c.x1 - 1 && o.y0 >= c.y0 + 1 && o.y1 <= c.y1 - 1);
  const boxed = (c) => all.some((o) => o !== c && o.x0 <= c.x0 - 1 && o.x1 >= c.x1 + 1 && o.y0 <= c.y0 - 1 && o.y1 >= c.y1 + 1);
  const heightSp = (c) => (c.y1 - c.y0 + 1) / sp;
  const bandTop = top - sp * 10.8;
  const bandBottom = top - sp * 0.2;
  const inBand = (c) => c.y0 >= bandTop && c.y1 <= bandBottom + sp * 0.4;
  const cand = text.filter(inBand).sort((a, b) => a.x0 - b.x0);
  const loose = text.filter((c) => c.n >= 3 && c.x0 + ox >= staff.x0 + sp * 2.5 && !containsOther(c) && !boxed(c));
  const out = [];
  const used = new Set();
  for (const r of cand) {
    if (used.has(r)) continue;
    const hs = heightSp(r);
    if (hs < 0.7 || hs > 1.9) continue;
    // rechts vom Schlüssel: Taktnummern und Stimmennamen am Zeilenrand sind keine Akkorde
    if (r.x0 + ox < staff.x0 + sp * 2.5) continue;
    if (containsOther(r) || boxed(r)) continue;
    const letter = classifyLetter(withXY(r, w));
    if (!letter) continue;
    const capH = r.y1 - r.y0 + 1;
    // am Wortanfang? Ein Buchstabe direkt links gleicher Zeile macht das hier zum Wortinneren
    const left = cand.find((o) => o !== r && o.x1 < r.x0 && r.x0 - o.x1 <= capH * 0.55 && Math.min(o.y1, r.y1) - Math.max(o.y0, r.y0) >= capH * 0.4);
    if (left) continue;
    // Folgezeichen einsammeln
    const token = [r];
    let right = r.x1;
    for (const o of cand) {
      if (o === r || o.x0 < right - 1) continue;
      if (o.x0 - right > capH * 0.45) break;
      // gleiche Zeile: oberhalb der Grundlinie, nicht tiefer als ein Drittel Höhe darunter
      if (o.y1 > r.y1 + capH * 0.35 || o.y0 < r.y0 - capH * 0.9) continue;
      token.push(o);
      right = Math.max(right, o.x1);
    }
    // Abkürzungen („D.S.“, „D.C.“): kleiner Punkt auf der Grundlinie im Wort
    if (token.some((o) => o !== r && o.n <= 12 && o.x1 - o.x0 + 1 <= capH * 0.3 && o.y1 - o.y0 + 1 <= capH * 0.3 && o.y1 >= r.y1 - capH * 0.2)) continue;
    if (token.length > 6 || right - r.x0 + 1 > capH * 4.8) continue;
    {
      let leftGap = Infinity;
      let rightGap = Infinity;
      for (const o of loose) {
        // gleiche Zeile: irgendeine Überlappung mit der Höhe des Grundtons (auch Oberlängen)
        if (token.includes(o) || Math.min(o.y1, r.y1) - Math.max(o.y0, r.y0) < capH * 0.3) continue;
        if (o.x1 < r.x0) leftGap = Math.min(leftGap, r.x0 - o.x1 - 1);
        else if (o.x0 > right) rightGap = Math.min(rightGap, o.x0 - right - 1);
      }
      if (leftGap < capH * 0.7 || rightGap < capH * 0.7) continue;
    }
    // der Grundton ist das größte Zeichen des Symbols (Kleinbuchstaben in Wörtern haben größere Nachbarn)
    if (token.some((o) => o !== r && o.y1 - o.y0 + 1 > capH * 1.12 && o.y0 < r.y0 - 1)) continue;
    // Striche („–“ in Texten) sind keine Zeichen von Akkordsymbolen
    if (token.some((o) => o !== r && (o.x1 - o.x0 + 1) / Math.max(1, o.y1 - o.y0 + 1) >= 3.2)) continue;
    // Vorzeichen: zweites Zeichen, klein, direkt am Grundton
    const rest = token.slice(1);
    let acc = null;
    let k = 0;
    if (rest.length) {
      const o = rest[0];
      const oh = o.y1 - o.y0 + 1;
      if (o.x0 - r.x1 <= capH * 0.35 && oh <= capH * 1.05 && oh >= capH * 0.35) {
        const kind = classifyAccidentalGlyph(withXY(o, w));
        if (kind) {
          acc = { kind, box: box(o, ox, oy) };
          k = 1;
        }
      }
    }
    // Bass nach Schrägstrich: ein schmaler, hoher, schräger Strich gefolgt von einem Buchstaben A–G
    let bass = null;
    let slashAt = -1;
    for (let i = k; i < rest.length - 0; i++) {
      const o = rest[i];
      const ow = o.x1 - o.x0 + 1;
      const oh = o.y1 - o.y0 + 1;
      if (oh >= capH * 0.9 && ow <= capH * 0.55 && ow >= 2 && i + 1 < rest.length) {
        const nxt = rest[i + 1];
        const l = classifyLetter(withXY(nxt, w));
        const nh = nxt.y1 - nxt.y0 + 1;
        if (l && nh >= capH * 0.8) {
          // Neigung: oben rechts, unten links
          let sx = 0;
          let n = 0;
          for (const p of o.pixels) {
            const y = (p / w) | 0;
            if (y < o.y0 + oh * 0.3) {
              sx += p % w;
              n++;
            }
          }
          let bx = 0;
          let m2 = 0;
          for (const p of o.pixels) {
            const y = (p / w) | 0;
            if (y > o.y1 - oh * 0.3) {
              bx += p % w;
              m2++;
            }
          }
          if (n && m2 && sx / n > bx / m2 + 1) {
            slashAt = i;
            bass = { letter: l, box: box(nxt, ox, oy), slash: box(o, ox, oy), acc: null };
            // Vorzeichen des Basses
            const a = rest[i + 2];
            if (a && a.x0 - nxt.x1 <= capH * 0.35 && a.y1 - a.y0 + 1 <= capH * 1.05) {
              const ak = classifyAccidentalGlyph(withXY(a, w));
              if (ak) bass.acc = { kind: ak, box: box(a, ox, oy) };
            }
          }
        }
      }
      if (slashAt >= 0) break;
    }
    const suffixComps = rest.filter((o, i) => i >= k && (slashAt < 0 || i < slashAt));
    // Suffix mit 4 und mehr Zeichen: ohne Ziffer oder Klammer am Ende ist es ein Wort („Andante“, „Allegretto“)
    if (suffixComps.length >= 4) {
      const last = suffixComps[suffixComps.length - 1];
      const lw = last.x1 - last.x0 + 1;
      const lh = last.y1 - last.y0 + 1;
      const onBase = last.y1 <= r.y1 + capH * 0.12 && last.y0 >= r.y0 - capH * 0.12;
      const digit = onBase && lh >= capH * 0.9 && (lw >= capH * 0.45 || holesIn(maskOf(withXY(last, w))).length >= 1);
      const paren = lh >= capH * 1.0 && last.y1 >= r.y1 + capH * 0.08 && lw <= capH * 0.5;
      if (!digit && !paren) continue;
    }
    token.forEach((o) => used.add(o));
    out.push({
      letter,
      capH,
      box: { x0: r.x0 + ox, x1: right + ox, y0: Math.min(...token.map((o) => o.y0)) + oy, y1: Math.max(...token.map((o) => o.y1)) + oy },
      root: { letter, box: box(r, ox, oy), ink: r.n / (capH * (r.x1 - r.x0 + 1)) },
      acc,
      suffix: suffixComps.map((o) => box(o, ox, oy)),
      bass,
    });
  }
  // Zeilen bilden (gemeinsame Grundlinie, gleiche Schrifthöhe) und Text aussortieren: In einer Akkordzeile
  // gehört fast alles, was auf der Grundlinie steht, zu einem Symbol; in Wörtern („Satz: Max Muster“) sind nur
  // einzelne Anfangsbuchstaben „Symbole“ und der Rest bleibt übrig.
  const rows = [];
  for (const t of out) {
    const base = t.root.box.y1;
    const row = rows.find((q) => Math.abs(q.base - base) <= t.capH * 0.3 && Math.abs(q.capH - t.capH) <= t.capH * 0.2);
    if (row) row.items.push(t);
    else rows.push({ base, capH: t.capH, items: [t] });
  }
  const keep = [];
  for (const row of rows) {
    const base = row.base - oy;
    const inRow = loose.filter((c) => Math.min(c.y1, base) - Math.max(c.y0, base - row.capH) >= Math.min(row.capH, c.y1 - c.y0 + 1) * 0.4);
    if (!inRow.length) continue;
    const mine = inRow.filter((c) => used.has(c)).length;
    if (debug) debug.push({ base: row.base, capH: row.capH, tokens: row.items.map((t) => t.root.letter + (t.acc ? t.acc.kind : "")), mine, total: inRow.length });
    if (mine / inRow.length >= 0.6) keep.push(...row.items);
  }
  return keep.sort((p, q) => p.box.x0 - q.box.x0);
}

const box = (c, ox, oy) => ({ x0: c.x0 + ox, x1: c.x1 + ox, y0: c.y0 + oy, y1: c.y1 + oy });

// ---- Akkordsymbol -> transponiertes Symbol ---------------------------------------------------------
// shift: { diatonic, chromatic } (Gesamtverschiebung seit dem Scan); Rückgabe neuer Text für Grundton/Bass
export function shiftName(letter, accKind, shift) {
  const alter = accKind === '#' ? 1 : accKind === 'b' ? -1 : 0;
  const q = transposePitch({ step: letter, alter, octave: 4 }, shift.diatonic, shift.chromatic);
  return q.step + (q.alter === 1 ? '#' : q.alter === -1 ? 'b' : q.alter === 2 ? '##' : q.alter === -2 ? 'bb' : '');
}

export const shiftIsIdentity = (s) => !s || (s.chromatic % 12 === 0 && s.diatonic % 7 === 0);

// Seite verändern: Grundton (und Bass) löschen, neu schreiben, Rest nach rechts/links schieben.
// drawText(text, { capH, bold }) -> { width, height, gray } (weiß = 255, Grundlinie = Unterkante des Bitmaps)
export function applyChordShift(page, symbols, shift, drawText) {
  if (shiftIsIdentity(shift)) return 0;
  const { width: W, height: H, gray } = page;
  const src = Uint8Array.from(gray);
  let changed = 0;
  const clear = (b, m = 1) => {
    for (let y = Math.max(0, b.y0 - m); y <= Math.min(H - 1, b.y1 + m); y++) for (let x = Math.max(0, b.x0 - m); x <= Math.min(W - 1, b.x1 + m); x++) gray[y * W + x] = 255;
  };
  const paste = (bmp, x, yBase) => {
    for (let y = 0; y < bmp.height; y++) {
      const py = yBase - bmp.height + 1 + y;
      if (py < 0 || py >= H) continue;
      for (let xx = 0; xx < bmp.width; xx++) {
        const px = x + xx;
        if (px < 0 || px >= W) continue;
        const v = bmp.gray[y * bmp.width + xx];
        if (v < gray[py * W + px]) gray[py * W + px] = v;
      }
    }
  };
  const copyBox = (b, dx) => {
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
      const v = src[y * W + x];
      const px = x + dx;
      if (px >= 0 && px < W && v < gray[y * W + px]) gray[y * W + px] = v;
    }
  };
  for (const s of symbols) {
    const newRoot = shiftName(s.root.letter, s.acc ? s.acc.kind : null, shift);
    const oldRight = (s.acc ? s.acc.box.x1 : s.root.box.x1) + 1;
    const bold = s.root.ink > 0.62;
    const rootBmp = drawText(newRoot, { capH: s.capH, bold });
    // alles löschen, was verschoben oder ersetzt wird
    clear(s.root.box);
    if (s.acc) clear(s.acc.box);
    s.suffix.forEach((b) => clear(b, 0));
    if (s.bass) {
      clear(s.bass.box);
      clear(s.bass.slash, 0);
      if (s.bass.acc) clear(s.bass.acc.box);
    }
    const x0 = s.root.box.x0;
    const baseY = s.root.box.y1;
    paste(rootBmp, x0, baseY);
    const gap = Math.max(1, Math.round(s.capH * 0.08));
    const newRight = x0 + rootBmp.width + gap;
    const dx = newRight - (s.suffix.length ? s.suffix[0].x0 : oldRight + gap);
    s.suffix.forEach((b) => copyBox(b, dx));
    if (s.bass) {
      const bassName = shiftName(s.bass.letter, s.bass.acc ? s.bass.acc.kind : null, shift);
      const bmp = drawText(bassName, { capH: s.capH, bold });
      copyBox(s.bass.slash, dx);
      paste(bmp, s.bass.box.x0 + dx, s.bass.box.y1);
    }
    changed++;
  }
  return changed;
}
