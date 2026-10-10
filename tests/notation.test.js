import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitDuration, meterInfo, layoutVoice } from '../src/output/notation.js';

const mi = meterInfo({ beats: 4, beatType: 4 });
const vals = (pos, dur, rest = false) => splitDuration(pos, dur, mi, rest).map((p) => `${p.type}${p.dots ? '.' : ''}`);

test('Takthälfte bleibt sichtbar: Halbe auf Zählzeit 2 wird gebunden', () => {
  assert.deepEqual(vals(24, 48), ['quarter', 'quarter']);
});
test('Synkope Achtel-Viertel-Achtel bleibt eine Viertel', () => {
  assert.deepEqual(vals(12, 24), ['quarter']);
});
test('Punktierte Halbe auf 1 erlaubt', () => {
  assert.deepEqual(vals(0, 72), ['half.']);
});
test('Pausen werden nicht synkopiert, Ganztaktpause', () => {
  assert.deepEqual(vals(12, 24, true), ['eighth', 'eighth']);
  const m = layoutVoice([], { beats: 4, beatType: 4 }, 1);
  assert.equal(m[0][0].measureRest, true);
});
test('Balken: 16tel pro Schlag, Achtel pro Takthälfte', () => {
  const ev = (start, dur) => ({ start, dur, pitches: [60], lofs: [0], art: [], fx: [] });
  const m = layoutVoice([ev(0, 12), ev(12, 12), ev(24, 12), ev(36, 12), ev(48, 6), ev(54, 6), ev(60, 12)], { beats: 4, beatType: 4 }, 1)[0];
  assert.deepEqual(m.slice(0, 4).map((x) => x.beams[0]), ['begin', 'continue', 'continue', 'end']);
  assert.deepEqual(m[4].beams, ['begin', 'begin']);
});
test('Triolen erhalten time-modification', () => {
  const ev = (start, dur) => ({ start, dur, pitches: [60], lofs: [0], art: [], fx: [] });
  const m = layoutVoice([ev(0, 8), ev(8, 8), ev(16, 8)], { beats: 4, beatType: 4 }, 1)[0];
  assert.ok(m[0].tuplet && m[0].tuplet.start);
  assert.ok(m[2].tuplet.stop);
});
