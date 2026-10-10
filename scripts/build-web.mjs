// Statische Web-App nach www/ kopieren (für GitHub Pages / Handy-App).
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.argv[2] || 'www');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'app.css', 'icon.svg', 'manifest.webmanifest', 'config.js', 'sw.js', 'version.json', 'icons', 'src', 'vendor']) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(out, f), { recursive: true });
}
console.log('Web-App kopiert nach', out);
