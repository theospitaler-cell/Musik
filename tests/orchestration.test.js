// Orchestrierungs-Engine (src/engine): Stem-Routing, Tonalität & Tempo, Besetzungen N = 1 / 4 / 8 / 15,
// Instrumenten-Profile, MusicXML-4.0-Notensatz. Die Regeln stammen aus der Direktive; geprüft wird an
// Stems mit bekannter Wahrheit (tests/fixtures/stems.js) und an den Demo-Liedern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXML } from '../src/core/xml.js';
import { parseMidiName, stepAlterOctaveToMidi } from '../src/theory/pitch.js';
import { makeKey } from '../src/theory/keys.js';
import { parseChord } from '../src/theory/chords.js';
import {
  routeStems,
  orchestrate,
  calibrateGrid,
  bandpass,
  filterBassNotes,
  decodeComping,
  estimateKey,
  keyTrack,
  spellPc,
  plausibleTempo,
  PROFILES,
  ENSEMBLES,
  ensembleFor,
  fitPitch,
  validateArrangement,
  exportScore,
  stemsFromWavs,
  suppressOvertones,
} from '../src/engine/index.js';
import { encodeWav16 } from '../src/input/stems.js';
import { BASS_MIDI_BAND, bassLag, compensateBassLag, consolidateNotes, gridTicker, classifyDrumHit, detectDrumOnsets } from '../src/engine/stems.js';
import { SPEC_TRANSPOSE } from '../src/engine/profiles.js';
import { frictions, isFriction, C3 } from '../src/engine/voicing.js';
import { soundingAt, sortEvents } from '../src/engine/util.js';
import { exportMidi } from '../src/output/midi.js';
import { Rng } from '../src/core/rng.js';
import { makeStemFixture, withPickup, randomMaterial } from './fixtures/stems.js';
import { demoSong, measureDurations } from './helpers.js';

// ---- Hilfen ------------------------------------------------------------------------------------
const fixture = makeStemFixture();
const material = routeStems(fixture.stems, { title: 'Testlied' });
const cache = new Map();
const run = (N, input = material) => {
  const k = `${N}:${input === material ? 'm' : 'x'}`;
  if (!cache.has(k) || input !== material) {
    const r = orchestrate(input, { voices: N, title: 'Testlied' });
    if (input !== material) return r;
    cache.set(k, r);
  }
  return cache.get(k);
};

// MusicXML -> Teile mit Noten (Position in Ticks, Tonhöhe, Balken, Artikulation) und Richtungen
function readScore(xml) {
  const root = parseXML(xml);
  const names = {};
  for (const sp of root.get('part-list').all('score-part')) {
    names[sp.attrs.id] = { name: sp.val('part-name'), program: sp.num('midi-instrument/midi-program') };
  }
  const parts = root.all('part').map((p) => {
    const part = { id: p.attrs.id, ...names[p.attrs.id], measures: [], notes: [], keys: [], transpose: null, dynamics: [], breathMarks: 0 };
    for (const m of p.all('measure')) {
      let pos = 0;
      const meas = { number: Number(m.attrs.number), notes: [], harmonies: [] };
      for (const el of m.children) {
        if (el.name === 'attributes') {
          if (el.has('key/fifths')) part.keys.push({ measure: meas.number, fifths: el.num('key/fifths'), mode: el.val('key/mode') });
          if (el.has('transpose')) part.transpose = { diatonic: el.num('transpose/diatonic'), chromatic: el.num('transpose/chromatic'), octave: el.num('transpose/octave-change') };
        } else if (el.name === 'harmony') {
          meas.harmonies.push({ step: el.val('root/root-step'), alter: el.num('root/root-alter', 0), kind: el.val('kind') });
        } else if (el.name === 'direction') {
          const d = el.child('direction-type') && el.child('direction-type').child('dynamics');
          if (d) part.dynamics.push({ measure: meas.number, pos, value: d.children[0].name });
        } else if (el.name === 'backup') pos -= el.num('duration');
        else if (el.name === 'forward') pos += el.num('duration');
        else if (el.name === 'note') {
          if (el.has('grace')) continue;
          const dur = el.num('duration', 0);
          if (el.has('rest')) {
            pos += dur;
            continue;
          }
          const step = el.val('pitch/step');
          const alter = el.num('pitch/alter', 0);
          const octave = el.num('pitch/octave');
          const arts = el.get('notations/articulations') ? el.get('notations/articulations').children.map((c) => c.name) : [];
          if (arts.includes('breath-mark')) part.breathMarks++;
          const note = {
            measure: meas.number,
            pos,
            dur,
            step,
            alter,
            octave,
            written: stepAlterOctaveToMidi(step, alter, octave),
            type: el.val('type'),
            beams: el.all('beam').map((b) => ({ n: Number(b.attrs.number), v: b.text })),
            arts,
            tieStop: el.all('tie').some((t) => t.attrs.type === 'stop'),
          };
          meas.notes.push(note);
          part.notes.push(note);
          pos += dur;
        }
      }
      part.measures.push(meas);
    }
    return part;
  });
  return { root, parts };
}

const lead = (r) => r.arr.voices.find((v) => v.role === 'lead');
const bassOf = (r) => r.arr.voices.find((v) => v.role === 'bass');
const names = (r) => r.arr.voices.map((v) => v.inst.name);

// ---- 1. Stem-Routing, Groove, rhythmische Synthese -----------------------------------------------
test('Stems: Bass-Band 30–250 Hz (Noten und Audio)', () => {
  assert.deepEqual(BASS_MIDI_BAND, [23, 59]);
  const kept = filterBassNotes([
    { start: 0, end: 0.5, midi: 28, amp: 0.8 }, // E1 ≈ 41 Hz
    { start: 0.5, end: 1, midi: 62, amp: 0.8 }, // D4 ≈ 294 Hz – Oberton/Durchsprechen
    { start: 1, end: 1.5, midi: 20, amp: 0.8 }, // unter 30 Hz
  ]);
  assert.deepEqual(kept.map((n) => n.midi), [28]);
  // Audio: 80 Hz geht durch, 1 kHz wird um > 20 dB gedämpft
  const sr = 22050;
  const tone = (f) => Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * f * i) / sr));
  const rms = (x) => Math.sqrt(x.slice(sr / 2).reduce((s, v) => s + v * v, 0) / (x.length - sr / 2));
  const pass = rms(bandpass(tone(80), sr)) / rms(tone(80));
  const stop = rms(bandpass(tone(1000), sr)) / rms(tone(1000));
  assert.ok(pass > 0.7, `80 Hz gedämpft: ${pass}`);
  assert.ok(20 * Math.log10(stop) < -20, `1 kHz nicht genug gedämpft: ${20 * Math.log10(stop)} dB`);
});

test('Stems: Sub-Bass-Lag wird gegen die Bassdrum-Transienten ausgeglichen', () => {
  const kicks = [0, 1, 2, 3, 4, 5].map((b) => 0.37 + b);
  const bass = kicks.map((k) => ({ start: k + 0.05, end: k + 0.5, midi: 36 }));
  const { lag, pairs } = bassLag(bass, kicks);
  assert.equal(pairs, 6);
  assert.ok(Math.abs(lag - 0.05) < 0.002);
  const fixed = compensateBassLag(bass, lag);
  assert.ok(fixed.every((n, i) => Math.abs(n.start - kicks[i]) < 0.002));
  // ungleichmäßiger Versatz ist kein Lag
  const messy = kicks.map((k, i) => ({ start: k + (i % 2 ? 0.1 : -0.02), end: k + 0.5, midi: 36 }));
  assert.equal(bassLag(messy, kicks).lag, 0);
  // im Gesamtweg: der Bass liegt nach dem Ausgleich exakt auf 1 und 3
  assert.ok(Math.abs(material.report.bassLag - 0.04) < 0.003);
  assert.deepEqual(material.bass.slice(0, 3).map((n) => n.start), [0, 48, 96]);
});

test('Stems: Schlagzeug liefert nur das Raster – Downbeat über den Backbeat, keine Noten', () => {
  assert.equal(material.grid.bpm, 120);
  assert.equal(material.grid.backbeat.snareOnBackbeat, 1);
  assert.equal(material.grid.backbeat.kickOnStrong, 1);
  // erste Melodienote liegt auf Takt 1, Zählzeit 1 (Musik beginnt bei 0,37 s, nicht bei 0)
  assert.equal(material.lead[0].start, 0);
  assert.equal(material.pickupBars, 0);
  assert.equal(material.measureCount, 16);
  // keine Drum-Töne in den Tonspuren
  for (const list of [material.lead, material.bass, material.comp]) assert.ok(list.every((n) => n.stem !== 'drums'));
  assert.ok(material.drums.length > 0 && material.drums.every((d) => ['kick', 'snare', 'hat'].includes(d.kind) && d.midi === undefined));
  // Vorspann ohne Bassdrum: die Eins wird trotzdem an der Bassdrum festgemacht
  const pre = fixture.stems.drums.hits.map((h) => ({ ...h }));
  const beat = fixture.truth.beat;
  const count = [0, 1].map((i) => ({ t: fixture.truth.t0 - (2 - i) * beat, kind: 'hat', w: 0.5 }));
  const grid = calibrateGrid([...count, ...pre]);
  const tick = gridTicker(grid)(fixture.truth.t0);
  assert.ok(Math.abs(tick) < 1, `erste Eins bei Tick ${tick}`);
  // Klassifizierung aus Bandenergien
  assert.equal(classifyDrumHit({ low: 9, mid: 1, high: 0.1 }), 'kick');
  assert.equal(classifyDrumHit({ low: 0.1, mid: 6, high: 3 }), 'snare');
  assert.equal(classifyDrumHit({ low: 0, mid: 0.5, high: 8 }), 'hat');
});

test('Stems: Transienten aus Audio (Bassdrum 1+3, Snare 2+4) ergeben dasselbe Raster', () => {
  const sr = 22050;
  const bpm = 100;
  const beat = 60 / bpm;
  const dur = 8 * beat + 0.5;
  const x = new Float32Array(Math.floor(sr * dur));
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const t0 = 0.21;
  for (let b = 0; b < 8; b++) {
    const t = t0 + b * beat;
    const start = Math.round(t * sr);
    for (let i = 0; i < 0.12 * sr && start + i < x.length; i++) {
      const env = Math.exp(-i / (0.03 * sr));
      if (b % 2 === 0) x[start + i] += 0.9 * env * Math.sin((2 * Math.PI * 60 * i) / sr); // Bassdrum
      else x[start + i] += 0.7 * env * rnd(); // Snare (Rauschen)
    }
  }
  const onsets = detectDrumOnsets(x, sr);
  assert.ok(onsets.length >= 7 && onsets.length <= 12, `${onsets.length} Einsätze`);
  const kinds = onsets.map(classifyDrumHit);
  assert.ok(kinds.filter((k) => k === 'kick').length >= 3);
  assert.ok(kinds.filter((k) => k === 'snare').length >= 3);
  const grid = calibrateGrid(onsets, { bpm });
  assert.ok(Math.abs(grid.bpm - 100) < 1);
  // Ein Backbeat-Raster: Bassdrum-Schläge stehen auf den Eins-/Drei-Zählzeiten
  const ticker = gridTicker(grid);
  const kickTicks = onsets.filter((o, i) => kinds[i] === 'kick').map((o) => ticker(o.t));
  assert.ok(kickTicks.every((k) => Math.abs((k % 48) + (k % 48 > 40 ? -48 : 0)) < 4), `Bassdrum-Ticks ${kickTicks.map((k) => k.toFixed(1))}`);
});

test('Stems: WAV-Dateien -> Transienten, Bass-Band, Noten (Basic Pitch ersetzt) -> Material', async () => {
  const sr = 22050;
  const fx = makeStemFixture({ bars: 8 });
  const dur = fx.truth.t0 + 8 * 4 * fx.truth.beat + 1;
  const silent = () => new Float32Array(Math.ceil(dur * sr));
  const drums = silent();
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (const h of fx.stems.drums.hits.filter((x) => x.kind !== 'hat')) {
    const a = Math.floor(h.t * sr);
    for (let i = 0; i < 0.1 * sr && a + i < drums.length; i++) {
      const env = Math.exp(-i / (0.025 * sr));
      drums[a + i] += h.kind === 'kick' ? 0.8 * env * Math.sin((2 * Math.PI * 60 * i) / sr) : 0.6 * env * rnd();
    }
  }
  const wav = (x) => encodeWav16([x], sr);
  const files = { vocals: wav(silent()), other: wav(silent()), bass: wav(silent()), drums: wav(drums) };
  // Basic Pitch ersetzt: liefert in der Reihenfolge vocals, other, bass die Noten der Wahrheit
  const queue = [fx.stems.vocals, fx.stems.other, fx.stems.bass];
  const stems = await stemsFromWavs(files, { pitch: async () => queue.shift() });
  assert.equal(queue.length, 0, 'jeder Stem genau einmal analysiert');
  assert.ok(stems.drums.hits.length >= 14, `${stems.drums.hits.length} Transienten`);
  const m = routeStems(stems, { title: 'WAV' });
  assert.ok(Math.abs(m.tempo - 120) < 1, `Tempo ${m.tempo}`);
  assert.equal(m.lead[0].start, 0);
  assert.equal(m.measureCount, 8);
  assert.equal(orchestrate(m, { voices: 4 }).validation.ok, true);
  // fehlende Spuren werden benannt
  await assert.rejects(() => stemsFromWavs({ vocals: files.vocals }, { pitch: async () => [] }), /drums\.wav/);
});

test('Stems: Oberton-Geister werden unterdrückt, der tiefste Basston gewinnt', () => {
  const kept = suppressOvertones([
    { start: 0, end: 1, midi: 72, amp: 0.8 },
    { start: 0.05, end: 0.9, midi: 91, amp: 0.3 }, // Duodezime darüber, leiser: Teilton
    { start: 0, end: 1, midi: 60, amp: 0.7 }, // zweite Stimme im Akkord (Dezime tiefer) bleibt
  ]);
  assert.deepEqual(kept.map((n) => n.midi).sort(), [60, 72]);
  // Akkord: die Oktave ist bei other kein Oberton
  const chord = suppressOvertones([{ start: 0, end: 1, midi: 48, amp: 0.7 }, { start: 0, end: 1, midi: 60, amp: 0.6 }], { octave: false });
  assert.equal(chord.length, 2);
  // Bass-Stem: Grundton 41 und lauter gemeldete Oktave 53 -> 41 bleibt
  const bass = filterBassNotes([
    { start: 0, end: 0.5, midi: 41, amp: 0.6 },
    { start: 0.01, end: 0.5, midi: 53, amp: 0.9 },
  ]);
  assert.deepEqual(bass.map((n) => n.midi), [41]);
});

test('Stems: Auftakt bekommt einen vorangestellten Takt', () => {
  const m = routeStems(withPickup(makeStemFixture()).stems, {});
  assert.equal(m.pickupBars, 1);
  assert.equal(m.measureCount, 17);
  assert.equal(m.lead[0].start, 96 - 24); // Auftakt auf Zählzeit 4 des vorangestellten Takts
  assert.equal(m.lead[1].start, 96); // Takt 1 der Vorlage
});

test('Tempo: Halbtempo-Fehler wird korrigiert, echte Balladen bleiben', () => {
  // Raster mit „erkanntem“ 75 BPM, tatsächlich 150: Achtel (= 16tel des erkannten Schlags) dominieren
  const real = 150;
  const hits = [];
  for (let i = 0; i < 80; i++) hits.push({ t: 0.3 + (i * 60) / real / 2, kind: i % 4 === 0 ? 'kick' : i % 4 === 2 ? 'snare' : 'hat', w: 1 });
  const g = calibrateGrid(hits, { bpm: 75 });
  assert.equal(g.doubled, true);
  assert.equal(g.detectedBpm, 75);
  assert.ok(Math.abs(g.bpm - 150) < 0.5);
  // Balladen-Gegenprobe: 79 BPM mit durchlaufenden Achteln wird NICHT verdoppelt
  const ballad = [];
  for (let i = 0; i < 80; i++) ballad.push(0.3 + (i * 60) / 79 / 2);
  assert.equal(plausibleTempo(79, ballad).doubled, false);
  // außerhalb 60–85 BPM wird nie verdoppelt
  const dense = [];
  for (let i = 0; i < 160; i++) dense.push(0.2 + (i * 60) / 100 / 4);
  assert.equal(plausibleTempo(100, dense).doubled, false);
  // 16tel-Dichte bei 80 BPM spricht für das doppelte Tempo
  const sixteenths = [];
  for (let i = 0; i < 160; i++) sixteenths.push(0.2 + (i * 60) / 80 / 4);
  const p = plausibleTempo(80, sixteenths);
  assert.equal(p.doubled, true);
  assert.equal(p.bpm, 160);
});

test('Comping: Dichte je Takt entscheidet über Einwürfe oder gehaltene Klänge', () => {
  const dec = decodeComping(material.comp, { measureTicks: 96, measureCount: 16 });
  const modes = dec.bars.map((b) => b.mode);
  assert.deepEqual(modes.slice(0, 4), ['sustained', 'sustained', 'sustained', 'sustained']);
  assert.deepEqual(modes.slice(4, 8), ['rhythmic', 'rhythmic', 'rhythmic', 'rhythmic']);
  assert.equal(dec.bars[4].density, 4);
  assert.equal(dec.bars[0].density, 1);
  // Ergebnis in der Partitur: Einwürfe sind kurze Staccato-/Marcato-Noten auf dem Nachschlag
  const r = run(4);
  const inner = r.arr.voices.filter((v) => v.role === 'inner');
  const bar = (e) => Math.floor(e.start / 96);
  const allStabs = inner.flatMap((v) => v.events.filter((e) => bar(e) >= 4 && bar(e) < 8 && e.role === 'stabs')).map((e) => e.start % 96);
  assert.ok(allStabs.includes(36) && allStabs.includes(84), 'Synkopen auf 2+ und 4+');
  for (const v of inner) {
    // (gehaltene Töne, die beim Atem der Nachbarstimme einspringen, sind keine Einwürfe)
    const stabs = v.events.filter((e) => bar(e) >= 4 && bar(e) < 8 && e.role === 'stabs');
    assert.ok(stabs.length >= 8);
    assert.ok(stabs.every((e) => e.dur <= 12), 'Einwürfe sind höchstens Achtel lang');
    assert.ok(stabs.every((e) => e.art.includes('staccato')), 'Staccato');
    assert.ok(stabs.some((e) => e.start % 24 === 12), 'Synkopen auf Offbeat-Achteln');
    assert.ok(stabs.filter((e) => e.start % 24 === 12).every((e) => e.art.includes('accent')), 'Marcato auf den Synkopen');
    // gehaltene Takte: keine Liegetöne über ganze Takte
    const pads = v.events.filter((e) => bar(e) < 4);
    assert.ok(pads.length >= 8 && pads.every((e) => e.dur < 96), 'Phrasierung statt Liegeton');
  }
});

test('Tonwiederholungen: schnelle Wiederholungen ab 60 ms bleiben einzelne Noten', () => {
  const same = (t) => ({ start: t, end: t + 0.05, midi: 74, amp: 0.8 });
  const kept = consolidateNotes([same(0), same(0.07), same(0.14), same(0.21)]);
  assert.equal(kept.length, 4, 'vier Anschläge im Abstand 70 ms');
  const merged = consolidateNotes([same(0), same(0.03), same(0.06), same(0.2)]);
  assert.equal(merged.length, 3, 'Splitter unter 60 ms werden zusammengefasst (0 + 0,03), 0,06 und 0,2 bleiben');
  // mit Anschlag-Detektor: Einsatz ohne neuen Anschlag wird verschmolzen
  const noAttack = consolidateNotes([{ start: 0, end: 0.2, midi: 60 }, { start: 0.22, end: 0.4, midi: 60 }], { attack: () => ({ ok: false }) });
  assert.equal(noAttack.length, 1);
  // Gesamtweg: vier 16tel auf D5 in Takt 11 stehen als vier Sechzehntel im Notenbild
  const ticks = material.lead.filter((n) => n.midi === 74 && n.start >= 10 * 96 + 24 && n.start < 10 * 96 + 48);
  assert.deepEqual(ticks.map((n) => n.start - 10 * 96), [24, 30, 36, 42]);
  const xml = run(1).xml();
  const part = readScore(xml).parts[0];
  const m11 = part.measures[10].notes.filter((n) => n.type === '16th');
  assert.ok(m11.length >= 4);
  assert.ok(m11.slice(0, 4).every((n) => n.beams.some((b) => b.n === 2)), 'schlagweise doppelt gebalkt');
});

// ---- 2. Tonalität, Tempo, Enharmonik ---------------------------------------------------------
test('Tonart: F-Dur und D-Moll tragen −1 Vorzeichen (nicht +1), auch im MusicXML', () => {
  const all = [...material.lead, ...material.bass, ...material.comp];
  const est = estimateKey(all);
  assert.equal(est.key.fifths, -1);
  assert.equal(est.key.mode, 'major');
  // D-Moll (harmonisch) mit Leitton: gleiche Vorzeichenzahl
  const dm = [62, 64, 65, 67, 69, 70, 73, 74].map((m, i) => ({ start: i * 24, dur: 24, midi: m }));
  const dmk = estimateKey([...dm, ...dm, { start: 400, dur: 96, midi: 62 }, { start: 400, dur: 96, midi: 65 }, { start: 400, dur: 96, midi: 69 }]);
  assert.equal(dmk.key.mode, 'minor');
  assert.equal(dmk.key.fifths, -1);
  // Partitur: nicht transponierende Stimmen (Posaune, Tuba) in F-Dur; B-Trompete notiert G-Dur (+1);
  // im Konzertton-Export tragen alle Stimmen −1
  const r = run(4);
  const sc = readScore(r.xml());
  const byName = Object.fromEntries(sc.parts.map((p) => [p.name, p]));
  assert.equal(byName['Posaune'].keys[0].fifths, -1);
  assert.equal(byName['Tuba'].keys[0].fifths, -1);
  assert.equal(byName['Trompete in B'].keys[0].fifths, 1);
  assert.equal(byName['Horn in F'].keys[0].fifths, 0);
  const concert = readScore(r.xml({ concert: true }));
  assert.ok(concert.parts.every((p) => p.keys[0].fifths === -1 && p.keys[0].mode === 'major'), 'Konzertpartitur: überall −1');
  assert.ok(concert.parts.every((p) => p.transpose === null));
});

test('Tonart: gleitende 8-Takt-Fenster erkennen die Modulation von F-Dur nach G-Dur', () => {
  const mk = (pcs, bar0) =>
    Array.from({ length: 8 }, (_, b) => pcs.map((m, i) => ({ start: (bar0 + b) * 96 + i * 24, dur: 24, midi: m }))).flat();
  const f = mk([65, 69, 72, 70], 0); // F A C Bb
  const g = mk([67, 71, 74, 72], 8); // G B D C
  const track = keyTrack([...f, ...g], { measureTicks: 96, measureCount: 16 });
  assert.equal(track.length, 2, JSON.stringify(track.map((t) => [t.start, t.end, t.key.fifths])));
  assert.equal(track[0].key.fifths, -1);
  assert.equal(track[1].key.fifths, 1);
  assert.ok(Math.abs(track[1].start - 8) <= 1, `Wechsel bei Takt ${track[1].start}`);
  // ohne Modulation bleibt es bei einem Abschnitt
  assert.equal(keyTrack(f, { measureTicks: 96, measureCount: 8 }).length, 1);
  // Gesamtweg: neuer Block mit Tonartwechsel; die Schreibweise folgt der lokalen Tonart
  const lead2 = [...f, ...g].filter((n, i) => i % 1 === 0).map((n) => ({ ...n, vel: 80 }));
  const bass2 = Array.from({ length: 16 }, (_, b) => ({ start: b * 96, dur: 96, midi: b < 8 ? 41 : 43 }));
  const r = orchestrate({ title: 'Modulation', tempo: 100, meter: { beats: 4, beatType: 4 }, measureCount: 16, lead: lead2, bass: bass2, comp: [], drums: [] }, { voices: 4 });
  assert.deepEqual(r.arr.keyChanges.map((k) => [k.bar, k.key.fifths]), [[0, -1], [8, 1]]);
  const tb = readScore(r.xml({ concert: true })).parts.find((p) => p.name === 'Posaune');
  assert.deepEqual(tb.keys.map((k) => [k.measure, k.fifths]), [[1, -1], [9, 1]]);
});

test('Enharmonik: Bb statt A#, Eb statt D#, Leitton C# in D-Moll (nie Db)', () => {
  // Einzeltöne
  const F = makeKey(-1, 'major');
  const Dm = makeKey(-1, 'minor');
  const G = makeKey(1, 'major');
  assert.equal(spellPc(10, F), -2); // Bb
  assert.equal(spellPc(3, F), -3); // Eb
  assert.equal(spellPc(1, Dm), 7); // C# (Leitton)
  assert.equal(spellPc(10, Dm), -2); // Bb (6. Stufe)
  assert.equal(spellPc(6, G), 6); // F#
  // Partitur F-Dur (Konzerttonhöhe): kein A#/D#/G#, aber Bb und Eb
  for (const N of [4, 8]) {
    const sc = readScore(run(N).xml({ concert: true }));
    const all = sc.parts.flatMap((p) => p.notes);
    assert.ok(all.some((n) => n.step === 'B' && n.alter === -1), 'Bb kommt vor');
    assert.ok(all.some((n) => n.step === 'E' && n.alter === -1), 'Eb (F7) kommt vor');
    assert.ok(!all.some((n) => n.alter > 0), `Kreuz in F-Dur: ${JSON.stringify(all.find((n) => n.alter > 0))}`);
    assert.ok(!all.some((n) => Math.abs(n.alter) > 1), 'keine Doppelvorzeichen');
  }
  // D-Moll mit Leitton
  const melody = [[0, 62], [1, 65], [2, 69], [3, 73], [4, 74], [5, 73], [6, 70], [7, 69]];
  const lead3 = melody.map(([b, m]) => ({ start: b * 24, dur: 24, midi: m, vel: 80 }));
  const mt = { title: 'Dm', tempo: 100, meter: { beats: 4, beatType: 4 }, measureCount: 4, lead: [...lead3, ...lead3.map((n) => ({ ...n, start: n.start + 192 }))].slice(0, 16), bass: [38, 33, 38, 33].map((m, b) => ({ start: b * 96, dur: 96, midi: m })), comp: [], drums: [] };
  const r = orchestrate(mt, { voices: 4 });
  const notes = readScore(r.xml({ concert: true })).parts.flatMap((p) => p.notes);
  assert.ok(notes.some((n) => n.step === 'C' && n.alter === 1), 'C# als Leitton');
  assert.ok(!notes.some((n) => n.step === 'D' && n.alter === -1), 'nie Db');
  assert.ok(!notes.some((n) => n.step === 'A' && n.alter === 1));
  assert.equal(r.validation.violations.filter((v) => v.rule === 'spelling').length, 0);
});

// ---- 3. Besetzungen -----------------------------------------------------------------------------
function assertClean(r, label) {
  const v = r.validation.violations;
  assert.equal(v.length, 0, `${label}: ${JSON.stringify(r.report.violations)} ${JSON.stringify(v.slice(0, 3))}`);
}

test('N = 1: Lead Sheet – Melodie mit Harmoniesymbolen', () => {
  const r = run(1);
  assert.equal(r.arr.voices.length, 1);
  assert.equal(r.arr.voices[0].role, 'lead');
  assertClean(r, 'N=1');
  const sc = readScore(r.xml());
  assert.equal(sc.parts.length, 1);
  const harm = sc.parts[0].measures.flatMap((m) => m.harmonies);
  assert.ok(harm.length >= 12, `${harm.length} Harmoniesymbole`);
  assert.ok(harm.some((h) => h.kind === 'dominant'), 'C7 ⇒ dominant');
  assert.ok(harm.some((h) => h.kind === 'minor'), 'Dm ⇒ minor');
  // Melodie vollständig übernommen (Tonhöhen im Bereich der B-Trompete)
  assert.equal(sc.parts[0].notes.length, lead(r).events.length);
  assert.ok(lead(r).events.length >= 60);
  // keine weiteren Stimmen, keine Begleitnoten
  assert.equal(r.arr.voices[0].events.filter((e) => e.role !== 'melody' && e.role !== 'answer').length, 0);
});

test('N = 2 und 3: Gegenstimme in Gegenbewegung (Terzen/Sexten), Bass als letzte Stimme', () => {
  const r2 = run(2);
  assert.deepEqual(r2.arr.voices.map((v) => v.role), ['lead', 'bass']);
  assertClean(r2, 'N=2');
  const r3 = run(3);
  assert.deepEqual(r3.arr.voices.map((v) => v.role), ['lead', 'counter', 'bass']);
  assertClean(r3, 'N=3');
  const [l, c] = r3.arr.voices;
  const ctr = sortEvents([...c.events]);
  let n = 0;
  let cons = 0;
  let moving = 0;
  let contrary = 0;
  let prev = null;
  for (const e of sortEvents([...l.events])) {
    const x = soundingAt(ctr, e.start);
    if (!x || x.role === 'answer') {
      prev = null;
      continue;
    }
    const d = e.pitches[0] - x.pitches[0];
    n++;
    if ([3, 4, 8, 9].includes(((d % 12) + 12) % 12)) cons++;
    if (prev) {
      const dl = e.pitches[0] - prev.l;
      const dc = x.pitches[0] - prev.c;
      if (dl && dc) {
        moving++;
        if (Math.sign(dl) !== Math.sign(dc)) contrary++;
      }
    }
    prev = { l: e.pitches[0], c: x.pitches[0] };
  }
  assert.ok(cons / n >= 0.6, `Terzen/Sexten ${cons}/${n}`);
  assert.ok(contrary / moving >= 0.5, `Gegenbewegung ${contrary}/${moving}`);
  // Gegenstimme bleibt unter der Melodie
  assert.ok(sortEvents([...l.events]).every((e) => { const x = soundingAt(ctr, e.start); return !x || x.pitches[0] < e.pitches[0]; }));
});

test('N = 4: Lead, zwei rhythmisch eigenständige Mittelstimmen, Bass', () => {
  const r = run(4);
  assert.deepEqual(r.arr.voices.map((v) => v.role), ['lead', 'inner', 'inner', 'bass']);
  assert.deepEqual(names(r), ['Trompete in B', 'Horn in F', 'Posaune', 'Tuba']);
  assertClean(r, 'N=4');
  const [, a, b] = r.arr.voices;
  const A = new Set(a.events.map((e) => e.start));
  const B = new Set(b.events.map((e) => e.start));
  const shared = [...A].filter((t) => B.has(t)).length;
  const ratio = shared / Math.min(A.size, B.size);
  assert.ok(ratio <= 0.65, `gemeinsamer Anschlaganteil ${ratio}`);
  assert.ok(ratio > 0, 'Einsatz auf der Eins gemeinsam – der Satz bleibt zusammen');
  assert.notDeepEqual([...A], [...B], 'verschiedene Rhythmen');
  // Lead oben, Bass unten – an jedem Einsatz
  const L = sortEvents([...lead(r).events]);
  for (const v of r.arr.voices.slice(1, 3)) for (const e of v.events) {
    const l = soundingAt(L, e.start);
    if (l && e.role !== 'answer') assert.ok(e.pitches[0] < l.pitches[0], `Mittelstimme über Lead bei ${e.start}`);
  }
  // Mittelstimmen leiser als der Lead (f → mf)
  const dyn = (v, t) => [...v.dirs].filter((d) => d.t <= t).pop().value;
  assert.equal(dyn(lead(r), 9 * 96), 'f');
  assert.equal(dyn(a, 9 * 96 + 36), 'mf');
  assert.equal(dyn(lead(r), 24), 'mp');
  assert.equal(dyn(a, 36), 'p');
  // nicht alle atmen gleichzeitig: wenn Stimme 2 atmet, hält Stimme 3
  for (const br of r.arr.engine.report.breaths) {
    const own = r.arr.voices[br.voice];
    if (own.role !== 'inner') continue;
    const others = r.arr.voices.filter((v) => v.role === 'inner' && v !== own);
    assert.ok(others.some((o) => soundingAt(sortEvents([...o.events]), br.t0)), `niemand hält bei ${br.t0}`);
  }
});

test('N = 8: Drop-2- und Drop-2/4-Voicings, Spannungen innen, keine Sekunden unter C3', () => {
  const r = run(8);
  assert.equal(r.arr.voices.length, 8);
  assertClean(r, 'N=8');
  const rec = r.arr.engine.report.voicings;
  assert.ok(rec.length > 30);
  const templates = new Set(rec.map((x) => x.template));
  assert.ok([...templates].every((t) => t === 'drop2' || t === 'drop24'), [...templates].join());
  assert.ok(templates.has('drop2') || templates.has('drop24'));
  // Struktur: im Drop-Satz liegt der versetzte Ton eine Oktave tiefer; +12 ergibt wieder die enge Lage
  for (const x of rec) {
    const moved = x.template === 'drop2' ? [x.closed[1]] : [x.closed[1], x.closed[3]];
    for (const m of moved) assert.ok(x.open.some((p) => p % 12 === m % 12 && p <= m - 12), `${x.t}: ${m} nicht versetzt`);
    const kept = x.closed.filter((p) => !moved.includes(p));
    for (const p of kept) assert.ok(x.open.includes(p));
    assert.ok(x.closed[0] === x.open[0], 'Melodieton bleibt oben');
  }
  // Spannungen (7, 9, 11/13) in den Innenstimmen
  const withTension = rec.filter((x) => x.roles.includes('tension')).length;
  assert.ok(withTension / rec.length > 0.5, `Spannungen in ${withTension}/${rec.length} Sätzen`);
  // Septimen: in jedem Satz über einem Septakkord steckt die Septime (Innenstimme oder Melodieton)
  const withSeventh = rec.map((x) => ({ x, ch: parseChord(x.chord) })).filter(({ ch }) => ch && ch.tones.some((q) => q.role === 'seventh'));
  assert.ok(withSeventh.length >= 10);
  const has7 = withSeventh.filter(({ x, ch }) => x.open.some((p) => p % 12 === ch.tones.find((q) => q.role === 'seventh').pc));
  assert.ok(has7.length / withSeventh.length >= 0.9, `Septime in ${has7.length}/${withSeventh.length}`);
  // keine Sekund-Reibung unterhalb von C3 (nur gleichzeitige Töne verschiedener Stimmen)
  assert.deepEqual(frictions(r.arr.voices.map((v) => v.events)), []);
  assert.ok(isFriction(41, 43) && !isFriction(50, 52) && !isFriction(41, 44) && C3 === 48);
  // Terzen/Septimen nicht im Keller: in den Sätzen liegt die tiefste Innenstimme meist ≥ G2
  const lowest = rec.map((x) => Math.min(...x.pitches));
  assert.ok(lowest.filter((p) => p >= 43).length / lowest.length > 0.7);
});

test('N = 15: vier Register-Schichten, Oktavverdopplungen, keine Cluster', () => {
  const r = run(15);
  assert.equal(r.arr.voices.length, 15);
  assertClean(r, 'N=15');
  assert.ok(r.arr.voices.every((v) => v.events.length > 5), 'jede Stimme spielt');
  const groups = (g) => r.arr.voices.filter((v) => v.group === g);
  assert.deepEqual(['S', 'AT', 'BAR', 'BASS'].map((g) => groups(g).length), [4, 4, 4, 3]);
  // Sopran-Schicht: Melodie + Oktavverdopplung nach oben, die anderen unisono
  const L = lead(r);
  const up = r.arr.voices.find((v) => v.role === 'double8');
  assert.equal(up.inst.name, 'Flöte');
  // (die Doppler atmen versetzt – an Atemstellen der Melodie kann der Lead-Ton fehlen)
  const sameStart = (v, shift) => {
    const pairs = v.events.map((e) => [e, L.events.find((l) => l.start === e.start)]).filter(([, l]) => l);
    assert.ok(pairs.length / v.events.length > 0.85, `${v.inst.name}: nur ${pairs.length}/${v.events.length} Einsätze wie der Lead`);
    for (const [e, l] of pairs) assert.equal(e.pitches[0], l.pitches[0] + shift, `${v.inst.name} bei ${e.start}`);
  };
  sameStart(up, 12);
  for (const v of r.arr.voices.filter((x) => x.role === 'doubleU')) sameStart(v, 0);
  // der Doppler trägt die Melodie weiter, wenn der Lead atmet (versetzte Atmung)
  const leadBreaths = L.events.filter((e) => e.breathAfter).map((e) => e.start + e.dur);
  assert.ok(leadBreaths.some((t) => soundingAt(sortEvents([...up.events]), t + 1)), 'Flöte füllt die Atempause des Leads');
  // Bass-Schicht: Fundament + 8vb-Oktavierung
  const fund = r.arr.voices.filter((v) => v.group === 'BASS' && v.role === 'bass');
  const low = r.arr.voices.find((v) => v.role === 'bass8vb');
  assert.equal(fund.length, 2);
  const f0 = fund[0].events;
  let octaves = 0;
  for (const e of low.events) {
    const f = soundingAt(f0, e.start);
    if (f && f.pitches[0] - e.pitches[0] === 12) octaves++;
  }
  assert.ok(octaves / low.events.length > 0.8, `8vb ${octaves}/${low.events.length}`);
  // Cluster: an jedem Einsatz der Mittelschichten gehören alle Töne zum Akkord (inkl. Spannungen) oder
  // sind Oktavverdopplungen von Lead/Bass – höchstens 6 verschiedene Tonklassen
  const inner = r.arr.voices.filter((v) => v.role === 'inner' || v.role === 'counter');
  const times = [...new Set(inner.flatMap((v) => v.events.filter((e) => e.role !== 'answer').map((e) => e.start)))];
  let widest = 0;
  for (const t of times) {
    const pcs = new Set();
    for (const v of [...inner, L]) {
      const e = soundingAt(sortEvents([...v.events]), t);
      if (e && e.role !== 'answer') pcs.add(e.pitches[0] % 12);
    }
    widest = Math.max(widest, pcs.size);
  }
  assert.ok(widest <= 6, `bis zu ${widest} Tonklassen gleichzeitig`);
  assert.equal(r.validation.violations.filter((v) => v.rule === 'cluster').length, 0);
  // MusicXML: 15 Stimmen, Gruppenklammern
  const xml = r.xml();
  assert.equal((xml.match(/<score-part /g) || []).length, 15);
  assert.ok((xml.match(/<part-group[^>]*type="start"/g) || []).length >= 2);
});

test('Alle Besetzungen N = 1…15 und alle Demo-Lieder erfüllen die Satzregeln', () => {
  for (let N = 1; N <= 15; N++) {
    const r = run(N);
    assert.equal(r.arr.voices.length, N);
    assertClean(r, `Stems N=${N}`);
  }
  for (const id of ['saints', 'groove', 'ode', 'grace']) {
    for (const N of [1, 4, 8, 15]) {
      const r = orchestrate(demoSong(id), { voices: N });
      assertClean(r, `${id} N=${N}`);
    }
  }
  assert.throws(() => orchestrate(material, { voices: 16 }), /1 bis 15/);
  assert.throws(() => orchestrate(material, { voices: 0 }), /1 bis 15/);
});

test('Zufallsmaterial in allen Taktarten: keine Regelverstöße, MusicXML mit vollständigen Takten', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const m = randomMaterial(seed, Rng);
    seen.add(`${m.meter.beats}/${m.meter.beatType}`);
    for (const N of [2, 4, 9, 15]) {
      const r = orchestrate(m, { voices: N });
      assertClean(r, `Zufall ${seed} (${m.meter.beats}/${m.meter.beatType}) N=${N}`);
      if (N === 4) for (const d of measureDurations(r.xml())) assert.equal(d.dur, d.expected, `Zufall ${seed} Takt ${d.measure}`);
    }
  }
  assert.ok(seen.size >= 4, `nur ${[...seen]} getestet`);
});

test('Phrasierung: Atempausen, Verzahnung und Melodieübernahme', () => {
  const r = run(8);
  const mt = 96;
  // keine Bläserstimme spielt länger als 8 Takte ohne Pause von mindestens einer Zählzeit
  for (const v of r.arr.voices) {
    const evs = sortEvents([...v.events]);
    let start = null;
    let end = null;
    let longest = 0;
    for (const e of evs) {
      if (start === null || e.start - end >= 24) {
        if (start !== null) longest = Math.max(longest, end - start);
        start = e.start;
      }
      end = Math.max(end ?? 0, e.start + e.dur);
    }
    longest = Math.max(longest, end - start);
    assert.ok(longest <= 8 * mt, `${v.inst.name}: ${longest / mt} Takte am Stück`);
  }
  // Takt 8, Zählzeit 3–4 pausiert die Melodie: eine Nebenstimme führt (Antwort), Melodie setzt in Takt 9 wieder ein
  const gap = [7 * 96 + 48, 8 * 96];
  const answers = r.arr.voices.filter((v) => v.role !== 'lead').flatMap((v) => v.events.filter((e) => e.role === 'answer' && e.start >= gap[0] && e.start < gap[1]));
  assert.ok(answers.length >= 2, 'Antwort in der Melodielücke');
  assert.ok(answers.every((e) => e.start + e.dur <= gap[1]));
  assert.ok(soundingAt(lead(r).events, gap[0] + 1) === null, 'Melodie pausiert');
  // Atemzeichen an Phrasenenden (Melodie)
  const lb = lead(r).events.filter((e) => e.breathAfter);
  assert.ok(lb.length >= 2);
  // Interlocking im Bericht
  assert.ok(r.arr.engine.report.breaths.length >= 2);
});

// ---- 4. Instrumenten-Profile ------------------------------------------------------------------------
test('Profile: Transpositionen, Bereiche und Sweet Spots laut Vorgabe', () => {
  for (const [key, [dia, chrom]] of Object.entries(SPEC_TRANSPOSE)) {
    assert.deepEqual([PROFILES[key].transpose.diatonic, PROFILES[key].transpose.chromatic], [dia, chrom], key);
  }
  const m = parseMidiName;
  assert.deepEqual(PROFILES.flute.range, [m('C4'), m('D7')]);
  assert.deepEqual(PROFILES.flute.sweet, [m('G4'), m('G6')]);
  assert.deepEqual(PROFILES.oboe.range, [m('Bb3'), m('G6')]);
  // Klarinette: E3–G6 notiert -> klingend D3–F6
  assert.deepEqual(PROFILES.clarinet.range, [m('E3') - 2, m('G6') - 2]);
  assert.equal(PROFILES.tenorSax.range[0], m('Ab2'));
  assert.equal(PROFILES.bariSax.range[0], m('C2'));
  assert.equal(PROFILES.trumpet.range[0], m('F#3') - 2);
  assert.equal(PROFILES.trumpet.range[1], m('C6') - 2);
  assert.equal(PROFILES.horn.range[1], m('C6') - 7);
  assert.equal(PROFILES.trombone.range[0], m('E1'));
  assert.equal(PROFILES.tuba.range[0], m('D1'));
  assert.equal(PROFILES.tuba.range[1], m('F3'));
  for (const p of Object.values(PROFILES)) assert.ok(p.sweet[0] >= p.range[0] && p.sweet[1] <= p.range[1] && p.sweet[1] - p.sweet[0] >= 7, p.key);
  // Schlüssel
  assert.equal(PROFILES.flute.clef, 'G2');
  assert.equal(PROFILES.trombone.clef, 'F4');
  assert.equal(PROFILES.tuba.clef, 'F4');
  // stufenweise Oktavierung in den Bereich
  assert.equal(fitPitch(100, PROFILES.flute), 88);
  assert.equal(fitPitch(40, PROFILES.flute), 64);
  assert.equal(fitPitch(20, PROFILES.tuba), 32);
  assert.equal(fitPitch(70, PROFILES.tuba), 46);
  assert.equal(fitPitch(60, PROFILES.flute), 60);
  // keine Besetzung kann mehr als 15 Stimmen haben; eigene Instrumente werden geprüft
  assert.equal(Object.keys(ENSEMBLES).length, 15);
  assert.throws(() => ensembleFor(4, ['flute', 'oboe']), /genau 4/);
  assert.throws(() => ensembleFor(2, ['flute', 'theremin']), /Unbekannt/);
  assert.deepEqual(ensembleFor(2, ['flute', 'tuba']).map((v) => v.profile), ['flute', 'tuba']);
});

test('Profile: kein Ton der Partitur liegt außerhalb des Profilbereichs (alle N)', () => {
  for (const N of [1, 4, 8, 15]) {
    const r = run(N);
    for (const v of r.arr.voices) {
      const [lo, hi] = PROFILES[v.profile].range;
      for (const e of v.events) assert.ok(e.pitches.every((p) => p >= lo && p <= hi), `${v.inst.name} ${e.pitches} bei ${e.start}`);
    }
  }
  // Eigene Besetzung: Flöten-Quartett zwingt die Melodie in den Flötenbereich
  const r = orchestrate(material, { voices: 4, instruments: ['flute', 'oboe', 'clarinet', 'tuba'] });
  assert.deepEqual(r.arr.voices.map((v) => v.profile), ['flute', 'oboe', 'clarinet', 'tuba']);
  assert.equal(r.validation.violations.filter((v) => v.rule === 'range').length, 0);
});

// ---- 5. MusicXML 4.0 -------------------------------------------------------------------------
test('MusicXML: Struktur, part-list, midi-instrument und transpose', () => {
  const r = run(15);
  const xml = r.xml();
  assert.match(xml, /<score-partwise version="4\.0">/);
  assert.match(xml, /MusicXML 4\.0 Partwise/);
  const sc = readScore(xml);
  assert.equal(sc.parts.length, 15);
  const ids = sc.parts.map((p) => p.id);
  assert.deepEqual(ids, Array.from({ length: 15 }, (_, i) => `P${i + 1}`));
  // jede score-part mit midi-instrument
  const scoreParts = sc.root.get('part-list').all('score-part');
  assert.equal(scoreParts.length, 15);
  for (const sp of scoreParts) assert.ok(sp.has('midi-instrument/midi-program') && sp.has('midi-instrument/midi-channel'));
  // Kanal 10 (Schlagzeug) bleibt frei
  assert.ok(scoreParts.every((sp) => sp.num('midi-instrument/midi-channel') !== 10));
  // <transpose> nach Vorgabe: Klarinette −1/−2, Altsax −5/−9, Tenorsax −8/−14, Baritonsax −12/−21, Trompete −1/−2, Horn −4/−7
  const want = { 'Klarinette in B': [-1, -2], 'Altsaxophon in Es': [-5, -9], 'Tenorsaxophon in B': [-8, -14], 'Baritonsaxophon in Es': [-12, -21], 'Trompete in B': [-1, -2], 'Horn in F': [-4, -7] };
  for (const p of sc.parts) {
    const base = p.name.replace(/ \d+$/, '');
    if (want[base]) {
      assert.deepEqual([p.transpose.diatonic, p.transpose.chromatic], want[base], p.name);
      assert.equal(p.transpose.octave, null, 'zusammengefasste Angabe ohne octave-change');
    } else assert.equal(p.transpose, null, p.name);
  }
  // Schlüssel: Posaune, Euphonium, Tuba im Bassschlüssel, Flöte im Violinschlüssel
  const clefOf = (name) => sc.root.all('part')[sc.parts.findIndex((p) => p.name === name)].all('measure')[0].child('attributes').child('clef').val('sign');
  assert.equal(clefOf('Flöte 1'), 'G');
  assert.equal(clefOf('Tuba'), 'F');
  assert.equal(clefOf('Euphonium'), 'F');
  // vollständige Takte in allen Stimmen
  for (const d of measureDurations(xml)) assert.equal(d.dur, d.expected, `Stimme ${d.part} Takt ${d.measure}`);
});

test('MusicXML: Probenbuchstaben an echten Formteilen, fortlaufend A, B, C …', () => {
  const r = run(4);
  const sc = readScore(r.xml());
  const marks = sc.root.all('part')[0].find('rehearsal').map((x) => x.text);
  assert.deepEqual(marks, ['A', 'B', 'C']);
  assert.equal(r.arr.blocks.filter((b) => b.rehearsal).length, 3);
  // Formteile beginnen an den erkannten Grenzen (Begleitung wechselt in Takt 5 und 9)
  assert.deepEqual(r.arr.blocks.map((b) => b.startBar), [0, 4, 8]);
  // Begleitwechsel ist die Grenze zwischen Liegeklängen und Einwürfen
  assert.ok(r.arr.blocks.every((b) => b.name && b.rehearsal));
});

test('MusicXML: Balken – nie über die Taktmitte, 16tel schlagweise', () => {
  for (const N of [1, 8]) {
    const sc = readScore(run(N).xml());
    for (const part of sc.parts) {
      for (const meas of part.measures) {
        // Balkengruppen (Ebene 1): begin … end
        let group = null;
        for (const n of meas.notes) {
          for (const b of n.beams) {
            if (b.n !== 1) continue;
            if (b.v === 'begin') group = { from: n.pos, to: n.pos + n.dur };
            else if (group) group.to = n.pos + n.dur;
            if (b.v === 'end' && group) {
              assert.ok(!(group.from < 48 && group.to > 48), `${part.name} Takt ${meas.number}: Balken über Zählzeit 3 (${group.from}–${group.to})`);
              group = null;
            }
          }
        }
        // 16tel-Balken (Ebene 2) reichen nie über eine Schlaggrenze
        let g2 = null;
        for (const n of meas.notes) {
          for (const b of n.beams) {
            if (b.n !== 2) continue;
            if (b.v === 'begin') g2 = { from: n.pos, to: n.pos + n.dur };
            else if (g2) g2.to = n.pos + n.dur;
            if (b.v === 'end' && g2) {
              assert.equal(Math.floor(g2.from / 24), Math.floor((g2.to - 1) / 24), `${part.name} Takt ${meas.number}: 16tel über die Schlaggrenze`);
              g2 = null;
            }
          }
        }
      }
    }
  }
});

test('MusicXML: Artikulation, Atemzeichen und Dynamik', () => {
  const r = run(8);
  const sc = readScore(r.xml());
  const all = sc.parts.flatMap((p) => p.notes);
  assert.ok(all.some((n) => n.arts.includes('staccato')));
  assert.ok(all.some((n) => n.arts.includes('accent') || n.arts.includes('strong-accent')));
  assert.ok(sc.parts.reduce((s, p) => s + p.breathMarks, 0) >= 3);
  // Staccato nur auf kurzen Tönen; Akzente nur auf synkopierten Einsätzen (nicht auf dem Schlag)
  for (const n of all) if (n.arts.includes('staccato')) assert.ok(n.dur <= 24);
  for (const e of r.arr.voices.flatMap((v) => v.events)) {
    if (e.art.includes('accent')) assert.ok(e.start % 24 !== 0, `Akzent auf dem Schlag bei ${e.start}`);
  }
  // Dynamik: jede Stimme hat Zeichen, und nur aus der Vorgabe-Reihe
  for (const p of sc.parts) {
    assert.ok(p.dynamics.length >= 1, p.name);
    assert.ok(p.dynamics.every((d) => ['pp', 'p', 'mp', 'mf', 'f', 'ff'].includes(d.value)));
  }
  // Begleitung stets eine Stufe unter dem Lead (Validator) und die MIDI-Ausgabe funktioniert
  assert.equal(r.validation.violations.filter((v) => v.rule === 'dynamics').length, 0);
  assert.ok(exportMidi(r.arr).length > 500);
});

test('Validator: erkennt eingebaute Verstöße', () => {
  const clone = () => {
    const r = orchestrate(material, { voices: 4, title: 'x' });
    return r.arr;
  };
  let arr = clone();
  assert.equal(validateArrangement(arr).ok, true);
  // außerhalb des Bereichs
  arr = clone();
  arr.voices[0].events[0].pitches = [110];
  assert.ok(validateArrangement(arr).violations.some((v) => v.rule === 'range'));
  // Sprung > Oktave
  arr = clone();
  arr.voices[1].events[3].pitches = [arr.voices[1].events[2].pitches[0] + 14];
  assert.ok(validateArrangement(arr).violations.some((v) => v.rule === 'leap' || v.rule === 'range'));
  // Sekunde unter C3
  arr = clone();
  const bass = arr.voices[3].events[0];
  arr.voices[2].events.push({ ...arr.voices[2].events[0], start: bass.start, dur: 12, pitches: [bass.pitches[0] + 2], lofs: [null], art: [], role: 'pad' });
  assert.ok(validateArrangement(arr).violations.some((v) => v.rule === 'friction'));
  // Atem: Pausenlos über 10 Takte
  arr = clone();
  arr.voices[3].events = Array.from({ length: 10 }, (_, i) => ({ ...arr.voices[3].events[0], start: i * 96, dur: 96, role: 'bass', breathAfter: false }));
  assert.ok(validateArrangement(arr).violations.some((v) => v.rule === 'breath'));
  // gleiche Anschläge in den Mittelstimmen
  arr = clone();
  arr.voices[2].events = arr.voices[1].events.map((e) => ({ ...e, pitches: [e.pitches[0] - 7], lofs: [null] }));
  assert.ok(validateArrangement(arr).violations.some((v) => v.rule === 'shared-attacks'));
  // Liegeton über den ganzen Takt
  arr = clone();
  arr.voices[1].events[0].dur = 96;
  assert.ok(validateArrangement(arr).violations.some((v) => v.rule === 'static-pad'));
  // Schreibweise: A# in F-Dur
  arr = clone();
  const tb = arr.voices[2].events.find((e) => e.pitches[0] % 12 === 10);
  if (tb) {
    tb.lofs = [8]; // A#
    assert.ok(validateArrangement(arr).violations.some((v) => v.rule === 'spelling'));
  }
});

test('Export: exportScore im Konzertton und als Einzelstimme', () => {
  const r = run(4);
  const part = exportScore(r.arr, { mode: 'part', partIndex: 2 });
  assert.equal((part.match(/<part id=/g) || []).length, 1);
  assert.match(part, /Posaune/);
  assert.ok(frictions([]).length === 0);
});
