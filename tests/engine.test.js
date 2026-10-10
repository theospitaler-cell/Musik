import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange } from '../src/arrange/engine.js';
import { PRESETS, slideGlissPossible, INSTRUMENTS } from '../src/arrange/instruments.js';
import { STYLE_LIST } from '../src/arrange/styles.js';
import { demoSong } from './helpers.js';

const song = demoSong('saints');

test('alle Stile × Besetzungen: Tonumfang, keine Überlappungen, Bewegungsregel', () => {
  for (const { id: style } of STYLE_LIST) {
    for (const p of PRESETS) {
      const a = arrange(song, { style, voices: p.voices, drums: true, seed: 3 });
      a.voices.forEach((v) => {
        for (let i = 0; i < v.events.length; i++) {
          const e = v.events[i];
          for (const m of e.pitches) assert.ok(m >= v.inst.range[0] && m <= v.inst.range[1], `${style}/${p.id}: ${v.inst.name} außerhalb des Tonumfangs (${m})`);
          if (i) assert.ok(v.events[i - 1].start + v.events[i - 1].dur <= e.start, `${style}/${p.id}: Überlappung in ${v.inst.name}`);
        }
      });
      assert.equal(a.report.longNotesCovered, a.report.longNotes, `${style}/${p.id}: lange Melodietöne ohne Bewegung`);
      assert.ok(a.drums.events.length > 0);
    }
  }
});

test('Rollentausch: Melodie wandert zwischen den Stimmen', () => {
  const a = arrange(song, { style: 'funk', seed: 1 });
  const melodyVoices = new Set();
  for (const b of a.blocks) for (const seg of b.segments) seg.roles.forEach((r, i) => r === 'melody' && melodyVoices.add(i));
  assert.ok(melodyVoices.size >= 2, 'Melodie in mindestens zwei Stimmen');
});

test('Solist bekommt das Solo, kompakte Form nutzt D.S. al Coda', () => {
  const a = arrange(song, { style: 'funk', solo: 2, seed: 1 });
  const solo = a.blocks.find((b) => b.type === 'solo');
  assert.ok(solo.segments.every((s) => s.roles[2] === 'solo'));
  assert.ok(a.form.segnoBar !== null && a.form.codaBar !== null);
});

test('Ausgeschriebene Form ohne Sprünge', () => {
  const a = arrange(song, { style: 'funk', form: 'full', seed: 1 });
  assert.equal(a.form.segnoBar, null);
});

test('Deterministisch pro Variante, unterschiedlich zwischen Varianten', () => {
  const sig = (a) => a.voices.map((v) => v.events.map((e) => e.start + ':' + e.pitches.join()).join(',')).join('|');
  assert.equal(sig(arrange(song, { seed: 5 })), sig(arrange(song, { seed: 5 })));
  assert.notEqual(sig(arrange(song, { seed: 5 })), sig(arrange(song, { seed: 6 })));
});

test('Posaunen-Glissando nur auf demselben Naturton (Zugphysik)', () => {
  const tb = INSTRUMENTS.trombone;
  assert.equal(slideGlissPossible(58, 53, tb), true, 'Bb3 -> F3 (Pos. 1 -> 6 auf dem 3. Teilton)');
  assert.equal(slideGlissPossible(46, 58, tb), false, 'Oktavsprung braucht Teiltonwechsel');
});

test('Bläser bekommen Atempausen', () => {
  const a = arrange(demoSong('ode'), { style: 'ballad', seed: 2 });
  const tuba = a.voices[3];
  const sec = 60 / a.tempo / 24;
  // gespielte Dauer (Stakkato-Noten klingen kurz, auch wenn sie länger notiert sind)
  let start = 0;
  let maxRun = 0;
  for (let i = 0; i < tuba.events.length; i++) {
    const e = tuba.events[i];
    const p = tuba.events[i - 1];
    if (!p || e.start - (p.start + (p.playDur ?? p.dur)) >= 6) start = e.start;
    maxRun = Math.max(maxRun, (e.start + (e.playDur ?? e.dur) - start) * sec);
  }
  assert.ok(maxRun <= tuba.inst.breath * 1.6, `längste Phrase ${maxRun.toFixed(1)} s`);
});

test('Eigener Tonumfang pro Stimme wird eingehalten (notierte Tonhöhe)', () => {
  // Trompete höchstens notiert G5 (=79), Sousaphon nicht unter klingend Es2 (=39)
  const a = arrange(song, { style: 'funk', seed: 1, drums: false, ranges: [{ lo: null, hi: 79 }, null, null, { lo: 39, hi: null }] });
  const trp = a.voices[0];
  for (const e of trp.events) for (const m of e.pitches) assert.ok(m + 2 <= 79, `Trompete zu hoch: notiert ${m + 2}`);
  for (const e of a.voices[3].events) for (const m of e.pitches) assert.ok(m >= 39, `Sousaphon zu tief: ${m}`);
});

test('Schwierigkeit: Stufe 1 ohne 16tel & Effekte, Stufe pro Stimme', () => {
  const a = arrange(song, { style: 'funk', seed: 2, difficulty: 1, voiceDifficulty: [null, null, null, 5] });
  for (let v = 0; v < 3; v++) {
    for (const e of a.voices[v].events) {
      assert.equal(e.start % 12, 0, `Stimme ${v + 1}: nur Achtelraster`);
      assert.ok(!e.fx.some((f) => ['falloff', 'glissStart', 'doit', 'scoop'].includes(f)), 'keine Effekte');
    }
  }
  assert.deepEqual(a.levels, [1, 1, 1, 5]);
  const easyHi = Math.max(...a.voices[0].events.flatMap((e) => e.pitches));
  const pro = arrange(song, { style: 'funk', seed: 2, difficulty: 5 });
  assert.ok(easyHi <= Math.max(...pro.voices[0].events.flatMap((e) => e.pitches)), 'leichte Stufe nicht höher als Profi');
});

test('Solo-Noten: ein Instrument bzw. Schlagzeug-Chart', () => {
  const t = arrange(song, { ensemble: 'solo', soloInstrument: 'altoSax', seed: 1 });
  assert.equal(t.voices.length, 1);
  assert.equal(t.drums, null);
  assert.ok(t.voices[0].events.length > 40);
  assert.ok(t.blocks.some((b) => b.type === 'solo'));
  const d = arrange(song, { ensemble: 'solo', soloInstrument: 'drums', seed: 1 });
  assert.equal(d.voices.length, 0);
  assert.ok(d.drums.events.length > 100);
  assert.ok(d.blocks.some((b) => b.name === 'Drum-Solo'));
});
