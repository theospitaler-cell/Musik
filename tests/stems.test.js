// Spurentrennung (Demucs): Modus & Hardware, WAV, Noten der Stems, Stimmentrennung mit Stems,
// Desktop-Hauptprozess mit einer Python-Attrappe, Einrichtungs-Skript.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STEM_MODES, normalizeStemMode, describeHardware, resolveStemPlan, parseWav, encodeWav16, mergeStemNotes } from '../src/input/stems.js';
import { separateVoices, cleanPoly, tidyAiNotes } from '../src/input/voices.js';
import { chooseTorchIndex, parseNvidiaSmi } from '../scripts/setup-demucs.mjs';
import { loadSettings, DEFAULT_SETTINGS } from '../src/web/settings.js';

const require = createRequire(import.meta.url);
const stemsMain = require('../electron/stems.cjs');

const GPU = { name: 'NVIDIA GeForce RTX 5060', driver: '610.88', memoryMB: 8151 };
const desktop = (o = {}) => ({ desktop: true, gpu: GPU, python: '3.12.4', demucs: { version: '4.0.1' }, cuda: true, device: GPU.name, ...o });

test('Modus: Automatisch ist Standard, drei Auswahlmöglichkeiten', () => {
  assert.deepEqual(STEM_MODES.map((m) => m.id), ['auto', 'force', 'off']);
  assert.equal(normalizeStemMode('quatsch'), 'auto');
  assert.equal(DEFAULT_SETTINGS.stemsMode, 'auto');
});

test('Plan: GPU nutzen falls vorhanden, Erzwingen auch auf CPU, Deaktiviert nie', () => {
  assert.deepEqual(resolveStemPlan('auto', desktop()), { use: true, device: 'cuda', reason: null });
  const cpu = desktop({ gpu: null, cuda: false, device: null });
  const auto = resolveStemPlan('auto', cpu);
  assert.equal(auto.use, false);
  assert.match(auto.reason, /Grafikkarte/);
  assert.deepEqual(resolveStemPlan('force', cpu), { use: true, device: 'cpu', reason: null });
  assert.equal(resolveStemPlan('off', desktop()).use, false);
  // GPU da, aber PyTorch ohne CUDA: automatisch nicht, erzwungen auf dem Prozessor
  const noCuda = desktop({ cuda: false, device: null });
  assert.equal(resolveStemPlan('auto', noCuda).use, false);
  assert.equal(resolveStemPlan('force', noCuda).device, 'cpu');
  // Demucs nicht eingerichtet: Rückfall auf die direkte Analyse mit Hinweis, auch beim Erzwingen
  const missing = desktop({ demucs: null, cuda: false });
  for (const m of ['auto', 'force']) {
    const p = resolveStemPlan(m, missing);
    assert.equal(p.use, false);
    assert.match(p.reason, /nicht eingerichtet/);
  }
  // Browser/Handy: still die direkte Analyse
  assert.deepEqual(resolveStemPlan('auto', { desktop: false }), { use: false, device: null, reason: null });
  assert.deepEqual(resolveStemPlan('force', null), { use: false, device: null, reason: null });
});

test('Hardware-Anzeige: erkannte Grafikkarte, CUDA-Zustand, fehlendes Python/Demucs', () => {
  assert.match(describeHardware(desktop()).text, /GPU erkannt: NVIDIA GeForce RTX 5060.*CUDA aktiv/);
  assert.match(describeHardware(desktop({ cuda: false })).text, /ohne CUDA/);
  assert.match(describeHardware(desktop({ gpu: null, cuda: false })).text, /Nur CPU verfügbar/);
  assert.match(describeHardware(desktop({ python: null, demucs: null })).text, /Python wurde nicht gefunden/);
  assert.match(describeHardware(desktop({ demucs: null, cuda: false })).text, /nicht installiert/);
  assert.match(describeHardware({ desktop: false }).text, /Desktop-App/);
});

test('WAV: 16 Bit schreiben und lesen, Float32 und 24 Bit lesen', () => {
  const n = 1000;
  const l = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 20) * 0.5);
  const r = Float32Array.from({ length: n }, (_, i) => Math.cos(i / 20) * 0.25);
  const back = parseWav(encodeWav16([l, r], 44100));
  assert.equal(back.sampleRate, 44100);
  assert.equal(back.channels.length, 2);
  assert.equal(back.channels[0].length, n);
  assert.ok(Math.abs(back.channels[0][123] - l[123]) < 1e-3);
  assert.ok(Math.abs(back.channels[1][500] - r[500]) < 1e-3);
  // Float32 (so schreibt Demucs mit --float32)
  const f = floatWav([l], 22050);
  const fb = parseWav(f);
  assert.equal(fb.sampleRate, 22050);
  assert.ok(Math.abs(fb.channels[0][77] - l[77]) < 1e-6);
  assert.throws(() => parseWav(new Uint8Array(10)), /WAV/);
});

function floatWav(chs, sr) {
  const ch = chs.length;
  const n = chs[0].length;
  const b = Buffer.alloc(44 + n * ch * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * ch * 4, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20);
  b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * ch * 4, 28);
  b.writeUInt16LE(ch * 4, 32);
  b.writeUInt16LE(32, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * ch * 4, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) b.writeFloatLE(chs[c][i], 44 + (i * ch + c) * 4);
  return new Uint8Array(b);
}

test('Stem-Noten: Bass nur aus dem Bass-Stem, Durchsprechen entfällt, Schlagzeug fehlt', () => {
  const note = (start, midi, amp = 0.7) => ({ start, end: start + 0.4, midi, amp });
  const merged = mergeStemNotes({
    vocals: [note(1, 72), note(2, 40)], // 40 im Gesang = Durchsprechen des Basses
    other: [note(1, 72), note(3, 60), note(4, 45)], // 72 doppelt (Gesang gewinnt), 45 = Bass-Rest
    bass: [note(2, 40), note(4, 45), note(5, 90)], // 90 ist kein Bass-Ton
    drums: [note(0, 38)], // wird ignoriert
  });
  const by = (stem) => merged.filter((n) => n.stem === stem).map((n) => `${n.start}:${n.midi}`);
  assert.deepEqual(by('bass'), ['2:40', '4:45']);
  assert.deepEqual(by('vocals'), ['1:72']);
  assert.deepEqual(by('other'), ['3:60']);
  assert.equal(merged.length, 4);
});

test('Stimmentrennung mit Stems: Bass kommt aus dem Bass-Stem, Melodie bevorzugt den Gesang', () => {
  const notes = [];
  for (let b = 0; b < 8; b++) {
    const t = b * 96;
    notes.push({ start: t, dur: 48, midi: 36 + (b % 2) * 7, amp: 0.8, stem: 'bass' });
    notes.push({ start: t + 48, dur: 48, midi: 36 + (b % 2) * 7, amp: 0.8, stem: 'bass' });
    // Gitarre ("other") ist lauter und höher als der Gesang – ohne Stems würde sie die Melodie
    notes.push({ start: t, dur: 48, midi: 79, amp: 0.9, stem: 'other' });
    notes.push({ start: t, dur: 48, midi: 72, amp: 0.6, stem: 'vocals' });
    // ein tiefer Gitarrenton unter der „Basslage“ bleibt Mittelstimme statt zu verschwinden
    notes.push({ start: t + 48, dur: 24, midi: 45, amp: 0.5, stem: 'other' });
  }
  const vs = separateVoices(cleanPoly(notes), { beat: 24, mt: 96 });
  assert.ok(vs.bass.length >= 8 && vs.bass.every((n) => n.midi < 50), 'Bass aus dem Bass-Stem');
  const voc = vs.melody.filter((n) => n.midi === 72).length;
  assert.ok(voc >= 6, `Gesang trägt die Melodie (${voc} von 8)`);
  assert.ok(vs.inner.flat().some((n) => n.midi === 45), 'tiefer Gitarrenton bleibt als Mittelstimme erhalten');
  // ohne Stem-Angabe bleibt alles wie bisher
  const plain = separateVoices(cleanPoly(notes.map(({ stem, ...n }) => n)), { beat: 24, mt: 96 });
  assert.ok(plain.melody.length > 0 && plain.bass.length > 0);
});

test('Glättung: gleiche Töne verschiedener Stems werden nicht zu einem verschmolzen', () => {
  const ai = [
    { start: 1, end: 1.5, midi: 60, amp: 0.7, stem: 'vocals' },
    { start: 1.52, end: 2, midi: 60, amp: 0.7, stem: 'other' },
  ];
  const out = tidyAiNotes(ai); // ohne Audio: Halte-Regel gilt erst ab 0,4 s – hier greifen beide
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((n) => n.stem).sort(), ['other', 'vocals']);
});

// ---- Hauptprozess: Python-Attrappe (Node-Skript statt echtem Python/Demucs)
function fakePython(dir, { failCuda = false } = {}) {
  const script = join(dir, 'fakepy.cjs');
  writeFileSync(
    script,
    `
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
if (a[0] === '-c') {
  console.log('NOTECODE_PROBE ' + JSON.stringify({ python: '3.12.0', demucs: '4.0.1', torch: '2.8.0', cuda: true, device: 'Fake GPU' }));
  process.exit(0);
}
if (a[0] === '-m' && a[1] === 'demucs.separate') {
  const get = (f) => a[a.indexOf(f) + 1];
  const dev = get('-d'); const out = get('-o'); const input = a[a.length - 1];
  if (dev === 'cuda' && ${failCuda}) { console.error('CUDA out of memory'); process.exit(1); }
  const sr = 44100, n = sr * 2;
  const wav = (f) => {
    const b = Buffer.alloc(44 + n * 8);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(3, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 8, 28);
    b.writeUInt16LE(8, 32); b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(n * 8, 40);
    for (let i = 0; i < n; i++) { const v = 0.3 * Math.sin(2 * Math.PI * f * i / sr); b.writeFloatLE(v, 44 + i * 8); b.writeFloatLE(v, 48 + i * 8); }
    return b;
  };
  const dir = path.join(out, get('-n'), path.basename(input, '.wav'));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, f] of [['vocals', 440], ['drums', 200], ['bass', 110], ['other', 330]]) fs.writeFileSync(path.join(dir, name + '.wav'), wav(f));
  console.error('  50%|#####     | 1/2');
  console.error('100%|##########| 2/2');
  console.error('device=' + dev);
  process.exit(0);
}
process.exit(2);
`,
  );
  return { cmd: process.execPath, args: [script] };
}

test('Hauptprozess: Zustand (GPU, Python, Demucs, CUDA) über die Attrappe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nc-fakepy-'));
  try {
    const st = await stemsMain.status({ python: fakePython(dir) });
    assert.equal(st.desktop, true);
    assert.equal(st.python, '3.12.0');
    assert.deepEqual(st.demucs, { version: '4.0.1' });
    assert.equal(st.cuda, true);
    assert.equal(st.device, 'Fake GPU');
    assert.ok(Array.isArray(st.pythonCmd));
    // kein Python: ehrlicher Zustand statt Absturz
    const none = await stemsMain.status({ python: { cmd: 'notecode-gibt-es-nicht', args: [] } });
    assert.equal(none.python, null);
    assert.equal(none.demucs, null);
    assert.equal(none.cuda, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Hauptprozess: Trennen liefert Gesang, Bass und Rest als 22,05-kHz-Mono; CUDA-Fehler -> Prozessor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nc-fakepy-'));
  try {
    const n = 44100 * 2;
    const wav = encodeWav16([new Float32Array(n), new Float32Array(n)], 44100);
    const prog = [];
    const ok = await stemsMain.separate(wav, { device: 'cuda', python: fakePython(dir), onProgress: (f, t) => prog.push([f, t]) });
    assert.equal(ok.device, 'cuda');
    assert.equal(ok.sampleRate, 22050);
    assert.deepEqual(Object.keys(ok.stems).sort(), ['bass', 'other', 'vocals']);
    assert.ok(ok.stems.vocals instanceof Float32Array);
    assert.ok(Math.abs(ok.stems.vocals.length - 44100) < 4, `Länge ${ok.stems.vocals.length}`);
    assert.ok(prog.some(([f]) => f >= 0.5) && prog.at(-1)[0] === 1, 'Fortschritt aus der Demucs-Ausgabe');
    // der Bass-Stem (110 Hz) hat Energie, Nulleingang spielt keine Rolle (Attrappe)
    const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    assert.ok(rms(ok.stems.bass) > 0.1);
    // CUDA scheitert (Speicher) -> derselbe Lauf auf dem Prozessor
    const fb = await stemsMain.separate(wav, { device: 'cuda', python: fakePython(dir, { failCuda: true }) });
    assert.equal(fb.device, 'cpu');
    // ohne Python: klare Fehlermeldung
    await assert.rejects(() => stemsMain.separate(wav, { device: 'cpu', python: { cmd: 'notecode-gibt-es-nicht', args: [] } }), /Demucs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Einrichtung: passender PyTorch-Index (RTX 50xx braucht cu128) und nvidia-smi-Ausgabe', () => {
  assert.equal(chooseTorchIndex({ gpu: 'NVIDIA GeForce RTX 5060', computeCap: '12.0', driverMajor: 610 }).tag, 'cu128');
  assert.equal(chooseTorchIndex({ gpu: 'NVIDIA GeForce RTX 4070', computeCap: '8.9', driverMajor: 551 }).tag, 'cu124');
  assert.equal(chooseTorchIndex({ gpu: 'GTX 1060', computeCap: '6.1', driverMajor: 470 }).tag, 'cu121');
  assert.equal(chooseTorchIndex({}).tag, 'cpu');
  assert.match(chooseTorchIndex({ gpu: 'x', computeCap: '8.6', driverMajor: 551 }).index, /download\.pytorch\.org\/whl\/cu124$/);
  const g = parseNvidiaSmi('NVIDIA GeForce RTX 5060, 610.88, 12.0, 8151\n');
  assert.deepEqual(g, { name: 'NVIDIA GeForce RTX 5060', driver: '610.88', driverMajor: 610, computeCap: '12.0', memoryMB: 8151 });
  assert.equal(parseNvidiaSmi(''), null);
});

test('Einstellungen: Aufwand immer Maximum (außer in den Einstellungen gewählt), Stil immer automatisch', async () => {
  const local = (saved) => ({ getKV: async () => saved });
  const fresh = await loadSettings(local({}));
  assert.equal(fresh.effort, 5);
  assert.equal(fresh.defaultStyle, 'auto');
  // ein alter Stand mit Aufwand 3 (damals über den Regler im Arbeitsbereich) wird wieder Maximum …
  const old = await loadSettings(local({ effort: 3, defaultStyle: 'funk' }));
  assert.equal(old.effort, 5);
  assert.equal(old.defaultStyle, 'auto');
  // … außer er wurde bewusst in den Einstellungen gewählt
  const chosen = await loadSettings(local({ effort: 2, effortChosen: true }));
  assert.equal(chosen.effort, 2);
});
