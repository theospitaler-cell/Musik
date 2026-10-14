// Stimmen dazuschreiben: nur Begleitung, Melodie anteilig mitspielen, Solos übergeben (Anteil je Stimme).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addVoices } from '../src/sheet/addvoices.js';
import { barsForShare } from '../src/engine/behavior.js';

const XML = readFileSync(new URL('./fixtures/scans/saints.truth.musicxml', import.meta.url), 'utf8');
const COMMON = { sourceId: 'concert', lead: 'trumpet', voices: ['horn', 'trombone', 'tuba'], mode: 'classic', activity: 3 };
const run = (extra) => addVoices(XML, { ...COMMON, ...extra });

// Takt -> Tonklassen-Folge einer Stimme
function barsOf(arr, voiceIndex) {
  const mt = arr.mt;
  const out = new Map();
  for (const e of arr.voices[voiceIndex].events) {
    const b = Math.floor(e.start / mt);
    if (!out.has(b)) out.set(b, []);
    out.get(b).push(`${e.start - b * mt}:${((e.pitches[0] % 12) + 12) % 12}:${e.dur}`);
  }
  return out;
}
const same = (a, b, bar) => (a.get(bar) || []).join('|') === (b.get(bar) || []).join('|') && (a.get(bar) || []).length > 0;

test('Takte für einen Anteil: 0 % keine, 100 % alle, sonst Blöcke gleichmäßig, erster Block bleibt frei', () => {
  assert.deepEqual(barsForShare(16, 0), []);
  assert.equal(barsForShare(16, 100).length, 16);
  const half = barsForShare(16, 50);
  assert.equal(half.length, 8);
  assert.ok(half.every((b) => b >= 2), 'erster Block gehört der Hauptstimme');
  // Zweierblöcke
  for (let i = 0; i < half.length; i += 2) assert.equal(half[i + 1], half[i] + 1);
  // Soli in Viererblöcken
  const solo = barsForShare(16, 25, 0, 4);
  assert.equal(solo.length, 4);
  assert.equal(solo[3] - solo[0], 3);
  // verschiedene Stimmen sind gegeneinander versetzt
  assert.notDeepEqual(barsForShare(16, 25, 0, 4), barsForShare(16, 25, 2, 4));
});

test('Nur Begleitung: keine Stimme spielt die Melodie der Hauptstimme', () => {
  const r = run({ melody: 'none' });
  const lead = barsOf(r.arr, 0);
  for (let v = 1; v < r.arr.voices.length; v++) {
    const bars = barsOf(r.arr, v);
    let equal = 0;
    for (const b of lead.keys()) if (same(lead, bars, b)) equal++;
    assert.ok(equal <= 1, `Stimme ${v + 1} spielt in ${equal} Takten die Melodie`);
  }
  assert.deepEqual(r.melodyShare, [0, 0, 0, 0]);
});

test('Melodie anteilig mitspielen: Hauptstimme unverändert, gewählter Anteil der Takte je Stimme', () => {
  const none = run({ melody: 'none' });
  const r = run({ melody: 'share', shares: [50, 0, 100] });
  const leadNone = barsOf(none.arr, 0);
  const lead = barsOf(r.arr, 0);
  for (const b of leadNone.keys()) assert.ok(same(lead, leadNone, b), `Hauptstimme Takt ${b + 1} verändert`);
  const total = lead.size;
  // Einsätze (Zeit und Länge) wie die Melodie: Terzparallelen und Oktaven haben denselben Rhythmus
  const countDoubled = (v) => {
    const bars = barsOf(r.arr, v);
    let n = 0;
    for (const b of lead.keys()) {
      const a = (lead.get(b) || []).map((x) => `${x.split(':')[0]}:${x.split(':')[2]}`).join('|');
      const c = (bars.get(b) || []).map((x) => `${x.split(':')[0]}:${x.split(':')[2]}`).join('|');
      if (a && a === c) n++;
    }
    return n;
  };
  const half = countDoubled(1);
  assert.ok(half >= total * 0.4 && half <= total * 0.6, `Horn: ${half} von ${total}`);
  assert.ok(countDoubled(2) <= 1, 'Posaune soll nicht mitspielen');
  assert.ok(countDoubled(3) >= total * 0.9, `Tuba 100 %: ${countDoubled(3)} von ${total}`);
  assert.ok(r.arr.report.notes.some((n) => /Melodie in Nebenstimmen/.test(n)));
  assert.deepEqual(r.report.violations, {});
});

test('Solos übergeben: die Stimme spielt das Solo, die Hauptstimme in diesen Takten ihre Begleitung', () => {
  const none = run({ melody: 'none' });
  const r = run({ melody: 'solo', shares: [50, 0, 0] });
  const leadNone = barsOf(none.arr, 0);
  const lead = barsOf(r.arr, 0);
  const soloist = barsOf(r.arr, 1);
  const changed = [...leadNone.keys()].filter((b) => !same(lead, leadNone, b));
  assert.ok(changed.length >= 6 && changed.length <= 10, `geänderte Takte: ${changed.length}`);
  assert.ok(!changed.includes(0), 'Takt 1 bleibt bei der Hauptstimme');
  // in den Solo-Takten spielt die Solostimme die ursprüngliche Melodie (Tonklassen und Rhythmus)
  const melody = (list) => list.map((x) => x.split(':').slice(0, 2).join(':')).join('|');
  let melodic = 0;
  for (const b of changed) if (melody(leadNone.get(b) || []) === melody(soloist.get(b) || [])) melodic++;
  assert.ok(melodic >= changed.length * 0.7, `Solostimme spielt die Melodie in ${melodic} von ${changed.length} Takten`);
  assert.ok(r.arr.report.notes.some((n) => /Solo-Übergabe/.test(n)));
  assert.deepEqual(r.report.violations, {});
});

test('Solos übergeben: mehrere Stimmen teilen sich die Takte ohne Überschneidung', () => {
  const none = run({ melody: 'none' });
  const r = run({ melody: 'solo', shares: [25, 25, 25] });
  const leadNone = barsOf(none.arr, 0);
  const melody = (list) => list.map((x) => x.split(':').slice(0, 2).join(':')).join('|');
  const owners = new Map();
  for (let v = 1; v <= 3; v++) {
    const bars = barsOf(r.arr, v);
    for (const b of leadNone.keys()) {
      const m = melody(leadNone.get(b) || []);
      if (m && m === melody(bars.get(b) || []) && !same(barsOf(none.arr, v), bars, b)) {
        if (owners.has(b)) assert.fail(`Takt ${b + 1}: zwei Solisten`);
        owners.set(b, v);
      }
    }
  }
  assert.ok(owners.size >= 8, `Solo-Takte: ${owners.size}`);
  assert.equal(new Set(owners.values()).size, 3, 'jede Stimme hat ein Solo');
});
