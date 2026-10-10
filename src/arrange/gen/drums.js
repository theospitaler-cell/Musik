// Optionales Schlagzeug: stilgerechte Grooves, Fills an Phrasenenden,
// Crash auf Formteil-Anfängen, Hits synchron zu den Bläser-Hits.
import { DIV } from '../../core/constants.js';
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

// ---------- Play-along: Schlagzeug 1:1 aus der Vorlage ----------
// General-MIDI-Percussion -> Drum-Set (Latin-Percussion u. ä. wird nicht notiert)
const GM_TO_KIT = {
  35: 'bd', 36: 'bd',
  37: 'rim', 38: 'sn', 39: 'sn', 40: 'sn',
  41: 'ftom', 43: 'ftom',
  45: 'tom2', 47: 'tom2',
  48: 'tom1', 50: 'tom1',
  42: 'hh', 44: 'hhPedal', 46: 'hhOpen',
  49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash',
  51: 'ride', 53: 'ride', 59: 'ride',
};
const HANDS = new Set(['sn', 'rim', 'hh', 'hhOpen', 'crash', 'ride', 'tom1', 'tom2', 'ftom']);

// notes: [{start, dur, midi, vel}] (Ticks relativ zu Takt 1 der Vorlage)
export function drumsFromNotes(notes, { offset = 0, totalTicks, beat = DIV }) {
  const out = [];
  const byBar = new Map();
  for (const n of notes) {
    const inst = GM_TO_KIT[n.midi];
    if (!inst) continue;
    const t = n.start + offset;
    if (t < 0 || t >= totalTicks) continue;
    out.push({ t, inst, vel: n.vel ?? 90 });
  }
  // Raster je Schlag: 16tel oder Triolen – je nachdem, worauf die Schläge liegen
  for (const h of out) {
    const b = Math.floor(h.t / beat);
    if (!byBar.has(b)) byBar.set(b, { six: 0, tri: 0 });
    const r = h.t - b * beat;
    const g = byBar.get(b);
    const d6 = Math.abs(r - Math.round(r / 6) * 6);
    const d8 = Math.abs(r - Math.round(r / 8) * 8);
    if (d8 < d6) g.tri++;
    else if (d6 < d8) g.six++;
  }
  const res = [];
  for (const h of out) {
    const b = Math.floor(h.t / beat);
    const g = byBar.get(b);
    const grid = g.tri > g.six ? 8 : 6;
    const t = Math.min(totalTicks - grid, b * beat + Math.round((h.t - b * beat) / grid) * grid);
    const ghost = h.inst === 'sn' && h.vel < 50;
    res.push(hit(t, grid, h.inst, false, ghost));
  }
  // Doppelte Schläge (Flams o. ä.) zusammenfassen
  const seen = new Set();
  return res
    .sort((a, b) => a.start - b.start)
    .filter((e) => {
      const k = `${e.start}:${e.drum}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// Fills ergänzen, die im Groove bleiben: Füße (Bass Drum, Hi-Hat-Pedal) laufen weiter,
// die Hände spielen im Raster des Grooves (16tel / Achtel / Triolen) über Snare und Toms.
// Nur dort, wo die Vorlage selbst keinen Fill hat; Länge & Form bleiben unverändert.
// fillBars: [{bar, beats}] ; Rückgabe: neue Ereignisliste
export function addGrooveFills(events, { mt, beat, fillBars, lv = null }) {
  let evs = events.slice();
  const inBar = (bar) => evs.filter((e) => e.start >= bar * mt && e.start < (bar + 1) * mt);
  for (const { bar, beats } of fillBars) {
    const cur = inBar(bar);
    const next = inBar(bar + 1);
    if (!cur.length || !next.length) continue; // in eine Pause hinein kein Fill
    if (cur.some((e) => ['tom1', 'tom2', 'ftom'].includes(e.drum))) continue; // Vorlage hat schon einen Fill
    const b0 = bar * mt;
    const fillStart = b0 + mt - Math.min(beats, Math.round(mt / beat)) * beat;
    const lastBeat = cur.filter((e) => e.start >= b0 + mt - beat && e.drum === 'sn' && !e.ghost);
    if (lastBeat.length >= 3) continue; // Snare-Fill vorhanden
    // Raster aus dem Groove ableiten
    const hands = cur.filter((e) => HANDS.has(e.drum) && e.start < fillStart);
    const rs = hands.map((e) => (e.start - b0) % beat);
    let grid = rs.some((r) => r % 8 === 0 && r % 6 !== 0) ? 8 : rs.some((r) => r % 12 !== 0) ? 6 : 12;
    if (lv && lv <= 2 && grid === 6) grid = 12;
    if (lv && lv <= 3 && grid === 6 && beats >= 2) grid = 12;
    const n = Math.round((b0 + mt - fillStart) / grid);
    const seq = n <= 2 ? ['sn', 'tom1'] : n <= 4 ? ['sn', 'sn', 'tom1', 'tom2'] : ['sn', 'sn', 'tom1', 'tom1', 'tom2', 'tom2', 'ftom', 'ftom'];
    evs = evs.filter((e) => !(e.start >= fillStart && e.start < b0 + mt && HANDS.has(e.drum)));
    for (let k = 0; k < n; k++) {
      const inst = seq[Math.min(seq.length - 1, Math.floor((k * seq.length) / n))];
      const h = hit(fillStart + k * grid, grid, inst, false, false);
      h.fill = true;
      evs.push(h);
    }
    // Einsatz danach: Crash + Bass Drum auf die "1" (statt Hi-Hat/Ride)
    const n0 = (bar + 1) * mt;
    if (!next.some((e) => e.start === n0 && e.drum === 'crash')) {
      evs = evs.filter((e) => !(e.start === n0 && (e.drum === 'hh' || e.drum === 'ride' || e.drum === 'hhOpen')));
      evs.push(hit(n0, 6, 'crash'));
      if (!next.some((e) => e.start === n0 && e.drum === 'bd')) evs.push(hit(n0, 6, 'bd'));
    }
  }
  return evs.sort((a, b) => a.start - b.start);
}

// ---------- Eigener Rhythmus im Charakter des Songs ----------
// Grundlage ist der Original-Groove (Bass Drum, Snare, Becken-Raster bleiben erkennbar);
// je Schwierigkeit wird vereinfacht oder angereichert:
//   Sehr leicht: Becken in Vierteln/Achteln, Bass Drum & Snare nur auf Zählzeiten, kurze Fills
//   Leicht:      alles im Achtelraster, einfache Achtel-Fills
//   Mittel:      Original + Fills an Formteil-Enden
//   Fortgeschr.: + Ghost-Notes vor dem Backbeat, Bass-Drum-Variationen, 16tel-Fills nach 4 Takten
//   Profi:       + 16tel-Becken bzw. offene Hi-Hat, Doppelschläge, 2-Schlag-Fills über Toms, Crashes
export function varyDrums(events, lv, { mt, beat, sections, leadBars = 0, rng }) {
  const L = lv || 3;
  let evs = events.map((e) => ({ ...e, art: [...(e.art || [])], fx: [...(e.fx || [])] }));
  const total = Math.max(0, ...evs.map((e) => e.start + 1));
  const bars = Math.ceil(total / mt);
  const has = (t, d) => evs.some((e) => e.start === t && e.drum === d);
  const add = (t, d, opts = {}) => {
    if (t < 0 || has(t, d)) return;
    const h = hit(t, opts.dur || 6, d, !!opts.accent, !!opts.ghost);
    h.varied = true;
    evs.push(h);
  };
  if (L <= 2) {
    const grid = L === 1 ? beat : beat / 2;
    evs = evs.filter((e) => {
      if (e.ghost) return false;
      const r = e.start % grid;
      if (r === 0) return true;
      // Becken auf Achteln dürfen bei "Leicht" bleiben, Toms/Fills werden ausgedünnt
      return false;
    });
    if (L === 1) evs = evs.filter((e) => !['tom1', 'tom2', 'ftom'].includes(e.drum) || e.start % beat === 0);
  }
  // Fills an Formteil-Enden (und ab "Fortgeschritten" nach jeweils 4 Takten)
  const fillBars = new Set();
  for (const sec of sections || []) {
    const end = leadBars + sec.start + sec.length - 1;
    fillBars.add(end);
    if (L >= 4) for (let k = 3; k < sec.length - 1; k += 4) fillBars.add(leadBars + sec.start + k);
  }
  for (let b = 0; b < bars; b++) {
    const b0 = b * mt;
    const inBar = evs.filter((e) => e.start >= b0 && e.start < b0 + mt);
    if (!inBar.length) continue;
    const kicks = inBar.filter((e) => e.drum === 'bd');
    const snares = inBar.filter((e) => e.drum === 'sn' && !e.ghost);
    const cym = inBar.filter((e) => ['hh', 'ride', 'hhOpen'].includes(e.drum));
    const cymDrum = cym.length ? cym[0].drum === 'hhOpen' ? 'hh' : cym[0].drum : 'hh';
    if (L >= 4) {
      // Ghost-Notes: 16tel vor jedem Backbeat
      for (const sn of snares) if (rng.chance(0.7)) add(sn.start - 6, 'sn', { ghost: true });
      // Bass-Drum-Variation: Achtel/16tel-Auftakt vor der 3 bzw. der nächsten 1
      if (kicks.length && rng.chance(0.5)) add(b0 + mt / 2 - 6, 'bd');
    }
    if (L >= 5) {
      // Becken verdichten (16tel) bzw. offene Hi-Hat auf dem letzten Offbeat
      const cymTimes = cym.map((e) => e.start);
      const step = cymTimes.length >= 2 ? Math.min(...cymTimes.slice(1).map((t, i) => t - cymTimes[i])) : beat;
      if (step >= 12 && cymDrum === 'hh') for (let t = b0; t < b0 + mt; t += 6) add(t, 'hh');
      else if (cymDrum === 'hh' && rng.chance(0.6)) {
        const t = b0 + mt - beat / 2;
        evs = evs.filter((e) => !(e.start === t && e.drum === 'hh'));
        add(t, 'hhOpen');
      }
      if (kicks.length && rng.chance(0.5)) add(b0 + beat + beat / 2 + 6, 'bd'); // Doppelschlag
    }
    // Fill
    if (fillBars.has(b) && L >= 2) {
      const beats = L >= 5 ? 2 : 1;
      const unit = L <= 2 ? beat / 2 : L === 3 ? beat / 2 : 6;
      const from = b0 + mt - beats * beat;
      if (inBar.some((e) => e.start >= from && ['tom1', 'tom2', 'ftom'].includes(e.drum)) && L <= 3) continue; // Original-Fill bleibt
      evs = evs.filter((e) => !(e.start >= from && e.start < b0 + mt && ['sn', 'hh', 'hhOpen', 'ride', 'tom1', 'tom2', 'ftom'].includes(e.drum)));
      const n = Math.round((b0 + mt - from) / unit);
      const seq = L >= 5 ? ['sn', 'sn', 'tom1', 'tom1', 'tom2', 'tom2', 'ftom', 'ftom'] : L >= 4 ? ['sn', 'sn', 'tom1', 'tom2'] : ['sn', 'sn'];
      for (let k = 0; k < n; k++) add(from + k * unit, seq[Math.min(seq.length - 1, Math.floor((k * seq.length) / n))], { accent: k === 0 });
      if (L >= 4) add(b0 + mt - unit, 'bd');
      // Crash auf die nächste "1"
      const n0 = b0 + mt;
      if (n0 < bars * mt && L >= 3) {
        evs = evs.filter((e) => !(e.start === n0 && ['hh', 'ride'].includes(e.drum)));
        add(n0, 'crash');
        add(n0, 'bd');
      }
    }
  }
  return evs.sort((a, b) => a.start - b.start);
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
