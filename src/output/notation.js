// Notensatz-Logik: Ereignisse -> notierbare Werte pro Takt.
// - Aufteilen an Taktstrichen und metrischen Schwerpunkten (Takthälfte bei 4/4
//   bleibt sichtbar), Synkopen-Ausnahmen (Achtel-Viertel-Achtel, 16tel-Achtel-16tel)
// - Haltebögen zwischen Teilstücken
// - Triolen (Achtel-/Viertel-/16tel-Triolen innerhalb eines Schlags)
// - Balken nach Zählzeiten (16tel pro Schlag, Achtel pro Takthälfte)
import { NOTE_VALUES } from '../core/constants.js';

export function meterInfo(meter) {
  const DIVQ = 24;
  const measureTicks = (meter.beats * DIVQ * 4) / meter.beatType;
  const compound = meter.beatType === 8 && meter.beats % 3 === 0 && meter.beats > 3;
  const beatTicks = compound ? (DIVQ * 3) / 2 : (DIVQ * 4) / meter.beatType;
  const nBeats = Math.round(measureTicks / beatTicks);
  const halfBar = nBeats === 4 ? measureTicks / 2 : null;
  return { measureTicks, beatTicks, nBeats, compound, halfBar, triple: !compound && nBeats === 3 };
}

export function strength(t, mi) {
  if (t === 0) return 5;
  if (mi.halfBar && t % mi.halfBar === 0) return 4;
  if (t % mi.beatTicks === 0) return 3;
  const sub1 = mi.compound ? mi.beatTicks / 3 : mi.beatTicks / 2;
  if (t % sub1 === 0) return 2;
  if (t % (sub1 / 2) === 0) return 1;
  return 0;
}

function unitOfStrength(s, mi) {
  const sub1 = mi.compound ? mi.beatTicks / 3 : mi.beatTicks / 2;
  if (s === 2) return sub1;
  if (s === 1) return sub1 / 2;
  return 3;
}

function allowed(pos, v, mi, isRest) {
  const sPos = strength(pos, mi);
  for (let b = pos + 3; b < pos + v; b += 3) {
    const sb = strength(b, mi);
    if (sb < sPos) continue;
    if (isRest) return false;
    if (sb >= 4) return false;
    // Synkopen-Ausnahme: z. B. Achtel auf "e" über die Achtelgrenze,
    // Viertel auf "und" über die Schlaggrenze
    if (sb === sPos + 1 && v <= 2 * unitOfStrength(sPos, mi)) continue;
    // 6/8: innerhalb eines Schlags frei
    if (mi.compound && sb === 2 && Math.floor(pos / mi.beatTicks) === Math.floor((pos + v - 1) / mi.beatTicks)) continue;
    // 3/4: auf Schlag beginnende Noten dürfen Schläge überbinden
    if (mi.triple && sPos >= 3 && sb === 3) continue;
    return false;
  }
  return true;
}

// Dauer an Position in notierbare Stücke aufteilen
export function splitDuration(pos, dur, mi, isRest = false) {
  const out = [];
  let p = pos;
  let rem = dur;
  let guard = 0;
  while (rem > 0 && guard++ < 64) {
    let chosen = null;
    for (const [ticks, type, dots] of NOTE_VALUES) {
      if (ticks > rem) continue;
      if (p + ticks > mi.measureTicks) continue;
      if (dots && isRest && ticks < 36) continue;
      if (!allowed(p, ticks, mi, isRest)) continue;
      chosen = { ticks, type, dots };
      break;
    }
    if (!chosen) chosen = { ticks: Math.min(rem, 3), type: '32nd', dots: 0 };
    out.push({ start: p, dur: chosen.ticks, type: chosen.type, dots: chosen.dots });
    p += chosen.ticks;
    rem -= chosen.ticks;
  }
  return out;
}

const TRIPLET_TYPES = { 4: '16th', 8: 'eighth', 16: 'quarter' };

function isTripletBeat(boundaries, beatStart, mi) {
  if (mi.compound) return false;
  for (const b of boundaries) {
    const r = b - beatStart;
    if (r > 0 && r < mi.beatTicks && r % 3 !== 0) return true;
  }
  return false;
}

// Gibt pro Takt eine Liste von Items zurück
// item: {kind, start, dur, type, dots, tuplet, ev, first, last, tieStart, tieStop, pitches, lofs}
// geom (optional, bei Taktartwechseln): {start(m), mi(m)} – Taktanfang & Taktart je Takt
export function layoutVoice(events, meter, totalBars, geom = null) {
  const mi0 = meterInfo(meter);
  const measures = [];
  const evs = [...events].sort((a, b) => a.start - b.start);
  // Haltebögen über Ereignisgrenzen (tieFromPrev)
  for (let i = 1; i < evs.length; i++) {
    const a = evs[i - 1];
    const b = evs[i];
    if (b.tieFromPrev && a.start + a.dur === b.start && a.pitches.join() === b.pitches.join()) {
      a._tieNext = true;
      b._tiePrev = true;
    }
  }
  let idx = 0;
  for (let m = 0; m < totalBars; m++) {
    const mi = geom ? geom.mi(m) : mi0;
    const mt = mi.measureTicks;
    const m0 = geom ? geom.start(m) : m * mt;
    const m1 = m0 + mt;
    const segs = [];
    while (idx < evs.length && evs[idx].start + evs[idx].dur <= m0) idx++;
    for (let k = idx; k < evs.length && evs[k].start < m1; k++) {
      const e = evs[k];
      const s = Math.max(m0, e.start);
      const f = Math.min(m1, e.start + e.dur);
      if (f <= s) continue;
      segs.push({ kind: 'note', s: s - m0, f: f - m0, ev: e, contFromPrev: e.start < m0, contToNext: e.start + e.dur > m1 });
    }
    // Lücken mit Pausen füllen
    const filled = [];
    let cur = 0;
    for (const sg of segs) {
      if (sg.s > cur) filled.push({ kind: 'rest', s: cur, f: sg.s });
      if (sg.s < cur) sg.s = cur;
      if (sg.f > sg.s) filled.push(sg);
      cur = Math.max(cur, sg.f);
    }
    if (cur < mt) filled.push({ kind: 'rest', s: cur, f: mt });
    // Ganztaktpause
    if (filled.length === 1 && filled[0].kind === 'rest') {
      measures.push([{ kind: 'rest', start: 0, dur: mt, type: 'whole', dots: 0, measureRest: true }]);
      continue;
    }
    // Triolen-Schläge bestimmen
    const boundaries = new Set();
    for (const sg of filled) {
      boundaries.add(sg.s);
      boundaries.add(sg.f);
    }
    const tripBeats = new Set();
    for (let b = 0; b < mi.nBeats; b++) if (isTripletBeat(boundaries, b * mi.beatTicks, mi)) tripBeats.add(b);
    const items = [];
    for (const sg of filled) {
      // an Triolen-Schlaggrenzen schneiden
      const cuts = [sg.s];
      for (let b = 0; b <= mi.nBeats; b++) {
        const bt = b * mi.beatTicks;
        if (bt > sg.s && bt < sg.f && (tripBeats.has(b) || tripBeats.has(b - 1))) cuts.push(bt);
      }
      cuts.push(sg.f);
      const pieces = [];
      for (let c = 0; c < cuts.length - 1; c++) {
        const a = cuts[c];
        const f = cuts[c + 1];
        const beatIdx = Math.floor(a / mi.beatTicks);
        if (tripBeats.has(beatIdx)) {
          // Triolen-Werte: 16 (Viertel-), 8 (Achtel-), 4 (16tel-Triole)
          let p = a;
          while (p < f) {
            let d = f - p;
            if (d >= 16 && (p - beatIdx * mi.beatTicks) % 8 === 0) d = 16;
            else if (d >= 8) d = 8;
            else d = 4;
            if (p + d > f) d = f - p;
            const typ = TRIPLET_TYPES[d] || '16th';
            pieces.push({ start: p, dur: d, type: typ, dots: 0, tuplet: { actual: 3, normal: 2 }, beatIdx });
            p += d;
          }
        } else pieces.push(...splitDuration(a, f - a, mi, sg.kind === 'rest'));
      }
      pieces.forEach((pc, k) => {
        const item = { kind: sg.kind, ...pc };
        if (sg.kind === 'note') {
          item.ev = sg.ev;
          item.pitches = sg.ev.pitches;
          item.lofs = sg.ev.lofs;
          item.first = k === 0 && !sg.contFromPrev;
          item.last = k === pieces.length - 1 && !sg.contToNext;
          item.tieStop = k > 0 || sg.contFromPrev || (k === 0 && !!sg.ev._tiePrev);
          item.tieStart = k < pieces.length - 1 || sg.contToNext || (k === pieces.length - 1 && !!sg.ev._tieNext);
        }
        items.push(item);
      });
    }
    // Tuplet-Klammern: Start/Stop pro Triolen-Schlag
    const byBeat = new Map();
    for (const it of items) if (it.tuplet) {
      if (!byBeat.has(it.beatIdx)) byBeat.set(it.beatIdx, []);
      byBeat.get(it.beatIdx).push(it);
    }
    for (const list of byBeat.values()) {
      list[0].tuplet = { ...list[0].tuplet, start: true };
      list[list.length - 1].tuplet = { ...list[list.length - 1].tuplet, stop: true };
    }
    computeBeams(items, mi);
    measures.push(items);
  }
  return measures;
}

const BEAM_LEVELS = { eighth: 1, '16th': 2, '32nd': 3 };

export function computeBeams(items, mi) {
  // Gruppen: aufeinanderfolgende balkbare Noten im selben Schlag
  const groups = [];
  let cur = [];
  let curBeat = -1;
  for (const it of items) {
    const lvl = BEAM_LEVELS[it.type] || 0;
    const beat = Math.floor(it.start / mi.beatTicks);
    if (it.kind !== 'note' || !lvl) {
      if (cur.length) groups.push(cur);
      cur = [];
      curBeat = -1;
      continue;
    }
    if (beat !== curBeat && cur.length) {
      groups.push(cur);
      cur = [];
    }
    curBeat = beat;
    cur.push(it);
  }
  if (cur.length) groups.push(cur);
  // 4/4: zwei volle Achtel-Schläge in derselben Takthälfte verbinden
  const merged = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const n = groups[i + 1];
    const pureEighths = (x) => x.length === 2 && x.every((it) => it.type === 'eighth' && !it.dots && !it.tuplet) && x[0].start % mi.beatTicks === 0;
    if (mi.halfBar && n && pureEighths(g) && pureEighths(n) && Math.floor(g[0].start / mi.halfBar) === Math.floor(n[0].start / mi.halfBar) && n[0].start === g[1].start + g[1].dur) {
      merged.push([...g, ...n]);
      i++;
    } else merged.push(g);
  }
  for (const g of merged) {
    if (g.length < 2) continue;
    for (let L = 1; L <= 3; L++) {
      let k = 0;
      while (k < g.length) {
        if ((BEAM_LEVELS[g[k].type] || 0) < L) {
          k++;
          continue;
        }
        let j = k;
        while (j + 1 < g.length && (BEAM_LEVELS[g[j + 1].type] || 0) >= L) j++;
        if (!g[k].beams) g[k].beams = [];
        if (L === 1) {
          for (let x = k; x <= j; x++) {
            if (!g[x].beams) g[x].beams = [];
            g[x].beams.push(x === k ? 'begin' : x === j ? 'end' : 'continue');
          }
        } else if (j > k) {
          for (let x = k; x <= j; x++) {
            if (!g[x].beams) g[x].beams = [];
            g[x].beams.push(x === k ? 'begin' : x === j ? 'end' : 'continue');
          }
        } else {
          g[k].beams.push(k === 0 ? 'forward hook' : 'backward hook');
        }
        k = j + 1;
      }
    }
  }
}

// Größte Dauer <= maxDur, die an Position pos als EIN Notenwert notierbar ist
export function singleValueDur(pos, maxDur, mi, minDur = 0, allowDots = false) {
  for (const [ticks, , dots] of NOTE_VALUES) {
    if (ticks > maxDur || ticks < minDur) continue;
    if (dots && !allowDots) continue;
    const pieces = splitDuration(pos, ticks, mi, false);
    if (pieces.length === 1) return ticks;
  }
  return null;
}
