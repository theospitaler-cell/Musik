// Begleitung aus der Vorlage: Basslinie und Begleitstimmen des Originals für einen Formteil.
// So bleibt beim Neu-Arrangieren der Groove des Liedes erhalten (Bassfigur, Rhythmus der
// Akkord-Einwürfe) – statt eines beliebigen Stil-Musters.
import { DIV, mod } from '../../core/constants.js';
import { ev, addArt, cleanLine, soundingAt } from '../context.js';
import { chordToneFor, toneUnder, tidy, movesTogether } from '../original.js';
import { scalePcs } from '../../theory/keys.js';

const medianOf = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Reicht die Vorlage für diesen Abschnitt? (im Schnitt mindestens ein Ton je Takt)
export function enoughSource(notes, measures) {
  return !!notes && notes.length >= Math.max(2, measures);
}

// notes: Bass der Vorlage im Abschnitt (blockrelativ, klingend). shift: Oktavlage für das Instrument
export function sourceBass(ctx, v, notes, { shift = 0, kicks = [] } = {}) {
  const inst = ctx.inst[v];
  const lo = inst.range[0];
  const hi = Math.min(inst.range[1], inst.comfort[1] + 4);
  let line = notes
    .filter((n) => n.start >= 0 && n.start < ctx.len)
    .map((n) => {
      let m = n.midi + shift;
      while (m < lo) m += 12;
      while (m > hi) m -= 12;
      return { start: n.start, dur: Math.min(n.dur, ctx.len - n.start), midi: m, lof: null };
    });
  // einzelne Ausreißer in die Lage der Nachbarn
  for (let i = 0; i < line.length; i++) {
    const around = line.slice(Math.max(0, i - 3), i).concat(line.slice(i + 1, i + 4));
    if (around.length < 2) continue;
    const ref = medianOf(around.map((n) => n.midi));
    const n = line[i];
    if (Math.abs(n.midi - ref) <= 9) continue;
    const folded = n.midi - 12 * Math.round((n.midi - ref) / 12);
    if (folded >= lo && folded <= hi) n.midi = folded;
  }
  line = tidy(line, ctx.len);
  // Lücken ab zwei Schlägen: Grundton im Rhythmus der Bass Drum, sonst auf den Takthälften
  const center = line.length ? medianOf(line.map((n) => n.midi)) : inst.comfort[0] + 5;
  const near = (pc) => {
    let m = center - 6;
    while (mod(m, 12) !== pc) m++;
    while (m < lo) m += 12;
    while (m > hi) m -= 12;
    return m;
  };
  const gaps = [];
  let cursor = 0;
  for (const n of [...line, { start: ctx.len, dur: 0 }]) {
    if (n.start - cursor >= 2 * ctx.beat) gaps.push([cursor, n.start]);
    cursor = Math.max(cursor, n.start + n.dur);
  }
  const half = ctx.mt % (2 * ctx.beat) === 0 ? ctx.mt / 2 : ctx.mt;
  const fill = [];
  for (const [a, b] of gaps) {
    let starts = kicks.filter((k) => k >= a && k < b && k % (DIV / 2) === 0);
    if (starts.length < Math.max(1, (b - a) / ctx.mt) || starts.length > (4 * (b - a)) / ctx.mt) {
      starts = [];
      for (let t = Math.ceil(a / half) * half; t < b; t += half) starts.push(t);
    }
    for (const c of ctx.chords) if (c.start > a && c.start < b) starts.push(c.start);
    if (a === 0 || !starts.length) starts.push(a % ctx.beat === 0 ? a : Math.ceil(a / ctx.beat) * ctx.beat);
    starts = [...new Set(starts)].filter((t) => t >= a && t < b).sort((x, y) => x - y);
    starts.forEach((st, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : b;
      const ch = ctx.chordAt(st);
      if (!ch || end <= st) return;
      const root = ch.tones.find((t) => t.role === 'root') || ch.tones[0];
      fill.push({ start: st, dur: end - st, midi: near(ch.bassPc ?? root.pc), lof: ch.bassLof ?? root.lof });
    });
  }
  line = tidy([...line, ...fill], ctx.len);
  const funky = ['funk', 'secondline', 'polka'].includes(ctx.style.id);
  const out = cleanLine(
    line.map((n) => {
      const e = ev(n.start, n.dur, n.midi, n.lof);
      if (funky && n.dur <= DIV / 4) addArt(e, 'staccato');
      return e;
    }),
  );
  if (out.length) ctx.setLast(v, out[out.length - 1].pitches[0]);
  return out;
}

// Begleitstimme der Vorlage. guide: eigene Linie (oder null), others: übrige Begleitlinien der
// Vorlage (für den gemeinsamen Rhythmus), partners: schon gesetzte Begleitstimmen dieses Abschnitts
export function sourceComp(ctx, v, kind, { guide = null, others = [], partners = [], melShift = 0 } = {}) {
  const inst = ctx.inst[v];
  const scale = scalePcs(ctx.key);
  const lead = ctx.melodyLine && ctx.melodyVoice !== undefined && v > ctx.melodyVoice ? ctx.melodyLine : null;
  const bass = ctx.bassLine || [];
  const guideBy = new Map((guide || []).map((n) => [n.start, n]));
  // Parallelstimme (läuft mit der Melodie mit): Töne wie gehört. Sonst – Akkord-Einwürfe von
  // Gitarre/Klavier – zählt der Rhythmus; die Töne werden sauber als Akkordtöne geführt.
  const together = movesTogether(guide, ctx.melodyLine);
  let last = ctx.lastPitch(v, Math.round(inst.comfort[0] + (inst.comfort[1] - inst.comfort[0]) * 0.45));
  if (last < inst.range[0] || last > inst.range[1]) last = Math.round((inst.comfort[0] + inst.comfort[1]) / 2);
  // Heimatlage: nach tiefen Stellen kehrt die Stimme in ihre gute Lage zurück
  const home = Math.round(inst.comfort[0] + (inst.comfort[1] - inst.comfort[0]) * 0.5);
  // Decke: die Melodie – aber nicht jeder kurze Abstecher nach unten, sondern ihre Lage im Takt
  const melCeil = (t) => {
    if (!lead) return null;
    const a0 = Math.floor(t / ctx.mt) * ctx.mt;
    const ps = lead.filter((e) => e.start >= a0 && e.start < a0 + ctx.mt).map((e) => e.pitches[0]);
    const now = soundingAt(lead, t);
    if (!ps.length) return now;
    const med = medianOf(ps);
    return now === null ? med : Math.max(now, med - 2);
  };
  const out = [];
  for (let bar = 0; bar < ctx.measures; bar++) {
    const a = bar * ctx.mt;
    const b = a + ctx.mt;
    const inBar = (n) => n.start >= a && n.start < b;
    const seen = new Set();
    const onsets = [];
    const add = (t, d) => {
      if (seen.has(t)) return;
      seen.add(t);
      onsets.push([t, d]);
    };
    if (together) {
      for (const n of (guide || []).filter(inBar)) add(n.start, n.dur);
      for (const g of others) for (const n of g.filter(inBar)) add(n.start, n.dur);
      for (const p of partners) for (const e of p.filter(inBar)) add(e.start, e.dur);
    } else {
      // Akkord-Einwürfe: nur die Stellen, an denen die Begleitung gemeinsam einsetzt
      const all = [guide || [], ...others].filter((g) => g.length);
      const count = new Map();
      for (const g of all) for (const n of g.filter(inBar)) count.set(n.start, (count.get(n.start) || 0) + 1);
      const need = all.length >= 2 ? 2 : 1;
      for (const t of [...count.keys()].sort((x, y) => x - y)) if (count.get(t) >= need) add(t, DIV / 2);
      // Akkordwechsel ohne Einwurf: neu ansetzen
      if (onsets.length) for (const c of ctx.chords) if (c.start >= a && c.start < b && !onsets.some(([t]) => Math.abs(t - c.start) <= DIV / 2)) add(c.start, DIV / 2);
    }
    let pad = false;
    if (!onsets.length) {
      pad = true;
      for (const c of ctx.chords) {
        const s = Math.max(a, c.start);
        const e = Math.min(b, c.start + c.dur);
        if (e > s) onsets.push([s, e - s]);
      }
    }
    onsets.sort((x, y) => x[0] - y[0]);
    if (!together && !pad) {
      // ausdünnen: Einwürfe höchstens in Achteln, Liegeklänge ein Anschlag je Takthälfte
      const minGap = kind === 'pad' ? ctx.mt / 2 : DIV / 2;
      let lastT = -Infinity;
      for (let i = 0; i < onsets.length; i++) {
        const slot = kind === 'pad' ? Math.floor(onsets[i][0] / minGap) : null;
        const keep = kind === 'pad' ? slot !== lastT : onsets[i][0] - lastT >= minGap;
        if (!keep) onsets.splice(i--, 1);
        else lastT = kind === 'pad' ? slot : onsets[i][0];
      }
    }
    for (const [t, d] of onsets) {
      const m = melCeil(t);
      const ups = partners.map((p) => soundingAt(p, t)).filter((x) => x !== null);
      let hi = Math.min(inst.range[1], inst.comfort[1] + 2);
      if (m !== null) hi = Math.min(hi, m - 1);
      if (ups.length) hi = Math.min(hi, Math.min(...ups) - 1);
      const bs = soundingAt(bass, t);
      let lo = Math.max(inst.range[0], bs !== null ? bs + 1 : inst.range[0]);
      if (hi < lo + 2) {
        lo = inst.range[0];
        hi = Math.max(hi, lo + 4);
      }
      const melPc = m !== null ? mod(m, 12) : null;
      const taken = ups.map((x) => mod(x, 12));
      const chord = ctx.chordAt(t);
      const g = guideBy.get(t);
      let pick = null;
      if (g && together) {
        const want = g.midi + melShift;
        if (want >= lo && want <= hi) pick = { midi: want, lof: null };
        else {
          let best = null;
          for (let mm = want - 48; mm <= want + 48; mm += 12) {
            if (mm < lo || mm > hi) continue;
            if (best === null || Math.abs(mm - last) < Math.abs(best - last)) best = mm;
          }
          if (best !== null) pick = { midi: best, lof: null };
        }
      }
      if (!pick && !pad && together) {
        const upper = ups.length ? Math.min(...ups) : m;
        if (upper !== null) pick = toneUnder(upper, chord, scale, Math.min(Math.max(last, lo), hi), lo, hi, taken, melPc);
      }
      if (!pick) pick = chordToneFor(chord, Math.min(Math.max(Math.round(0.7 * last + 0.3 * home), lo), hi), lo, hi, taken, melPc, g ? mod(g.midi + melShift, 12) : null);
      if (!pick) continue;
      out.push({ start: t, dur: Math.min(d, ctx.len - t), midi: pick.midi, lof: pick.lof });
      last = pick.midi;
    }
  }
  // Liegeklänge klingen bis zum nächsten Einsatz, Einwürfe bleiben kurz
  const line = tidy(out, ctx.len, { sustain: kind === 'pad' ? ctx.mt : 0 });
  const rhythmic = ['funk', 'secondline', 'swing', 'polka'].includes(ctx.style.id);
  const res = cleanLine(
    line.map((n) => {
      const e = ev(n.start, n.dur, n.midi, n.lof);
      if (kind === 'pad' && n.dur >= ctx.beat * 2) e.pad = true;
      if (kind !== 'pad' && rhythmic && n.dur <= DIV / 4) addArt(e, 'staccato');
      return e;
    }),
  );
  if (res.length) ctx.setLast(v, res[res.length - 1].pitches[0]);
  return res;
}
