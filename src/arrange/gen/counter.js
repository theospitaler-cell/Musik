// Gegenstimme & Fill-Ins: echte Kontrapunktik statt Parallel-Block-Satz.
// Prinzip: Hält die Melodie oder pausiert sie, bewegt sich die Gegenstimme
// (Läufe, Motiv-Imitationen, Arpeggien, Funk-Riffs). Ist die Melodie aktiv,
// hält die Gegenstimme lange Leittöne (3/7) oder pausiert (Call & Response).
import { mod, clamp } from '../../core/constants.js';
import { guideTones, toneByRole } from '../../theory/chords.js';
import {
  ev,
  addArt,
  cleanLine,
  scaleStep,
  placePc,
  melodyGaps,
  soundingAt,
  melodyDirection,
  chordToneNear,
  isChordTone,
  lofForChordPc,
} from '../context.js';
import { bassDirection } from '../voicing.js';

function avgPitch(line, def) {
  if (!line || !line.length) return def;
  let s = 0;
  let w = 0;
  for (const e of line) {
    s += e.pitches[0] * e.dur;
    w += e.dur;
  }
  return w ? s / w : def;
}

// Dissonanz zur Melodie vermeiden (Prime, kleine Sekunde, große Septime, kl. None)
function clashes(m, melP) {
  if (melP === null || melP === undefined) return false;
  const iv = Math.abs(m - melP) % 12;
  return m === melP || iv === 1 || iv === 11;
}

function fixAgainstMelody(ctx, e, melLine, lo, hi, above) {
  const t = e.start;
  const melP = soundingAt(melLine, t);
  if (melP === null) return e;
  let m = e.pitches[0];
  const strong = t % ctx.beat === 0;
  const badSide = above ? m < melP : m > melP;
  if (clashes(m, melP) || (strong && badSide && Math.abs(m - melP) < 12)) {
    const chord = ctx.chordAt(t);
    const exclude = [];
    for (let k = -14; k <= 14; k++) if (clashes(melP + k, melP)) exclude.push(melP + k);
    const c = chordToneNear(chord, above ? Math.max(m, melP + 3) : Math.min(m, melP - 3), lo, hi, { exclude });
    e.pitches = [c.midi];
    e.lofs = [c.lof];
  }
  return e;
}

// Rhythmus-Vorlagen für Fill-Figuren (pro Schlag, 16tel-Raster).
// Innerhalb einer Figur werden Töne gebunden ('-'), Pausen ('.') nur am Figurrand –
// das hält das Notenbild ruhig (keine 16tel-Pausen-Ketten).
const FUNK_BEAT_FIGS = ['x-x-', 'x-xx', 'xxx-', '..x-', 'x---', '..xx'];
const FUNK_FILL_FIGS = ['..x-', 'x-x-', '..xx', 'x-xx'];
const STRAIGHT8_FIGS = ['xx', 'x.', '.x'];

function figureRhythm(ctx, a, b, kind) {
  const sub = ctx.style.sub;
  const out = [];
  const start = Math.ceil(a / sub) * sub;
  if (ctx.style.id === 'funk' || ctx.style.id === 'secondline') {
    let beatStart = Math.floor(a / ctx.beat) * ctx.beat; // Schlag des Fensterbeginns
    while (beatStart + 6 <= b) {
      const fig = ctx.rng.pick(kind === 'fill' ? FUNK_FILL_FIGS : FUNK_BEAT_FIGS);
      for (let k = 0; k < 4; k++) {
        if (fig[k] !== 'x') continue;
        const tt = beatStart + k * 6;
        if (tt < a || tt + 6 > b) continue;
        let len = 1;
        while (k + len < 4 && fig[k + len] === '-') len++;
        out.push({ t: tt, d: Math.min(len * 6, b - tt) });
      }
      beatStart += ctx.beat;
    }
    // innerhalb der Figur legato: bis zum nächsten Anschlag halten (max. 1 Schlag)
    for (let i = 0; i < out.length - 1; i++) {
      const gap = out[i + 1].t - out[i].t;
      if (gap <= 12 && gap > out[i].d) out[i].d = gap;
    }
    return out;
  }
  let t = start;
  const unit = ctx.intensity >= 0.75 && ctx.style.id === 'classical' ? 6 : sub;
  while (t + unit <= b) {
    if (unit === 12 && ctx.style.id !== 'classical' && ctx.rng.chance(0.15)) {
      const f = ctx.rng.pick(STRAIGHT8_FIGS);
      if (f[0] === 'x') out.push({ t, d: unit });
      if (f[1] === 'x' && t + 2 * unit <= b) out.push({ t: t + unit, d: unit });
      t += 2 * unit;
      continue;
    }
    out.push({ t, d: unit });
    t += unit;
  }
  return out;
}

// Motiv-Imitation: die letzten Melodietöne als Echo
function motifEcho(ctx, melLine, a, b, startPitch, lo, hi) {
  const src = melLine.filter((e) => e.start < a && e.start >= a - ctx.mt).slice(-4);
  if (src.length < 2) return null;
  const t0 = src[0].start;
  const span = src[src.length - 1].start + src[src.length - 1].dur - t0;
  if (span > b - a || span <= 0) return null;
  const shift = startPitch - src[0].pitches[0];
  const out = [];
  for (const s of src) {
    const t = a + (s.start - t0);
    const scale = ctx.scaleAt(t);
    let m = s.pitches[0] + shift;
    if (!scale.includes(mod(m, 12))) m = scaleStep(m, -1, scale);
    while (m < lo) m += 12;
    while (m > hi) m -= 12;
    out.push(ev(t, Math.min(s.dur, b - t), m, null));
  }
  return out;
}

function runTo(ctx, rhythm, target, dir, lo, hi) {
  // Läuft rückwärts vom Ziel, damit die Figur sicher im Akkordton landet
  const n = rhythm.length;
  const pitches = new Array(n);
  let m = target;
  for (let k = n - 1; k >= 0; k--) {
    const scale = ctx.scaleAt(rhythm[k].t);
    m = scaleStep(m, -dir, scale);
    pitches[k] = m;
  }
  // Bereich prüfen
  const maxP = Math.max(...pitches);
  const minP = Math.min(...pitches);
  let off = 0;
  if (maxP > hi) off = -12;
  if (minP < lo) off = 12;
  return rhythm.map((r, k) => ev(r.t, r.d, pitches[k] + off, null));
}

function arpeggio(ctx, rhythm, startPitch, dir, lo, hi) {
  const out = [];
  let m = startPitch;
  for (const r of rhythm) {
    const chord = ctx.chordAt(r.t);
    const pcs = chord.tones.map((t) => t.pc);
    let mm = m + dir;
    for (let k = 0; k < 12 && !pcs.includes(mod(mm, 12)); k++) mm += dir;
    if (mm > hi || mm < lo) {
      dir = -dir;
      mm = m + dir;
      for (let k = 0; k < 12 && !pcs.includes(mod(mm, 12)); k++) mm += dir;
    }
    out.push(ev(r.t, r.d, mm, lofForChordPc(chord, mod(mm, 12), ctx.key)));
    m = mm;
  }
  return out;
}

function funkRiff(ctx, rhythm, base, lo, hi) {
  const scale = ctx.scaleAt(rhythm[0]?.t ?? 0);
  const neigh = scaleStep(base, -1, scale);
  const blue = base - 3 >= lo ? base - 3 : base;
  return rhythm.map((r, k) => {
    const m = k % 3 === 1 ? neigh : k % 4 === 3 ? blue : base;
    const e = ev(r.t, r.d, clamp(m, lo, hi), null);
    if (k === 0) addArt(e, 'accent');
    else if (r.d <= 6) addArt(e, 'staccato');
    return e;
  });
}

// Bereich [a,b) aus Liegetönen herausschneiden
function carve(events, a, b, minRest) {
  const out = [];
  for (const e of events) {
    const s = e.start;
    const f = e.start + e.dur;
    if (f <= a || s >= b) {
      out.push(e);
      continue;
    }
    if (s < a && a - s >= 6) out.push({ ...e, dur: a - s, art: [...e.art], fx: [...e.fx] });
    if (f > b && f - b >= minRest) out.push({ ...e, start: b, dur: f - b, art: [...e.art], fx: [...e.fx] });
  }
  return out;
}

export function genCounter(ctx, v, melLine, { mode = 'counter', above = null } = {}) {
  const inst = ctx.inst[v];
  const [clo, chi] = inst.comfort;
  const melAvg = avgPitch(melLine, (clo + chi) / 2);
  const isAbove = above ?? (ctx.melodyVoice !== undefined && v < ctx.melodyVoice);
  let center = isAbove ? melAvg + 7 : melAvg - 8;
  center = clamp(center, clo + 4, chi - 4);
  const lo = clo;
  const hi = isAbove ? chi : Math.min(chi, Math.round(melAvg) + 2);
  const st = ctx.style.id;
  const funky = st === 'funk' || st === 'secondline';
  let last = ctx.lastPitch(v, center);
  if (Math.abs(last - center) > 9) last = center;

  // 1) Rückgrat: Leittöne (Terz/Septime) mit glatter Stimmführung
  let backbone = [];
  if (mode === 'counter') {
    for (let ci = 0; ci < ctx.chords.length; ci++) {
      const seg = ctx.chords[ci];
      const chord = seg.chord;
      const melP = soundingAt(melLine, seg.start);
      const g = guideTones(chord);
      // Gegenbewegung zum Bass: fällt der Bass, steigt die Gegenstimme
      const bDir = ci > 0 ? bassDirection(ctx.bassLine, seg.start - 1, seg.start) : 0;
      let best = null;
      const cands = [];
      for (const tone of g) {
        const m0 = placePc(tone.pc, last, lo, hi);
        cands.push({ m: m0, tone });
        if (m0 + 12 <= hi) cands.push({ m: m0 + 12, tone });
        if (m0 - 12 >= lo) cands.push({ m: m0 - 12, tone });
      }
      for (const { m, tone } of cands) {
        let cost = Math.abs(m - last) + Math.abs(m - center) * 0.25;
        if (bDir && m !== last) cost += Math.sign(m - last) === bDir ? 6 : -1.5;
        if (melP !== null && clashes(m, melP)) cost += 8;
        if (melP !== null && mod(m - melP, 12) === 0) cost += 4;
        if (!best || cost < best.cost) best = { m, lof: tone.lof, cost };
      }
      if (!best) continue;
      // Funk: Call & Response – nicht immer liegen bleiben
      if (funky && ctx.rng.chance(0.55)) {
        last = best.m;
        continue;
      }
      // Klassik: Vorhalt (Suspension) bei Akkordwechsel
      const prevEv = backbone[backbone.length - 1];
      if (st === 'classical' && prevEv && prevEv.start + prevEv.dur === seg.start && seg.dur >= ctx.beat * 2) {
        const p = prevEv.pitches[0];
        const res = scaleStep(p, -1, ctx.scaleAt(seg.start));
        if (!isChordTone(chord, p) && isChordTone(chord, res) && !clashes(p, melP)) {
          const sus = ev(seg.start, ctx.beat, p, prevEv.lofs[0], { tieFromPrev: true });
          sus.suspension = true;
          backbone.push(sus);
          backbone.push(ev(seg.start + ctx.beat, seg.dur - ctx.beat, res, null));
          last = res;
          continue;
        }
      }
      const e = ev(seg.start, seg.dur, best.m, best.lof);
      if (funky) addFxPad(e);
      backbone.push(e);
      last = best.m;
    }
    // Lange Liegetöne in Taktportionen teilen (Lesbarkeit, Atmung)
    backbone = splitLong(backbone, ctx.mt * 2);
  }

  // 2) Fill-Figuren in Melodie-Lücken
  const gaps = melodyGaps(melLine, ctx.len, ctx.beat, mode === 'fill' ? ctx.beat * 1.5 : ctx.beat);
  let figures = [];
  for (const g of gaps) {
    if (mode === 'fill' && !ctx.rng.chance(0.75)) continue;
    let a = g.a;
    let b = Math.min(g.b, a + (mode === 'fill' ? ctx.beat * 2 : ctx.mt));
    if (b - a < ctx.beat) continue;
    // Ziel: Akkordton am Ende des Fensters (Leitton)
    const chordB = ctx.chordAt(Math.min(ctx.len - 1, g.b));
    const startRef = soundingAt(backbone, a) ?? last;
    const target = chordToneNear(chordB, startRef + (isAbove ? 2 : -2), lo, hi, { roles: ['third', 'seventh', 'fifth', 'root'] });
    const nextMelDir = melodyDirection(melLine, g.b, g.b + ctx.mt);
    // Gegenbewegung: zuerst zum Bass, sonst zur Melodie
    const bDir = bassDirection(ctx.bassLine, a, Math.min(ctx.len - 1, b));
    const dir = bDir !== 0 ? -bDir : nextMelDir !== 0 ? -nextMelDir : target.midi >= startRef ? 1 : -1;
    // Motiv-Imitation (Echo der Melodie) bevorzugt – das bindet die Begleitung an den Song
    const kinds = funky ? [['motif', 3], ['riff', 2], ['run', 2], ['arp', 1]] : st === 'classical' ? [['motif', 5], ['run', 2], ['arp', 2]] : st === 'swing' ? [['motif', 3], ['run', 3], ['arp', 1]] : [['motif', 3], ['run', 2], ['arp', 2]];
    const kind = ctx.rng.weighted(kinds);
    let fig = null;
    if (kind === 'motif') fig = motifEcho(ctx, melLine, a, b, startRef, lo, hi);
    if (!fig) {
      const rhythm = figureRhythm(ctx, a, b, mode);
      if (!rhythm.length) continue;
      if (kind === 'riff') fig = funkRiff(ctx, rhythm, chordToneNear(ctx.chordAt(a), startRef, lo, hi, { roles: ['root', 'fifth', 'third'] }).midi, lo, hi);
      else if (kind === 'arp') fig = arpeggio(ctx, rhythm, startRef, dir, lo, hi);
      else fig = runTo(ctx, rhythm, target.midi, dir === 0 ? 1 : dir, lo, hi);
    }
    if (!fig || !fig.length) continue;
    const fa = fig[0].start;
    const fb = fig[fig.length - 1].start + fig[fig.length - 1].dur;
    backbone = carve(backbone, fa, fb, ctx.beat);
    figures.push(...fig);
    // Zielton nach dem Lauf (Landung), falls Platz bis zur nächsten Melodienote
    last = fig[fig.length - 1].pitches[0];
  }
  let line = cleanLine([...backbone, ...figures]);
  line = line.map((e) => fixAgainstMelody(ctx, e, melLine, lo, Math.max(hi, lo + 12), isAbove));
  // Phrasierung für Legato-Stile
  if (st === 'ballad' || st === 'classical' || inst.family === 'string') slurFigures(line, ctx);
  if (line.length) ctx.setLast(v, line[line.length - 1].pitches[0]);
  return line;
}

function addFxPad(e) {
  e.padSwell = true;
}

function splitLong(events, maxLen) {
  const out = [];
  for (const e of events) {
    if (e.dur <= maxLen) {
      out.push(e);
      continue;
    }
    let t = e.start;
    let first = true;
    while (t < e.start + e.dur) {
      const d = Math.min(maxLen, e.start + e.dur - t);
      out.push({ ...e, start: t, dur: d, art: [...e.art], fx: [...e.fx], tieFromPrev: !first });
      first = false;
      t += d;
    }
  }
  return out;
}

function slurFigures(line, ctx) {
  let runStart = null;
  for (let i = 0; i < line.length; i++) {
    const e = line[i];
    const n = line[i + 1];
    const short = e.dur <= ctx.beat / 2;
    if (short && runStart === null) runStart = i;
    const contiguous = n && n.start === e.start + e.dur && n.dur <= ctx.beat;
    if (runStart !== null && !contiguous) {
      const endIdx = n && n.start === e.start + e.dur ? i + 1 : i;
      if (endIdx - runStart >= 1) {
        line[runStart].slurStart = true;
        line[endIdx].slurEnd = true;
      }
      runStart = null;
    }
  }
}

export function fifthTone(chord) {
  return toneByRole(chord, 'fifth');
}
