// Notenerkennung im Desktop-Hauptprozess (electron/omr.cjs) mit einer Attrappe statt dem echten homr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const omr = require('../electron/omr.cjs');

const XML = '<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list><part id="P1"><measure number="1"/></part></score-partwise>';

// Attrappe: [node, Skript] – das Skript liest das Bild, meldet zwei Notenzeilen und schreibt <bild>.musicxml
function fakeHomr(dir, { fail = false } = {}) {
  const script = join(dir, 'fake-homr.cjs');
  const lines = [
    "const fs = require('fs');",
    'const p = process.argv[2];',
    "if (p === '--help') { console.log('usage: homr [image]'); process.exit(0); }",
    "process.stderr.write('Running TrOmr inference on staff image 0\\n');",
    "process.stderr.write('Running TrOmr inference on staff image 1\\n');",
    fail ? 'process.exit(3);' : `fs.writeFileSync(p.replace(/\\.[^.]+$/, '') + '.musicxml', ${JSON.stringify(XML)});`,
  ];
  writeFileSync(script, lines.join('\n') + '\n');
  return [process.execPath, script];
}

test('Notenerkennung: Zustand und Lauf mit Attrappe, Fortschritt je Notenzeile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omr-test-'));
  try {
    const exe = fakeHomr(dir);
    const st = await omr.status({ exe });
    assert.equal(st.available, true);
    assert.equal(st.desktop, true);
    const seen = [];
    const r = await omr.recognize(new Uint8Array([137, 80, 78, 71]), { ext: 'png', exe, onProgress: (f, t) => seen.push([f, t]) });
    assert.match(r.xml, /<score-partwise/);
    assert.ok(seen.some(([, t]) => /Notenzeile 2/.test(t)), JSON.stringify(seen));
    assert.equal(seen[seen.length - 1][0], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Notenerkennung: Fehlschlag und nicht eingerichtet werden verständlich gemeldet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omr-test-'));
  try {
    const exe = fakeHomr(dir, { fail: true });
    await assert.rejects(() => omr.recognize(new Uint8Array([1, 2, 3]), { exe }), /fehlgeschlagen/);
    const none = await omr.status({ exe: join(dir, 'gibt-es-nicht') });
    assert.equal(none.available, false);
    assert.equal(omr.progressFrom('Running TrOmr inference on staff image 2').staff, 3);
    assert.equal(omr.progressFrom('nichts'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
