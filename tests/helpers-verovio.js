// Nur für Tests: Verovio (WASM) in Node laden und ein einfaches „Rastern“ des SVG für Geometrie-Prüfungen.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cached = null;
export function loadVerovioNode() {
  if (cached) return cached;
  cached = new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'verovio-'));
    const file = join(dir, 'verovio.cjs');
    writeFileSync(file, readFileSync(new URL('../vendor/verovio-toolkit-wasm.js', import.meta.url), 'utf8'));
    const require = createRequire(import.meta.url);
    try {
      const v = require(file);
      v.module.onRuntimeInitialized = () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // egal
        }
        resolve(new v.toolkit());
      };
    } catch (e) {
      reject(e);
    }
  });
  return cached;
}

// Sehr einfacher Ersatz für den Browser-Rasterer: Notenlinien als Striche, Zeichen (<use>) als gefüllte
// Kästen von ca. einem Zeilenabstand. Genügt, um Lage, Ausrichtung und Löschen/Einfügen zu prüfen.
export function fakeRasterize(svg, { scale, dx, dy, width, height }) {
  const gray = new Uint8Array(width * height).fill(255);
  const put = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(height - 1, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(width - 1, Math.ceil(x1)); x++) gray[y * width + x] = 0;
    }
  };
  const defsEnd = svg.indexOf('</defs>');
  const body = defsEnd >= 0 ? svg.slice(defsEnd) : svg;
  // Linien
  for (const m of body.matchAll(/<path d="M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[ ,]+(-?[\d.]+)"[^>]*?(?:stroke-width="([\d.]+)")?[^>]*>/g)) {
    const [x0, y0, x1, y1] = [m[1], m[2], m[3], m[4]].map(Number);
    if (y0 === y1) put(x0 * scale + dx, y0 * scale + dy - 0.4, x1 * scale + dx, y0 * scale + dy + 0.4);
    else if (x0 === x1) put(x0 * scale + dx - 0.4, Math.min(y0, y1) * scale + dy, x0 * scale + dx + 0.4, Math.max(y0, y1) * scale + dy);
  }
  // Zeichen: Kasten über dem Ankerpunkt (Notenkopf ≈ 1,2 sp breit, 1 sp hoch)
  for (const m of body.matchAll(/<use[^>]*?\sx="(-?[\d.]+)"[^>]*?\sy="(-?[\d.]+)"[^>]*>/g)) {
    const x = Number(m[1]) * scale + dx;
    const y = Number(m[2]) * scale + dy;
    put(x, y - 90 * scale, x + 216 * scale, y + 90 * scale);
  }
  return Promise.resolve({ width, height, gray });
}
