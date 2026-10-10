// Optionales Schlagzeug: stilgerechte Grooves, Fills an Phrasenenden,
// Crash auf Formteil-Anfängen, Hits synchron zu den Bläser-Hits.
import { parseRhythm, drumGroove } from '../styles.js';

// General-MIDI-Drum-Map
export const KIT = {
  bd: 36,
  sn: 38,
  rim: 37,
  hh: 42,
  hhPedal: 44,
  hhOpen: 46,
  crash: 49,
  ride: 51,
  tom1: 48,
  tom2: 45,
  ftom: 41,
};

function hit(t, d, inst, accent = false, ghost = false) {
  return { start: t, dur: d, pitches: [KIT[inst]], drum: inst, art: accent ? ['accent'] : [], fx: [], ghost };
}

function grooveBar(ctx, b0, groove, out, { skipCymbalAt0 = false } = {}) {
  // Im Groove keine Akzentzeichen (Drum-Chart-Konvention) – Ghost-Notes bleiben
  for (const [inst, str] of Object.entries(groove)) {
    for (const h of parseRhythm(str)) {
      const t = b0 + h.step * 6;
      if (skipCymbalAt0 && h.step === 0 && (inst === 'hh' || inst === 'ride')) continue;
      out.push(hit(t, 6, inst, false, h.short));
    }
  }
}

function fillBar(ctx, b0, beats, out, rng) {
  const st = ctx.style.id;
  const fillStart = b0 + ctx.mt - beats * ctx.beat;
  const unit = st === 'swing' || st === 'ballad' || st === 'polka' ? 12 : 6;
  const seq = ['sn', 'sn', 'tom1', 'tom1', 'tom2', 'tom2', 'ftom', 'ftom'];
  const n = Math.floor((b0 + ctx.mt - fillStart) / unit);
  for (let k = 0; k < n; k++) {
    const inst = st === 'polka' || st === 'classical' ? 'sn' : seq[Math.floor((k * seq.length) / n)];
    out.push(hit(fillStart + k * unit, unit, inst, k === 0 || (rng.chance(0.2) && k % 2 === 0)));
  }
  if (st !== 'classical') out.push(hit(fillStart, unit, 'bd'));
}

// segRoles: Rollen des Segments, hitsLine: Ereignisse einer Tutti-Stimme (für Hits)
export function genDrumsSegment(ctx, { mode, bars, isBlockStart, isBlockEnd, hitsLine = null, intensity = 0.5 }) {
  const out = [];
  if (mode === 'rest') return out;
  const variant = intensity >= 0.75 ? 1 : 0;
  const groove = drumGroove(ctx.style, ctx.steps, variant);
  for (let bar = 0; bar < bars; bar++) {
    const b0 = bar * ctx.mt;
    if (mode === 'hits' || mode === 'final') {
      // Kicks + Snare + Crash auf den Bläser-Hits
      const hits = (hitsLine || []).filter((e) => e.start >= b0 && e.start < b0 + ctx.mt);
      hits.forEach((e, k) => {
        out.push(hit(e.start, 6, 'bd', true));
        out.push(hit(e.start, 6, k === 0 || e.finalHit ? 'crash' : 'sn', true));
      });
      if (mode === 'hits' && bar === bars - 1 && isBlockEnd) fillBar(ctx, b0, 1, out, ctx.rng);
      continue;
    }
    const phraseEnd = (bar + 1) % 4 === 0;
    const lastBar = bar === bars - 1;
    if ((phraseEnd && ctx.rng.chance(0.65)) || (lastBar && isBlockEnd)) {
      const fillBeats = lastBar && isBlockEnd ? (intensity > 0.6 ? 2 : 1) : 1;
      // Groove bis zum Fill
      const cut = b0 + ctx.mt - fillBeats * ctx.beat;
      const tmp = [];
      grooveBar(ctx, b0, groove, tmp, { skipCymbalAt0: bar === 0 && isBlockStart });
      out.push(...tmp.filter((e) => e.start < cut));
      fillBar(ctx, b0, fillBeats, out, ctx.rng);
    } else {
      grooveBar(ctx, b0, groove, out, { skipCymbalAt0: bar === 0 && isBlockStart });
    }
    if (bar === 0 && isBlockStart) out.push(hit(b0, 6, 'crash', true));
  }
  return out;
}

// Ausgeschriebenes Drum-Solo: Dramaturgie Break -> Snare-Akzente -> Toms -> großer Fill
const ACCENTS = [0, 3, 6, 8, 11, 14]; // 3+3+2-Gruppierung
export function genDrumSolo(ctx, bars) {
  const out = [];
  const rng = ctx.rng;
  for (let bar = 0; bar < bars; bar++) {
    const b0 = bar * ctx.mt;
    const steps = ctx.steps;
    const p = bars > 1 ? bar / (bars - 1) : 1;
    const last = bar === bars - 1;
    const kind = last ? 'fill' : p < 0.3 ? 'break' : p < 0.6 ? 'snare' : 'toms';
    for (let s = 0; s < steps; s++) {
      const t = b0 + s * 6;
      const acc = ACCENTS.includes(s % 16);
      if (kind === 'break') {
        if (s % 4 === 0 && s % 8 !== 4) out.push(hit(t, 6, 'bd', s === 0));
        if (s % 8 === 4) out.push(hit(t, 6, 'sn', true));
        if (s % 2 === 0) out.push(hit(t, 6, 'hh', false));
        if (rng.chance(0.25) && s % 4 === 3) out.push(hit(t, 6, 'sn', false, true));
      } else if (kind === 'snare') {
        out.push(hit(t, 6, 'sn', acc, !acc));
        if (s % 8 === 0) out.push(hit(t, 6, 'bd', true));
        if (acc && rng.chance(0.3)) out.push(hit(t, 6, 'crash', false));
      } else if (kind === 'toms') {
        const seq = ['sn', 'tom1', 'tom2', 'ftom'];
        out.push(hit(t, 6, seq[Math.floor(s / 4) % 4], acc));
        if (acc) out.push(hit(t, 6, 'bd', false));
      } else {
        const seq = ['sn', 'sn', 'tom1', 'tom1', 'tom2', 'tom2', 'ftom', 'ftom'];
        out.push(hit(t, 6, seq[Math.floor((s * seq.length) / steps)], acc || s >= steps - 2));
        if (s % 4 === 0) out.push(hit(t, 6, 'bd', true));
      }
    }
  }
  return out;
}

// Hits zur Melodie (Kicks + Crash/Snare auf betonte, lange Melodietöne) über einem leichten Groove
export function genDrumHits(ctx, melody, bars) {
  const out = [];
  const groove = drumGroove(ctx.style, ctx.steps, 0);
  const hats = groove.hh || groove.ride || 'x.x.x.x.x.x.x.x.';
  for (let bar = 0; bar < bars; bar++) {
    for (const h of parseRhythm(hats)) out.push(hit(bar * ctx.mt + h.step * 6, 6, groove.hh ? 'hh' : 'ride', false, h.short));
  }
  for (const n of melody) {
    if (n.dur < ctx.beat && n.start % ctx.beat !== 0) continue;
    out.push(hit(n.start, 6, 'bd', true));
    out.push(hit(n.start, 6, n.dur >= ctx.beat * 2 ? 'crash' : 'sn', true));
  }
  return out;
}
