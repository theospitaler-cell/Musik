// Kleine Morphologie für Binärbilder (Uint8Array, 1 = Tinte): Öffnen mit Quadrat, Löcher füllen.
// Alles mit Summen-Bildern (Integralbild), damit große Seiten schnell bleiben.

function integral(bin, w, h) {
  const s = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += bin[y * w + x];
      s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
    }
  }
  return s;
}

function boxSum(s, w, x0, y0, x1, y1) {
  // Summe über [x0, x1) × [y0, y1)
  const W = w + 1;
  return s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
}

// Erosion: Pixel bleibt, wenn das k×k-Fenster (Mitte = Pixel) ganz aus Tinte besteht
export function erode(bin, w, h, k) {
  const s = integral(bin, w, h);
  const out = new Uint8Array(w * h);
  const a = Math.floor(k / 2);
  const b = k - a;
  for (let y = a; y < h - b + 1; y++) {
    for (let x = a; x < w - b + 1; x++) {
      if (boxSum(s, w, x - a, y - a, x + b, y + b) === k * k) out[y * w + x] = 1;
    }
  }
  return out;
}

export function dilate(bin, w, h, k) {
  const s = integral(bin, w, h);
  const out = new Uint8Array(w * h);
  const a = Math.floor(k / 2);
  const b = k - a;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - b + 1);
      const y0 = Math.max(0, y - b + 1);
      const x1 = Math.min(w, x + a + 1);
      const y1 = Math.min(h, y + a + 1);
      if (boxSum(s, w, x0, y0, x1, y1) > 0) out[y * w + x] = 1;
    }
  }
  return out;
}

export const open = (bin, w, h, k) => dilate(erode(bin, w, h, k), w, h, k);

// Geschlossene Weißflächen (nicht am Rand) bis maxArea werden Tinte – füllt die Mitte hohler Notenköpfe
export function fillHoles(bin, w, h, maxArea) {
  const out = Uint8Array.from(bin);
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let start = 0; start < bin.length; start++) {
    if (bin[start] || seen[start]) continue;
    // 4er-Nachbarschaft
    const region = [];
    let touches = false;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      region.push(p);
      const x = p % w;
      const y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      if (region.length > maxArea * 4 && touches) {
        // schon zu groß und offen: nicht weiter verfolgen (Rest wird beim nächsten Start übersprungen)
      }
      if (x > 0 && !bin[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), stack.push(p - 1);
      if (x < w - 1 && !bin[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), stack.push(p + 1);
      if (y > 0 && !bin[p - w] && !seen[p - w]) (seen[p - w] = 1), stack.push(p - w);
      if (y < h - 1 && !bin[p + w] && !seen[p + w]) (seen[p + w] = 1), stack.push(p + w);
    }
    if (!touches && region.length <= maxArea) for (const p of region) out[p] = 1;
  }
  return out;
}
