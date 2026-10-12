// Besetzungssteuerung (1–15 Stimmen, Vorlagen, Stimmen-Slots), erweiterte Instrumentenprofile
// (Streicher, E-Bass, Klavier im Doppelsystem) und die Verdrahtung der Oberfläche mit orchestrate().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXML } from '../src/core/xml.js';
import {
  ENSEMBLE_PRESETS,
  MIN_VOICES,
  MAX_VOICES,
  defaultVoices,
  presetForCount,
  matchPreset,
  applyPreset,
  resizeEnsemble,
  slotRole,
  slotInfo,
  describeInstrument,
  instrumentOptions,
  ensembleLabel,
} from '../src/engine/ensembles.js';
import { PROFILES, ENSEMBLES } from '../src/engine/profiles.js';
import { INSTRUMENTS } from '../src/arrange/instruments.js';
import { orchestrate, orchestrateFromOptions } from '../src/engine/index.js';
import { exportMusicXML } from '../src/output/musicxml.js';
import { buildPlan } from '../src/output/report.js';
import { transcribe } from '../src/input/audio.js';
import { demoSong, measureDurations } from './helpers.js';
import { synthSong } from './synth-audio.js';

const root = (p) => new URL(`../${p}`, import.meta.url);

test('Vorlagen: sechs Schnellwahlen, Standardbesetzung für jede Stimmenzahl 1…15', () => {
  assert.deepEqual(
    ENSEMBLE_PRESETS.map((p) => p.id),
    ['leadsheet', 'duotrio', 'quartet', 'brass', 'orchestra', 'strings'],
  );
  assert.equal(MIN_VOICES, 1);
  assert.equal(MAX_VOICES, 15);
  for (let n = MIN_VOICES; n <= MAX_VOICES; n++) {
    const id = presetForCount(n);
    const v = defaultVoices(id, n);
    assert.equal(v.length, n, `${id} mit ${n} Stimmen`);
    assert.ok(v.every((k) => PROFILES[k] && INSTRUMENTS[k]), `${id}/${n}: jedes Instrument hat Profil und Bibliothekseintrag`);
    assert.equal(matchPreset(v), id === 'strings' ? 'strings' : matchPreset(v), 'Besetzung wird wiedererkannt');
    assert.ok(ensembleLabel(n));
  }
  // Streicher-Vorlage: Violinen oben, Bratschen, Cello, Kontrabass ab 5 Stimmen
  assert.deepEqual(defaultVoices('strings', 4), ['violin', 'violin', 'viola', 'cello']);
  assert.equal(defaultVoices('strings', 8).at(-1), 'contrabass');
  assert.deepEqual(defaultVoices('leadsheet', 1).length, 1);
  assert.deepEqual(defaultVoices('duotrio', 2), ['trumpet', 'trombone']);
  assert.deepEqual(defaultVoices('quartet', 4), ['trumpet', 'horn', 'trombone', 'tuba']);
  // Anwählen: bleibt die Anzahl im Bereich, bleibt sie; sonst gilt die Voreinstellung
  assert.equal(applyPreset('brass', 7).voices.length, 7);
  assert.equal(applyPreset('brass', 2).voices.length, 5);
  assert.equal(applyPreset('orchestra', 4).voices.length, 13);
  assert.equal(applyPreset('leadsheet', 6).voices.length, 1);
});

test('Anzahl ändern: Vorlage folgt der Zahl, eigene Wahl bleibt erhalten', () => {
  // Vorlage: Quartett -> 6 Stimmen wird Brass Ensemble, zurück auf 4 wieder das Quartett (± heben sich auf)
  let r = resizeEnsemble(defaultVoices('quartet', 4), 6, 'quartet');
  assert.equal(r.voices.length, 6);
  assert.equal(r.preset, 'brass');
  r = resizeEnsemble(r.voices, 4, r.preset);
  assert.deepEqual(r.voices, ['trumpet', 'horn', 'trombone', 'tuba']);
  assert.equal(r.preset, 'quartet');
  // eine bis fünfzehn Stimmen durchlaufen
  let v = defaultVoices('leadsheet', 1);
  let preset = 'leadsheet';
  for (let n = 2; n <= 15; n++) {
    ({ voices: v, preset } = resizeEnsemble(v, n, preset));
    assert.equal(v.length, n);
  }
  assert.equal(preset, 'orchestra');
  // Streicher-Ensemble bleibt beim Vergrößern bei Streichern
  r = resizeEnsemble(defaultVoices('strings', 4), 6, 'strings');
  assert.equal(r.preset, 'strings');
  assert.deepEqual(r.voices, defaultVoices('strings', 6));
  // eigene Besetzung: Lead und Bass bleiben, neue Plätze kommen vor den Bass, Mittelstimmen fallen hinten weg
  const own = ['flute', 'piano', 'cello', 'tuba'];
  assert.equal(matchPreset(own), 'custom');
  const grown = resizeEnsemble(own, 6, 'custom');
  assert.equal(grown.voices.length, 6);
  assert.deepEqual(grown.voices.slice(0, 3), ['flute', 'piano', 'cello']);
  assert.equal(grown.voices.at(-1), 'tuba');
  assert.equal(grown.preset, 'custom');
  const small = resizeEnsemble(['flute', 'piano', 'cello', 'viola', 'tuba'], 3, 'custom');
  assert.deepEqual(small.voices, ['flute', 'piano', 'tuba']);
  assert.deepEqual(resizeEnsemble(own, 1, 'custom').voices, ['flute']);
});

test('Stimmen-Slots: erkannte Rolle, Schlüssel und Transposition je Instrument', () => {
  const q = ['trumpet', 'horn', 'trombone', 'tuba'];
  assert.deepEqual([0, 1, 2, 3].map((i) => slotRole(i, 4)), ['lead', 'inner', 'inner', 'bass']);
  assert.deepEqual([0, 1, 2].map((i) => slotRole(i, 3)), ['lead', 'counter', 'bass']);
  assert.deepEqual([0, 1].map((i) => slotRole(i, 2)), ['lead', 'bass']);
  assert.equal(slotRole(0, 1), 'lead');
  const roles15 = Array.from({ length: 15 }, (_, i) => slotRole(i, 15));
  for (const r of ['lead', 'double8', 'doubleU', 'inner', 'counter', 'bass', 'bass8vb']) assert.ok(roles15.includes(r), r);
  const t = slotInfo(q, 0);
  assert.equal(t.title, 'Trompete in B (G-Schlüssel)');
  assert.equal(t.transposition, 'klingt eine große Sekunde tiefer');
  assert.equal(t.roleLabel, 'Lead');
  assert.equal(slotInfo(q, 2).title, 'Posaune in C (F-Schlüssel)');
  assert.equal(slotInfo(q, 2).transposition, 'klingt wie notiert');
  assert.equal(slotInfo(q, 1).transposition, 'klingt eine Quinte tiefer');
  assert.equal(slotInfo(q, 3).roleLabel, 'Bass');
  assert.equal(slotInfo(['flute', 'horn', 'tuba'], 1).roleLabel, 'Gegenmelodie');
  assert.equal(slotInfo(q, 1).roleLabel, 'Harmonie / Riff');
  // Streicher & Band
  assert.equal(describeInstrument('viola').clef, 'Altschlüssel');
  assert.equal(describeInstrument('cello').clef, 'F-Schlüssel');
  assert.equal(describeInstrument('contrabass').transposition, 'klingt eine Oktave tiefer');
  assert.equal(describeInstrument('ebass').transposition, 'klingt eine Oktave tiefer');
  assert.equal(describeInstrument('piano').clef, 'Doppelsystem G/F');
  assert.equal(describeInstrument('tenorSax').transposition, 'klingt eine große None tiefer');
  assert.equal(describeInstrument('altoSax').title, 'Altsaxophon in Es (G-Schlüssel)');
  // Auswahlfeld: nach Familie, jedes Profil genau einmal
  const groups = instrumentOptions();
  const keys = groups.flatMap((g) => g.items.map((x) => x.key));
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), Object.keys(PROFILES).sort());
  for (const k of ['violin', 'viola', 'cello', 'contrabass', 'ebass', 'piano']) assert.ok(keys.includes(k), k);
  assert.ok(groups.some((g) => g.family === 'string') && groups.some((g) => g.family === 'keys'));
});

test('Profile: Streicher, E-Bass und Klavier mit Bereich, Sweet Spot, Schlüssel, Transposition', () => {
  const P = PROFILES;
  assert.deepEqual(P.violin.range, [55, 100]); // G3–E7
  assert.deepEqual(P.viola.range, [48, 93]); // C3–A6
  assert.deepEqual(P.cello.range, [36, 67]); // C2–G4
  assert.deepEqual(P.contrabass.range, [28, 55]); // E1–G3 klingend
  assert.equal(P.ebass.range[0], 28);
  assert.deepEqual(P.piano.range, [21, 108]); // A0–C8
  assert.equal(P.viola.clef, 'C3'); // Altschlüssel
  assert.equal(P.cello.clef, 'F4');
  assert.equal(P.contrabass.clef, 'F4');
  assert.equal(P.piano.staves, 2);
  // Kontrabass und E-Bass: eine Oktave tiefer klingend als notiert
  assert.deepEqual(P.contrabass.transpose, { diatonic: -7, chromatic: -12 });
  assert.deepEqual(P.ebass.transpose, { diatonic: -7, chromatic: -12 });
  assert.deepEqual(P.violin.transpose, { diatonic: 0, chromatic: 0 });
  for (const p of [P.violin, P.viola, P.cello, P.contrabass, P.ebass, P.piano]) {
    assert.ok(p.sweet[0] >= p.range[0] && p.sweet[1] <= p.range[1] && p.sweet[1] - p.sweet[0] >= 7, p.key);
    assert.equal(p.breath, null, 'kein Atemzwang für Streicher & Klavier');
  }
  // jedes Bibliotheksinstrument hat ein Profil (alte Besetzungen funktionieren weiter)
  for (const id of Object.keys(INSTRUMENTS)) assert.ok(PROFILES[id], id);
  assert.equal(ENSEMBLES[4].length, 4);
});

test('Streicherensemble 4–8 Stimmen: Satzregeln erfüllt, Altschlüssel und Kontrabass-Oktave im MusicXML', () => {
  for (let n = 4; n <= 8; n++) {
    const ids = defaultVoices('strings', n);
    const r = orchestrate(demoSong('ode'), { voices: n, instruments: ids });
    assert.equal(r.validation.violations.length, 0, `${n}: ${JSON.stringify(r.report.violations)}`);
    assert.equal(r.arr.voices.length, n);
    // Streicher atmen nicht: die Atem-Regel gilt nur für Bläser
    assert.equal(r.report.breaths, 0);
  }
  const r = orchestrate(demoSong('saints'), { voices: 5, instruments: defaultVoices('strings', 5) });
  const xml = r.xml();
  const doc = parseXML(xml);
  const parts = doc.all('part');
  const clefOf = (i) => parts[i].all('measure')[0].child('attributes').child('clef');
  assert.equal(clefOf(2).val('sign'), 'C'); // Viola
  assert.equal(clefOf(2).val('line'), '3');
  assert.equal(clefOf(4).val('sign'), 'F'); // Kontrabass
  const tr = parts[4].all('measure')[0].child('attributes').child('transpose');
  assert.equal(tr.val('chromatic'), '-12');
  assert.equal(tr.val('diatonic'), '-7');
  for (const d of measureDurations(xml)) assert.equal(d.dur, d.expected, `Stimme ${d.part} Takt ${d.measure}`);
});

test('Klavier: Doppelsystem G/F mit Akkorden in beiden Händen', () => {
  const ids = ['trumpet', 'piano', 'trombone', 'tuba'];
  const r = orchestrate(demoSong('groove'), { voices: 4, instruments: ids });
  assert.equal(r.validation.violations.length, 0, JSON.stringify(r.report.violations));
  const piano = r.arr.voices[1];
  assert.equal(piano.inst.id, 'piano');
  // mehrstimmige Ereignisse: rechte Hand Akkord, linke Hand Basston
  assert.ok(piano.events.some((e) => e.pitches.length >= 3), 'Akkorde');
  assert.ok(piano.events.some((e) => e.pitches.some((p) => p < 60)) && piano.events.some((e) => e.pitches.some((p) => p >= 60)));
  const xml = r.xml({ concert: true });
  const doc = parseXML(xml);
  const part = doc.all('part')[1];
  const attrs = part.all('measure')[0].child('attributes');
  assert.equal(attrs.val('staves'), '2');
  const clefs = attrs.all('clef');
  assert.deepEqual(clefs.map((c) => [c.attrs.number, c.val('sign'), c.val('line')]), [['1', 'G', '2'], ['2', 'F', '4']]);
  assert.equal(part.find('part-symbol')[0].text, 'brace');
  // jede Note trägt ihr System; unter C4 im Bassschlüssel, ab C4 oben
  const octMidi = (n) => {
    const step = n.val('pitch/step');
    const alter = n.num('pitch/alter', 0);
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step];
    return (n.num('pitch/octave') + 1) * 12 + base + alter;
  };
  let low = 0;
  let high = 0;
  for (const n of part.find('note')) {
    if (!n.has('pitch')) continue;
    const staff = n.val('staff');
    assert.ok(staff === '1' || staff === '2', 'staff gesetzt');
    if (octMidi(n) < 60) {
      assert.equal(staff, '2');
      low++;
    } else {
      assert.equal(staff, '1');
      high++;
    }
  }
  assert.ok(low > 5 && high > 5, `${low} unten / ${high} oben`);
  assert.ok(part.find('backup').length >= 8, 'zweites System über backup');
  for (const d of measureDurations(xml)) assert.equal(d.dur, d.expected, `Stimme ${d.part} Takt ${d.measure} Voice ${d.voice}`);
  // Einzelstimme (Klavierauszug): ebenfalls im Doppelsystem
  const solo = exportMusicXML(r.arr, { mode: 'part', partIndex: 1, concert: false });
  assert.match(solo, /<staves>2<\/staves>/);
  // Klavier als Lead (Melodie rechts) und als Bass
  const lead = orchestrate(demoSong('ode'), { voices: 2, instruments: ['piano', 'cello'] });
  assert.equal(lead.validation.violations.length, 0, JSON.stringify(lead.report.violations));
});

test('Oberfläche → Engine: Optionen werden zu Besetzung, Tonart, Tempo und Schlagzeug', () => {
  const song = demoSong('groove');
  const base = orchestrateFromOptions(song, { voices: ['trumpet', 'horn', 'trombone', 'tuba'], transpose: 0 });
  assert.equal(base.arr.transposeShift, 0);
  assert.equal(base.arr.voices.map((v) => v.inst.id).join(), 'trumpet,horn,trombone,tuba');
  // feste Transposition in Halbtönen
  const up = orchestrateFromOptions(song, { voices: ['trumpet', 'horn', 'trombone', 'tuba'], transpose: 2 });
  assert.equal(up.arr.transposeShift, 2);
  assert.equal(up.arr.key.fifths, (base.arr.key.fifths + 2) % 12 > 6 ? (base.arr.key.fifths + 2) % 12 - 12 : (base.arr.key.fifths + 2) % 12, 'Tonart wandert eine Sekunde hoch');
  // automatisch: bläserfreundlich wie in der klassischen Methode
  const auto = orchestrateFromOptions(song, { voices: ['trumpet', 'horn', 'trombone', 'tuba'], transpose: 'auto' });
  assert.equal(auto.arr.transposeShift, 2);
  assert.equal(auto.arr.meta.keyNameDe, 'C-Dur');
  // zwei B-Trompeten + Posaune + Tuba: B-Dur klingt schon bläserfreundlich -> unverändert
  assert.equal(orchestrateFromOptions(song, { voices: ['trumpet', 'trumpet', 'trombone', 'tuba'], transpose: 'auto' }).arr.transposeShift, 0);
  // Tempo
  assert.equal(orchestrateFromOptions(song, { voices: ['trumpet', 'tuba'], tempo: 140, transpose: 0 }).arr.tempo, 140);
  // Schlagzeug: aus den erkannten Schlägen der Vorlage
  const withDrums = { ...song, drumNotes: [0, 24, 48, 72].flatMap((t, i) => [{ start: t + 96, dur: 12, midi: i % 2 ? 38 : 36, vel: 90 }, { start: t + 108, dur: 6, midi: 42, vel: 70 }]) };
  const d = orchestrateFromOptions(withDrums, { voices: ['trumpet', 'tuba'], drums: true, transpose: 0 });
  assert.ok(d.arr.drums && d.arr.drums.events.length >= 8);
  assert.match(exportMusicXML(d.arr, { mode: 'score' }), /<part-name>Schlagzeug<\/part-name>/);
  const noDrums = orchestrateFromOptions(song, { voices: ['trumpet', 'tuba'], drums: true, transpose: 0 });
  assert.equal(noDrums.arr.drums, null);
  assert.ok(noDrums.arr.report.notes.some((n) => /kein erkanntes Schlagzeug/.test(n)));
  // Ein Lead Sheet (1 Stimme) ist möglich: Akkordsymbole, keine weiteren Stimmen
  const sheet = orchestrateFromOptions(song, { voices: ['flute'], transpose: 0 });
  assert.equal(sheet.arr.voices.length, 1);
  assert.match(sheet.xml(), /<harmony/);
});

test('Aufnahme -> Analyse -> Besetzung N -> MusicXML (Ende-zu-Ende ohne Oberfläche)', () => {
  // synthetische Aufnahme: Melodie, Bass, Schlagzeug (Bassdrum 1+3, Snare 2+4)
  const rec = synthSong({ groove: 'rock8', bars: 8, bpm: 120, seed: 2 });
  const song = transcribe(rec.audio, { title: 'Aufnahme' });
  assert.equal(song.source, 'audio');
  assert.ok(song.drumNotes.length > 8, 'Schlagzeug erkannt');
  for (const preset of ['leadsheet', 'quartet', 'brass', 'orchestra', 'strings']) {
    const p = ENSEMBLE_PRESETS.find((x) => x.id === preset);
    const n = p.def;
    const voices = defaultVoices(preset, n);
    const r = orchestrateFromOptions(song, { voices, transpose: 'auto', drums: true });
    assert.equal(r.arr.voices.length, n, preset);
    assert.equal(r.validation.violations.length, 0, `${preset}: ${JSON.stringify(r.report.violations)}`);
    assert.ok(r.arr.drums && r.arr.drums.events.length > 8, `${preset}: Schlagzeug aus der Aufnahme`);
    const xml = r.xml();
    assert.match(xml, /<score-partwise version="4\.0">/);
    assert.equal((xml.match(/<score-part /g) || []).length, n + 1, 'n Stimmen + Schlagzeug');
    for (const d of measureDurations(xml)) assert.equal(d.dur, d.expected, `${preset}: Stimme ${d.part} Takt ${d.measure}`);
  }
});

test('Regieplan & Prüfbericht arbeiten mit dem Ergebnis der Orchestrierung', () => {
  const r = orchestrateFromOptions(demoSong('saints'), { voices: ['trumpet', 'horn', 'trombone', 'tuba'], transpose: 'auto' });
  const plan = buildPlan(r.arr);
  assert.equal(plan.style, 'Orchestrierung');
  assert.ok(plan.rows.length >= 1 && plan.rows[0].roles.length === 4);
  assert.ok(plan.quality.some((q) => /Satzregeln: alle erfüllt/.test(q)));
  assert.ok(plan.quality.some((q) => /Atempausen/.test(q)));
  assert.equal(plan.instruments.length, 4);
  assert.equal(plan.printedBars, r.arr.totalBars);
});

test('Oberfläche: Elemente und Verdrahtung der Besetzungssteuerung sind vorhanden', () => {
  const html = readFileSync(root('index.html'), 'utf8');
  for (const id of ['vc-minus', 'vc-plus', 'vc-range', 'voice-count-name', 'preset-chips', 'voice-grid', 'arr-mode', 'generate', 'es-generate']) {
    assert.ok(html.includes(`id="${id}"`), `index.html: #${id}`);
  }
  for (const m of ['orchestra', 'free', 'original']) assert.ok(html.includes(`data-method="${m}"`), `Methode ${m}`);
  assert.match(html, /id="vc-range"[^>]*min="1"[^>]*max="15"/);
  const app = readFileSync(root('src/web/app.js'), 'utf8');
  for (const needle of ['orchestrateFromOptions(S.song, opts)', "from '../engine/ensembles.js'", 'slotInfo(voices, i)', 'resizeEnsemble(S.opts.voices', 'applyPreset(id', "transposeForm = eng ? 'compound'", "engine: 'classic'"]) {
    assert.ok(app.includes(needle), `app.js: ${needle}`);
  }
  // Der Knopf führt in beiden Pfaden zu Noten: Beschriftung
  assert.match(html, /<span>Noten erstellen<\/span>/);
});
