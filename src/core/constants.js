// Grundlegende Zeit-Konstanten der Engine.
// Alle Zeitangaben sind "Ticks"; DIV Ticks entsprechen einer Viertelnote.
// 24 erlaubt 32tel (3), 16tel (6), Achtel-Triolen (8) und 16tel-Triolen (4).
export const DIV = 24;

export const T = {
  WHOLE: 96,
  HALF_DOT: 72,
  HALF: 48,
  QUARTER_DOT: 36,
  QUARTER: 24,
  EIGHTH_DOT: 18,
  EIGHTH: 12,
  SIXTEENTH_DOT: 9,
  SIXTEENTH: 6,
  THIRTYSECOND: 3,
};

// Notierbare (binäre) Werte, absteigend. [ticks, type, dots]
export const NOTE_VALUES = [
  [144, 'whole', 1],
  [96, 'whole', 0],
  [72, 'half', 1],
  [48, 'half', 0],
  [36, 'quarter', 1],
  [24, 'quarter', 0],
  [18, 'eighth', 1],
  [12, 'eighth', 0],
  [9, '16th', 1],
  [6, '16th', 0],
  [3, '32nd', 0],
];

export const DYN_LEVELS = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];

export function dynIndex(d) {
  const i = DYN_LEVELS.indexOf(d);
  return i < 0 ? 3 : i;
}

export function dynShift(d, steps) {
  const i = Math.max(0, Math.min(DYN_LEVELS.length - 1, dynIndex(d) + steps));
  return DYN_LEVELS[i];
}

export function dynVelocity(d) {
  return [40, 52, 66, 80, 96, 112][dynIndex(d)];
}

export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

export function mod(n, m) {
  return ((n % m) + m) % m;
}
