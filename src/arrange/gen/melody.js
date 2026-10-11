// Melodie-Platzierung & stilistische Anpassung ("Lied anpassen").
import { mod } from '../../core/constants.js';
import { fitOctave } from '../instruments.js';
import { ev, addArt, cleanLine, scaleStep } from '../context.js';

export function phrasesOf(line, gapMin = 12) {
  const out = [];
  let cur = [];
  for (let i = 0; i < line.length; i++) {
    const e = line[i];
    const prev = line[i - 1];
    if (prev && e.start - (prev.start + prev.dur) >= gapMin) {
      if (cur.length) out.push(cur);
      cur = [];
    }
    cur.push(e);
  }
  if (cur.length) out.push(cur);
  return out;
}

function posStrength(t, ctx) {
  const p = mod(t, ctx.mt);
  if (p === 0) return 4;
  if (ctx.steps === 16 && p === ctx.mt / 2) return 3;
  if (p % ctx.beat === 0) return 2;
  if (p % (ctx.beat / 2) === 0) return 1;
  return 0;
}

// melody: [{start, dur, midi, lof}] (klingend, blockrelativ)
export function placeMelody(ctx, v, melody, { adapt = 1, climax = false, preferUp = false } = {}) {
  const inst = ctx.inst[v];
  const fit = fitOctave(melody, inst, { allowClimax: climax, prefer: preferUp ? 1 : 0 });
  let line = melody.map((n) => ev(n.start, n.dur, n.midi + fit.shift, n.lof));
  line = cleanLine(line);
  line = adaptMelody(ctx, line, adapt);
  articulate(ctx, line, inst);
  if (line.length) ctx.setLast(v, line[line.length - 1].pitches[0]);
  return { line, shift: fit.shift };
}

export function adaptMelody(ctx, line, adapt) {
  const st = ctx.style.id;
  const rng = ctx.rng;
  if (adapt <= 0 || !line.length) return line;
  const out = line.map((e) => ({ ...e, art: [...e.art], fx: [...e.fx] }));
  const half = ctx.steps === 16 ? ctx.mt / 2 : ctx.mt;
  // 1) Antizipationen ("Pushes")
  const pushBy = st === 'funk' || st === 'secondline' ? 6 : st === 'swing' || st === 'ballad' ? 12 : 0;
  if (pushBy) {
    const prob = (st === 'ballad' ? 0.12 : 0.28) * adapt;
    for (let i = 1; i < out.length; i++) {
      const e = out[i];
      const prev = out[i - 1];
      if (e.start % half !== 0 || e.dur < ctx.beat) continue;
      if (e.start - pushBy < 0) continue;
      const prevEnd = prev.start + prev.dur;
      const canShorten = prev.dur - pushBy >= 6 || prevEnd <= e.start - pushBy;
      if (!canShorten || !rng.chance(prob)) continue;
      if (prevEnd > e.start - pushBy) prev.dur = e.start - pushBy - prev.start;
      e.start -= pushBy;
      e.dur += pushBy;
      addArt(e, 'accent');
    }
  }
  // 2) Starke Anpassung: lange Töne rhythmisch neu artikulieren (Funk)
  if (adapt >= 2 && (st === 'funk' || st === 'secondline')) {
    const extra = [];
    for (const e of out) {
      if (e.dur >= ctx.beat * 3 && rng.chance(0.35)) {
        const total = e.dur;
        const p = e.pitches[0];
        e.dur = 12;
        addArt(e, 'accent');
        const b = ev(e.start + 18, 6, p, e.lofs[0]);
        addArt(b, 'staccato');
        const c = ev(e.start + 24, total - 24, p, e.lofs[0]);
        addArt(c, 'tenuto');
        extra.push(b, c);
      }
    }
    out.push(...extra);
  }
  // 3) Klassik: Diminution (Durchgangstöne in Terzsprüngen)
  if (adapt >= 2 && st === 'classical') {
    const extra = [];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i];
      const b = out[i + 1];
      const iv = b.pitches[0] - a.pitches[0];
      if (Math.abs(iv) >= 3 && Math.abs(iv) <= 4 && a.dur >= ctx.beat && a.start + a.dur === b.start && rng.chance(0.5)) {
        const h = a.dur / 2;
        if (h % 6 !== 0) continue;
        a.dur = h;
        const scale = ctx.scaleAt(a.start + h);
        const pass = scaleStep(a.pitches[0], Math.sign(iv), scale);
        if (pass !== b.pitches[0]) extra.push(ev(a.start + h, h, pass, null));
        else a.dur *= 2;
      }
    }
    out.push(...extra);
  }
  // 4) Verzierungen
  if (adapt >= 1) {
    for (let i = 0; i < out.length; i++) {
      const e = out[i];
      const prev = out[i - 1];
      if ((st === 'polka' || st === 'classical') && prev && prev.pitches[0] === e.pitches[0] && e.dur >= 12 && rng.chance(0.25)) {
        const scale = ctx.scaleAt(e.start);
        e.grace = { midi: scaleStep(e.pitches[0], +1, scale), lof: null, slash: true };
      }
      if (st === 'ballad' && (!prev || e.start - (prev.start + prev.dur) >= 12) && e.dur >= ctx.beat * 2 && rng.chance(0.2)) {
        const scale = ctx.scaleAt(e.start);
        e.grace = { midi: scaleStep(e.pitches[0], -1, scale), lof: null, slash: true };
      }
    }
    if (st === 'classical' && out.length > 3) {
      // Triller auf der vorletzten langen Note der Schlusskadenz
      const sorted = [...out].sort((a, b) => a.start - b.start);
      const pen = sorted[sorted.length - 2];
      if (pen && pen.dur >= ctx.beat && Math.abs(sorted[sorted.length - 1].pitches[0] - pen.pitches[0]) <= 2) pen.orn = ['trill'];
    }
  }
  return cleanLine(out);
}

// Artikulation & Phrasierung
export function articulate(ctx, line, inst, { plain = false } = {}) {
  // plain: 1:1 aus der Vorlage übernommene Stimmen – nur kurze Töne vor einer Pause bekommen
  // einen Staccato-Punkt, keine stilistischen Akzente
  if (plain) {
    line.forEach((e, i) => {
      const nxt = line[i + 1];
      if (e.dur <= 12 && nxt && nxt.start - (e.start + e.dur) >= 12) addArt(e, 'staccato');
    });
    return line;
  }
  const st = ctx.style.id;
  const legato = st === 'ballad' || st === 'classical' || inst.family === 'string';
  const phrases = phrasesOf(line, st === 'funk' || st === 'secondline' ? 12 : 12);
  for (const ph of phrases) {
    if (legato && ph.length >= 2) {
      // Bögen nicht über zu lange Phrasen (max. ~2 Takte)
      let startIdx = 0;
      for (let i = 1; i <= ph.length; i++) {
        const tooLong = i < ph.length && ph[i].start - ph[startIdx].start >= ctx.mt * 2 && ph[i].start % ctx.mt === 0;
        if (i === ph.length || tooLong) {
          if (i - startIdx >= 2) {
            ph[startIdx].slurStart = true;
            ph[i - 1].slurEnd = true;
          }
          startIdx = i;
        }
      }
    }
    for (let i = 0; i < ph.length; i++) {
      const e = ph[i];
      const nxt = ph[i + 1];
      const gapAfter = nxt ? nxt.start - (e.start + e.dur) : 99;
      const p = posStrength(e.start, ctx);
      if (st === 'funk' || st === 'secondline') {
        if (e.dur <= 12 && (gapAfter > 0 || p <= 1)) addArt(e, 'staccato');
        if (p <= 1 && e.dur >= 12) addArt(e, 'accent');
      } else if (st === 'swing') {
        if (e.dur <= 12 && gapAfter > 0 && p === 1) addArt(e, 'staccato');
        if (p === 1 && e.dur >= 24) addArt(e, 'accent');
        if (!nxt && e.dur <= 24) addArt(e, 'marcato');
      } else if (st === 'polka') {
        if (e.dur <= 24 && gapAfter >= 0 && nxt) addArt(e, 'staccato');
        if (p === 4 && e.dur >= 12 && ctx.rng.chance(0.3)) addArt(e, 'accent');
      } else if (st === 'ballad' || st === 'classical') {
        if (e.dur >= ctx.beat * 2 && !e.slurStart && !e.slurEnd && st === 'ballad') addArt(e, 'tenuto');
      }
      // Konflikte auflösen
      if (e.art.includes('staccato') && e.art.includes('tenuto')) e.art = e.art.filter((a) => a !== 'tenuto');
    }
  }
  return line;
}

// Motiv aus der Songmelodie (für Intros/Hooks): erste 1–2 Takte, funkifiziert
export function motifFrom(melody, ctx, bars = 2) {
  const len = ctx.mt * bars;
  return melody.filter((n) => n.start >= 0 && n.start < len).map((n) => ({ ...n, dur: Math.min(n.dur, len - n.start) }));
}
