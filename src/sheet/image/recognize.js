// Eingebaute Notenerkennung (ohne KI): saubere, gerade Drucke einstimmiger Stimmen (Melodie, Trompete, Posaune …).
// Läuft im Browser und auf dem Handy. Für Fotos, dichte Sätze und mehrstimmige Systeme ist die KI-Erkennung
// der Desktop-App (homr) besser. Erkannt werden: Schlüssel (G/F/C), Vorzeichen, Noten (Ganze bis
// Sechzehntel, punktiert), Pausen, Versetzungszeichen, Haltebögen, Taktstriche; die Taktart ergibt sich aus den
// Taktfüllungen. Triolen, Mehrstimmigkeit und Verzierungen werden nicht erkannt.
import { removeStaffLines, labelComponents, classifier } from './erase.js';
import { open, fillHoles } from './morph.js';

const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E H als Stufen
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];
// diatonischer Index (C0 = 0) der untersten Linie
const CLEF_BOTTOM = { G2: 4 * 7 + 2, F4: 2 * 7 + 4, C3: 3 * 7 + 3, C4: 3 * 7 + 1 };
const NAT = [0, 2, 4, 5, 7, 9, 11];

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// Anzahl senkrechter Striche (Spalten mit langer Tintenstrecke) in einer Fläche
function strokeInfo(c, mask, w, sp) {
  const need = Math.max(3, (c.y1 - c.y0 + 1) * 0.7);
  const cols = [];
  const own = new Set(c.pixels);
  for (let x = c.x0; x <= c.x1; x++) {
    let best = 0;
    let run = 0;
    let top = -1;
    let bestTop = -1;
    for (let y = c.y0; y <= c.y1 + 1; y++) {
      const on = y <= c.y1 && own.has(y * w + x);
      if (on) {
        if (!run) top = y;
        run++;
      } else {
        if (run > best) {
          best = run;
          bestTop = top;
        }
        run = 0;
      }
    }
    if (best >= need) cols.push({ x, top: bestTop, len: best });
  }
  // benachbarte Spalten = ein Strich
  const strokes = [];
  for (const k of cols) {
    const last = strokes[strokes.length - 1];
    if (last && k.x - last.x1 <= 1) {
      last.x1 = k.x;
      last.top = Math.min(last.top, k.top);
    } else strokes.push({ x0: k.x, x1: k.x, top: k.top });
  }
  void mask;
  void sp;
  return strokes;
}

// Löcher (geschlossene Weißflächen) in der Fläche c: Anzahl und mittlere Höhe relativ zur Fläche (0 = oben, 1 = unten)
function holesOf(c, ink, filled, w) {
  const seen = new Set();
  const holes = [];
  for (let y = c.y0; y <= c.y1; y++) {
    for (let x = c.x0; x <= c.x1; x++) {
      const p = y * w + x;
      if (!filled[p] || ink[p] || seen.has(p)) continue;
      const stack = [p];
      seen.add(p);
      let n = 0;
      let sy = 0;
      while (stack.length) {
        const q = stack.pop();
        n++;
        const qy = (q / w) | 0;
        sy += qy;
        for (const d of [1, -1, w, -w]) {
          const t = q + d;
          if (t < 0 || seen.has(t) || !filled[t] || ink[t]) continue;
          const tx = t % w;
          const ty = (t / w) | 0;
          if (tx < c.x0 || tx > c.x1 || ty < c.y0 || ty > c.y1) continue;
          seen.add(t);
          stack.push(t);
        }
      }
      if (n >= 2) holes.push({ n, cy: (sy / n - c.y0) / Math.max(1, c.y1 - c.y0) });
    }
  }
  return holes;
}

// Vorzeichen: Kreuz (zwei Löcher), b (ein Loch im unteren Teil), Auflösungszeichen (ein Loch in der Mitte).
// Ohne Loch (verwaschen) entscheidet die Verteilung der Tinte auf die vier Viertel.
// Flächen ohne senkrechten Strich (Pausen, Ziffern) liefern null.
function classifyAccidental(c, mask, w, sp, ink = null, filled = null) {
  const st = strokeInfo(c, mask, w, sp);
  if (!st.length) return null;
  if (ink && filled) {
    const holes = holesOf(c, ink, filled, w);
    if (holes.length >= 2) return 'sharp';
    if (holes.length === 1) return holes[0].cy >= 0.58 ? 'flat' : 'natural';
  }
  const mx = (c.x0 + c.x1) / 2;
  const my = (c.y0 + c.y1) / 2;
  let ul = 0;
  let ur = 0;
  let ll = 0;
  let lr = 0;
  for (const p of c.pixels) {
    const x = p % w;
    const y = (p / w) | 0;
    if (y < my) {
      if (x < mx) ul++;
      else ur++;
    } else if (x < mx) ll++;
    else lr++;
  }
  const total = ul + ur + ll + lr;
  if (!total) return null;
  if (ur < 0.2 * total && lr > 0.25 * total) return 'flat';
  if ((ul + lr) / total >= 0.64 && ur < 0.3 * total && ll < 0.3 * total) return 'natural';
  return 'sharp';
}

// Waagrechter Block (ganze/halbe Pause): oben und unten gerade – Bogenstücke (Haltebögen) sind gekrümmt
function isBlock(c, w) {
  const tops = new Map();
  const bottoms = new Map();
  for (const p of c.pixels) {
    const x = p % w;
    const y = (p / w) | 0;
    if (!tops.has(x) || y < tops.get(x)) tops.set(x, y);
    if (!bottoms.has(x) || y > bottoms.get(x)) bottoms.set(x, y);
  }
  const spread = (m) => Math.max(...m.values()) - Math.min(...m.values());
  return spread(tops) <= 1 && spread(bottoms) <= 1;
}

function ringsAt(mask, w, x, y0, y1) {
  let n = 0;
  let on = false;
  for (let y = y0; y <= y1; y++) {
    const v = mask[y * w + x] === 1;
    if (v && !on) n++;
    on = v;
  }
  return n;
}

// Eine Notenzeile erkennen. page: Graustufen { width, gray }; staff aus staff.js mit barlines.
export function recognizeStaff(page, staff, { threshold = 170 } = {}) {
  const sp = staff.space;
  const W = page.width;
  const pad = Math.ceil(sp * 4.6);
  const ox = Math.max(0, Math.floor(staff.x0 - 2));
  const oy = Math.max(0, Math.floor(staff.top - pad));
  const x1 = Math.min(W - 1, Math.ceil(staff.x1 + 2));
  const y1 = Math.min(page.height - 1, Math.ceil(staff.bottom + pad));
  const w = x1 - ox + 1;
  const h = y1 - oy + 1;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ink[y * w + x] = page.gray[(y + oy) * W + x + ox] < threshold ? 1 : 0;
  // Hohle Notenköpfe: kleine geschlossene Weißflächen füllen (mit den Linien, damit der Ring dicht bleibt)
  const filled = fillHoles(ink, w, h, Math.round(sp * sp * 0.6));
  const noLines = removeStaffLines(filled, w, h, staff, ox, oy);
  const top = staff.top - oy;
  const bottom = staff.bottom - oy;
  const allComps = labelComponents(noLines, w, h).comps;
  const isMusic = classifier(allComps, noLines, w, staff, ox, oy, top, bottom);
  const comps = allComps.filter((c) => c.n >= 2 && isMusic(c));
  const music = new Uint8Array(w * h);
  for (const c of comps) for (const p of c.pixels) music[p] = 1;
  const big = comps.filter((c) => c.n >= 3);
  const warnings = [];

  // ---- Notenkopf-Kandidaten (vor dem Zeilenanfang, damit Noten nicht für Taktart/Vorzeichen gehalten werden):
  // Öffnen entfernt Hälse, Balken, Fähnchen, Linien, Punkte; übrig bleiben Köpfe
  const k = Math.max(3, Math.round(sp * 0.7));
  const opened = open(music, w, h, k);
  const headBlobs = labelComponents(opened, w, h).comps.filter((c) => {
    const cw = (c.x1 - c.x0 + 1) / sp;
    const ch = (c.y1 - c.y0 + 1) / sp;
    return cw >= 0.78 && cw <= 2.2 && ch >= 0.72 && ch <= 3.6;
  });
  const containsHead = (c) => headBlobs.some((b) => b.x0 >= c.x0 - 2 && b.x1 <= c.x1 + 2 && b.y0 >= c.y0 - 2 && b.y1 <= c.y1 + 2);

  // ---- Schlüssel
  const headerLimit = sp * 7;
  const lead = big.filter((c) => c.x0 < staff.x0 - ox + headerLimit).sort((a, b) => a.x0 - b.x0);
  let clefId = 'G2';
  let headerEnd = staff.x0 - ox + sp * 2;
  const clefComp = lead.find((c) => c.y1 - c.y0 >= sp * 2.2);
  if (clefComp) {
    const hh = (clefComp.y1 - clefComp.y0 + 1) / sp;
    const topRel = (clefComp.y0 - top) / sp;
    if (hh >= 5) clefId = 'G2';
    else if (hh <= 3.7 && topRel > -0.8) clefId = 'F4';
    else {
      // C-Schlüssel: Mitte der Fläche = Linie (Alt: mittlere Linie, Tenor: zweite von oben)
      const mid = (clefComp.y0 + clefComp.y1) / 2 - top;
      clefId = mid / sp < 1.5 ? 'C4' : 'C3';
    }
    headerEnd = clefComp.x1 + sp * 0.4;
  } else warnings.push('Schlüssel nicht erkannt (Violinschlüssel angenommen)');

  // ---- Vorzeichen am Zeilenanfang: Folge schmaler, hoher Flächen direkt nach dem Schlüssel
  const afterClef = lead.filter((c) => c.x0 > headerEnd - sp * 0.2 && c.y1 - c.y0 >= sp * 1.5 && c.y1 - c.y0 <= sp * 3.6 && c.x1 - c.x0 <= sp * 1.3 && !containsHead(c));
  const keyAcc = [];
  let lastX = headerEnd;
  for (const c of afterClef) {
    if (c.x0 - lastX > sp * 1.6) break;
    keyAcc.push(c);
    lastX = c.x1;
  }
  let fifths = 0;
  if (keyAcc.length) {
    const kinds = keyAcc.map((c) => classifyAccidental(c, noLines, w, sp, ink, filled));
    const cut = kinds.indexOf(null);
    const use = cut < 0 ? keyAcc.length : cut;
    const sharps = kinds.slice(0, use).filter((k) => k === 'sharp').length;
    if (use > 0) {
      fifths = sharps >= use / 2 ? use : -use;
      headerEnd = keyAcc[use - 1].x1 + sp * 0.3;
    }
  }
  // Taktart (zwei gestapelte Ziffern, oft zu einer hohen Fläche verwachsen) direkt nach den Vorzeichen.
  // Eine einzelne Pause (2,5 Zeilenabstände hoch) ist keine Taktart.
  let hasTime = false;
  {
    const cands = lead
      .filter((c) => c.x0 > headerEnd - sp * 0.3 && c.x0 - headerEnd < sp * 1.6 && c.y0 >= top - sp * 0.4 && c.y1 <= bottom + sp * 0.4 && c.x1 - c.x0 + 1 <= sp * 2.2 && !containsHead(c))
      .sort((p, q) => p.x0 - q.x0);
    const tall = cands.find((c) => c.y1 - c.y0 + 1 >= sp * 3.2);
    let blockComps = tall ? [tall] : [];
    if (!blockComps.length && cands.length >= 2) {
      const [u, v] = cands;
      const overlap = Math.min(u.x1, v.x1) - Math.max(u.x0, v.x0);
      const stacked = Math.abs((u.y0 + u.y1) / 2 - (v.y0 + v.y1) / 2) >= sp * 1.2;
      if (overlap >= 0.5 * Math.min(u.x1 - u.x0, v.x1 - v.x0) && stacked && u.y1 - u.y0 >= sp * 1.4 && v.y1 - v.y0 >= sp * 1.4) blockComps = [u, v];
    }
    if (blockComps.length) {
      hasTime = true;
      headerEnd = Math.max(...blockComps.map((c) => c.x1)) + sp * 0.4;
    }
  }

  const headComps = headBlobs.filter((c) => c.x0 > headerEnd);
  const clefBottom = CLEF_BOTTOM[clefId];
  const heads = [];
  for (const c of headComps) {
    const ch = (c.y1 - c.y0 + 1) / sp;
    const n = Math.max(1, Math.round(ch / 0.95));
    for (let i = 0; i < n; i++) {
      const cy = c.y0 + ((i + 0.5) * (c.y1 - c.y0 + 1)) / n;
      const cx = (c.x0 + c.x1) / 2;
      heads.push({ cx, cy, x0: c.x0, x1: c.x1, y0: Math.round(cy - sp * 0.45), y1: Math.round(cy + sp * 0.45), chord: n > 1 });
    }
  }
  heads.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  // Akkord/Mehrklang: pro Einsatz nur die oberste Note (Melodie)
  const uniq = [];
  for (const hd of heads) {
    const last = uniq[uniq.length - 1];
    if (last && Math.abs(last.cx - hd.cx) < sp * 0.6) continue;
    uniq.push(hd);
  }
  const events = [];
  for (const hd of uniq) {
    // gefüllt oder hohl? Hohle Köpfe waren Ringe: ihre Löcher wurden oben gefüllt (filled=1, ink=0)
    let holes = 0;
    let area = 0;
    for (let y = Math.round(hd.cy - sp * 0.5); y <= Math.round(hd.cy + sp * 0.5); y++) {
      for (let x = Math.round(hd.cx - sp * 0.7); x <= Math.round(hd.cx + sp * 0.7); x++) {
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        area++;
        if (filled[y * w + x] && !ink[y * w + x]) holes++;
      }
    }
    const hollow = area > 0 && holes / area >= 0.1;
    // Hals: längste senkrechte Tintenstrecke an der linken/rechten Kopfkante
    let best = { len: 0, dir: 0, x: 0, tip: 0 };
    for (const x of [hd.x0 - 1, hd.x0, hd.x0 + 1, hd.x1 - 1, hd.x1, hd.x1 + 1]) {
      if (x < 0 || x >= w) continue;
      for (const dir of [-1, 1]) {
        let y = dir < 0 ? Math.round(hd.cy - sp * 0.2) : Math.round(hd.cy + sp * 0.2);
        let len = 0;
        // erst durch den Kopf, dann am Hals entlang
        while (y >= 0 && y < h && (music[y * w + x] || len < sp * 0.4)) {
          y += dir;
          len++;
          if (len > sp * 6) break;
        }
        const stemLen = len - sp * 0.2;
        if (stemLen > best.len) best = { len: stemLen, dir, x, tip: y - dir };
      }
    }
    const hasStem = best.len >= sp * 1.8;
    // Balken/Fähnchen an der Halsspitze: Tintenstrecken rechts und links vom Hals
    let flags = 0;
    if (hasStem) {
      const count = (xp) => {
        let runs = 0;
        let on = false;
        const from = best.tip;
        const to = best.tip - best.dir * Math.round(sp * 2.2);
        const step = to > from ? 1 : -1;
        for (let y = from; y !== to; y += step) {
          if (y < 0 || y >= h) break;
          const v = music[y * w + xp] === 1 || music[y * w + xp + step * 0] === 1;
          if (v && !on) runs++;
          on = v;
        }
        return runs;
      };
      const off = Math.max(2, Math.round(sp * 0.42));
      flags = Math.min(3, Math.max(count(Math.min(w - 1, best.x + off)), count(Math.max(0, best.x - off))));
    }
    // Punkt rechts vom Kopf
    const dotted = big.concat(comps.filter((c) => c.n >= 2 && c.n <= 40)).some((c) => {
      const cw = c.x1 - c.x0 + 1;
      const chh = c.y1 - c.y0 + 1;
      return cw <= sp * 0.55 && chh <= sp * 0.55 && c.x0 >= hd.x1 + sp * 0.1 && c.x0 <= hd.x1 + sp * 1.3 && Math.abs((c.y0 + c.y1) / 2 - hd.cy) <= sp * 0.7;
    });
    // Versetzungszeichen links vom Kopf
    const acc = big.find((c) => c.x1 >= hd.x0 - sp * 2.2 && c.x1 <= hd.x0 - sp * 0.05 && c.y1 - c.y0 >= sp * 1.6 && c.y1 - c.y0 <= sp * 3.4 && c.x1 - c.x0 <= sp * 1.2 && Math.abs((c.y0 + c.y1) / 2 - hd.cy) <= sp * 1.4 && c.x0 > headerEnd - sp * 0.1);
    const accKind = acc ? classifyAccidental(acc, noLines, w, sp, ink, filled) : null;
    // Tonhöhe: Linienposition in Halbschritten über der untersten Linie
    const pos = Math.round(((bottom - hd.cy) / sp) * 2);
    const d = clefBottom + pos;
    // Dauer in Sechzehnteln
    let base;
    if (hollow) base = hasStem ? 8 : 16;
    else base = flags >= 3 ? 0.5 : flags === 2 ? 1 : flags === 1 ? 2 : 4;
    if (!hollow && !hasStem) base = 4; // gefüllt ohne Hals: Viertel (Hals evtl. nicht gefunden)
    events.push({ kind: 'note', x: hd.cx, d, base, dots: dotted ? 1 : 0, acc: accKind, accComp: acc || null, cy: hd.cy });
  }

  // ---- Pausen: Flächen in der Zeile, die kein Kopf, Hals, Zeichen oder Punkt sind
  const headBoxes = uniq.map((hd) => ({ x0: hd.x0 - sp * 0.3, x1: hd.x1 + sp * 0.3 }));
  const inNote = (c) => headBoxes.some((b) => c.x1 >= b.x0 && c.x0 <= b.x1);
  const accSet = new Set();
  const usedAcc = new Set(events.filter((e) => e.accComp).map((e) => e.accComp));
  for (const c of big) {
    if (c.x0 <= headerEnd) continue;
    const cw = (c.x1 - c.x0 + 1) / sp;
    const chh = (c.y1 - c.y0 + 1) / sp;
    if (inNote(c) || usedAcc.has(c)) continue;
    if (c.y1 < top - sp * 0.2 || c.y0 > bottom + sp * 0.2) continue;
    // Taktstriche/Hälse/Balken überspringen: schmal & hoch bzw. sehr breit
    if (cw < 0.45 || cw > 2.6) continue;
    let rest = null;
    if (chh >= 1.8 && chh <= 3.4 && cw >= 0.55 && cw <= 1.4) rest = 4; // Viertelpause
    else if (chh >= 1.0 && chh < 1.8 && cw >= 0.5 && cw <= 1.2) rest = 2; // Achtelpause
    else if (chh <= 0.75 && cw >= 0.8 && cw <= 1.6 && c.n / (cw * chh * sp * sp) >= 0.75 && isBlock(c, w)) {
      // ganze Pause hängt an der 4. Linie (von unten), halbe sitzt auf der mittleren Linie
      const mid = ((c.y0 + c.y1) / 2 - top) / sp;
      if (mid >= 0.7 && mid <= 1.45) rest = 16;
      else if (mid >= 1.55 && mid <= 2.25) rest = 8;
    }
    if (rest !== null) {
      // Versetzungszeichen sind höher und schmaler als Pausen und stehen vor Köpfen – sie sind hier schon ausgeschlossen
      events.push({ kind: 'rest', x: (c.x0 + c.x1) / 2, base: rest, dots: 0 });
    } else accSet.add(c);
  }
  events.sort((a, b) => a.x - b.x);
  // Punkt hinter Pausen
  for (const e of events) {
    if (e.kind !== 'rest') continue;
    e.dots = big.concat(comps).some((c) => c.n >= 2 && c.n <= 40 && c.x1 - c.x0 <= sp * 0.55 && c.y1 - c.y0 <= sp * 0.55 && c.x0 >= e.x + sp * 0.4 && c.x0 <= e.x + sp * 1.4 && c.y0 >= top && c.y1 <= bottom)
      ? 1
      : 0;
  }
  // Haltebögen: flache, dünne Bögen zwischen zwei gleich hohen Noten
  const arcs = big.filter((c) => (c.x1 - c.x0 + 1) >= sp * 1.4 && (c.y1 - c.y0 + 1) <= sp * 1.2 && c.n <= (c.x1 - c.x0 + 1) * (staff.thickness + 3));
  const notes = events.filter((e) => e.kind === 'note');
  for (let i = 0; i + 1 < notes.length; i++) {
    const a = notes[i];
    const b = notes[i + 1];
    if (a.d !== b.d) continue;
    if (arcs.some((c) => c.x0 <= a.x + sp * 0.8 && c.x1 >= b.x - sp * 0.8 && Math.abs((c.y0 + c.y1) / 2 - a.cy) <= sp * 1.9)) {
      a.tie = true;
      b.tieStop = true;
    }
  }
  // Taktstriche (relativ zum Ausschnitt)
  const bars = (staff.barlines || []).map((x) => x - ox).filter((x) => x > headerEnd + sp * 0.5).sort((p, q) => p - q);
  const endX = staff.x1 - ox;
  if (!bars.length || endX - bars[bars.length - 1] > sp * 2) bars.push(endX + 1);
  return { clefId, fifths, hasTime, headerEnd, events, bars, warnings, space: sp, debug: { heads: uniq.map((hd) => ({ x0: hd.x0, x1: hd.x1, y0: hd.y0, y1: hd.y1, cy: hd.cy })), comps: big.map((c) => ({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, n: c.n })), top, bottom } };
}

// ---- Seite -> MusicXML ----------------------------------------------------------------------------------
const TYPE_OF = { 16: 'whole', 8: 'half', 4: 'quarter', 2: 'eighth', 1: '16th', 0.5: '32nd' };
const durOf = (e) => e.base * (e.dots ? 1.5 : 1);

function spell(d, acc, key, measureAcc) {
  const stepIdx = ((d % 7) + 7) % 7;
  const octave = Math.floor(d / 7);
  let alter = 0;
  if (key > 0 && SHARP_ORDER.indexOf(stepIdx) < key) alter = 1;
  if (key < 0 && FLAT_ORDER.indexOf(stepIdx) < -key) alter = -1;
  const tag = `${stepIdx}:${octave}`;
  if (acc === 'sharp') measureAcc.set(tag, 1);
  else if (acc === 'flat') measureAcc.set(tag, -1);
  else if (acc === 'natural') measureAcc.set(tag, 0);
  if (measureAcc.has(tag)) alter = measureAcc.get(tag);
  return { step: STEPS[stepIdx], alter, octave };
}

export function recognizePage(prepared, opts = {}) {
  const { page, staves } = prepared;
  const systems = staves.map((s) => recognizeStaff(page, s, opts));
  const warnings = systems.flatMap((s, i) => s.warnings.map((w) => `Zeile ${i + 1}: ${w}`));
  const first = systems[0];
  const key = first ? first.fifths : 0;
  const clef = first ? first.clefId : 'G2';
  // Takte je Zeile aus den Taktstrichen
  const rows = systems.map((sys) => {
    const out = [];
    let left = sys.headerEnd - 2;
    for (const bx of sys.bars) {
      const items = sys.events.filter((e) => e.x > left && e.x <= bx);
      out.push(items);
      left = bx;
    }
    return out;
  });
  // Taktfüllung (Sechzehntel): häufigste Summe der Takte (ohne erste und letzte Zeile-Reste)
  const sums = rows.flat().map((m) => m.reduce((a, e) => a + durOf(e), 0)).filter((s) => s > 0);
  const counts = new Map();
  for (const s of sums) counts.set(s, (counts.get(s) || 0) + 1);
  let L = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 16;
  if (![8, 12, 16, 24, 6, 20].includes(L)) {
    const nearest = [6, 8, 12, 16, 20, 24].reduce((p, c) => (Math.abs(c - L) < Math.abs(p - L) ? c : p), 16);
    warnings.push(`Taktfüllung ${L} Sechzehntel unsicher – ${nearest} angenommen`);
    L = nearest;
  }
  const beats = L === 16 ? [4, 4] : L === 12 ? [3, 4] : L === 8 ? [2, 4] : L === 24 ? [6, 4] : L === 20 ? [5, 4] : [3, 8];
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  lines.push('<score-partwise version="4.0">');
  lines.push('  <work><work-title></work-title></work>');
  lines.push('  <identification><encoding><software>NoteCode (eingebaute Erkennung)</software></encoding></identification>');
  lines.push('  <part-list><score-part id="P1"><part-name></part-name></score-part></part-list>');
  lines.push('  <part id="P1">');
  let n = 0;
  let noteCount = 0;
  rows.forEach((measures, si) => {
    measures.forEach((items, mi) => {
      n++;
      lines.push(`    <measure number="${n}">`);
      if (si > 0 && mi === 0) lines.push('      <print new-system="yes"/>');
      if (n === 1) {
        const c = { G2: ['G', 2], F4: ['F', 4], C3: ['C', 3], C4: ['C', 4] }[clef];
        lines.push('      <attributes>');
        lines.push('        <divisions>4</divisions>');
        lines.push(`        <key><fifths>${key}</fifths></key>`);
        lines.push(`        <time><beats>${beats[0]}</beats><beat-type>${beats[1]}</beat-type></time>`);
        lines.push(`        <clef><sign>${c[0]}</sign><line>${c[1]}</line></clef>`);
        lines.push('      </attributes>');
      }
      const measureAcc = new Map();
      let sum = 0;
      const out = [];
      for (const e of items) {
        const dur = Math.round(durOf(e));
        if (dur <= 0) continue;
        out.push({ e, dur });
        sum += dur;
      }
      // Korrektur: zu lange Takte kürzen, zu kurze (außer Auftakt/letzter Takt) mit Pause auffüllen
      const isLast = si === rows.length - 1 && mi === measures.length - 1;
      const isFirst = n === 1;
      if (sum > L) {
        warnings.push(`Takt ${n}: Notenwerte ergeben ${sum} statt ${L} Sechzehntel – gekürzt`);
        let over = sum - L;
        for (let i = out.length - 1; i >= 0 && over > 0; i--) {
          const cut = Math.min(out[i].dur - 1, over);
          out[i].dur -= cut;
          over -= cut;
        }
        out.forEach((o) => (o.e.dots = 0));
        sum = out.reduce((a, o) => a + o.dur, 0);
      }
      if (sum < L && !isFirst && !isLast && sum > 0) {
        warnings.push(`Takt ${n}: nur ${sum} von ${L} Sechzehnteln erkannt – mit Pause aufgefüllt`);
        out.push({ e: { kind: 'rest', base: L - sum, dots: 0 }, dur: L - sum });
        sum = L;
      }
      if (!out.length) {
        out.push({ e: { kind: 'rest', base: L, dots: 0 }, dur: L });
        warnings.push(`Takt ${n}: nichts erkannt – Pause gesetzt`);
      }
      for (const { e, dur } of out) {
        const type = TYPE_OF[e.base] || '16th';
        const dot = e.dots && Math.abs(dur - e.base * 1.5) < 0.01 ? '<dot/>' : '';
        if (e.kind === 'rest') {
          lines.push(`      <note><rest/><duration>${dur}</duration><type>${type}</type>${dot}</note>`);
        } else {
          noteCount++;
          const p = spell(e.d, e.acc, key, measureAcc);
          lines.push(
            `      <note><pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch><duration>${dur}</duration>${e.tieStop ? '<tie type="stop"/>' : ''}${e.tie ? '<tie type="start"/>' : ''}<type>${type}</type>${dot}${e.tie || e.tieStop ? `<notations>${e.tieStop ? '<tied type="stop"/>' : ''}${e.tie ? '<tied type="start"/>' : ''}</notations>` : ''}</note>`,
          );
        }
      }
      lines.push('    </measure>');
    });
  });
  lines.push('  </part>');
  lines.push('</score-partwise>');
  return { xml: lines.join('\n') + '\n', warnings, stats: { measures: n, notes: noteCount, staves: systems.length, clef, key, timeBeats: beats } };
}

// Einstieg für die Oberfläche
export function recognizeSimple(prepared, opts = {}) {
  const r = recognizePage(prepared, opts);
  if (!r.stats.notes) r.warnings.push('Es wurden keine Noten erkannt – bitte ein klareres, gerades Bild verwenden oder die KI-Erkennung der Desktop-App nutzen.');
  void median;
  void ringsAt;
  return r;
}
