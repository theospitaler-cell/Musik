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
  for (const [inst, str] of Object.entries(groove)) {
    for (const h of parseRhythm(str)) {
      const t = b0 + h.step * 6;
      if (skipCymbalAt0 && h.step === 0 && (inst === 'hh' || inst === 'ride')) continue;
      out.push(hit(t, 6, inst, h.accent, h.short));
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
