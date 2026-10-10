// Schwierigkeitsgrade 1–5 (global oder pro Stimme). "auto" = Standard der Engine.
//  1 Sehr leicht (Anfänger)  – bequeme Lage, nur Viertel/Achtel, keine Synkopen-Bögen,
//                               kleine Sprünge, keine Effekte, viele Atempausen
//  2 Leicht                  – Achtel-Synkopen erlaubt, keine 16tel, wenige Effekte
//  3 Mittel                  – 16tel erlaubt (ohne 16tel-Synkopen), Fall-offs & Scoops
//  4 Fortgeschritten         – volle Rhythmik, alle Effekte, gehobene Lage
//  5 Profi                   – kompletter Tonumfang inkl. Höhepunkte, alles erlaubt
import { clamp } from '../core/constants.js';
import { cleanLine } from './context.js';

export const DIFFICULTY_LEVELS = [
  { value: 1, name: 'Sehr leicht', short: 'Anfänger' },
  { value: 2, name: 'Leicht', short: 'Leicht' },
  { value: 3, name: 'Mittel', short: 'Mittel' },
  { value: 4, name: 'Fortgeschritten', short: 'Fortgeschr.' },
  { value: 5, name: 'Profi', short: 'Profi' },
];

export function levelFor(opts, v) {
  const per = opts.voiceDifficulty ? opts.voiceDifficulty[v] : null;
  if (per !== null && per !== undefined && per !== 'auto' && per !== '') return Number(per);
  if (opts.difficulty === 'auto' || opts.difficulty === null || opts.difficulty === undefined || opts.difficulty === '') return null;
  return Number(opts.difficulty);
}

// Tonumfang je Stufe (klingend); null = unverändert
export function difficultyRange(inst, lv) {
  if (!lv || lv >= 5) return inst;
  const [rlo, rhi] = inst.range;
  const [clo, chi] = inst.comfort;
  let lo;
  let hi;
  if (lv === 4) {
    lo = rlo;
    hi = Math.max(chi + 1, rhi - 2);
  } else if (lv === 3) {
    lo = Math.min(clo, rlo + 2);
    hi = chi + 1;
  } else if (lv === 2) {
    lo = clo + 1;
    hi = chi - 2;
  } else {
    lo = clo + 3;
    hi = chi - 5;
  }
  if (hi - lo < 12) {
    const mid = (lo + hi) / 2;
    lo = Math.round(mid - 6);
    hi = lo + 12;
  }
  lo = Math.max(rlo, lo);
  hi = Math.min(rhi, hi);
  const comfort = [clamp(clo, lo, hi), clamp(chi, lo, hi)];
  if (comfort[1] - comfort[0] < 9) {
    comfort[0] = lo;
    comfort[1] = hi;
  }
  return { ...inst, range: [lo, hi], comfort, level: lv };
}

// Rhythmus vereinfachen (nach der Generierung)
export function simplifyRhythm(events, lv, mt, beat) {
  if (!lv || lv >= 4) return events;
  const out = [];
  const evs = [...events].sort((a, b) => a.start - b.start);
  for (let i = 0; i < evs.length; i++) {
    const e = { ...evs[i], art: [...evs[i].art], fx: [...evs[i].fx] };
    const next = evs[i + 1];
    if (lv <= 2) {
      // Raster: Achtel
      const s = Math.round(e.start / 12) * 12;
      const prev = out[out.length - 1];
      if (prev && s <= prev.start) continue; // zu dichte Töne fallen weg
      if (prev && prev.start + prev.dur > s) prev.dur = s - prev.start;
      let end = Math.max(s + 12, Math.round((e.start + e.dur) / 12) * 12);
      if (next) end = Math.min(end, Math.max(s + 12, Math.round(next.start / 12) * 12));
      e.start = s;
      e.dur = end - s;
      if (lv === 1 && e.start % beat !== 0 && e.dur > 12) {
        // keine Synkopen-Bögen: Offbeat-Töne enden auf dem nächsten Schlag
        e.dur = Math.min(e.dur, Math.ceil((e.start + 1) / beat) * beat - e.start);
      }
      e.grace = null;
      if (e.orn) e.orn = null;
    } else if (lv === 3) {
      // keine 16tel-Synkopen (Ton auf "e"/"a" über die Achtelgrenze hinaus)
      if (e.start % 12 === 6 && e.dur > 6) {
        const prev = out[out.length - 1];
        const shiftTo = e.start + 6;
        if (!next || next.start > shiftTo) {
          if (prev && prev.start + prev.dur === e.start) prev.dur += 6;
          e.dur -= 6;
          e.start = shiftTo;
        }
      }
    }
    if (e.dur > 0) out.push(e);
  }
  // Takt-Grenzen respektieren (nichts darüber hinaus verschieben)
  return cleanLine(out.filter((e) => e.dur > 0 && Math.floor(e.start / mt) === Math.floor(e.start / mt)));
}

// Große Sprünge in Begleitstimmen entschärfen
export function limitLeaps(events, lv, inst) {
  if (!lv || lv >= 4) return events;
  const maxLeap = lv === 1 ? 7 : lv === 2 ? 9 : 12;
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1];
    const b = events[i];
    if (['melody', 'solo', 'hook', 'subject', 'tutti'].includes(b.role)) continue;
    const pa = a.pitches[a.pitches.length - 1];
    let pb = b.pitches[0];
    while (pb - pa > maxLeap && pb - 12 >= inst.range[0]) pb -= 12;
    while (pa - pb > maxLeap && pb + 12 <= inst.range[1]) pb += 12;
    if (pb !== b.pitches[0]) {
      const d = pb - b.pitches[0];
      b.pitches = b.pitches.map((p) => p + d);
    }
  }
  return events;
}

export function simplifyDrums(events, lv) {
  if (!lv || lv >= 4) return events;
  return events.filter((e) => {
    if (e.ghost) return false;
    if (lv <= 2 && e.start % 12 !== 0 && ['hh', 'ride'].includes(e.drum)) return false;
    if (lv === 1 && e.start % 12 !== 0) return false;
    return true;
  });
}

// erlaubte Effekte je Stufe
export function fxAllowed(lv, fx) {
  if (!lv || lv >= 4) return true;
  if (lv === 3) return ['falloff', 'scoop', 'stopped', 'pizz', 'mutes'].includes(fx);
  return ['pizz', 'mutes'].includes(fx);
}
