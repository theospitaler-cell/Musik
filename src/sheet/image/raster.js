// Bildverarbeitung für eingescannte Notenblätter – reine Arrays, läuft in Browser und Node.
// Bilder sind { width, height, data: Uint8ClampedArray(RGBA) } oder Graustufen { width, height, gray: Uint8Array }.

export function toGray(img) {
  if (img.gray) return img;
  const { width: w, height: h, data } = img;
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    // helle Hintergründe (Alpha 0) zählen als weiß
    const a = data[p + 3] / 255;
    const v = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    g[i] = Math.round(v * a + 255 * (1 - a));
  }
  return { width: w, height: h, gray: g };
}

export function grayToRgba(img) {
  const { width: w, height: h, gray } = img;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    data[p] = data[p + 1] = data[p + 2] = gray[i];
    data[p + 3] = 255;
  }
  return { width: w, height: h, data };
}

export function histogram(gray) {
  const h = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) h[gray[i]]++;
  return h;
}

export function percentile(hist, total, q) {
  const target = total * q;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

// Otsu-Schwelle (Tinte < Schwelle)
export function otsu(gray) {
  const hist = histogram(gray);
  const total = gray.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

// Beleuchtung schätzen: je Block der helle Anteil (Papier), dann bilinear auf Pixelgröße
export function backgroundMap(img, block = 32) {
  const { width: w, height: h, gray } = img;
  const bw = Math.max(1, Math.ceil(w / block));
  const bh = Math.max(1, Math.ceil(h / block));
  const bg = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y++) {
        for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x++) {
          hist[gray[y * w + x]]++;
          n++;
        }
      }
      bg[by * bw + bx] = percentile(hist, n, 0.9);
    }
  }
  // Blöcke ohne Papier (viel Tinte) übernehmen den Wert der Nachbarn: Minimum von 3×3-Max-Filter vermeiden,
  // stattdessen zweimal das Maximum über die Nachbarschaft (Tinte ist nie heller als Papier)
  const filt = new Float32Array(bg.length);
  for (let pass = 0; pass < 1; pass++) {
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = by + dy;
          const xx = bx + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) m = Math.max(m, bg[yy * bw + xx]);
        }
        filt[by * bw + bx] = m;
      }
    }
    bg.set(filt);
  }
  return { bw, bh, block, bg };
}

function sampleBg(map, x, y) {
  const fx = Math.min(map.bw - 1, Math.max(0, x / map.block - 0.5));
  const fy = Math.min(map.bh - 1, Math.max(0, y / map.block - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(map.bw - 1, x0 + 1);
  const y1 = Math.min(map.bh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = map.bg[y0 * map.bw + x0] * (1 - tx) + map.bg[y0 * map.bw + x1] * tx;
  const b = map.bg[y1 * map.bw + x0] * (1 - tx) + map.bg[y1 * map.bw + x1] * tx;
  return a * (1 - ty) + b * ty;
}

// Hintergrund perfekt weiß: Beleuchtung herausrechnen, Papier auf 255, Tinte kräftig (Weiß-/Schwarzpunkt).
// Rückgabe: Graustufen-Bild; tiefe Schwarztöne bleiben erhalten (keine Binarisierung).
export function whiten(img, { block = 32, paper = 0.93, ink = 0.3 } = {}) {
  const g = toGray(img);
  const { width: w, height: h, gray } = g;
  const map = backgroundMap(g, block);
  const flat = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = Math.max(40, sampleBg(map, x, y));
      flat[y * w + x] = Math.min(255, Math.round((gray[y * w + x] / b) * 255));
    }
  }
  // Weiß-/Schwarzpunkt: Papier ab `paper`·255 ist exakt weiß, Tinte unterhalb `ink`·255 exakt schwarz
  const white = 255 * paper;
  const black = 255 * ink;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = v >= white ? 255 : v <= black ? 0 : Math.round(((v - black) / (white - black)) * 255);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = lut[flat[i]];
  return { width: w, height: h, gray: out };
}

// Binärbild: 1 = Tinte
export function binarize(img, threshold = null) {
  const g = toGray(img);
  const t = threshold ?? Math.min(200, Math.max(60, otsu(g.gray)));
  const out = new Uint8Array(g.gray.length);
  for (let i = 0; i < out.length; i++) out[i] = g.gray[i] < t ? 1 : 0;
  return { width: g.width, height: g.height, bin: out, threshold: t };
}

// Neigungswinkel (Grad, positiv = Seite im Uhrzeigersinn gedreht) über die Schärfe des Zeilenprofils
export function estimateSkew(img, { maxDeg = 4, step = 0.1 } = {}) {
  const b = binarize(img);
  const { width: w, height: h, bin } = b;
  // auf höchstens ~700 px Breite verkleinern (Tinte zählt: Maximum im Block)
  const f = Math.max(1, Math.floor(w / 700));
  const sw = Math.floor(w / f);
  const sh = Math.floor(h / f);
  const pts = [];
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let ink = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) ink += bin[(y * f + dy) * w + x * f + dx];
      if (ink * 2 >= f * f) pts.push(x, y);
    }
  }
  if (pts.length < 200) return 0;
  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180);
    const rows = new Float32Array(sh * 2);
    for (let i = 0; i < pts.length; i += 2) {
      const y = Math.round(pts[i + 1] - t * (pts[i] - sw / 2)) + Math.floor(sh / 2);
      if (y >= 0 && y < sh * 2) rows[y]++;
    }
    let s = 0;
    for (let y = 0; y < rows.length; y++) s += rows[y] * rows[y];
    return s;
  };
  let best = 0;
  let bestS = -1;
  for (let d = -maxDeg; d <= maxDeg + 1e-9; d += step) {
    const s = score(d);
    if (s > bestS) {
      bestS = s;
      best = d;
    }
  }
  // zweiter, feinerer Durchgang
  for (let d = best - step; d <= best + step + 1e-9; d += step / 5) {
    const s = score(d);
    if (s > bestS) {
      bestS = s;
      best = d;
    }
  }
  return Math.round(best * 100) / 100;
}

// Graustufenbild um den Mittelpunkt drehen (bilinear), Rand = weiß. deg > 0 dreht den Inhalt gegen den Uhrzeigersinn.
export function rotate(img, deg, fill = 255) {
  const { width: w, height: h, gray } = img;
  if (Math.abs(deg) < 0.005) return img;
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = w / 2;
  const cy = h / 2;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Rückabbildung
      const dx = x - cx;
      const dy = y - cy;
      const sx = cos * dx - sin * dy + cx;
      const sy = sin * dx + cos * dy + cy;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) {
        out[y * w + x] = fill;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const tx = sx - x0;
      const ty = sy - y0;
      const v00 = gray[y0 * w + x0];
      const v10 = gray[y0 * w + x1];
      const v01 = gray[y1 * w + x0];
      const v11 = gray[y1 * w + x1];
      out[y * w + x] = Math.round((v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty);
    }
  }
  return { width: w, height: h, gray: out };
}

// Anteil „perfekt weißer“ Pixel (Papier) – Messgröße für den Test „Hintergrund perfekt weiß“
export function whiteShare(gray) {
  let n = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] === 255) n++;
  return n / gray.length;
}

// ---- Auflösung --------------------------------------------------------------------------------------
// Notenlinienabstand aus der Periodizität des Zeilenprofils (die Linien dürfen blass und dünn sein).
// Rückgabe { space, strength } oder null, wenn kein regelmäßiges Linienmuster zu sehen ist.
export function estimateStaffSpace(img, { min = 3, max = 40 } = {}) {
  const { width: w, height: h, gray } = toGray(img);
  const prof = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) s += 255 - gray[base + x];
    prof[y] = s / w;
  }
  // Hochpass: gleitenden Mittelwert (Breite 2·max+1) abziehen
  const win = 2 * max + 1;
  const hp = new Float64Array(h);
  let acc = 0;
  const cs = new Float64Array(h + 1);
  for (let y = 0; y < h; y++) cs[y + 1] = cs[y] + prof[y];
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - max);
    const b = Math.min(h, y + max + 1);
    hp[y] = prof[y] - (cs[b] - cs[a]) / (b - a);
    acc += hp[y] * hp[y];
  }
  void win;
  if (acc <= 0) return null;
  const r = new Float64Array(max + 1);
  for (let lag = min; lag <= max; lag++) {
    let s = 0;
    for (let y = 0; y + lag < h; y++) s += hp[y] * hp[y + lag];
    r[lag] = s / acc;
  }
  let best = 0;
  for (let lag = min; lag <= max; lag++) if (r[lag] > best) best = r[lag];
  if (best < 0.03) return null;
  // kleinster Abstand mit mindestens 70 % des Maximums (Vielfache des Abstands ignorieren)
  let lag = min;
  for (let l = min + 1; l < max; l++) {
    if (r[l] >= best * 0.7 && r[l] >= r[l - 1] && r[l] >= r[l + 1]) {
      lag = l;
      break;
    }
  }
  // Feinwert: Parabel durch die drei Werte um das Maximum
  const a = r[lag - 1] || 0;
  const b = r[lag];
  const c = r[lag + 1] || 0;
  const d = a - 2 * b + c;
  const off = d < 0 ? (0.5 * (a - c)) / d : 0;
  return { space: lag + Math.max(-0.5, Math.min(0.5, off)), strength: best };
}

// Bilinear vergrößern/verkleinern (Faktor > 0)
export function scaleGray(img, factor) {
  const { width: w, height: h, gray } = toGray(img);
  const W = Math.max(1, Math.round(w * factor));
  const H = Math.max(1, Math.round(h * factor));
  const out = new Uint8Array(W * H);
  const fx = w / W;
  const fy = h / H;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = sx - x0;
      const top = gray[y0 * w + x0] * (1 - tx) + gray[y0 * w + x1] * tx;
      const bot = gray[y1 * w + x0] * (1 - tx) + gray[y1 * w + x1] * tx;
      out[y * W + x] = Math.round(top * (1 - ty) + bot * ty);
    }
  }
  return { width: W, height: H, gray: out };
}

// Blasse, dünne Striche (Bildschirmfoto, verkleinerter Druck) nachdunkeln: alles bis `black` wird schwarz,
// ab `white` weiß, dazwischen linear
export function darken(img, { black = 170, white = 240 } = {}) {
  const { width: w, height: h, gray } = toGray(img);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = v >= white ? 255 : v <= black ? 0 : Math.round(((v - black) / (white - black)) * 255);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = lut[gray[i]];
  return { width: w, height: h, gray: out };
}

// Typischer Grauwert der Notenlinien (Zeilen mit der stärksten, gleichmäßigen Tinte über die Breite)
export function estimateLineGray(img) {
  const { width: w, height: h, gray } = toGray(img);
  const prof = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) s += 255 - gray[base + x];
    prof[y] = s / w;
  }
  const sorted = Array.from(prof).sort((a, b) => a - b);
  const q = sorted[Math.floor(sorted.length * 0.985)];
  if (!(q > 0)) return 255;
  const vals = [];
  for (let y = 0; y < h; y++) {
    if (prof[y] < q * 0.5) continue;
    for (let x = 0; x < w; x++) if (gray[y * w + x] < 250) vals.push(gray[y * w + x]);
  }
  if (!vals.length) return 255;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}
