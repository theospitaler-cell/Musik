// Ausgeschriebenes Solo ("improvisiert" über die Akkorde):
// Dramaturgie mit Motiventwicklung -> dichter werdende Linien -> Höhepunkt.
import { mod, clamp } from '../../core/constants.js';
import { bluesScale, isMinorish, isDominant } from '../../theory/chords.js';
import { singleValueDur } from '../../output/notation.js';
import { ev, addArt, cleanLine, scaleStep, chordToneNear, lofForChordPc, isChordTone } from '../context.js';

function soloScale(ctx, t, useBlues) {
  const chord = ctx.chordAt(t);
  const base = ctx.scaleAt(t);
  if (!useBlues) return base;
  const minor = isMinorish(chord) || isDominant(chord);
  const bl = bluesScale(minor && !isDominant(chord) ? chord.rootPc : ctx.key.tonicPc, true);
  return [...new Set([...base, ...bl])].sort((a, b) => a - b);
}

function rhythmCells(ctx, from, to, density, lyrical) {
  const st = ctx.style.id;
  const out = [];
  let t = from;
  const funky = st === 'funk' || st === 'secondline';
  const units = [];
  if (lyrical) units.push([24, 3], [12, 4], [36, 1], [48, 1]);
  else if (funky) units.push([6, 1 + density * 5], [12, 3], [18, 1], [24, 1.5 - density]);
  else if (st === 'swing') units.push([12, 5], [24, 1.5], [6, density * 1.5], [36, 0.5]);
  else if (st === 'classical') units.push([12, 3], [6, density * 4], [24, 1.5]);
  else units.push([12, 4], [24, 2], [6, density * 2]);
  while (t < to) {
    let d = ctx.rng.weighted(units.map(([u, w]) => [u, Math.max(0.05, w)]));
    // Raster sauber halten
    if (t % 12 !== 0 && d >= 12 && !funky) d = 12 - (t % 12);
    if (t + d > to) d = to - t;
    if (d <= 0) break;
    // nur Werte, die an dieser Position als EIN Notenwert lesbar sind
    const pos = t % ctx.mt;
    const single = singleValueDur(pos, d, ctx.mi, 3, true);
    if (single) d = single;
    const rest = !lyrical && out.length > 1 && ctx.rng.chance(funky ? 0.14 : 0.08);
    out.push({ t, d, rest });
    t += d;
  }
  return out.filter((c) => !c.rest && c.d >= 3);
}

function linePhrase(ctx, from, to, cur, targetCenter, density, lo, hi, useBlues, lyrical) {
  const cells = rhythmCells(ctx, from, to, density, lyrical);
  const out = [];
  let dir = targetCenter >= cur ? 1 : -1;
  for (let i = 0; i < cells.length; i++) {
    const { t, d } = cells[i];
    const chord = ctx.chordAt(t);
    const strong = t % ctx.beat === 0;
    const nextCell = cells[i + 1];
    let m;
    if (i === cells.length - 1) {
      m = chordToneNear(chord, cur + dir, lo, hi, { roles: ['third', 'root', 'fifth', 'seventh', 'tension'], withColor: true, styleId: ctx.style.id }).midi;
    } else if (strong) {
      m = chordToneNear(chord, cur + dir * 2, lo, hi, { withColor: ctx.style.id !== 'classical' && ctx.style.id !== 'polka', styleId: ctx.style.id }).midi;
    } else if (nextCell && nextCell.t % ctx.beat === 0 && ctx.rng.chance(0.22) && ctx.style.id !== 'polka') {
      // chromatischer Annäherungston an den nächsten Akkordton
      const nc = chordToneNear(ctx.chordAt(nextCell.t), cur + dir * 2, lo, hi);
      m = nc.midi + (dir > 0 ? -1 : 1);
    } else if (ctx.rng.chance(0.13)) {
      // Sprung (Arpeggio)
      m = chordToneNear(chord, cur + dir * 5, lo, hi).midi;
    } else {
      m = scaleStep(cur, dir, soloScale(ctx, t, useBlues));
    }
    if (m >= hi - 1 || m <= lo + 1) dir = -dir;
    else if (ctx.rng.chance(0.18)) dir = -dir;
    if (Math.abs(targetCenter - m) > 7) dir = Math.sign(targetCenter - m) || dir;
    m = clamp(m, lo, hi);
    const e = ev(t, d, m, isChordTone(chord, m) ? lofForChordPc(chord, mod(m, 12), ctx.key) : null);
    out.push(e);
    cur = m;
  }
  return out;
}

function motifPhrase(ctx, motif, from, to, startPitch, lo, hi, sequenceStep = 0) {
  if (!motif || motif.length < 2) return [];
  const m0 = motif[0];
  const out = [];
  const span = motif[motif.length - 1].start + motif[motif.length - 1].dur - m0.start;
  if (span <= 0) return [];
  let base = startPitch;
  for (let rep = 0; rep < 2; rep++) {
    const off = from + rep * Math.ceil(span / ctx.beat) * ctx.beat;
    if (off + span > to) break;
    const scale = ctx.scaleAt(off);
    let shift = base - m0.midi;
    for (const n of motif) {
      const t = off + (n.start - m0.start);
      let m = n.midi + shift;
      const sc = ctx.scaleAt(t);
      if (!sc.includes(mod(m, 12))) m = scaleStep(m, -1, sc);
      m = clamp(m, lo, hi);
      out.push(ev(t, Math.min(n.dur, to - t), m, null));
    }
    base = scaleStep(base, sequenceStep >= 0 ? 1 : -1, scale);
    base = scaleStep(base, 1, scale);
  }
  return out;
}

function repeatPhrase(ctx, from, to, pitch) {
  const pats = ['x.xx.x.x', 'xx.x..x.', 'x..x..x.'];
  const pat = ctx.rng.pick(pats);
  const out = [];
  let t = from;
  while (t < to) {
    for (let k = 0; k < pat.length && t + k * 6 < to; k++) {
      if (pat[k] !== 'x') continue;
      const e = ev(t + k * 6, 6, pitch, null);
      addArt(e, k === 0 ? 'accent' : 'staccato');
      out.push(e);
    }
    t += pat.length * 6;
  }
  return out;
}

function climaxPhrase(ctx, from, to, cur, top, lo) {
  const out = [];
  const chordEnd = ctx.chordAt(Math.max(from, to - ctx.beat * 2));
  const peak = chordToneNear(chordEnd, top, Math.max(lo, top - 7), top, { roles: ['root', 'third', 'fifth', 'tension'], withColor: true, styleId: ctx.style.id });
  const holdLen = Math.min(ctx.beat * 3, Math.max(ctx.beat, to - from - ctx.beat));
  const runEnd = to - holdLen;
  const step = ctx.style.id === 'swing' ? 12 : 6;
  const maxN = Math.max(0, Math.floor((runEnd - from) / step));
  // Lauf aufwärts zum Höhepunkt (höchstens eine Oktave, nie unter den Tonumfang)
  let m = peak.midi;
  const pitches = [];
  for (let k = 0; k < Math.min(maxN, 8); k++) {
    const nm = scaleStep(m, -1, ctx.scaleAt(runEnd - (k + 1) * step));
    if (nm < lo + 2) break;
    m = nm;
    pitches.unshift(m);
  }
  const n = pitches.length;
  pitches.forEach((p, k) => out.push(ev(runEnd - (n - k) * step, step, clamp(p, lo, top), null)));
  const h = ev(runEnd, holdLen, peak.midi, peak.lof);
  h.soloClimax = true;
  addArt(h, 'accent');
  out.push(h);
  void cur;
  return out;
}

// Melodie-Paraphrase: die Melodie des ersetzten Formteils, ausgeziert – lange Töne werden
// angespielt und mit Durchgangs-/Annäherungstönen zum nächsten Melodieton verbunden.
// So beginnt das Solo erkennbar mit dem Song und entwickelt sich erst danach frei.
function paraphrase(ctx, mel, from, to, lo, hi) {
  const src = mel.filter((n) => n.start >= from && n.start < to).sort((a, b) => a.start - b.start);
  if (src.length < 2) return [];
  // eine Oktavlage im Kernbereich
  const avg = src.reduce((s, n) => s + n.midi, 0) / src.length;
  let sh = 0;
  while (avg + sh < lo + 4) sh += 12;
  while (avg + sh > hi - 3) sh -= 12;
  const funky = ctx.style.id === 'funk' || ctx.style.id === 'secondline';
  const unit = funky && ctx.intensity >= 0.6 ? 6 : 12;
  const out = [];
  src.forEach((n, i) => {
    const next = src[i + 1];
    const m = Math.max(lo, Math.min(hi, n.midi + sh));
    const end = Math.min(to, next ? next.start : n.start + n.dur);
    const span = end - n.start;
    if (next && span >= 2 * ctx.beat) {
      // Melodieton anspielen, dann Annäherung an den nächsten Melodieton
      const hold = ctx.beat;
      out.push(ev(n.start, hold, m, n.lof ?? null));
      const target = Math.max(lo, Math.min(hi, next.midi + sh));
      const nRun = Math.min(6, Math.floor((span - hold) / unit));
      const dir = target >= m ? 1 : -1;
      const pitches = [];
      let p = target;
      for (let k = 0; k < nRun; k++) {
        p = scaleStep(p, -dir, ctx.scaleAt(end - (k + 1) * unit));
        pitches.unshift(p);
      }
      pitches.forEach((pp, k) => out.push(ev(end - (nRun - k) * unit, unit, Math.max(lo, Math.min(hi, pp)), null)));
    } else {
      out.push(ev(n.start, Math.max(6, Math.min(n.dur, end - n.start)), m, n.lof ?? null));
    }
  });
  const line = cleanLine(out.filter((e) => e.start >= from && e.start < to));
  if (line.length) addArt(line[0], 'accent');
  return line;
}

export function genSolo(ctx, v, { lyrical = false, from = 0, to = null, melody = null, full = false } = {}) {
  const inst = ctx.inst[v];
  const [clo, chi] = inst.comfort;
  const top = Math.min(inst.range[1] - 1, chi + (inst.family === 'brass' ? 2 : 4));
  const end = to ?? ctx.len;
  const st = ctx.style.id;
  const useBlues = st === 'funk' || st === 'secondline' || st === 'swing';
  const out = [];
  let cur = clamp(ctx.lastPitch(v, clo + 7), clo + 3, chi - 6);
  let t = from + (lyrical ? 0 : ctx.rng.pick([0, 0, 6, 12]));
  const motif = (ctx.songMotif || []).slice(0, 6);
  let phrase = 0;
  // Paraphrase der Melodie des Formteils (Wiedererkennung): die erste Hälfte, bei „full“ der
  // ganze Formteil – das Solo bleibt dann durchgehend die ausgezierte Melodie des Liedes
  if (melody && melody.length && end - from >= 4 * ctx.mt) {
    const half = full ? end : from + Math.floor((end - from) / ctx.mt / 2) * ctx.mt;
    const para = paraphrase(ctx, melody, from, half - ctx.beat / 2, clo, top);
    if (para.length >= 3) {
      out.push(...para);
      cur = para[para.length - 1].pitches[0];
      t = Math.max(half, Math.ceil((para[para.length - 1].start + para[para.length - 1].dur + ctx.beat) / 12) * 12);
      phrase = 1;
    }
  }
  const total = Math.max(1, end - from);
  while (t < end - ctx.beat) {
    const p = (t - from) / total;
    const targetCenter = Math.round(clo + 3 + (top - 3 - (clo + 3)) * (0.12 + 0.75 * Math.pow(p, 1.25)));
    const bars = lyrical ? 2 : ctx.rng.weighted([[1, 0.45], [2, 0.55]]);
    let pEnd = Math.min(end, Math.floor(t / ctx.mt) * ctx.mt + bars * ctx.mt - (lyrical ? ctx.beat : ctx.beat / 2));
    if (pEnd - t < ctx.beat) pEnd = Math.min(end, t + ctx.beat * 2);
    const remaining = end - t;
    let notes;
    const density = Math.min(1, p * 1.1 + ctx.intensity * 0.3);
    if (!lyrical && remaining <= ctx.mt * 2 + ctx.beat && remaining >= ctx.beat * 3) {
      notes = climaxPhrase(ctx, t, end - ctx.beat / 2, cur, top, clo);
      pEnd = end;
    } else if (phrase === 0 && motif.length >= 3) {
      notes = motifPhrase(ctx, motif, t, pEnd, chordToneNear(ctx.chordAt(t), targetCenter, clo, chi).midi, clo, top);
      if (!notes.length) notes = linePhrase(ctx, t, pEnd, cur, targetCenter, density, clo, top, useBlues, lyrical);
    } else if (!lyrical && (st === 'funk' || st === 'secondline') && p > 0.35 && ctx.rng.chance(0.2)) {
      notes = repeatPhrase(ctx, t, pEnd, chordToneNear(ctx.chordAt(t), targetCenter, clo, top, { roles: ['root', 'fifth', 'seventh'] }).midi);
    } else {
      notes = linePhrase(ctx, t, pEnd, cur, targetCenter, density, clo, top, useBlues, lyrical);
    }
    if (notes.length) {
      out.push(...notes);
      cur = notes[notes.length - 1].pitches[0];
      const lastN = notes[notes.length - 1];
      pEnd = Math.max(pEnd, lastN.start + lastN.dur);
    }
    phrase++;
    // Atempause zwischen Phrasen
    const restBeats = lyrical ? 1 : p < 0.5 ? ctx.rng.pick([1, 1.5, 2]) : ctx.rng.pick([0.5, 1, 1.5]);
    t = Math.ceil((pEnd + restBeats * ctx.beat) / 12) * 12;
  }
  const line = cleanLine(out).filter((e) => e.start < end);
  for (const e of line) if (e.start + e.dur > end) e.dur = end - e.start;
  line.forEach((e) => (e.solo = true));
  if (line.length) ctx.setLast(v, line[line.length - 1].pitches[0]);
  return line;
}
