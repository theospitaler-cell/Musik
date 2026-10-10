// Harmonischer Motor: Begleit-Rhythmen (Stabs, Comping, Nachschlag),
// Liegeklänge (Pads) und Solo-Backgrounds (erst Pads, dann Riffs).
import { mod, clamp } from '../../core/constants.js';
import { parseRhythm, compPatterns, fitRhythmString } from '../styles.js';
import { ev, addArt, cleanLine, chordToneNear, soundingAt } from '../context.js';

const ROLE_PRIORITY = [
  ['third', 'seventh', 'tension', 'fifth', 'root'],
  ['seventh', 'third', 'fifth', 'tension', 'root'],
  ['fifth', 'third', 'root', 'seventh'],
];

function compRegister(ctx, v) {
  const inst = ctx.inst[v];
  const [clo, chi] = inst.comfort;
  let lo = clo;
  let hi = chi - 3;
  let center = clo + (chi - clo) * 0.45;
  const lead = ctx.melodyLine;
  if (lead && lead.length && ctx.melodyVoice !== undefined && v > ctx.melodyVoice) {
    const melLow = Math.min(...lead.map((e) => e.pitches[0]));
    hi = Math.max(lo + 7, Math.min(hi, melLow - 1));
    center = Math.min(center, hi - 4);
  }
  return { lo, hi, center: clamp(center, lo + 2, hi - 2) };
}

function patternList(ctx, kind) {
  const st = ctx.style;
  const steps = ctx.steps;
  if (kind === 'pad') return st.comp.pads.map((p) => fitRhythmString(p, steps));
  if (kind === 'riffs') return st.comp.riffs.map((p) => fitRhythmString(p, steps));
  return compPatterns(st, steps);
}

// Akkordwechsel innerhalb eines Pads -> neu anschlagen
function splitAtChanges(ctx, t, dur) {
  const pieces = [];
  let s = t;
  const end = t + dur;
  for (const c of ctx.chords) {
    if (c.start > s && c.start < end) {
      pieces.push([s, c.start - s]);
      s = c.start;
    }
  }
  pieces.push([s, end - s]);
  return pieces.filter(([, d]) => d > 0);
}

export function genComp(ctx, v, kind = 'comp', { partners = [], rank = 0, from = 0, to = null } = {}) {
  const { lo, hi, center } = compRegister(ctx, v);
  const end = to ?? ctx.len;
  let list;
  if (kind === 'pad') list = patternList(ctx, 'pad');
  else if (kind === 'riffs') list = patternList(ctx, 'riffs');
  else list = patternList(ctx, 'comp');
  if (kind === 'stabs' && list.length > 2) {
    const shortOnes = list.filter((p) => !/-{3,}/.test(p));
    if (shortOnes.length) list = shortOnes;
  }
  if (!list.length) list = patternList(ctx, 'comp');
  // Musterwahl blockweise konsistent, Variante am Phrasenende
  const keyName = `comp_${kind}_${rank}`;
  if (ctx[keyName] === undefined) ctx[keyName] = ctx.rng.int(0, list.length - 1);
  const main = ctx[keyName] % list.length;
  const alt = (main + 1) % list.length;
  const prio = ctx.style.strict || ctx.style.id === 'polka' ? [['third', 'fifth', 'root'], ['fifth', 'root', 'third'], ['root', 'third', 'fifth']][rank % 3] : ROLE_PRIORITY[rank % ROLE_PRIORITY.length];
  const withColor = (ctx.style.id === 'funk' || ctx.style.id === 'secondline' || ctx.style.id === 'swing') && ctx.intensity >= 0.45;
  let last = ctx.lastPitch(v, center);
  if (last < lo || last > hi + 2) last = center;
  const out = [];
  for (let bar = Math.floor(from / ctx.mt); bar < Math.ceil(end / ctx.mt); bar++) {
    const b0 = bar * ctx.mt;
    const phraseEnd = (bar + 1) % 4 === 0;
    const pat = parseRhythm(list[phraseEnd && kind !== 'pad' ? alt : main]);
    for (const hit of pat) {
      const t0 = b0 + hit.step * 6;
      if (t0 < from || t0 >= end) continue;
      let dur = Math.min(hit.len * 6, end - t0);
      const pieces = kind === 'pad' || dur >= ctx.beat * 2 ? splitAtChanges(ctx, t0, dur) : [[t0, dur]];
      for (const [t, d] of pieces) {
        const chord = ctx.chordAt(t);
        const melP = ctx.melodyLine ? soundingAt(ctx.melodyLine, t) : null;
        const avoidPcs = [];
        const exclude = [];
        if (melP !== null) {
          avoidPcs.push(mod(melP, 12));
          for (let k = -1; k <= 1; k++) exclude.push(melP + k);
        }
        for (const p of partners) {
          const pp = soundingAt(p, t);
          if (pp !== null) {
            avoidPcs.push(mod(pp, 12));
            exclude.push(pp, pp - 1, pp + 1);
          }
        }
        const c = chordToneNear(chord, last, lo, hi, { roles: prio, avoidPcs, withColor, styleId: ctx.style.id, exclude });
        const e = ev(t, d, c.midi, c.lof);
        const rhythmic = ['funk', 'secondline', 'swing', 'polka'].includes(ctx.style.id);
        if (hit.accent && rhythmic && kind !== 'pad') addArt(e, 'accent');
        if (hit.short || (kind === 'stabs' && d <= 6)) addArt(e, 'staccato');
        if (ctx.style.id === 'polka' && d <= 12) addArt(e, 'staccato');
        if (kind === 'pad') e.pad = true;
        out.push(e);
        last = c.midi;
      }
    }
  }
  const line = cleanLine(out);
  if (line.length) ctx.setLast(v, line[line.length - 1].pitches[0]);
  return line;
}

// Solo-Background: erste Hälfte Liegeklänge, zweite Hälfte Riffs
export function genBackground(ctx, v, opts = {}) {
  const half = Math.max(ctx.mt, Math.floor(ctx.measures / 2) * ctx.mt);
  const pads = genComp(ctx, v, 'pad', { ...opts, from: 0, to: half });
  const riffs = genComp(ctx, v, 'riffs', { ...opts, from: half, to: ctx.len });
  for (const e of pads) e.background = 'pad';
  for (const e of riffs) e.background = 'riff';
  return cleanLine([...pads, ...riffs]);
}
