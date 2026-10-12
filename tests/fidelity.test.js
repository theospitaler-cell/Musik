// Werktreue bei „Automatisch“: jeder erkannte Ton der Melodie bleibt erhalten – kein Ton weniger, keiner
// mehr. Kein Atem-Schnitt, keine zusammengefassten Wiederholungen, keine Pushes/Verzierungen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseABC } from '../src/input/abc.js';
import { arrange } from '../src/arrange/engine.js';
import { reduceSyllableRepeats } from '../src/arrange/rules.js';
import { orchestrate } from '../src/engine/index.js';
import { endOf, sortEvents } from '../src/engine/util.js';

// Durchgehende Achtel ohne Pause (12 Takte) und Wiederholungen gleicher Töne
const ABC = `X:1
T:Durchlauf
M:4/4
L:1/8
Q:1/4=104
K:C
|: CCCC DDDD | EEEE FFFF | GGGG AAAA | BBBB cccc | cBAG FEDC | CCCC DDDD :|
|: EEEE FFFF | GGGG AAAA | BBBB cccc | dcBA GFED | CCCC EEEE | G4 c4 |]
`;
const song = parseABC(ABC);
const noteKey = (n) => `${n.start}:${((n.midi % 12) + 12) % 12}`;

test('Orchestrierung: die Lead-Stimme behält jeden Melodieton – auch ohne Pause über viele Takte', () => {
  const total = song.melody.length;
  assert.ok(total >= 90, `Eingabe: ${total} Noten`);
  for (const N of [2, 4, 8, 15]) {
    const r = orchestrate(song, { voices: N, mode: 'classic', title: 'x' });
    const lead = r.arr.voices.find((v) => v.role === 'lead').events;
    const have = new Set(lead.map((e) => `${e.start}:${((e.pitches[0] % 12) + 12) % 12}`));
    const missing = song.melody.filter((n) => !have.has(noteKey(n)));
    assert.equal(missing.length, 0, `N=${N}: ${missing.length} Melodietöne fehlen (z. B. ${JSON.stringify(missing[0])})`);
    assert.equal(r.validation.violations.filter((v) => v.rule === 'breath').length, 0);
  }
});

test('Orchestrierung dynamisch: Lead und Solo-Stimmen zusammen spielen die vollständige Melodie', () => {
  const r = orchestrate(song, { voices: 8, mode: 'dynamic', activity: 5, title: 'x' });
  const lead = r.arr.voices.find((v) => v.role === 'lead').events;
  const solos = r.arr.engine.report.fills.filter((f) => f.kind === 'solo');
  const have = new Set(lead.map((e) => `${e.start}:${((e.pitches[0] % 12) + 12) % 12}`));
  for (const s of solos) {
    for (const e of r.arr.voices[s.voice].events) if (e.start >= s.t0 && e.start < s.t1) have.add(`${e.start}:${((e.pitches[0] % 12) + 12) % 12}`);
  }
  const missing = song.melody.filter((n) => !have.has(noteKey(n)));
  assert.equal(missing.length, 0, `${missing.length} Melodietöne fehlen`);
});

test('Schwierigkeit „Automatisch“: gleiche Töne hintereinander bleiben einzeln (keine Silbenzusammenfassung)', () => {
  const evs = [0, 12, 24, 36, 48, 60].map((t) => ({ start: t, dur: 12, pitches: [60], lofs: [null], art: [], fx: [] }));
  const auto = reduceSyllableRepeats(evs, null, 24);
  assert.equal(auto.merged, 0);
  assert.equal(auto.events.length, 6);
  // mit gewählter Schwierigkeit „Mittel“ werden Wiederholungen weiterhin lesbar zusammengefasst
  const mid = reduceSyllableRepeats(evs, 3, 24);
  assert.ok(mid.merged > 0 && mid.events.length < 6);
});

for (const [name, opts] of [
  ['Solo (frei)', { ensemble: 'solo', playback: false }],
  ['Solo mit Playback (1:1)', { ensemble: 'solo', playback: true, playParts: [{ source: 'melody', inst: 'trumpet' }] }],
  ['Quartett nah am Original', { ensemble: 'quartet', voices: ['trumpet', 'horn', 'trombone', 'tuba'], original: true }],
]) {
  test(`${name}: bei „Automatisch“ stehen alle Melodietöne im Notenbild (Einsatz und Tonklasse)`, () => {
    const a = arrange(song, { style: 'auto', adapt: 1, seed: 1, difficulty: 'auto', voiceDifficulty: [], ranges: [], drums: false, solo: 0, soloInstrument: 'trumpet', ...opts });
    const evs = sortEvents(a.voices[0].events.filter((e) => e.pitches && e.pitches.length));
    // die Melodie kommt – eventuell um einen Takt (Intro) versetzt – vollständig und in Reihenfolge vor
    const seq = evs.map((e) => ((e.pitches[0] % 12) + 12) % 12);
    const mel = [...song.melody].sort((x, y) => x.start - y.start);
    let best = -1;
    for (let shift = 0; shift < 12; shift++) {
      const want = mel.map((n) => (n.midi + shift) % 12);
      let j = 0;
      for (const p of seq) if (j < want.length && p === want[j]) j++;
      if (j > best) best = j;
    }
    assert.equal(best, mel.length, `${best}/${mel.length} Melodietöne in Reihenfolge`);
    // und nicht mehr als der Intro-/Schlussteil dazukommt
    assert.ok(evs.length <= mel.length * 1.2 + 8, `${evs.length} Ereignisse für ${mel.length} Melodietöne`);
  });
}

test('Atem der Lead-Stimme: nur dort, wo die Vorlage pausiert (Pausen bleiben, nichts wird gekürzt außer Haltetönen)', () => {
  const r = orchestrate(song, { voices: 4, mode: 'classic', title: 'x' });
  const lead = sortEvents(r.arr.voices.find((v) => v.role === 'lead').events);
  const src = [...song.melody].sort((a, b) => a.start - b.start);
  // jeder Einsatz der Vorlage steht mit gleicher Dauer da (bei Haltetönen höchstens um den Atem gekürzt)
  for (const n of src) {
    const e = lead.find((x) => x.start === n.start || x.start === n.start + 96);
    if (!e) continue;
    assert.ok(e.dur <= n.dur && e.dur >= n.dur - 24, `Dauer bei ${n.start}: ${e.dur} statt ${n.dur}`);
  }
  assert.ok(endOf(lead[lead.length - 1]) > 0);
});

test('Erkennung: kurze Töne mit steilem Anschlag bleiben (ab 60 ms), schwache Ghost-Noten fallen weg', async () => {
  const { tidyAiNotes } = await import('../src/input/voices.js');
  const mk = (start, dur, midi, amp = 0.6) => ({ start, end: start + dur, midi, amp, stem: 'vocals' });
  const raw = [mk(0, 0.5, 60), mk(1, 0.08, 62), mk(2, 0.08, 64), mk(3, 0.04, 65), mk(4, 0.5, 67)];
  // ohne Anschlag-Messung: Regel wie bisher (unter 120 ms weg)
  assert.deepEqual(tidyAiNotes(raw).map((n) => n.midi), [60, 67]);
  // mit Anschlag-Messung: 62 hat einen steilen Einsatz, 64 nicht, 65 ist zu kurz (< 60 ms)
  const rise = (t, midi) => (midi === 62 || midi === 65 ? 8 : 1.5);
  assert.deepEqual(tidyAiNotes(raw, { rise }).map((n) => n.midi), [60, 62, 67]);
  // leise Töne (unter 0,8 × Median) bleiben auch bei steilem Anschlag draußen
  const quiet = [mk(0, 0.5, 60, 0.8), mk(1, 0.08, 62, 0.2), mk(2, 0.5, 67, 0.8)];
  assert.deepEqual(tidyAiNotes(quiet, { rise: () => 9 }).map((n) => n.midi), [60, 67]);
});
