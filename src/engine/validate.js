// Regelprüfung der Orchestrierung – für den Bericht der Engine und die Tests.
// Jede Regel stammt aus der Vorgabe; ein Eintrag in `violations` ist ein konkreter Verstoß.
import { mod, dynShift, dynIndex } from '../core/constants.js';
import { spellingIssues } from './tonality.js';
import { frictions, perfectIssues, chordPool } from './voicing.js';
import { chordAt } from '../model/song.js';
import { leadGaps } from './phrasing.js';
import { soundingAt, endOf, sortEvents } from './util.js';

const isWind = (v) => v.inst.breath !== null && v.inst.breath !== undefined;

function dynAt(v, t) {
  let cur = null;
  for (const d of v.dirs) if (d.kind === 'dyn' && d.t <= t) cur = d.value;
  return cur;
}

// Lautstärke des Leads an der Stelle t: die des Formteils (der Lead selbst kann dort pausieren)
function leadDynAt(arr, t) {
  const bar = Math.floor(t / arr.mt);
  let b = arr.blocks[0];
  for (const x of arr.blocks) if (x.startBar <= bar) b = x;
  return b.dyn;
}

// Anteil gemeinsamer Einsätze an den Einsätzen der spärlicheren Stimme
export function sharedAttackRatio(a, b) {
  const A = new Set(a.events.map((e) => e.start));
  const B = new Set(b.events.map((e) => e.start));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size);
}

export function validateArrangement(arr, { maxRunBars = 8, sharedMax = 0.65 } = {}) {
  const violations = [];
  const v = (rule, detail) => violations.push({ rule, ...detail });
  const mt = arr.mt;
  const beat = arr.beat;
  const voices = arr.voices;
  const N = voices.length;
  const lead = voices.find((x) => x.role === 'lead');
  const foundation = voices.find((x) => x.role === 'bass');
  const inner = voices.filter((x) => x.role === 'inner' || (x.role === 'counter' && N < 9));
  const behavior = (arr.engine && arr.engine.behavior) || { dynamic: true, mode: 'dynamic' };
  const stats = { notes: voices.map((x) => x.events.length) };

  // 1. Tonumfang
  voices.forEach((x, i) => {
    const [lo, hi] = x.inst.range;
    for (const e of x.events) for (const p of e.pitches) if (p < lo || p > hi) v('range', { voice: i, t: e.start, midi: p, range: [lo, hi] });
  });

  // 2. Sprünge ≤ Oktave innerhalb einer Phrase (Pause ≥ 1 Takt = neue Phrase)
  voices.forEach((x, i) => {
    if (x.inst.staves > 1) return; // Klavier: Akkorde, kein einstimmiger Sprung
    const evs = sortEvents([...x.events]);
    for (let k = 1; k < evs.length; k++) {
      if (evs[k].start - endOf(evs[k - 1]) >= mt) continue;
      const d = Math.abs(evs[k].pitches[0] - evs[k - 1].pitches[evs[k - 1].pitches.length - 1]);
      if (d > 12) v('leap', { voice: i, t: evs[k].start, semitones: d });
    }
  });

  // 3. Sekund-Reibungen unter C3
  for (const f of frictions(voices.map((x) => x.events))) v('friction', { t: f.t, voices: [f.a, f.b], pitches: [f.pa, f.pb] });

  // 4. verdeckte Quinten/Oktaven Lead-Bass
  if (lead && foundation) for (const p of perfectIssues(lead.events, foundation.events)) v('hidden-perfect', p);

  // 5. Atem: kein Bläser spielt mehr als maxRunBars Takte ohne Pause von mindestens einer Zählzeit
  voices.forEach((x, i) => {
    // (die Melodie der Lead-Stimme wird nie für den Atem gekürzt – sie atmet nur an Pausen der Vorlage)
    if (!isWind(x) || x.role === 'lead') return;
    const evs = sortEvents([...x.events]);
    let runStart = null;
    let runEnd = null;
    const close = () => {
      if (runStart !== null && runEnd - runStart > maxRunBars * mt) v('breath', { voice: i, t0: runStart, bars: Math.round(((runEnd - runStart) / mt) * 10) / 10 });
    };
    for (const e of evs) {
      if (runStart === null || e.start - runEnd >= beat) {
        close();
        runStart = e.start;
      }
      runEnd = Math.max(runEnd ?? 0, endOf(e));
    }
    close();
  });

  // 6. Verzahnung: atmet eine Mittelstimme, klingt mindestens eine andere
  const breaths = (arr.engine && arr.engine.report.breaths) || [];
  for (const br of breaths) {
    const own = voices[br.voice];
    if (!inner.includes(own) || inner.length < 2) continue;
    const holds = inner.some((o) => o !== own && !!soundingAt(sortEvents([...o.events]), br.t0));
    if (!holds) v('interlock', { voice: br.voice, t0: br.t0 });
  }

  // 7a. Klassischer Solo-Lead: Einwürfe, Läufe, Gegenmelodien und Soli gehören allein der Lead-Stimme
  if (!behavior.dynamic) {
    voices.forEach((x, i) => {
      if (x === lead) return;
      for (const e of x.events) if (e.role === 'answer') v('classic-lead', { voice: i, t: e.start });
    });
  }

  // 7. Melodieübernahme: Lead pausiert ≥ 2 Zählzeiten -> eine Nebenstimme führt (dynamischer Modus)
  if (lead && N >= 2 && behavior.dynamic) {
    const line = sortEvents([...lead.events]);
    for (const g of leadGaps(line, { beat })) {
      const filled = voices.some((x) => x !== lead && x.role !== 'double8' && x.role !== 'doubleU' && x.events.some((e) => e.role === 'answer' && e.start >= g.start && e.start < g.end));
      if (!filled) v('handoff', { gap: [g.start, g.end] });
    }
  }

  // 8. keine Cluster: Innenstimmen nur Akkordtöne/Spannungen oder Oktavverdopplungen von Lead/Bass
  const chords = arr.chordTrack;
  if (inner.length) {
    for (const x of inner) {
      const i = voices.indexOf(x);
      for (const e of x.events) {
        if (e.role !== 'pad' && e.role !== 'stabs') continue;
        const ch = chordAt(chords, e.start);
        if (!ch) continue;
        const allowed = new Set(chordPool(ch, { tensions: true }).map((p) => p.pc));
        allowed.add(ch.rootPc);
        const l = lead && soundingAt(sortEvents([...lead.events]), e.start);
        if (l) allowed.add(mod(l.pitches[0], 12));
        const b = foundation && soundingAt(foundation.events, e.start);
        if (b) allowed.add(mod(b.pitches[0], 12));
        for (const p of e.pitches) if (!allowed.has(mod(p, 12))) v('cluster', { voice: i, t: e.start, midi: p, chord: ch.symbol });
      }
    }
  }

  // 9. Dynamik: Begleitung eine Stufe leiser als der Lead
  if (lead && inner.length) {
    for (const x of inner) {
      const i = voices.indexOf(x);
      for (const e of x.events) {
        if (e.role !== 'pad' && e.role !== 'stabs') continue;
        const ld = leadDynAt(arr, e.start);
        const mine = dynAt(x, e.start);
        if (ld && mine && dynIndex(mine) > dynIndex(dynShift(ld, -1))) v('dynamics', { voice: i, t: e.start, lead: ld, voiceDyn: mine });
      }
    }
  }

  // 10. Schreibweise
  const barOf = (t) => Math.max(0, Math.floor(t / mt));
  voices.forEach((x, i) => {
    for (const is of spellingIssues(x.events, { keyAt: (bar) => arr.keyAt(bar * mt), barOf })) v('spelling', { voice: i, ...is });
  });

  // 11. Mittelstimmen: gemeinsamer Anschlaganteil
  if (N >= 4) {
    // die beiden höchsten Mittelstimmen (nach Lage) gehören zu verschiedenen Rhythmusgruppen
    const centerOf = (x) => (x.inst.comfort[0] + x.inst.comfort[1]) / 2;
    const mids = voices.filter((x) => x.role === 'inner' || (x.role === 'counter' && N < 9)).sort((a, b) => centerOf(b) - centerOf(a));
    if (mids.length >= 2) {
      const r = sharedAttackRatio(mids[0], mids[1]);
      stats.sharedAttack = r;
      if (r > sharedMax) v('shared-attacks', { ratio: r });
    }
  }

  // 12. keine Liegetöne über ganze Takte in der Begleitung
  for (const x of inner) {
    const i = voices.indexOf(x);
    for (const e of x.events) if ((e.role === 'pad' || e.role === 'stabs') && e.dur >= mt) v('static-pad', { voice: i, t: e.start, dur: e.dur });
  }

  // 13. Drop-2 / Drop-2/4 (N = 5..8): geschlossener Satz -> geöffneter Satz
  const rec = (arr.engine && arr.engine.report.voicings) || [];
  stats.voicings = rec.length;
  if (N >= 5 && N <= 8) {
    for (const r of rec) {
      if (r.template !== 'drop2' && r.template !== 'drop24') {
        v('voicing-template', { t: r.t, template: r.template });
        continue;
      }
      const closed = [...r.closed];
      const open = [...r.open];
      const dropped = r.template === 'drop2' ? [1] : [1, 3].filter((k) => k < closed.length);
      const expectedKept = closed.filter((_, k) => !dropped.includes(k)).sort((a, b) => b - a);
      const openCopy = [...open];
      let ok = true;
      for (const p of expectedKept) {
        const idx = openCopy.indexOf(p);
        if (idx < 0) {
          ok = false;
          break;
        }
        openCopy.splice(idx, 1);
      }
      // übrig bleiben die versetzten Töne – jeweils eine (oder mehr) Oktaven tiefer
      const moved = dropped.map((k) => closed[k]);
      if (ok && openCopy.length === moved.length) {
        const rem = [...openCopy];
        for (const m of moved) {
          const j = rem.findIndex((p) => mod(p, 12) === mod(m, 12) && p <= m - 12);
          if (j < 0) {
            ok = false;
            break;
          }
          rem.splice(j, 1);
        }
      } else ok = false;
      if (!ok) v('voicing-template', { t: r.t, template: r.template, closed, open });
    }
  }
  return { ok: violations.length === 0, violations, stats };
}

export function summarize(result) {
  const by = {};
  for (const x of result.violations) by[x.rule] = (by[x.rule] || 0) + 1;
  return by;
}
