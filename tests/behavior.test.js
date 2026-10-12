// Führung & Stimmendynamik (src/engine/behavior.js): Modus A „Dynamisch & Polyphon“ und Modus B
// „Klassischer Solo-Lead“, Aktivität der Nebenstimmen 1–5. Geprüft an Stems mit bekannter Wahrheit
// (tests/fixtures/stems.js) und an den Demo-Liedern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXML } from '../src/core/xml.js';
import { dynIndex } from '../src/core/constants.js';
import { orchestrate, orchestrateFromOptions, routeStems, behaviorFor, validateArrangement, PROFILES, ACTIVITY_NAMES, MODES } from '../src/engine/index.js';
import { endOf, sortEvents } from '../src/engine/util.js';
import { inRange } from '../src/engine/profiles.js';
import { makeStemFixture } from './fixtures/stems.js';
import { demoSong, measureDurations } from './helpers.js';

const material = routeStems(makeStemFixture().stems, { title: 'Testlied' });
const cache = new Map();
const run = (opts, input = material, key = 'stems') => {
  const k = `${key}:${JSON.stringify(opts)}`;
  if (!cache.has(k)) cache.set(k, orchestrate(input, { title: 'Testlied', ...opts }));
  return cache.get(k);
};
const dyn = (N, mode, activity) => run({ voices: N, mode, activity });
const leadOf = (r) => r.arr.voices.find((v) => v.role === 'lead');
const fillsOf = (r, kind) => r.arr.engine.report.fills.filter((f) => (f.kind || 'gap') === kind);
const dynAt = (v, t) => {
  let cur = null;
  for (const d of v.dirs) if (d.kind === 'dyn' && d.t <= t) cur = d.value;
  return cur;
};
const prof = (v) => PROFILES[v.profile];
const countRole = (r, role) => r.arr.voices.reduce((s, v) => s + v.events.filter((e) => e.role === role).length, 0);

// ---- Stellschrauben ---------------------------------------------------------------------------
test('Verhalten: Standard ist dynamisch/ausgewogen, Aktivität wird auf 1–5 begrenzt', () => {
  assert.deepEqual(MODES, ['dynamic', 'classic']);
  assert.equal(ACTIVITY_NAMES.length, 5);
  const d = behaviorFor();
  assert.equal(d.mode, 'dynamic');
  assert.equal(d.dynamic, true);
  assert.equal(d.activity, 3);
  assert.equal(behaviorFor({ mode: 'classic' }).dynamic, false);
  assert.equal(behaviorFor({ activity: 9 }).activity, 5);
  assert.equal(behaviorFor({ activity: -2 }).activity, 1);
  assert.equal(behaviorFor({ activity: 'x' }).activity, 3);
  assert.equal(behaviorFor({ mode: 'irgendwas' }).mode, 'dynamic');
});

test('Verhalten: Aktivität steigert Einwürfe, Mini-Soli, Begleitung und Bass monoton', () => {
  const b = [1, 2, 3, 4, 5].map((a) => behaviorFor({ activity: a }));
  for (let i = 1; i < 5; i++) {
    assert.ok(b[i].gapBeats <= b[i - 1].gapBeats, 'Lücken ab immer kürzer');
    assert.ok(b[i].answerBars >= b[i - 1].answerBars);
    assert.ok(b[i].miniSoloBars >= b[i - 1].miniSoloBars);
    assert.ok(b[i].stabs >= b[i - 1].stabs);
    assert.ok(b[i].bassRiff >= b[i - 1].bassRiff);
  }
  assert.equal(b[0].sustainBeats, null, 'dezent: keine Bewegung unter Haltetönen');
  assert.equal(b[0].miniSoloBars, 0);
  assert.ok(b[2].miniSoloBars >= 2 && b[4].miniSoloBars <= 4, 'Mini-Soli über 2–4 Takte');
});

// ---- Modus B: Klassischer Solo-Lead --------------------------------------------------------------
test('Modus B: die Lead-Stimme hat Melodien, Läufe und Fills allein', () => {
  for (const N of [2, 4, 8, 15]) {
    const r = dyn(N, 'classic', 5);
    assert.equal(r.arr.engine.behavior.mode, 'classic');
    assert.equal(countRole(r, 'answer'), 0, `N=${N}: keine Einwürfe/Gegenmelodien`);
    assert.equal(r.arr.engine.report.fills.length, 0, `N=${N}: keine Soli/Fills`);
    assert.equal(r.validation.violations.length, 0, JSON.stringify(r.report.violations));
    const lead = leadOf(r);
    assert.ok(lead.events.every((e) => e.role === 'melody'), 'Lead trägt nur Melodie');
    // keine Nebenstimme führt, solange die Lead-Stimme pausiert (sie bleibt still oder hält Akkordtöne)
    for (const v of r.arr.voices) {
      if (v === lead) continue;
      for (const e of v.events) assert.ok(['double', 'counter', 'pad', 'stabs', 'bass', 'inner', 'melody'].includes(e.role) || e.role === 'double', `Rolle ${e.role}`);
    }
  }
});

test('Modus B: Begleitung ist harmonisch – Akkordtöne und Liegeklänge statt Gegenmelodie', () => {
  const r = dyn(4, 'classic', 3);
  const inner = r.arr.voices.filter((v) => v.role === 'inner');
  assert.ok(inner.length >= 2);
  // innere Stimmen: nur Liegeklänge und Rhythmus-Stützen auf Akkordtönen – keine Gegenmelodie, kein Lauf
  for (const v of inner) {
    const roles = new Set(v.events.map((e) => e.role));
    assert.ok([...roles].every((x) => x === 'pad' || x === 'stabs'), `${v.inst.name}: ${[...roles].join()}`);
    assert.ok(v.events.every((e) => e.pitches.length === 1));
  }
  // Validator-Regel „classic-lead“ greift bei einem Einwurf in der klassischen Partitur
  assert.equal(validateArrangement(r.arr).violations.filter((v) => v.rule === 'classic-lead').length, 0);
  const bad = orchestrate(material, { voices: 4, mode: 'classic', activity: 3, title: 'Testlied' }).arr;
  bad.voices.find((v) => v.role === 'inner').events[0].role = 'answer';
  assert.ok(validateArrangement(bad).violations.some((v) => v.rule === 'classic-lead'), 'Einwurf im klassischen Satz wird gemeldet');
});

// ---- Modus A: Dynamisch & Polyphon ---------------------------------------------------------------
test('Modus A ist der Standard und unterscheidet sich hörbar von Modus B', () => {
  const def = run({ voices: 4 });
  assert.equal(def.arr.engine.behavior.mode, 'dynamic');
  assert.equal(def.arr.engine.behavior.activity, 3);
  const a = dyn(4, 'dynamic', 3);
  const b = dyn(4, 'classic', 3);
  assert.ok(countRole(a, 'answer') >= 10, `Einwürfe: ${countRole(a, 'answer')}`);
  const voicesWithAnswers = a.arr.voices.filter((v) => v.events.some((e) => e.role === 'answer'));
  assert.ok(voicesWithAnswers.length >= 2, 'mindestens zwei Nebenstimmen werden aktiv');
  assert.ok(!voicesWithAnswers.includes(leadOf(a)), 'die Lead-Stimme bleibt Lead');
  assert.equal(a.validation.violations.length, 0, JSON.stringify(a.report.violations));
  assert.equal(countRole(b, 'answer'), 0);
  // Dynamik hat mehr Einsätze in den Nebenstimmen als der klassische Satz
  const notes = (r) => r.arr.voices.filter((v) => v.role === 'inner').reduce((s, v) => s + v.events.length, 0);
  assert.ok(notes(a) > notes(b) * 0.9, 'dynamisch nicht ärmer als klassisch');
});

test('Modus A: Lücken der Melodie werden zu Call-and-Response (Einwurf, Lead pausiert)', () => {
  const r = dyn(4, 'dynamic', 3);
  const gaps = fillsOf(r, 'gap');
  assert.ok(gaps.length >= 2, 'Lücken gefüllt');
  const lead = leadOf(r);
  const beat = 24;
  for (const f of gaps) {
    const v = r.arr.voices[f.voice];
    const [g0, g1] = f.gap;
    assert.ok(g1 - g0 >= behaviorFor({ activity: 3 }).gapBeats * beat, `Lücke ${g0}–${g1} mindestens ${behaviorFor({ activity: 3 }).gapBeats} Schläge`);
    // die Lead-Stimme spielt in der Lücke nicht
    assert.equal(lead.events.filter((e) => e.start < g1 && endOf(e) > g0).length, 0, 'Lead pausiert in der Lücke');
    // eine Nebenstimme antwortet im Fenster – höchstens answerBars Takte
    const ev = v.events.filter((e) => e.start >= f.t0 && e.start < f.t1);
    assert.ok(ev.length >= 1 && ev.every((e) => e.role === 'answer'), `Antwort bei ${f.t0}`);
    assert.ok(f.t1 - f.t0 <= behaviorFor({ activity: 3 }).answerBars * 96 + 12);
    // die Antwort liegt unterhalb der Lead-Stimme (kein Überkreuzen)
    const around = lead.events.filter((e) => Math.abs(e.start - f.t0) <= 96);
    for (const e of ev) for (const l of around) assert.ok(e.pitches[0] <= l.pitches[0] + 12, 'Einwurf nicht über Lead-Oktave');
  }
});

test('Modus A: Haltetöne der Melodie werden von einer Nebenstimme umspielt', () => {
  const r = dyn(4, 'dynamic', 3);
  const sus = fillsOf(r, 'sustain');
  assert.ok(sus.length >= 3, `${sus.length} Gegenfiguren unter Haltetönen`);
  const lead = leadOf(r);
  const beat = 24;
  for (const f of sus) {
    const held = lead.events.find((e) => e.start < f.t0 && endOf(e) >= f.t1 - 1);
    assert.ok(held, `unter einem Liegeton (${f.t0})`);
    assert.ok(held.dur >= behaviorFor({ activity: 3 }).sustainBeats * beat, 'Ton ≥ 1,5 Schläge');
    const ev = r.arr.voices[f.voice].events.filter((e) => e.start >= f.t0 && e.start < f.t1);
    assert.ok(ev.length >= 2 && ev.every((e) => e.role === 'answer' && e.dur <= 12), 'Achtelbewegung');
    assert.ok(ev.every((e) => e.pitches[0] < held.pitches[0]), 'unterhalb des Haltetons');
  }
  // Aktivität 1: dezent – keine Bewegung unter Haltetönen
  assert.equal(fillsOf(dyn(4, 'dynamic', 1), 'sustain').length, 0);
});

test('Modus A: Mini-Solo über 2–4 Takte mit Übergabe an die Lead-Stimme', () => {
  const r = dyn(4, 'dynamic', 3);
  const solos = fillsOf(r, 'solo');
  assert.ok(solos.length >= 1, 'Mini-Solo vorhanden');
  const lead = leadOf(r);
  for (const s of solos) {
    const bars = (s.t1 - s.t0) / 96;
    assert.ok(bars >= 2 && bars <= 4 && Number.isInteger(bars), `${bars} Takte`);
    assert.ok(lead.events.every((e) => e.start >= s.t1 || endOf(e) <= s.t0), 'Lead pausiert im Solo');
    assert.ok(lead.events.some((e) => e.start >= s.t1 && e.start < s.t1 + 2 * 96), 'Übergabe zurück an Lead');
    const v = r.arr.voices[s.voice];
    assert.notEqual(v, lead);
    const ev = v.events.filter((e) => e.start >= s.t0 && e.start < s.t1);
    assert.ok(ev.length >= 3 && ev.every((e) => e.role === 'answer'));
    assert.ok(ev.every((e) => inRange(e.pitches[0], prof(v))), 'im Tonumfang');
    // die Melodie Ton für Ton: gleicher Einsatz, gleiche Dauer, gleiche Tonklasse wie im klassischen Satz
    const orig = leadOf(dyn(4, 'classic', 3)).events;
    for (const e of ev) {
      const o = orig.find((x) => x.start === e.start);
      assert.ok(o, `Melodieton bei ${e.start}`);
      assert.equal(((e.pitches[0] % 12) + 12) % 12, ((o.pitches[0] % 12) + 12) % 12, `Tonklasse bei ${e.start}`);
      assert.ok(e.dur <= o.dur);
    }
    const inWindow = orig.filter((x) => x.start >= s.t0 && x.start < s.t1);
    assert.ok(ev.length >= inWindow.length - 1, `${ev.length} von ${inWindow.length} Melodietönen`);
    // andere Nebenstimmen werfen im Solo nicht ein
    for (const o of r.arr.voices) {
      if (o === v || o === lead) continue;
      assert.ok(!o.events.some((e) => e.role === 'answer' && e.start >= s.t0 && e.start < s.t1), 'keine fremden Einwürfe im Solo');
    }
  }
  // dezent/ruhig: keine Mini-Soli
  assert.equal(fillsOf(dyn(4, 'dynamic', 1), 'solo').length, 0);
  assert.equal(fillsOf(dyn(4, 'dynamic', 2), 'solo').length, 0);
});

test('Modus A: Oktav-Doppler pausieren während des Mini-Solos', () => {
  const r = run({ voices: 15, mode: 'dynamic', activity: 5 });
  const solos = fillsOf(r, 'solo');
  assert.ok(solos.length >= 1);
  for (const s of solos) {
    for (const v of r.arr.voices.filter((x) => x.role === 'double8' || x.role === 'doubleU')) {
      assert.ok(v.events.every((e) => e.start >= s.t1 || endOf(e) <= s.t0), `${v.inst.name} pausiert`);
    }
  }
  assert.equal(r.validation.violations.length, 0, JSON.stringify(r.report.violations));
});

test('Aktivität 1…5: mehr Einwürfe, Begleitung und Bewegung, nie Regelverstöße', () => {
  const counts = [1, 2, 3, 4, 5].map((a) => {
    const r = dyn(4, 'dynamic', a);
    assert.equal(r.validation.violations.length, 0, `Aktivität ${a}: ${JSON.stringify(r.report.violations)}`);
    assert.equal(r.arr.engine.behavior.activity, a);
    return { answers: countRole(r, 'answer'), fills: r.arr.engine.report.fills.length };
  });
  assert.ok(counts[0].answers < counts[2].answers, JSON.stringify(counts));
  assert.ok(counts[2].answers <= counts[4].answers, JSON.stringify(counts));
  assert.ok(counts[0].fills <= counts[2].fills);
});

// ---- Rhythmik, Bass, Artikulation, Dynamik --------------------------------------------------------
test('Bass: lebendige Linie bei Groove-Material, ruhig bei Hymnen und Chorälen', () => {
  const groove = demoSong('groove');
  const bassOf = (r) => r.arr.voices.find((v) => v.role === 'bass');
  const a = bassOf(run({ voices: 4, mode: 'dynamic', activity: 3 }, groove, 'groove'));
  const c = bassOf(run({ voices: 4, mode: 'classic', activity: 3 }, groove, 'groove'));
  const off = (v) => v.events.filter((e) => e.start % 24 !== 0).length;
  assert.ok(off(a) >= 10 && off(a) > off(c), `Synkopen im Bass: ${off(a)} vs ${off(c)}`);
  assert.ok(a.events.length > c.events.length * 1.5, `${a.events.length} vs ${c.events.length} Anschläge`);
  // im Bereich der Instrumente (Tuba), keine unspielbaren Sprünge
  for (let i = 1; i < a.events.length; i++) assert.ok(Math.abs(a.events[i].pitches[0] - a.events[i - 1].pitches[0]) <= 19, `Bass-Sprung bei ${a.events[i].start}`);
  assert.ok(a.events.every((e) => inRange(e.pitches[0], prof(a))));
  // Hymne: Bass wie in der Vorlage
  const ode = demoSong('ode');
  const o1 = bassOf(run({ voices: 4, mode: 'dynamic', activity: 5 }, ode, 'ode'));
  const o2 = bassOf(run({ voices: 4, mode: 'classic', activity: 5 }, ode, 'ode'));
  assert.deepEqual(o1.events.map((e) => [e.start, e.dur]), o2.events.map((e) => [e.start, e.dur]), 'gleicher Rhythmus wie in der Vorlage');
});

test('Begleitung: Nachschläge auf den Offbeats mit Staccato, Betonung auf den Synkopen', () => {
  const r = dyn(4, 'dynamic', 4);
  const stabs = r.arr.voices.filter((v) => v.role === 'inner').flatMap((v) => v.events.filter((e) => e.role === 'stabs'));
  assert.ok(stabs.length > 20);
  const off = stabs.filter((e) => e.start % 24 === 12);
  assert.ok(off.length / stabs.length > 0.6, `Offbeat-Anteil ${off.length}/${stabs.length}`);
  assert.ok(off.every((e) => e.art.includes('staccato') && e.art.includes('accent')), 'Staccato + Akzent');
  assert.ok(stabs.every((e) => e.dur <= 24));
});

test('Artikulation: Fanfaren-Auftakte betont und lange Phrasenenden tenuto (nur Modus A)', () => {
  const a = dyn(4, 'dynamic', 3);
  const b = dyn(4, 'classic', 3);
  const art = (r, name) => r.arr.voices.reduce((s, v) => s + v.events.filter((e) => e.art.includes(name)).length, 0);
  const pickups = (r) => {
    let n = 0;
    for (const v of r.arr.voices) {
      const evs = sortEvents([...v.events]);
      evs.forEach((e, i) => {
        if (e.art.includes('accent') && e.start % 24 === 0 && i > 0 && e.start - endOf(evs[i - 1]) >= 24) n++;
      });
    }
    return n;
  };
  assert.ok(pickups(a) >= 1, 'betonte Einsätze nach Pausen');
  assert.equal(pickups(b), 0, 'klassisch: keine Auftakt-Akzente');
  assert.ok(art(a, 'tenuto') >= 1, 'Tenuto an Phrasenenden');
  assert.ok(art(a, 'staccato') >= 1);
});

test('Dynamik: Einwürfe und Solo mindestens mf, die Begleitung tritt währenddessen zurück', () => {
  const r = dyn(4, 'dynamic', 3);
  const MF = dynIndex('mf');
  const lead = leadOf(r);
  const answers = [];
  for (const v of r.arr.voices) {
    for (const e of v.events) {
      if (e.role !== 'answer') continue;
      const d = dynAt(v, e.start);
      assert.ok(dynIndex(d) >= MF, `${v.inst.name}: Einwurf bei ${e.start} nur ${d}`);
      answers.push({ v, e, level: dynIndex(d) });
    }
  }
  assert.ok(answers.length > 0);
  let compared = 0;
  for (const { v, e, level } of answers) {
    for (const o of r.arr.voices) {
      if (o === v || o === lead) continue;
      for (const x of o.events) {
        if (x.role === 'answer' || x.start >= endOf(e) || endOf(x) <= e.start) continue;
        const want = level - (o.role === 'bass' ? 1 : 2);
        assert.ok(dynIndex(dynAt(o, x.start)) <= Math.max(0, want), `${o.inst.name} bei ${x.start}: ${dynAt(o, x.start)} unter dem Einwurf (${level})`);
        compared++;
      }
    }
  }
  assert.ok(compared > 5, `${compared} Vergleiche`);
});

test('Spielbarkeit: Nebenstimmen bleiben im Tonumfang, keine Sprünge über eine Oktave', () => {
  for (const [N, act] of [[4, 5], [8, 5], [12, 4]]) {
    const r = dyn(N, 'dynamic', act);
    assert.equal(r.validation.violations.length, 0, `N=${N}: ${JSON.stringify(r.report.violations)}`);
    for (const v of r.arr.voices) {
      assert.ok(v.events.every((e) => e.pitches.every((p) => inRange(p, prof(v)))), `${v.inst.name} im Umfang`);
      if (v.role === 'lead') continue;
      const mono = sortEvents(v.events.filter((e) => e.pitches.length === 1));
      for (let i = 1; i < mono.length; i++) {
        const gap = mono[i].start - endOf(mono[i - 1]);
        if (gap > 24) continue;
        assert.ok(Math.abs(mono[i].pitches[0] - mono[i - 1].pitches[0]) <= 12, `${v.inst.name}: Sprung bei ${mono[i].start}`);
      }
    }
  }
});

test('MusicXML 4.0: Übergaben, Dynamik, Artikulation und vollständige Takte', () => {
  const r = dyn(4, 'dynamic', 4);
  const xml = r.xml();
  assert.match(xml, /<score-partwise version="4\.0"/);
  assert.ok(measureDurations(xml).every((m) => m.dur === m.expected), 'jeder Takt vollständig');
  assert.ok(/<mf\/>/.test(xml) && /<p\/>/.test(xml), 'mf für Einwürfe, p für die Begleitung');
  assert.ok(/<staccato\/>/.test(xml) && /<accent\/>/.test(xml));
  assert.ok(/<tenuto\/>/.test(xml), 'Tenuto an Phrasenenden');
  // Mini-Solo: die Lead-Stimme hat in den Soli-Takten nur Pausen, die Solo-Stimme die Noten
  const solo = fillsOf(r, 'solo')[0];
  assert.ok(solo, 'Mini-Solo vorhanden');
  const root = parseXML(xml);
  const parts = root.all('part');
  const leadIdx = r.arr.voices.indexOf(leadOf(r));
  const soloIdx = solo.voice;
  const m0 = solo.t0 / 96;
  const m1 = solo.t1 / 96;
  const bars = (p) => parts[p].all('measure');
  for (let m = m0; m < m1; m++) {
    const lead = bars(leadIdx)[m].all('note');
    assert.ok(lead.length >= 1 && lead.every((n) => n.has('rest')), `Takt ${m + 1}: Lead nur Pausen`);
    const so = bars(soloIdx)[m].all('note');
    assert.ok(so.some((n) => !n.has('rest')), `Takt ${m + 1}: Solo-Stimme spielt`);
  }
  // direkt nach der Übergabe spielt die Lead-Stimme wieder
  assert.ok(bars(leadIdx)[m1].all('note').some((n) => !n.has('rest')), 'Lead übernimmt wieder');
});

test('Zufallsmaterial: beide Modi und alle Aktivitäten ohne Regelverstöße', () => {
  const inputs = [['groove', demoSong('groove')], ['saints', demoSong('saints')], ['grace', demoSong('grace')]];
  for (const [id, input] of inputs) {
    for (const mode of MODES) {
      for (const activity of [1, 3, 5]) {
        for (const N of [1, 2, 3, 5, 9, 15]) {
          const r = run({ voices: N, mode, activity }, input, id);
          assert.equal(r.validation.violations.length, 0, `${id} ${mode}/${activity} N=${N}: ${JSON.stringify(r.report.violations)}`);
          if (mode === 'classic') assert.equal(countRole(r, 'answer'), 0);
        }
      }
    }
  }
});

test('Reproduzierbar: gleiche Eingabe, gleiche Einstellung – gleiche Partitur', () => {
  const a = orchestrate(material, { voices: 6, mode: 'dynamic', activity: 4, title: 'x' });
  const b = orchestrate(material, { voices: 6, mode: 'dynamic', activity: 4, title: 'x' });
  assert.equal(a.xml(), b.xml());
  const c = orchestrate(material, { voices: 6, mode: 'classic', activity: 4, title: 'x' });
  assert.notEqual(a.xml(), c.xml());
});

// ---- Oberfläche -------------------------------------------------------------------------------
test('Oberfläche: Optionen orchMode/orchActivity erreichen die Engine', () => {
  const o = { voices: ['trumpet', 'trumpet', 'horn', 'trombone'], title: 'Test' };
  const d = orchestrateFromOptions(material, o);
  assert.equal(d.report.mode, 'dynamic');
  assert.equal(d.report.activity, 3);
  const c = orchestrateFromOptions(material, { ...o, orchMode: 'classic', orchActivity: 5 });
  assert.equal(c.report.mode, 'classic');
  assert.equal(c.report.solos, 0);
  const v = orchestrateFromOptions(material, { ...o, orchMode: 'dynamic', orchActivity: 5 });
  assert.equal(v.report.activity, 5);
  assert.ok(v.report.fills >= 1 && d.report.fills >= 1);
});

test('Oberfläche: Auswahl „Führung & Stimmendynamik“ und Regler 1–5 sind verdrahtet', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
  assert.match(html, /Führung &amp; Stimmendynamik/);
  assert.match(html, /name="orch-mode" value="dynamic" checked/);
  assert.match(html, /name="orch-mode" value="classic"/);
  assert.match(html, /Dynamisch &amp; Polyphon/);
  assert.match(html, /Gegenmelodien, Fills &amp; Soloverteilung/);
  assert.match(html, /Klassischer Solo-Lead/);
  assert.match(html, /Begleitung bleibt rein akkordisch/);
  assert.match(html, /id="orch-activity"[^>]*min="1"[^>]*max="5"/);
  assert.match(html, /Aktivität der Nebenstimmen/);
  assert.match(js, /orchMode: S\.opts\.orchMode === 'classic'/);
  assert.match(js, /orchActivity: clampActivity\(S\.opts\.orchActivity\)/);
  assert.match(js, /orchMode: 'dynamic'/);
  assert.match(js, /#orch-activity'\)\.disabled = mode === 'classic'/);
});
