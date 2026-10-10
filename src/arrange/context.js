// Hilfsfunktionen für die Stimmgeneratoren: Akkordtöne in Lage finden,
// Skalenschritte, Melodie-Aktivität, Ereignis-Container.
import { DIV, mod, clamp } from '../core/constants.js';
import { chordScale, guideTones, colorTones, toneByRole } from '../theory/chords.js';
import { lofNear, keyCenter } from '../theory/pitch.js';
import { chordAt, chordSegmentAt } from '../model/song.js';

// ---------- Ereignisse ---------------------------------------------------
// ev = {start, dur, pitches:[midi], lofs:[lof], art:[], fx:[], grace:null, slurStart, slurEnd, tieHint}
export function ev(start, dur, midi, lof = null, extra = {}) {
  const pitches = Array.isArray(midi) ? midi : [midi];
  const lofs = Array.isArray(lof) ? lof : [lof];
  return { start, dur, pitches, lofs, art: [], fx: [], ...extra };
}

export function addArt(e, a) {
  if (e && !e.art.includes(a)) e.art.push(a);
  return e;
}
export function addFx(e, f) {
  if (e && !e.fx.includes(f)) e.fx.push(f);
  return e;
}

// Monophone Folge sicherstellen (Überlappungen kürzen), sortieren
export function cleanLine(events) {
  const s = events.filter((e) => e && e.dur > 0 && e.pitches.length).sort((a, b) => a.start - b.start);
  const out = [];
  for (const e of s) {
    const prev = out[out.length - 1];
    if (prev && prev.start === e.start) {
      out[out.length - 1] = e;
      continue;
    }
    if (prev && prev.start + prev.dur > e.start) prev.dur = e.start - prev.start;
    out.push(e);
  }
  return out.filter((e) => e.dur > 0);
}

export function lineEnd(events) {
  return events.length ? Math.max(...events.map((e) => e.start + e.dur)) : 0;
}

export function shiftEvents(events, dt) {
  return events.map((e) => ({ ...e, start: e.start + dt, art: [...e.art], fx: [...e.fx] }));
}

// ---------- Tonhöhen ----------------------------------------------------
// pc in Oktavlage nahe "near", innerhalb [lo, hi]
export function placePc(pc, near, lo, hi) {
  let best = null;
  for (let m = lo; m <= hi; m++) {
    if (mod(m, 12) !== pc) continue;
    const d = Math.abs(m - near);
    if (best === null || d < Math.abs(best - near)) best = m;
  }
  if (best === null) {
    // außerhalb -> nächstliegende Oktave trotzdem
    let m = near - mod(near - pc, 12);
    if (Math.abs(m + 12 - near) < Math.abs(m - near)) m += 12;
    best = m;
  }
  return best;
}

// Akkordton nahe target; opts: roles (Reihenfolge = Präferenz), avoidPcs, withColor, styleId
export function chordToneNear(chord, target, lo, hi, opts = {}) {
  const { roles = null, avoidPcs = [], withColor = false, styleId = 'funk', maxLeap = 99, exclude = [] } = opts;
  let tones = [...chord.tones];
  if (withColor) tones = tones.concat(colorTones(chord, styleId));
  if (roles) tones = tones.filter((t) => roles.includes(t.role) || (t.role === 'tension' && roles.includes('tension')));
  if (!tones.length) tones = [...chord.tones];
  let best = null;
  for (const t of tones) {
    for (let m = lo; m <= hi; m++) {
      if (mod(m, 12) !== t.pc) continue;
      if (exclude.includes(m)) continue;
      let cost = Math.abs(m - target);
      if (cost > maxLeap) cost += 20;
      if (avoidPcs.includes(t.pc)) cost += 5;
      if (roles) cost += roles.indexOf(t.role) >= 0 ? roles.indexOf(t.role) * 0.6 : 1.5;
      if (!best || cost < best.cost) best = { midi: m, lof: t.lof, role: t.role, cost };
    }
  }
  if (!best) {
    const t = tones[0];
    const m = placePc(t.pc, target, lo, hi);
    best = { midi: m, lof: t.lof, role: t.role, cost: 99 };
  }
  return best;
}

export function lofForChordPc(chord, pc, key) {
  if (chord) {
    const t = [...chord.tones, ...chord.tens].find((x) => x.pc === pc);
    if (t) return t.lof;
    const c = colorTones(chord, 'funk').find((x) => x.pc === pc);
    if (c) return c.lof;
  }
  return lofNear(pc, keyCenter(key));
}

// Nächster Skalenton (dir=+1/-1) in der Akkordskala
export function scaleStep(midi, dir, scale) {
  let m = midi + dir;
  for (let k = 0; k < 12; k++, m += dir) if (scale.includes(mod(m, 12))) return m;
  return midi + dir;
}

export function scaleFor(chord, key) {
  return chordScale(chord, key);
}

export function isChordTone(chord, midi) {
  return chord && chord.tones.some((t) => t.pc === mod(midi, 12));
}

export function rootNear(chord, near, lo, hi) {
  const pc = chord.bassPc ?? chord.rootPc;
  const lof = chord.bassLof ?? chord.rootLof;
  return { midi: placePc(pc, near, lo, hi), lof };
}

export function guideNear(chord, near, lo, hi, avoidPcs = []) {
  const g = guideTones(chord);
  let best = null;
  for (const t of g) {
    const m = placePc(t.pc, near, lo, hi);
    const cost = Math.abs(m - near) + (avoidPcs.includes(t.pc) ? 4 : 0);
    if (!best || cost < best.cost) best = { midi: m, lof: t.lof, cost, role: t.role };
  }
  return best;
}

export function fifthOf(chord) {
  return toneByRole(chord, 'fifth');
}

// ---------- Block-Kontext ----------------------------------------------
export class BlockCtx {
  constructor({ style, rng, key, meter, measures, chords, tempo, inst, block, intensity = 0.5, songMotif = null, prevState }) {
    this.style = style;
    this.rng = rng;
    this.key = key;
    this.meter = meter;
    this.mt = (meter.beats * DIV * 4) / meter.beatType;
    this.compound = meter.beatType === 8 && meter.beats % 3 === 0 && meter.beats > 3;
    this.beat = this.compound ? (DIV * 3) / 2 : (DIV * 4) / meter.beatType;
    this.steps = this.mt / 6; // 16tel pro Takt
    this.mi = { measureTicks: this.mt, beatTicks: this.beat, nBeats: Math.round(this.mt / this.beat), compound: this.compound, halfBar: Math.round(this.mt / this.beat) === 4 ? this.mt / 2 : null, triple: !this.compound && Math.round(this.mt / this.beat) === 3 };
    this.measures = measures;
    this.len = measures * this.mt;
    this.chords = chords;
    this.tempo = tempo;
    this.inst = inst;
    this.block = block;
    this.intensity = intensity;
    this.songMotif = songMotif;
    this.prev = prevState; // [{last: midi}] pro Stimme
    this.lines = [[], [], [], []]; // generierte Ereignisse (blockrelativ)
    this.melodyLine = null; // Ereignisse der Führungsstimme
  }
  chordAt(t) {
    return chordAt(this.chords, clamp(t, 0, this.len - 1));
  }
  segAt(t) {
    return chordSegmentAt(this.chords, t);
  }
  // Akkordwechsel-Zeitpunkte
  changes() {
    return this.chords.map((c) => c.start);
  }
  scaleAt(t) {
    return chordScale(this.chordAt(t), this.key);
  }
  secPerTick() {
    return 60 / this.tempo / DIV;
  }
  lastPitch(v, def) {
    return this.prev[v]?.last ?? def;
  }
  setLast(v, m) {
    if (!this.prev[v]) this.prev[v] = {};
    this.prev[v].last = m;
  }
}

// Wo pausiert/hält die Melodie? -> Fenster [a,b) für Fill-Ins
export function melodyGaps(melody, len, beat, minLen = null) {
  const min = minLen ?? beat * 1.5;
  const gaps = [];
  const s = [...melody].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (let i = 0; i <= s.length; i++) {
    const n = s[i];
    const nextStart = n ? n.start : len;
    // Lücke (Pause)
    if (nextStart - cursor >= min) gaps.push({ a: cursor, b: nextStart, kind: 'rest' });
    if (!n) break;
    // gehaltener Ton: Fenster ab einer Zählzeit nach Anschlag
    const holdFrom = n.start + beat;
    const end = n.start + n.dur;
    const nx = s[i + 1] ? s[i + 1].start : len;
    if (end - holdFrom >= min * 0.67 && n.dur >= beat * 2) gaps.push({ a: holdFrom, b: Math.min(end, nx), kind: 'hold', pitch: n.pitches ? n.pitches[0] : n.midi });
    cursor = Math.max(cursor, end);
  }
  return gaps.filter((g) => g.b - g.a >= beat);
}

// Melodie-Ton zum Zeitpunkt t (klingend)
export function soundingAt(line, t) {
  for (const e of line) if (e.start <= t && e.start + e.dur > t) return e.pitches[0];
  return null;
}

export function attacksIn(line, a, b) {
  return line.filter((e) => e.start >= a && e.start < b);
}

// Bewegungsrichtung der Melodie in [a,b)
export function melodyDirection(line, a, b) {
  const ns = line.filter((e) => e.start >= a - 1 && e.start < b);
  if (ns.length < 2) return 0;
  return Math.sign(ns[ns.length - 1].pitches[0] - ns[0].pitches[0]);
}
