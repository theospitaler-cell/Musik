// Notensysteme im Bild finden: je System fünf Linien mit Abstand, Dicke und Ausdehnung.
import { binarize } from './raster.js';

// Längste zusammenhängende Tintenstrecken je Zeile -> Zeilenwert = Summe der Strecken ≥ minRun
function rowScores(bin, w, h, minRun) {
  const score = new Float32Array(h);
  const xs0 = new Int32Array(h).fill(-1);
  const xs1 = new Int32Array(h).fill(-1);
  for (let y = 0; y < h; y++) {
    let run = 0;
    let sum = 0;
    let first = -1;
    let last = -1;
    const base = y * w;
    for (let x = 0; x <= w; x++) {
      const on = x < w && bin[base + x] === 1;
      if (on) run++;
      else {
        if (run >= minRun) {
          sum += run;
          if (first < 0) first = x - run;
          last = x - 1;
        }
        run = 0;
      }
    }
    score[y] = sum;
    xs0[y] = first;
    xs1[y] = last;
  }
  return { score, xs0, xs1 };
}

// Rückgabe: [{ lines: [y0..y4], space, thickness, x0, x1, top, bottom }]
export function detectStaves(img, opts = {}) {
  const b = img.bin ? img : binarize(img);
  const { width: w, height: h, bin } = b;
  const minRun = Math.max(24, Math.round(w * (opts.minRunShare ?? 0.06)));
  const { score, xs0, xs1 } = rowScores(bin, w, h, minRun);
  let max = 0;
  for (let y = 0; y < h; y++) if (score[y] > max) max = score[y];
  if (max === 0) return [];
  // Zeilen, die zu Linien gehören: ein großer Teil der Zeilenlänge ist Tinte in langen Strecken
  const rows = [];
  const thr = Math.max(minRun * 1.5, max * (opts.lineShare ?? 0.3));
  for (let y = 0; y < h; y++) if (score[y] >= thr) rows.push(y);
  // zusammenhängende Zeilen -> Linien (Mitte, Dicke)
  const lines = [];
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] - rows[j] <= 1) j++;
    const y0 = rows[i];
    const y1 = rows[j];
    // Gewichtete Mitte
    let sw = 0;
    let sy = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let y = y0; y <= y1; y++) {
      sw += score[y];
      sy += score[y] * y;
      if (xs0[y] >= 0) x0 = Math.min(x0, xs0[y]);
      if (xs1[y] >= 0) x1 = Math.max(x1, xs1[y]);
    }
    lines.push({ y: sy / sw, thickness: y1 - y0 + 1, x0, x1, score: sw / (y1 - y0 + 1) });
    i = j + 1;
  }
  // Gruppen aus fünf Linien mit gleichem Abstand (±25 %)
  const staves = [];
  const used = new Array(lines.length).fill(false);
  for (let i = 0; i + 4 < lines.length; i++) {
    if (used[i]) continue;
    const g = lines.slice(i, i + 5);
    const gaps = [g[1].y - g[0].y, g[2].y - g[1].y, g[3].y - g[2].y, g[4].y - g[3].y];
    const med = [...gaps].sort((a, c) => a - c)[1.5 | 0] || gaps[0];
    const mean = gaps.reduce((a, c) => a + c, 0) / 4;
    if (mean < 4) continue;
    if (!gaps.every((d) => Math.abs(d - mean) <= mean * 0.25)) continue;
    void med;
    for (let k = i; k < i + 5; k++) used[k] = true;
    // Ausdehnung: kürzeste der fünf Linien (Linien enden einheitlich)
    const x0 = Math.round(median(g.map((l) => l.x0)));
    const x1 = Math.round(median(g.map((l) => l.x1)));
    staves.push({
      lines: g.map((l) => l.y),
      space: mean,
      thickness: median(g.map((l) => l.thickness)),
      x0,
      x1,
      top: g[0].y,
      bottom: g[4].y,
    });
  }
  return staves;
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// Notenzeilen aus Systemen gruppieren (Klammer/Akkolade): untereinander liegende Zeilen mit kleinem Abstand
export function groupSystems(staves) {
  const out = [];
  let cur = [];
  for (const s of staves) {
    const prev = cur[cur.length - 1];
    if (prev && s.top - prev.bottom < s.space * 6 && Math.abs(s.x0 - prev.x0) < s.space * 3) cur.push(s);
    else {
      if (cur.length) out.push(cur);
      cur = [s];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
