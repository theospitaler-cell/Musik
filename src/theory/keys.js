// Tonarten: Darstellung, Parsing, Erkennung (Krumhansl-Schmuckler).
import { mod } from '../core/constants.js';
import { parseNoteName, lofPc, lofName, lofNameDe, semisToLofDelta, normalizeFifths } from './pitch.js';

// key = {fifths, mode: 'major'|'minor', tonicPc, tonicLof}
export function makeKey(fifths, mode = 'major') {
  const tonicLof = mode === 'minor' ? fifths + 3 : fifths;
  return { fifths, mode, tonicLof, tonicPc: lofPc(tonicLof) };
}

export function keyFromName(name) {
  const m = /^\s*([A-Ga-g][#b♯♭]?)\s*(m|min|minor|moll|-)?\s*$/i.exec(name);
  if (!m) return null;
  const lof = parseNoteName(m[1][0].toUpperCase() + m[1].slice(1).replace('♯', '#').replace('♭', 'b'));
  const minor = !!m[2];
  const fifths = minor ? lof - 3 : lof;
  return makeKey(fifths, minor ? 'minor' : 'major');
}

export function keyName(key) {
  return lofName(key.tonicLof) + (key.mode === 'minor' ? 'm' : '');
}

export function keyNameDe(key) {
  const n = lofNameDe(key.tonicLof);
  return key.mode === 'minor' ? n.toLowerCase() + '-Moll' : n + '-Dur';
}

export function transposeKey(key, semis) {
  if (!semis) return key;
  const d = semisToLofDelta(semis);
  let f = key.fifths + d;
  f = normalizeFifths(f, key.mode === 'minor' ? -6 : -6, key.mode === 'minor' ? 6 : 5);
  return makeKey(f, key.mode);
}

export function scalePcs(key) {
  const steps = key.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return steps.map((s) => mod(key.tonicPc + s, 12));
}

// Krumhansl-Kessler-Profile
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// notes: [{midi, dur}] ; optional finalPc (letzter Ton) als Hinweis
export function detectKey(notes, { finalPc = null, bassFinalPc = null } = {}) {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[mod(n.midi, 12)] += n.dur || 1;
  let best = null;
  for (let pc = 0; pc < 12; pc++) {
    for (const mode of ['major', 'minor']) {
      const prof = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const rot = prof.map((_, i) => prof[mod(i - pc, 12)]);
      let score = correlate(hist, rot);
      if (finalPc === pc) score += 0.08;
      if (bassFinalPc === pc) score += 0.1;
      if (!best || score > best.score) best = { pc, mode, score };
    }
  }
  if (!best) return makeKey(0, 'major');
  // Vorzeichen bestimmen: bevorzugt übliche Schreibweise
  const tonicLof = pcToKeyLof(best.pc, best.mode);
  const fifths = best.mode === 'minor' ? tonicLof - 3 : tonicLof;
  return makeKey(fifths, best.mode);
}

function pcToKeyLof(pc, mode) {
  // Dur: Gb(-6)..B(5) ; Moll: eb(-6)..g#(5+3)
  const base = mod(7 * pc, 12);
  const cands = [base - 12, base, base + 12];
  let best = cands[0];
  for (const l of cands) {
    const f = mode === 'minor' ? l - 3 : l;
    if (f >= -6 && f <= 6) {
      const bf = mode === 'minor' ? best - 3 : best;
      if (!(bf >= -6 && bf <= 6) || Math.abs(f) < Math.abs(bf)) best = l;
    }
  }
  return best;
}

export function keyFromPc(pc, mode) {
  const tonicLof = pcToKeyLof(pc, mode);
  return makeKey(mode === 'minor' ? tonicLof - 3 : tonicLof, mode);
}
