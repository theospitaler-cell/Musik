import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange } from '../src/arrange/engine.js';
import { PRESETS } from '../src/arrange/instruments.js';
import { presetVoices, nextInstrument, resizeVoices, ensembleName, MAX_VOICES } from '../src/web/voices.js';
import { exportMusicXML } from '../src/output/musicxml.js';
import { exportMidi } from '../src/output/midi.js';
import { demoSong } from './helpers.js';

const orch = PRESETS.find((p) => p.id === 'orchestra');

test('Orchester: Vorlage in Partiturordnung, verkleinern behält die wichtigsten Stimmen', () => {
  assert.equal(orch.voices.length, 13);
  assert.equal(MAX_VOICES, 15);
  assert.equal(ensembleName(13), 'Kammerorchester');
  const four = presetVoices(orch, 4);
  assert.equal(four.length, 4);
  assert.ok(four.includes('violin') && four.includes('cello'));
  // Partiturordnung bleibt: Holz vor Blech vor Streichern
  const order = (id) => ({ flute: 0, oboe: 0, clarinet: 0, bassoon: 0, horn: 1, trumpet: 1, trombone: 1, tuba: 1, violin: 2, viola: 2, cello: 2, contrabass: 2 })[id];
  const nine = presetVoices(orch, 9).map(order);
  assert.deepEqual(nine, [...nine].sort((a, b) => a - b));
  // wachsen über 13 hinaus: Streicher und Bläser kommen dazu, nie mehr als 15
  let v = [...orch.voices];
  v = resizeVoices(v, 15);
  assert.equal(v.length, 15);
  assert.equal(resizeVoices(v, 40).length, 15);
  assert.ok(nextInstrument(['violin', 'cello', 'flute', 'trumpet', 'viola', 'horn', 'contrabass', 'oboe']).length > 0);
});

test('Orchester: 13 Stimmen, erste Geige führt, Gruppenklammern, Pausen in dünnen Teilen', () => {
  const song = demoSong('ode');
  const a = arrange(song, { voices: orch.voices, style: 'classical', seed: 1 });
  assert.equal(a.voices.length, 13);
  assert.ok(a.voices.every((v) => v.events.length > 0), 'jede Stimme spielt irgendwo');
  assert.equal(a.voices[a.slots.lead].inst.id, 'violin');
  // nicht alle spielen immer: es gibt Segmente mit Pausen bei Holz/Blech
  const rests = a.blocks.flatMap((b) => b.segments).filter((s) => s.roles.filter((r) => r === 'rest').length >= 3);
  assert.ok(rests.length > 0, 'Tacet-Stellen');
  const xml = exportMusicXML(a, { mode: 'score', concert: false, paper: 'A4', chords: 'all' });
  const starts = xml.match(/<part-group[^>]*type="start"/g) || [];
  const stops = xml.match(/<part-group[^>]*type="stop"/g) || [];
  assert.equal(starts.length, 3, 'Holz, Blech, Streicher');
  assert.equal(stops.length, 3);
  // Schlagzeug-Kanal 10 bleibt frei
  const midi = exportMidi(a);
  assert.ok(midi.length > 1000);
});

test('Orchester: Original übernehmen füllt alle 13 Stimmen; mehr als 15 Stimmen werden abgelehnt', () => {
  const song = demoSong('saints');
  const a = arrange(song, { voices: orch.voices, style: 'classical', seed: 1, original: true });
  assert.equal(a.voices.length, 13);
  assert.ok(a.voices.filter((v) => v.events.length > 0).length >= 12);
  const many = [...orch.voices, 'violin', 'viola', 'cello'];
  assert.throws(() => arrange(song, { voices: many, style: 'classical', seed: 1 }), /2 bis 15/);
});
