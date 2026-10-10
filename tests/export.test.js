import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange } from '../src/arrange/engine.js';
import { exportMusicXML } from '../src/output/musicxml.js';
import { exportMidi } from '../src/output/midi.js';
import { parseMidi } from '../src/input/midi.js';
import { songFromMusicXML } from '../src/input/musicxml.js';
import { printedMeasures, playbackOrder, timelineToPrinted } from '../src/output/form.js';
import { planMarkdown } from '../src/output/report.js';
import { zip, unzip } from '../src/core/zip.js';
import { STYLE_LIST } from '../src/arrange/styles.js';
import { demoSong, measureDurations } from './helpers.js';

test('MusicXML: jeder Takt jeder Stimme ist vollständig', () => {
  for (const { id: style } of STYLE_LIST) {
    for (const id of ['saints', 'grace']) {
      const a = arrange(demoSong(id), { style, drums: true, seed: 4 });
      const xmls = [exportMusicXML(a, { mode: 'score' }), ...[0, 1, 2, 3, 'drums'].map((i) => exportMusicXML(a, { mode: 'part', partIndex: i }))];
      for (const x of xmls) for (const m of measureDurations(x)) assert.equal(m.dur, m.expected, `${style}/${id} ${m.part} T.${m.measure} Stimme ${m.voice}`);
    }
  }
});

test('Einzelstimmen: transponiert, ohne Instrumentennamen vor den Systemen', () => {
  const a = arrange(demoSong('saints'), { voices: ['trumpet', 'altoSax', 'horn', 'tuba'], seed: 1 });
  const trp = exportMusicXML(a, { mode: 'part', partIndex: 0 });
  assert.match(trp, /<chromatic>-2<\/chromatic>/);
  assert.match(trp, /<part-name print-object="no">/);
  assert.match(exportMusicXML(a, { mode: 'part', partIndex: 1 }), /<chromatic>-9<\/chromatic>/);
  assert.match(exportMusicXML(a, { mode: 'part', partIndex: 2 }), /<chromatic>-7<\/chromatic>/);
});

test('Gedruckte Form (Segno/Coda/Wiederholung) ergibt exakt den gespielten Ablauf', () => {
  for (const { id: style } of STYLE_LIST) {
    const a = arrange(demoSong('saints'), { style, seed: 2 });
    const pr = printedMeasures(a);
    const order = playbackOrder(pr);
    const t2p = timelineToPrinted(a, pr);
    const idx = new Map(pr.map((m, i) => [m.src, i]));
    assert.equal(order.length, a.totalBars, style);
    order.forEach((src, k) => assert.equal(idx.get(src), t2p(k), `${style}: Takt ${k}`));
  }
});

test('MusicXML-Rückimport liefert Melodie und Akkorde', () => {
  const a = arrange(demoSong('ode'), { style: 'classical', seed: 1 });
  const s = songFromMusicXML(exportMusicXML(a, { mode: 'part', partIndex: 0 }));
  assert.ok(s.melody.length > 20);
  assert.ok(s.chords.length > 0);
});

test('MIDI-Export ist lesbar (Spuren, Tempo)', () => {
  const a = arrange(demoSong('saints'), { drums: true, seed: 1 });
  const p = parseMidi(exportMidi(a));
  assert.equal(p.tracks.length, 6);
  assert.ok(p.meta.tempo > 0);
  assert.ok(p.tracks.slice(1).every((t) => t.notes.length > 0));
});

test('ZIP schreiben & lesen', async () => {
  const z = zip([{ name: 'a.txt', data: 'Hallo NoteCode' }]);
  const files = await unzip(z);
  assert.equal(new TextDecoder().decode(files.get('a.txt')), 'Hallo NoteCode');
});

test('Regieplan enthält Formverlauf und Qualitätsbericht', () => {
  const md = planMarkdown(arrange(demoSong('groove'), { seed: 1 }));
  assert.match(md, /## Formverlauf/);
  assert.match(md, /## Qualitätsbericht/);
});

test('Schlagzeug als Drum-Chart: Groove ausgeschrieben, dann Slash-Takte (sim.), Fills markiert', () => {
  const a = arrange(demoSong('saints'), { drums: true, seed: 1 });
  const x = exportMusicXML(a, { mode: 'part', partIndex: 'drums' });
  assert.match(x, /<notehead>slash<\/notehead>/);
  assert.match(x, />sim\.</);
  assert.match(x, />Fill</);
  assert.match(x, /<part-name print-object="no">/);
  for (const m of measureDurations(x)) assert.equal(m.dur, m.expected, `T.${m.measure}`);
});
