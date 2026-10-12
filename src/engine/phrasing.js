// Phrasierung: Melodieübernahme bei Lead-Pausen, Atemräume (versetzt), Verzahnung der Mittelstimmen.
import { mod } from '../core/constants.js';
import { inRange, nearestOctave } from './profiles.js';
import { chordPool } from './voicing.js';
import { ladder, ladderIndex, makeEvent, endOf, soundingAt, lastBefore, sortEvents } from './util.js';
import { answerPool } from './behavior.js';

// ---- Melodie übernehmen ---------------------------------------------------------------------
// Lücken der Melodie (≥ 2 Schläge, mitten im Stück) bekommen eine Antwort der Nebenstimme.
export function leadGaps(leadLine, { beat, minBeats = 2 }) {
  const gaps = [];
  for (let i = 0; i + 1 < leadLine.length; i++) {
    const a = endOf(leadLine[i]);
    const b = leadLine[i + 1].start;
    if (b - a >= minBeats * beat) gaps.push({ start: a, end: b, before: i, after: i + 1 });
  }
  return gaps;
}

function makeFill(score, voice, gap, maxBars = 2) {
  const { ctx, leadLine, chordAt, scaleAtTick } = score;
  const { geo } = ctx;
  const beat = geo.beat;
  const len = gap.end - gap.start;
  const start = Math.ceil(gap.start / 12) * 12;
  const end = Math.min(start + maxBars * geo.mt, gap.end - (len >= 3 * beat ? beat / 2 : 0));
  if (end - start < 12) return [];
  // Motiv: die letzten (bis zu 4) Melodietöne vor der Lücke
  const motif = leadLine.slice(Math.max(0, gap.before - 3), gap.before + 1).filter((e) => gap.start - endOf(e) <= geo.mt);
  const chord = chordAt(start);
  const pcs = [...scaleAtTick(start)];
  if (chord) for (const t of chord.tones) if (!pcs.includes(t.pc)) pcs.push(t.pc);
  const lad = ladder(pcs, voice.profile.range[0], voice.profile.range[1]);
  if (lad.length < 3) return [];
  const lastLead = motif.length ? motif[motif.length - 1].pitches[0] : lad[Math.floor(lad.length / 2)];
  // Antwort eine Terz tiefer, im Bereich der Stimme
  let idx = ladderIndex(lad, nearestOctave(lastLead - 4, lastLead - 4, voice.profile));
  const steps = [];
  const durs = [];
  for (let i = 1; i < motif.length; i++) {
    const li = ladderIndex(lad, motif[i].pitches[0]);
    const lj = ladderIndex(lad, motif[i - 1].pitches[0]);
    steps.push(li - lj);
  }
  for (const e of motif) durs.push(Math.max(12, Math.min(36, Math.round(e.dur / 6) * 6)));
  if (!durs.length) durs.push(24, 12, 12, 48);
  const out = [];
  let t = start;
  let k = 0;
  while (t < end) {
    const d = Math.min(durs[k % durs.length], end - t);
    if (d < 6) break;
    if (k > 0) idx = Math.max(0, Math.min(lad.length - 1, idx + (steps.length ? steps[(k - 1) % steps.length] : (k % 2 ? 1 : -1))));
    out.push(makeEvent(t, d, lad[idx], null, { role: 'answer' }));
    t += d;
    k++;
    if (k > 12) break;
  }
  if (!out.length) return out;
  // Schlusston: Akkordton
  const last = out[out.length - 1];
  const lc = chordAt(last.start);
  if (lc) {
    const tones = lc.tones.map((x) => x.pc);
    let best = last.pitches[0];
    for (let d = 0; d <= 6; d++) {
      for (const s of [d, -d]) {
        if (tones.includes(mod(last.pitches[0] + s, 12)) && inRange(last.pitches[0] + s, voice.profile)) {
          best = last.pitches[0] + s;
          d = 99;
          break;
        }
      }
    }
    last.pitches[0] = best;
  }
  return out;
}

// minBeats: Mindestlänge der Lücke in Schlägen; maxBars: längste Antwort in Takten (aus dem Verhalten)
export function applyHandoff(score, { minBeats = 2, maxBars = 2 } = {}) {
  const { voices, leadLine, ctx, report } = score;
  const beat = ctx.geo.beat;
  const gaps = leadGaps(leadLine, { beat, minBeats });
  if (!gaps.length) return 0;
  // Call-and-Response über alle Gegen- und Mittelstimmen (von oben, im Wechsel); ohne sie der Bass
  const bass = voices.find((v) => v.role === 'bass');
  const named = answerPool(score);
  const pool = named.length ? named : bass ? [bass] : [];
  if (!pool.length) return 0;
  let n = 0;
  gaps.forEach((gap, gi) => {
    const v = pool[gi % pool.length];
    const fill = makeFill(score, v, gap, maxBars);
    if (!fill.length) return;
    const a = fill[0].start;
    const z = endOf(fill[fill.length - 1]);
    // vorhandene Töne der Stimme im Fenster entfernen / kürzen
    const keep = [];
    for (const e of v.events) {
      if (endOf(e) <= a || e.start >= z) keep.push(e);
      else if (e.start < a && endOf(e) > a) {
        e.dur = a - e.start;
        if (e.dur >= 6) keep.push(e);
      }
    }
    v.events = sortEvents([...keep, ...fill]);
    report.fills.push({ voice: v.index, t0: a, t1: z, gap: [gap.start, gap.end] });
    n++;
  });
  return n;
}

// ---- Atem ---------------------------------------------------------------------------------------
const isWind = (v) => v.inst.breath !== null && v.inst.breath !== undefined;

// Phrasengrenzen versetzt: Klasse 0 atmet bei 4, 8, 12 … Klasse 1 bei 2, 6, 10 …
function breathCandidates(parity, mt, from, to) {
  const out = [];
  const step = 4 * mt;
  const off = parity === 0 ? 0 : 2 * mt;
  for (let t = off + (parity === 0 ? step : 0); t <= to; t += step) if (t >= from) out.push(t);
  return out;
}

function runsOf(events, beat) {
  const runs = [];
  let cur = null;
  for (const e of events) {
    if (cur && e.start - cur.end < beat) {
      cur.end = Math.max(cur.end, endOf(e));
      cur.events.push(e);
    } else {
      cur = { start: e.start, end: endOf(e), events: [e] };
      runs.push(cur);
    }
  }
  return runs;
}

function cutBreath(v, b, beat) {
  const w0 = b - beat;
  let marked = false;
  for (const e of v.events) {
    if (e.start >= b || endOf(e) <= w0) continue;
    if (e.start >= w0) e.dur = 0;
    else {
      e.dur = w0 - e.start;
      if (e.dur < 6) e.dur = 0;
    }
  }
  v.events = v.events.filter((e) => e.dur > 0);
  const last = lastBefore(v.events, b);
  if (last && endOf(last) <= b) {
    last.breathAfter = true;
    marked = true;
  }
  return marked;
}

export function applyBreaths(score, { target = 6, hard = 8 } = {}) {
  const { voices, ctx, report } = score;
  const { geo } = ctx;
  const { mt, beat } = geo;
  const innerVoices = voices.filter((v) => v.role === 'inner' || v.role === 'counter');
  const parityOf = (v) => {
    const k = innerVoices.indexOf(v);
    if (k >= 0) return k % 2 === 0 ? 1 : 0; // erste Mittelstimme: Klasse 1
    if (v.role === 'double8' || v.role === 'doubleU' || v.role === 'bass8vb') return 1;
    return 0;
  };
  for (const v of voices) {
    if (!isWind(v) || v.events.length < 2) continue;
    v.events = sortEvents(v.events);
    const parity = parityOf(v);
    const isInner = innerVoices.includes(v);
    for (let guard = 0; guard < 40; guard++) {
      const runs = runsOf(v.events, beat);
      const bad = runs.find((r) => r.end - r.start > target * mt);
      if (!bad) break;
      const from = bad.start + 3 * mt;
      const to = Math.min(bad.start + hard * mt, bad.end - beat);
      // Mittelstimmen verteilen ihre Atemstellen: nie atmen alle zugleich (eine hält die Harmonie), und
      // möglichst keine zwei an derselben Stelle
      const counts = new Map();
      if (isInner) for (const x of report.breaths) if (x.voice !== v.index && innerVoices.some((o) => o.index === x.voice)) counts.set(x.t1, (counts.get(x.t1) || 0) + 1);
      const maxTogether = Math.max(1, innerVoices.length - 1);
      const own = breathCandidates(parity, mt, from, to);
      const other = breathCandidates(1 - parity, mt, from, to);
      const bars = [];
      for (let t = Math.ceil(from / mt) * mt; t <= to; t += mt) bars.push(t);
      const want = bad.start + target * mt;
      const rank = (t) => (counts.get(t) || 0) * 1000 + (own.includes(t) ? 0 : other.includes(t) ? 60 : 120) + Math.abs(t - want) / mt;
      // Antworten (Melodieübernahme) werden nicht durch einen Atemraum zerschnitten
      const clearOfAnswers = (t) => !v.events.some((e) => e.role === 'answer' && e.start < t && endOf(e) > t - beat);
      let cands = [...new Set([...own, ...other, ...bars])].filter((t) => (counts.get(t) || 0) < maxTogether && clearOfAnswers(t));
      if (v.role === 'lead') {
        // Die Melodie bleibt vollständig: Atem nur dort, wo in der letzten Zählzeit davor kein Ton beginnt
        // (ein Ton wird gekürzt oder es ist schon Pause) – sonst läuft die Melodie ohne Atemstelle weiter
        const safe = (t) => !v.events.some((e) => (e.start >= t - beat && e.start < t) || (e.start < t - beat && endOf(e) > t - beat && t - beat - e.start < 6));
        const beats = [];
        for (let t = Math.ceil(from / beat) * beat; t <= to; t += beat) beats.push(t);
        cands = [...new Set([...cands, ...beats])].filter(safe);
      }
      cands.sort((x, y) => rank(x) - rank(y));
      if (!cands.length) {
        if (v.role === 'lead' && !report.notes.some((x) => x.startsWith('Lead: keine Atemstelle'))) report.notes.push('Lead: keine Atemstelle ohne Tonverlust – die Melodie läuft vollständig durch (Atem an den Pausen der Vorlage).');
        break;
      }
      const b = cands[0];
      cutBreath(v, b, beat);
      report.breaths.push({ voice: v.index, t0: b - beat, t1: b, parity });
    }
  }
}

// Verzahnung: Wenn eine Mittelstimme atmet, hält mindestens eine andere die Harmonie
export function interlock(score) {
  const { voices, ctx, report, chordAt } = score;
  const { beat } = ctx.geo;
  // Begleitstimmen: Mittelstimmen (im Trio und Quartett bis Oktett auch die Gegenstimme)
  const innerVoices = voices.filter((v) => v.role === 'inner' || (v.role === 'counter' && score.N < 9));
  let added = 0;
  for (const br of report.breaths) {
    const v = voices[br.voice];
    if (!innerVoices.includes(v) || innerVoices.length < 2) continue;
    const others = innerVoices.filter((o) => o !== v);
    const holds = (o) => !!soundingAt(sortEvents(o.events), br.t0);
    if (others.some(holds)) continue;
    // nächste Stimme der anderen Klasse hält einen Ton des Akkords
    const cand = [...others].sort((a, b) => Math.abs(a.index - v.index) - Math.abs(b.index - v.index))[0];
    const prev = lastBefore(sortEvents(cand.events), br.t0 + 1);
    const chord = chordAt(br.t0);
    const pool = chord ? chordPool(chord, { tensions: false }).map((p) => p.pc) : [];
    let p = prev ? prev.pitches[0] : cand.profile.sweet[0] + 5;
    if (pool.length && !pool.includes(mod(p, 12))) {
      let bestD = 99;
      let bestP = p;
      for (let d = -6; d <= 6; d++) if (pool.includes(mod(p + d, 12)) && Math.abs(d) < bestD && inRange(p + d, cand.profile)) {
        bestD = Math.abs(d);
        bestP = p + d;
      }
      p = bestP;
    }
    // Überlappendes entfernen
    cand.events = cand.events.filter((e) => !(e.start >= br.t0 && e.start < br.t1));
    for (const e of cand.events) if (e.start < br.t0 && endOf(e) > br.t0) e.dur = br.t0 - e.start;
    cand.events = cand.events.filter((e) => e.dur > 0);
    cand.events.push(makeEvent(br.t0, br.t1 - br.t0, p, null, { role: 'pad' }));
    cand.events = sortEvents(cand.events);
    added++;
  }
  return added;
}

// Phrasenenden: Atemzeichen nach einem Ton, dem eine Pause von mindestens einer Zählzeit folgt –
// aber nur nach echten Phrasen (mindestens zwei Schläge Spiel davor), nicht nach Staccato-Einwürfen
export function markPhraseEnds(score) {
  const { voices, ctx } = score;
  const { beat } = ctx.geo;
  for (const v of voices) {
    if (!isWind(v)) continue;
    const evs = sortEvents(v.events);
    let phraseStart = null;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (phraseStart === null) phraseStart = e.start;
      const next = evs[i + 1];
      if (!next) continue;
      const gap = next.start - endOf(e);
      if (gap < beat) continue;
      const stabby = e.role === 'stabs' || e.role === 'pad';
      const len = endOf(e) - phraseStart;
      if (!stabby && len >= 2 * beat && e.dur >= 12) e.breathAfter = true;
      else if (stabby && gap >= 2 * beat && e.dur >= beat && len >= 2 * beat) e.breathAfter = true;
      phraseStart = null;
    }
  }
}
