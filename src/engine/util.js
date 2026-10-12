// Kleine gemeinsame Helfer der Engine (Ereignisse, Skalen, Zeitraster).
import { DIV, mod } from '../core/constants.js';

// Ereignis im Format der Arrangement-Schicht (siehe src/arrange/context.js)
export function makeEvent(start, dur, midi, lof = null, extra = {}) {
  return {
    start,
    dur,
    pitches: [midi],
    lofs: [lof],
    art: [],
    fx: [],
    grace: null,
    orn: null,
    slurStart: false,
    slurEnd: false,
    tieFromPrev: false,
    fermata: false,
    breathAfter: false,
    ...extra,
  };
}

export const top = (e) => e.pitches[e.pitches.length - 1];
export const bottom = (e) => e.pitches[0];
export const endOf = (e) => e.start + e.dur;

export function sortEvents(events) {
  return events.sort((a, b) => a.start - b.start || a.pitches[0] - b.pitches[0]);
}

// Einstimmige Folge: Überlappungen kürzen, Gleichzeitiges auf das erste reduzieren, Länge > 0
export function monoClean(events) {
  const s = sortEvents(events.filter((e) => e && e.dur > 0));
  const out = [];
  for (const e of s) {
    const prev = out[out.length - 1];
    if (prev && prev.start === e.start) continue;
    if (prev && endOf(prev) > e.start) prev.dur = e.start - prev.start;
    if (e.dur > 0) out.push(e);
  }
  return out.filter((e) => e.dur > 0);
}

// Ereignis, das zum Zeitpunkt t klingt (start ≤ t < ende)
export function soundingAt(events, t) {
  let lo = 0;
  let hi = events.length - 1;
  let res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].start <= t) {
      res = events[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return res && endOf(res) > t ? res : null;
}

// letzter Ton, der vor t begann (auch wenn schon verklungen)
export function lastBefore(events, t) {
  let res = null;
  for (const e of events) {
    if (e.start >= t) break;
    res = e;
  }
  return res;
}

// Skala als Leiter aller Tonhöhen im Bereich [lo, hi]
export function ladder(pcs, lo = 12, hi = 120) {
  const set = new Set(pcs.map((p) => mod(p, 12)));
  const out = [];
  for (let m = lo; m <= hi; m++) if (set.has(mod(m, 12))) out.push(m);
  return out;
}

// Stufen-Index einer Tonhöhe in der Leiter (nächster Ton, bei Gleichstand der tiefere)
export function ladderIndex(lad, midi) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < lad.length; i++) {
    const d = Math.abs(lad[i] - midi);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// Zeitraster: Taktlänge, Schlaglänge, Zählzeiten je Takt
export function meterGeometry(meter) {
  const mt = (meter.beats * DIV * 4) / meter.beatType;
  const compound = meter.beatType === 8 && meter.beats % 3 === 0 && meter.beats > 3;
  const beat = compound ? (DIV * 3) / 2 : (DIV * 4) / meter.beatType;
  return { mt, beat, nBeats: Math.round(mt / beat), compound, half: mt % 2 === 0 && Math.round(mt / beat) === 4 ? mt / 2 : null };
}

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
