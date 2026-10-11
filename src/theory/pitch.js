// Tonhöhen & Rechtschreibung über die Quintenreihe ("line of fifths", LOF).
// LOF: C=0, G=1, D=2 ... F=-1, Bb=-2 ...  Eine gespellte Note = {midi, lof}.
import { mod } from '../core/constants.js';

const LOF_LETTERS = 'FCGDAEB'; // LOF -1..5
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function lofLetter(lof) {
  return LOF_LETTERS[mod(lof + 1, 7)];
}
export function lofAlter(lof) {
  return Math.floor((lof + 1) / 7);
}
export function lofPc(lof) {
  return mod(lof * 7, 12);
}

// Name wie "Bb", "F#", "C"
export function lofName(lof, { unicode = false } = {}) {
  const a = lofAlter(lof);
  const acc = a > 0 ? (unicode ? '♯' : '#').repeat(a) : a < 0 ? (unicode ? '♭' : 'b').repeat(-a) : '';
  return lofLetter(lof) + acc;
}

// Deutscher Name (B = H, Bb = B)
export function lofNameDe(lof) {
  const letter = lofLetter(lof);
  const a = lofAlter(lof);
  if (letter === 'B') {
    if (a === 0) return 'H';
    if (a === -1) return 'B';
  }
  const base = letter;
  if (a > 0) return base + 'is'.repeat(a);
  if (a < 0) {
    if (base === 'E' || base === 'A') return base + 's' + 'es'.repeat(-a - 1);
    return base + 'es'.repeat(-a);
  }
  return base;
}

export function parseNoteName(name) {
  const m = /^([A-Ga-g])([#b♯♭]*)$/.exec(name.trim());
  if (!m) return null;
  const letter = m[1].toUpperCase();
  let alter = 0;
  for (const ch of m[2]) alter += ch === '#' || ch === '♯' ? 1 : -1;
  return letterAlterToLof(letter, alter);
}

export function letterAlterToLof(letter, alter) {
  return LOF_LETTERS.indexOf(letter) - 1 + 7 * alter;
}

// Für MusicXML: step/alter/octave
export function spelled(midi, lof) {
  const step = lofLetter(lof);
  const alter = lofAlter(lof);
  const octave = Math.floor((midi - alter - LETTER_PC[step]) / 12) - 1 + Math.floor(LETTER_PC[step] / 12);
  return { step, alter, octave };
}

export function stepAlterOctaveToMidi(step, alter, octave) {
  return (octave + 1) * 12 + LETTER_PC[step] + alter;
}

// Kandidat-LOF für eine Tonhöhenklasse, nahe einem Zentrum
export function lofNear(pc, center) {
  const base = mod(7 * pc, 12); // lof ≡ 7*pc (mod 12)
  let best = base;
  let bestD = Infinity;
  for (let k = -3; k <= 3; k++) {
    const l = base + 12 * k;
    // keine Doppel-Vorzeichen (Heses, Fisis …): lieber der enharmonisch einfache Ton
    if (l < -8 || l > 12) continue;
    const d = Math.abs(l - center);
    // Gleichstand -> b-Schreibung (kleinere LOF)
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) < 1e-9 && l < best)) {
      best = l;
      bestD = d;
    }
  }
  return best;
}

export function keyCenter(key) {
  return key.mode === 'minor' ? key.fifths + 3 : key.fifths + 2;
}

// Intervall in Halbtönen -> LOF-Verschiebung (für Transposition)
export function semisToLofDelta(semis, preferFlat = true) {
  const base = mod(7 * semis, 12); // 0..11
  const up = base;
  const down = base - 12;
  if (Math.abs(up) < Math.abs(down)) return up;
  if (Math.abs(down) < Math.abs(up)) return down;
  return preferFlat ? down : up;
}

// Tonart-Vorzeichen auf -6..+6 normalisieren (mit Tendenz zu b-Tonarten)
export function normalizeFifths(f, lo = -6, hi = 5) {
  let x = f;
  while (x > hi) x -= 12;
  while (x < lo) x += 12;
  return x;
}

export function midiName(midi, lof = null) {
  const l = lof ?? lofNear(mod(midi, 12), 0);
  const s = spelled(midi, l);
  return lofName(l) + s.octave;
}

// "C4", "Bb3", "F#5" -> midi
export function parseMidiName(s) {
  const m = /^([A-Ga-g][#b]*)(-?\d)$/.exec(s.trim());
  if (!m) throw new Error('Ungültiger Tonname: ' + s);
  const lof = parseNoteName(m[1]);
  return stepAlterOctaveToMidi(lofLetter(lof), lofAlter(lof), Number(m[2]));
}
