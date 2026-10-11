import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretFeedback, sanitizeTweaks, applyTweaks, mergeTweaks } from '../src/arrange/feedback.js';
import { TaskList, formatEta } from '../src/web/tasks.js';
import { EFFORT, effortOf, effortFromLegacy } from '../src/core/effort.js';
import { arrange } from '../src/arrange/engine.js';
import { arrangeBest } from '../src/arrange/best.js';
import { scoreArrangement } from '../src/arrange/quality.js';
import { INSTRUMENTS } from '../src/arrange/instruments.js';
import { demoSong } from './helpers.js';

const ctx = { voices: ['trumpet', 'trumpet', 'trombone', 'sousaphone'], bars: 40, hasAudio: true, tempo: 100 };

test('Aufwand: fünf Stufen, mehr Aufwand = mehr Zeit und mehr Suche', () => {
  assert.equal(EFFORT.length, 5);
  for (let i = 1; i < 5; i++) {
    assert.ok(EFFORT[i].analysis.passes >= EFFORT[i - 1].analysis.passes);
    assert.ok(EFFORT[i].arrange.seeds >= EFFORT[i - 1].arrange.seeds);
    assert.ok(EFFORT[i].arrange.search >= EFFORT[i - 1].arrange.search);
    assert.ok(EFFORT[i].arrange.budgetMs >= EFFORT[i - 1].arrange.budgetMs);
  }
  assert.equal(effortOf(0).level, 1);
  assert.equal(effortOf(9).level, 5);
  assert.equal(effortOf('x').level, 3);
  assert.equal(effortFromLegacy('fast'), 1);
  assert.equal(effortFromLegacy('thorough'), 3);
  assert.equal(EFFORT[0].analysis.passes, 1, 'Schnell = ein Durchgang');
});

test('Rückmeldung: Melodie fehlt -> Melodie-Vorrang, nah am Original, Aufnahme neu hören', () => {
  const r = interpretFeedback('Die Melodie fehlt in der Strophe oder kommt nur bruchweise', ctx);
  assert.equal(r.tweaks.melodyFirst, true);
  assert.equal(r.tweaks.adapt, 0);
  assert.equal(r.tweaks.reanalyze, true);
  assert.ok(!r.tweaks.general);
  assert.ok(r.notes.length >= 1);
  // ohne Aufnahme (MIDI/ABC) keine Neu-Analyse
  const m = interpretFeedback('Melodie fehlt', { ...ctx, hasAudio: false });
  assert.ok(!m.tweaks.reanalyze);
});

test('Rückmeldung: Stimmen passen nicht zusammen, Takte, Schwierigkeit, Lage', () => {
  const a = interpretFeedback('Takt 17-24 klingt schief und die Stimmen passen nicht zusammen', ctx);
  assert.deepEqual(a.tweaks.focus, [{ from: 17, to: 24 }]);
  assert.equal(a.tweaks.cleanHarmony, true);
  const b = interpretFeedback('Das ist viel zu schwer', ctx);
  assert.equal(b.tweaks.difficultyDelta, -1);
  const c = interpretFeedback('Stimme 2 liegt zu hoch', ctx);
  assert.deepEqual(c.tweaks.voiceRanges, [{ voice: 1, dir: 'lower' }]);
  const d = interpretFeedback('Die Posaune ist zu tief', ctx);
  assert.deepEqual(d.tweaks.voiceRanges, [{ voice: 2, dir: 'higher' }]);
  const e = interpretFeedback('Das Schlagzeug nervt und das Solo ist zu lang, der Bass ist hektisch', ctx);
  assert.equal(e.tweaks.drums, 'off');
  assert.equal(e.tweaks.solo, 'short');
  assert.equal(e.tweaks.bass, 'calm');
});

test('Rückmeldung: leer oder unverständlich = alles gründlich überarbeiten', () => {
  assert.equal(interpretFeedback('', ctx).tweaks.general, true);
  assert.equal(interpretFeedback('   ', ctx).general, true);
  const x = interpretFeedback('Gefällt mir nicht so richtig', ctx);
  assert.equal(x.tweaks.general, true);
  assert.ok(x.tweaks.deep);
});

test('Rückmeldung anwenden: Schwierigkeit, Lage, Tempo, Solo, Bass; Fremdes wird geprüft', () => {
  const opts = { voices: ctx.voices, difficulty: 'auto', adapt: 1, tempo: null, ranges: [] };
  const t = mergeTweaks(interpretFeedback('zu schwer, Stimme 1 zu hoch, Tempo zu schnell, Solo weg', ctx).tweaks, {});
  const o = applyTweaks(opts, t, { tempo: 120, instruments: INSTRUMENTS });
  assert.equal(o.difficulty, 2);
  assert.equal(o.solo, 'none');
  assert.equal(o.tempo, Math.round(120 * 0.88));
  const tr = INSTRUMENTS.trumpet;
  assert.equal(o.ranges[0].hi, tr.comfort[1] + tr.transpose.semis - 3);
  // Fremde Vorschläge: nur Erlaubtes, in Grenzen
  const s = sanitizeTweaks({ melodyFirst: true, evil: 'x', tempoFactor: 9, adapt: 7, voiceRanges: [{ voice: 99, dir: 'lower' }, { voice: 1, dir: 'higher' }], focus: [{ from: 5, to: 2 }] });
  assert.equal(s.melodyFirst, true);
  assert.equal(s.tempoFactor, 1.5);
  assert.equal(s.adapt, undefined);
  assert.ok(!('evil' in s));
  assert.deepEqual(s.voiceRanges, [{ voice: 1, dir: 'higher' }]);
  assert.deepEqual(s.focus, [{ from: 2, to: 5 }]);
  assert.equal(sanitizeTweaks({ evil: 1 }).general, true);
});

test('Fortschritt in Aufgaben: stetig, nie zurück, Restzeit nimmt ab, Aufgabe läuft ohne Meldung weiter', () => {
  let now = 0;
  const tl = new TaskList([{ id: 'a', label: 'A', expect: 10000 }, { id: 'b', label: 'B', expect: 5000 }], { now: () => now });
  tl.start('a');
  const seen = [];
  for (let i = 0; i < 100; i++) {
    now += 100;
    tl.update(100);
    seen.push(tl.get('a').shown);
  }
  // ohne echte Meldung wächst die Anzeige trotzdem, ohne 100 % zu erreichen
  assert.ok(seen[seen.length - 1] > 0.3, `Anzeige ${seen[seen.length - 1]}`);
  assert.ok(seen[seen.length - 1] < 0.985);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'springt nicht zurück');
  // echter Stand: die Anzeige folgt, die Restzeit passt sich an
  // die Arbeit dauert real 20 s: nach 10 s steht sie bei 50 %, danach laufen die Meldungen weiter
  tl.set('a', 0.5, 'Durchgang 2 von 4');
  for (let i = 0; i < 40; i++) {
    now += 100;
    tl.update(100);
    if (i % 10 === 9) tl.set('a', Math.min(1, now / 20000));
  }
  const v = tl.view().find((x) => x.id === 'a');
  assert.ok(v.shown >= 0.5);
  assert.equal(v.detail, 'Durchgang 2 von 4');
  assert.ok(v.etaMs < 9000 && v.etaMs > 3000, 'Restzeit ' + v.etaMs);
  tl.done('a');
  for (let i = 0; i < 30; i++) {
    now += 100;
    tl.update(100);
  }
  assert.equal(tl.get('a').shown, 1);
  assert.equal(tl.view().find((x) => x.id === 'b').state, 'wait');
  assert.ok(tl.totalEta() > 0);
  tl.finish();
  assert.ok(tl.tasks.every((t) => t.state === 'done'));
});

test('Restzeit lesbar', () => {
  assert.equal(formatEta(1500), 'gleich fertig');
  assert.equal(formatEta(42000), 'noch ca. 40 s');
  assert.equal(formatEta(130000), 'noch ca. 2 Min. 10 s');
  assert.equal(formatEta(14 * 60000), 'noch ca. 14 Min.');
});

test('Arrangement: gleiche Einstellungen = gleiches Ergebnis; Variantensuche & Schwerpunkt liefern gültige Fassungen', () => {
  const song = demoSong('saints');
  const o = { style: 'funk', seed: 3 };
  const a = arrange(song, o);
  const b = arrange(song, o);
  assert.equal(JSON.stringify(a.voices.map((v) => v.events.length)), JSON.stringify(b.voices.map((v) => v.events.length)));
  const s = arrange(song, { ...o, search: 6, focus: [{ from: 3, to: 6 }], deepSegments: ['1:0'], cleaner: true });
  assert.equal(s.voices.length, 4);
  assert.ok(s.voices.every((v) => v.events.length > 0));
  assert.ok(Array.isArray(s.segmentScores) && s.segmentScores.length > 0);
  const m = arrange(song, { ...o, melodyFirst: true, cleanHarmony: true, bassMode: 'calm' });
  assert.ok(m.voices.every((v) => v.events.length > 0));
});

test('Gründlich arrangieren: mehrere Fassungen, beste gewählt, Bericht vorhanden', async () => {
  const song = demoSong('saints');
  const a = await arrangeBest(song, { style: 'funk', seed: 1 }, { seeds: 4, search: 3, budgetMs: 5000, sweep: true, polish: 1 });
  assert.ok(a.report.search.trials >= 4);
  assert.ok(a.report.search.score >= 40);
  // die gewählte Fassung ist mindestens so gut wie die Standardfassung
  const base = scoreArrangement(arrange(song, { style: 'funk', seed: 1 }));
  assert.ok(a.report.search.score >= Math.round(base * 10) / 10 - 0.05, `${a.report.search.score} vs ${base}`);
  assert.ok(a.voices.every((v) => v.events.length > 0));
});

test('Arrangieren lässt sich abbrechen: AbortError, nichts halb fertig', async () => {
  const song = demoSong('saints');
  const ctl = new AbortController();
  let calls = 0;
  const p = arrangeBest(song, { style: 'funk', seed: 1 }, { seeds: 8, search: 3, budgetMs: 20000, sweep: false, polish: 0 }, {
    signal: ctl.signal,
    onProgress: () => {
      if (++calls >= 2) ctl.abort();
    },
  });
  await assert.rejects(p, (e) => e.name === 'AbortError');
  // bereits abgebrochenes Signal bricht sofort ab
  await assert.rejects(arrangeBest(song, { style: 'funk' }, { seeds: 3, search: 2, budgetMs: 5000 }, { signal: AbortSignal.abort() }), (e) => e.name === 'AbortError');
});

test('Noten aus KI-Aktivierungen: gepflanzte Töne werden gefunden, 4 Minuten in unter 3 s', async () => {
  const { activationsToNotes } = await import('../src/input/ai-pitch.js');
  const nOut = 240 * 86;
  const frames = new Float32Array(nOut * 88);
  const onsets = new Float32Array(nOut * 88);
  const planted = [];
  for (let k = 0; k < 400; k++) {
    const t = 40 + k * 50;
    const p = 20 + ((k * 7) % 50);
    const len = 20 + (k % 5) * 6;
    onsets[t * 88 + p] = 0.95;
    for (let i = 0; i < len; i++) frames[(t + i) * 88 + p] = 0.8;
    planted.push({ t, p, len });
  }
  const t0 = Date.now();
  const notes = activationsToNotes({ frames, onsets, nOut, multi: true });
  assert.ok(Date.now() - t0 < 3000, `Umrechnung dauerte ${Date.now() - t0} ms`);
  // gepflanzte Töne (Frames × 256 / 22050 s)
  let found = 0;
  for (const q of planted) {
    // Modell-Frame -> Sekunden wie in Basic Pitch (Fenster-Versatz je 2-s-Fenster)
    const offset = (256 / 22050) * (172 - (22050 * 2 - 256) / 256) + 0.0018;
    const start = (q.t * 256) / 22050 - offset * Math.floor(q.t / 172);
    if (notes.some((n) => n.midi === q.p + 21 && Math.abs(n.start - start) < 0.05)) found++;
  }
  assert.ok(found >= 390, `${found} von 400 gefunden`);
});
