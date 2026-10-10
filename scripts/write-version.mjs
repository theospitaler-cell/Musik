// version.json für die App (Anzeige & In-App-Updates). In GitHub Actions: Build-Nummer = Lauf-Nummer.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const build = Number(process.env.GITHUB_RUN_NUMBER || 0);
const [maj, min] = pkg.version.split('.');
const info = {
  version: build ? `${maj}.${min}.${build}` : pkg.version,
  build,
  sha: (process.env.GITHUB_SHA || '').slice(0, 7),
  date: new Date().toISOString(),
};
writeFileSync(join(root, 'version.json'), JSON.stringify(info, null, 2) + '\n');
console.log('version.json', info);
