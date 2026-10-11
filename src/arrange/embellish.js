// Schwierigkeit nach oben: Verzierungen, Läufe & Sprünge, die im Original nicht stehen.
// Die Originaltöne behalten ihre Einsätze (wichtig fürs Playback) – Verzierungen entstehen
// nur, indem lange Töne verkürzt und Pausen gefüllt werden.
//   Mittel (3):          vereinzelt Durchgangstöne und Auftakt-Achtel in neue Phrasen
//   Fortgeschritten (4): Durchgangstöne zwischen langen Tönen, Auftakt-Läufe (Achtel),
//                        Sprünge mit Durchgangston, Vorschlagsnoten auf Phrasen-Höhepunkten
//   Profi (5):           16tel-Läufe & Doppelschläge, Pausen mit Läufen/Arpeggien gefüllt,
//                        Oktavsprünge auf Höhepunkten, Triller/Shakes auf langen hohen Tönen,
//                        dazu: Läufe am Ende schon ab einem Schlag, kurze Lücken (ab zwei
//                        Sechzehnteln) werden mit einem Lauf auf den nächsten Ton gefüllt
import { mod } from '../core/constants.js';
import { chordAt } from '../model/song.js';
import { chordScale } from '../theory/chords.js';
import { scaleStep, cleanLine } from './context.js';

const EMBELLISH_ROLES = new Set(['melody', 'hook', 'counter', 'fill']);

function mk(e, start, dur, midi) {
  return { ...e, start, dur, pitches: [midi], lofs: [null], art: [], fx: [], grace: null, orn: null, fermata: false, finalHold: false, slurStart: false, slurEnd: false, tieFromPrev: false, embellish: true };
}

// Tonleiterschritte von a Richtung b (ohne b), höchstens n Töne, endend direkt vor b
function stepsToward(a, b, n, scale) {
  const out = [];
  const dir = b > a ? 1 : -1;
  let m = b;
  for (let k = 0; k < n; k++) {
    m = scaleStep(m, -dir, scale);
    if ((dir > 0 && m <= a) || (dir < 0 && m >= a)) break;
    out.unshift(m);
  }
  return out;
}

export function embellishLine(events, lv, { chordTrack, keyAt, inst, style, mt, beat, rng }) {
  if (!lv || lv < 3 || !events.length) return events;
  const pro = lv >= 5;
  const mid = lv === 3;
  // Wahrscheinlichkeiten je Stufe
  const P = mid ? { pass: 0.5, pickup: 0.5, grace: 0, leap: 0 } : pro ? { pass: 0.95, pickup: 0.9, grace: 0.6, leap: 0.8 } : { pass: 0.8, pickup: 0.8, grace: 0.8, leap: 0.7 };
  const lo = pro ? inst.range[0] + 1 : inst.comfort[0];
  const hi = pro ? inst.range[1] - 1 : Math.min(inst.range[1] - 1, inst.comfort[1] + 2);
  const inRange = (m) => m >= lo && m <= hi;
  const scaleAt = (t) => chordScale(chordAt(chordTrack, t), keyAt(t));
  const unit = pro ? 6 : 12; // 16tel bzw. Achtel
  const jazzy = ['funk', 'secondline', 'swing'].includes(style.id);
  const src = [...events].sort((a, b) => a.start - b.start);
  const out = [];
  // Phrasen-Höhepunkte (höchster Ton je Phrase)
  const peaks = new Set();
  let ph = [];
  const flush = () => {
    if (ph.length >= 3) peaks.add(ph.reduce((a, b) => (b.pitches[0] > a.pitches[0] ? b : a), ph[0]));
    ph = [];
  };
  src.forEach((e, i) => {
    const p = src[i - 1];
    if (p && e.start - (p.start + p.dur) >= beat) flush();
    ph.push(e);
  });
  flush();

  for (let i = 0; i < src.length; i++) {
    const e = { ...src[i], art: [...src[i].art], fx: [...src[i].fx] };
    const n = src[i + 1];
    const ok = EMBELLISH_ROLES.has(e.role) && e.pitches.length === 1 && e.start % 6 === 0 && e.dur % 6 === 0 && !e.fermata && !e.finalHold;
    out.push(e);
    if (!ok) continue;
    const m = e.pitches[0];
    const end = e.start + e.dur;
    const scale = scaleAt(e.start);
    // Vorschlag / Oktavsprung / Triller auf dem Phrasen-Höhepunkt
    if (peaks.has(src[i]) && e.dur >= beat) {
      if (pro && e.dur >= 2 * beat && inRange(m + 12) && rng.chance(0.45)) {
        // Oktavsprung: erste Hälfte original, zweite Hälfte eine Oktave höher
        const h = Math.floor(e.dur / 2 / 6) * 6;
        e.dur = h;
        out.push(mk(e, e.start + h, end - e.start - h, m + 12));
        continue;
      }
      if (!e.grace && P.grace && rng.chance(P.grace)) e.grace = { midi: scaleStep(m, 1, scale), lof: null, slash: true };
      if (pro && e.dur >= 2 * beat && m >= inst.comfort[1] - 5 && rng.chance(0.5)) e.orn = [jazzy && inst.family !== 'string' ? 'shake' : 'trill'];
    }
    if (!n) continue;
    const gap = n.start - end;
    const target = n.pitches[0];
    // 1) lange Töne: Durchgang / Lauf zum nächsten Ton (Original-Einsatz bleibt)
    if (gap === 0 && (e.dur >= 2 * beat || (pro && e.dur >= beat)) && !e.orn && rng.chance(P.pass)) {
      const count = Math.round(beat / unit);
      let fig = stepsToward(m, target, count, scaleAt(end - beat));
      if (Math.abs(target - m) <= 2 && pro) {
        // Doppelschlag um den Haltetön
        const up = scaleStep(m, 1, scale);
        const dn = scaleStep(m, -1, scale);
        fig = [up, m, dn, m].slice(0, count);
      }
      fig = fig.filter(inRange);
      // der Ton behält mindestens eine Sechzehntel (sonst würde der Lauf den ganzen Ton ersetzen)
      if (fig.length >= 2 && e.dur - fig.length * unit >= unit) {
        const figStart = end - fig.length * unit;
        e.dur = figStart - e.start;
        fig.forEach((f, k) => out.push(mk(e, figStart + k * unit, unit, f)));
        continue;
      }
    }
    // 2) Töne vor einem Sprung: Durchgangston (Achtel) bzw. kurzer 16tel-Lauf überbrückt ihn
    if (P.leap && gap === 0 && e.dur >= beat && e.dur < 2 * beat && Math.abs(target - m) >= (pro ? 5 : 4) && rng.chance(P.leap)) {
      const nFig = pro ? 2 : 1;
      const u = pro ? 6 : 12;
      const fig = stepsToward(m, target, nFig, scaleAt(end - nFig * u)).filter(inRange);
      if (fig.length === nFig) {
        e.dur -= nFig * u;
        fig.forEach((f, k) => out.push(mk(e, end - nFig * u + k * u, u, f)));
        continue;
      }
    }
    // 2b) Profi: kurze Lücke (zwei bis drei Sechzehntel) wird mit einem Lauf auf den nächsten Ton gefüllt
    if (pro && gap >= 2 * unit && gap < beat && rng.chance(0.6)) {
      const count = Math.floor(gap / unit);
      const sc = scaleAt(n.start - count * unit);
      let fig = [];
      let x = target;
      for (let k = 0; k < count; k++) {
        x = scaleStep(x, -1, sc);
        fig.unshift(x);
      }
      fig = fig.filter(inRange);
      if (fig.length >= 2) {
        const s0 = n.start - fig.length * unit;
        if (s0 >= end) fig.forEach((g, k) => out.push(mk(e, s0 + k * unit, unit, g)));
      }
    }
    // 3) Pausen: Auftakt-Lauf in die nächste Phrase (bzw. Profi: Lauf/Arpeggio über die Pause)
    if (gap >= beat) {
      const len = pro ? (gap >= 2 * beat ? beat : beat / 2) : beat;
      if (len >= 12 && rng.chance(P.pickup)) {
        const count = Math.round(len / unit);
        const sc = scaleAt(n.start - len);
        let fig;
        if (pro && gap >= 2 * beat && rng.chance(0.4)) {
          // Arpeggio des kommenden Akkords hinauf zum Zielton
          const ch = chordAt(chordTrack, n.start);
          const pcs = ch.tones.map((t) => t.pc);
          fig = [];
          let x = target;
          for (let k = 0; k < count; k++) {
            x -= 1;
            while (!pcs.includes(mod(x, 12))) x -= 1;
            fig.unshift(x);
          }
        } else {
          // von unten stufenweise auf den Zielton zu
          fig = [];
          let x = target;
          for (let k = 0; k < count; k++) {
            x = scaleStep(x, -1, sc);
            fig.unshift(x);
          }
        }
        fig = fig.filter(inRange);
        if (fig.length >= 2) {
          const s0 = n.start - fig.length * unit;
          if (s0 >= end) fig.forEach((f, k) => out.push(mk(e, s0 + k * unit, unit, f)));
        }
      }
    }
  }
  const line = cleanLine(out);
  void mt;
  return line;
}
