import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, INSTRUMENTS } from '../src/arrange/instruments.js';
import { resizeVoices, presetVoices, matchingPreset, carryPerVoice, voiceRole, ensembleName, MIN_VOICES, MAX_VOICES } from '../src/web/voices.js';
import { groupLibrary, mergeFolders, sameFolders, songKey, uniqueFolderName } from '../src/web/folders.js';

test('Besetzung: jede Vorlage lässt sich auf 2–8 Stimmen bringen', () => {
  for (const p of PRESETS) {
    for (let n = MIN_VOICES; n <= MAX_VOICES; n++) {
      const v = presetVoices(p, n);
      assert.equal(v.length, n, `${p.id} mit ${n} Stimmen`);
      for (const id of v) assert.ok(INSTRUMENTS[id], `${id} ist ein Instrument`);
      assert.equal(v[0], p.voices[0], 'die Oberstimme bleibt');
      assert.equal(matchingPreset(v)?.voices.join(), presetVoices(matchingPreset(v), 4).join());
    }
    assert.deepEqual(presetVoices(p, 4), p.voices);
  }
});

test('Besetzung: + und − heben sich bei Vorlagen auf, eigene Besetzung verliert die letzte Stimme', () => {
  const base = ['trumpet', 'trumpet', 'trombone', 'sousaphone'];
  let v = base;
  for (let n = 5; n <= 8; n++) v = resizeVoices(v, n);
  assert.equal(v.length, 8);
  for (let n = 7; n >= 4; n--) v = resizeVoices(v, n);
  assert.deepEqual(v, base);
  const own = ['flute', 'trumpet', 'violin', 'tuba'];
  assert.deepEqual(resizeVoices(own, 3), ['flute', 'trumpet', 'violin']);
  const bigger = resizeVoices(own, 6);
  assert.equal(bigger.length, 6);
  assert.equal(bigger[0], 'flute');
  assert.equal(resizeVoices(own, 1).length, MIN_VOICES);
  assert.equal(resizeVoices(own, 12).length, MAX_VOICES);
});

test('Besetzung: Feineinstellungen wandern mit ihrem Instrument', () => {
  const vals = carryPerVoice(['trumpet', 'trumpet', 'trombone', 'sousaphone'], ['trumpet', 'trumpet', 'horn', 'trombone', 'sousaphone'], [1, 2, 3, 4]);
  assert.deepEqual(vals, [1, 2, null, 3, 4]);
  assert.equal(voiceRole(0, 4), 'Sopran');
  assert.equal(voiceRole(7, 8), 'Bass');
  assert.equal(ensembleName(5), 'Quintett');
});

test('Bibliothek: gleiche Lieder werden automatisch zusammengefasst, eigene Ordner haben Vorrang', () => {
  const items = [
    { id: 'a', title: 'Mario – Funk', songTitle: 'Super Mario Bros. Theme Song' },
    { id: 'b', title: 'Mario – Jazz', songTitle: ' super mario bros. theme song ' },
    { id: 'c', title: 'Mario – Klassik', songTitle: 'Super Mario Bros. Theme Song', folder: 'f1' },
    { id: 'd', title: 'Ode an die Freude' },
    { id: 'e', title: 'Unbekannt', folder: 'f-fremd' },
    { id: 'f', title: 'Weg', folder: 'f-del' },
    { id: 'g', title: 'Mario – Brass', source: { song: { title: 'Super Mario Bros. Theme Song' } } },
  ];
  const folders = [
    { id: 'f1', name: 'Konzert', updatedAt: '2026-01-01' },
    { id: 'f-del', name: 'Alt', deleted: true, updatedAt: '2026-01-02' },
  ];
  const g = groupLibrary(items, folders);
  assert.deepEqual(
    g.folders.map((f) => [f.id, f.items.map((x) => x.id)]),
    [
      ['f1', ['c']],
      ['f-fremd', ['e']],
    ],
  );
  assert.equal(g.folders[1].missing, true);
  assert.equal(g.auto.length, 1);
  assert.equal(g.auto[0].name, 'Super Mario Bros. Theme Song');
  assert.deepEqual(
    g.auto[0].items.map((x) => x.id),
    ['a', 'b', 'g'],
  );
  assert.deepEqual(
    g.loose.map((x) => x.id),
    ['d', 'f'],
  );
  assert.equal(songKey({ title: '  Hallo  Welt ' }), 'hallo welt');
});

test('Bibliothek: Ordnerlisten zweier Geräte – der neueste Stand gewinnt, Löschungen bleiben gelöscht', () => {
  const a = [
    { id: '1', name: 'Probe', createdAt: '1', updatedAt: '2026-01-01' },
    { id: '2', name: 'Konzert', createdAt: '2', updatedAt: '2026-01-05' },
  ];
  const b = [
    { id: '1', name: 'Probe neu', createdAt: '1', updatedAt: '2026-01-03' },
    { id: '2', name: 'Konzert', createdAt: '2', updatedAt: '2026-01-04', deleted: true },
    { id: '3', name: 'Sommer', createdAt: '3', updatedAt: '2026-01-02' },
  ];
  const m = mergeFolders(a, b);
  assert.deepEqual(
    m.map((f) => [f.id, f.name, !!f.deleted]),
    [
      ['1', 'Probe neu', false],
      ['2', 'Konzert', false],
      ['3', 'Sommer', false],
    ],
  );
  assert.ok(sameFolders(m, mergeFolders(b, a)));
  assert.equal(uniqueFolderName([{ id: 'x', name: 'Neuer Ordner' }]), 'Neuer Ordner 2');
});
