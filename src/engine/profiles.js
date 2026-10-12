// Instrumenten-Profile der Orchestrierungs-Engine.
//
// Jedes Profil trägt: absoluten Maximalbereich (klingend, MIDI), Sweet Spot, Schlüssel und die
// <transpose>-Angabe für MusicXML (diatonic/chromatic). Die Zahlen stammen aus der Vorgabe der
// Orchestrierungs-Direktive; wo sie dort gemischt notiert/klingend angegeben sind, ist die
// Lesart je Seite ausdrücklich festgehalten (`in`) und in klingende Tonhöhen umgerechnet:
//
//   Klarinette  E3–G6   beides notiert  -> klingend D3–F6
//   Altsax      Db3–F6  unten klingend (tiefstes notierte B ist Db3 klingend), oben notiert (F6 -> Ab5)
//   Tenorsax    Ab2–E5  klingend
//   Baritonsax  C2–Db5  klingend
//   Trompete    F#3–C6  notiert -> klingend E3–Bb5
//   Horn        F2–C6   unten klingend, oben notiert (C6 -> F5)
//   Posaune/Euph. E1–F4 klingend, Tenorschlüssel-Lage bis Bb4 (äußerste Höhe)
//   Tuba        D1–F3   klingend
//   Violine G3–E7, Bratsche C3–A6 (Altschlüssel), Cello C2–G4, Kontrabass E1–G3 klingend (eine Oktave
//   höher notiert), E-Bass wie Kontrabass notiert, Klavier A0–C8 (Doppelsystem G/F)
//
// Jedes weitere Instrument der Bibliothek bekommt ein Profil aus deren Umfang und Komfortbereich, damit
// auch ältere Besetzungen (Sousaphon, Tenorhorn …) in der Orchestrierung funktionieren.
//
// Das Gegenstück zur Bibliothek `src/arrange/instruments.js` (die dort für Schlüssel, MIDI-Programm,
// Kurzname und Effekte zuständig bleibt) – hier stehen nur die für die Orchestrierung maßgeblichen
// Bereiche. Die <transpose>-Tags werden aus den Bibliothekswerten abgeleitet und im Test gegen die
// Vorgabe geprüft.
import { INSTRUMENTS } from '../arrange/instruments.js';
import { parseMidiName } from '../theory/pitch.js';
import { mod } from '../core/constants.js';

const note = (name) => parseMidiName(name);

// low/high: Tonname; lowIn/highIn: 'sounding' | 'written'
const SPEC = {
  flute: { lib: 'flute', low: 'C4', high: 'D7', sweet: ['G4', 'G6'] },
  oboe: { lib: 'oboe', low: 'Bb3', high: 'G6' },
  clarinet: { lib: 'clarinet', low: 'E3', high: 'G6', lowIn: 'written', highIn: 'written' },
  bassClarinet: { lib: 'bassClarinet', low: 'E3', high: 'G6', lowIn: 'written', highIn: 'written', extra: true },
  altoSax: { lib: 'altoSax', low: 'Db3', high: 'F6', highIn: 'written' },
  tenorSax: { lib: 'tenorSax', low: 'Ab2', high: 'E5' },
  bariSax: { lib: 'bariSax', low: 'C2', high: 'Db5' },
  trumpet: { lib: 'trumpet', low: 'F#3', high: 'C6', lowIn: 'written', highIn: 'written' },
  flugelhorn: { lib: 'flugelhorn', low: 'F#3', high: 'C6', lowIn: 'written', highIn: 'written' },
  horn: { lib: 'horn', low: 'F2', high: 'C6', highIn: 'written' },
  trombone: { lib: 'trombone', low: 'E1', high: 'Bb4', sweet: ['E2', 'F4'] },
  euphonium: { lib: 'euphonium', low: 'E1', high: 'Bb4', sweet: ['E2', 'F4'] },
  bassTrombone: { lib: 'bassTrombone', low: 'E1', high: 'F4', extra: true },
  tuba: { lib: 'tuba', low: 'D1', high: 'F3' },
  // Streicher & Band
  violin: { lib: 'violin', low: 'G3', high: 'E7' },
  viola: { lib: 'viola', low: 'C3', high: 'A6' },
  cello: { lib: 'cello', low: 'C2', high: 'G4' },
  contrabass: { lib: 'contrabass', low: 'E1', high: 'G3' },
  ebass: { lib: 'ebass', low: 'E1', high: 'G4', sweet: ['E1', 'G3'] },
  piano: { lib: 'piano', low: 'A0', high: 'C8', sweet: ['C2', 'C6'] },
};

// <transpose> der Vorgabe (diatonic, chromatic) – zur Gegenprüfung
export const SPEC_TRANSPOSE = {
  flute: [0, 0],
  oboe: [0, 0],
  clarinet: [-1, -2],
  altoSax: [-5, -9],
  tenorSax: [-8, -14],
  bariSax: [-12, -21],
  trumpet: [-1, -2],
  flugelhorn: [-1, -2],
  horn: [-4, -7],
  trombone: [0, 0],
  euphonium: [0, 0],
  tuba: [0, 0],
};

function transposeTag(lib) {
  const t = lib.transpose || { semis: 0, lof: 0 };
  const steps = mod(4 * t.lof, 7) + 7 * Math.floor(t.semis / 12);
  return { diatonic: steps ? -steps : 0, chromatic: t.semis ? -t.semis : 0 };
}

function build(key, s) {
  const lib = INSTRUMENTS[s.lib];
  const tag = transposeTag(lib);
  const chrom = tag.chromatic; // klingend = notiert + chromatic
  const lo = note(s.low) + ((s.lowIn || 'sounding') === 'written' ? chrom : 0);
  const hi = note(s.high) + ((s.highIn || 'sounding') === 'written' ? chrom : 0);
  const range = [lo, hi];
  let sweet = s.sweet ? [note(s.sweet[0]), note(s.sweet[1])] : [Math.max(lo, lib.comfort[0]), Math.min(hi, lib.comfort[1])];
  // Sweet Spot immer innerhalb des absoluten Bereichs und mindestens eine Quinte breit
  sweet = [Math.max(lo, sweet[0]), Math.min(hi, sweet[1])];
  if (sweet[1] - sweet[0] < 7) sweet = [lo + 2, hi - 2];
  return {
    key,
    lib: s.lib,
    name: lib.name,
    short: lib.short,
    family: lib.family,
    clef: lib.clef,
    transpose: tag,
    range,
    sweet,
    breath: lib.breath,
    staves: lib.staves || 1,
    spec: { low: s.low, high: s.high, sweet: s.sweet || null, lowIn: s.lowIn || 'sounding', highIn: s.highIn || 'sounding' },
    extra: !!s.extra,
  };
}

export const PROFILES = Object.fromEntries(Object.entries(SPEC).map(([k, s]) => [k, build(k, s)]));

// Bibliotheksinstrumente ohne eigene Vorgabe (Kornett, Tenorhorn, Bariton, Sousaphon, Sopransax, Fagott …)
for (const [id, lib] of Object.entries(INSTRUMENTS)) {
  if (PROFILES[id]) continue;
  const tag = transposeTag(lib);
  PROFILES[id] = {
    key: id,
    lib: id,
    name: lib.name,
    short: lib.short,
    family: lib.family,
    clef: lib.clef,
    transpose: tag,
    range: [...lib.range],
    sweet: [Math.max(lib.range[0], lib.comfort[0]), Math.min(lib.range[1], lib.comfort[1])],
    breath: lib.breath,
    staves: lib.staves || 1,
    spec: null,
    extra: true,
  };
}

export function getProfile(key) {
  const p = PROFILES[key];
  if (!p) throw new Error('Unbekanntes Instrumentenprofil: ' + key);
  return p;
}

// Instrument im Format der Arrangement-Bibliothek (für Notensatz & MIDI), mit den Profilbereichen
export function profileInstrument(key) {
  const p = getProfile(key);
  const lib = INSTRUMENTS[p.lib];
  return { ...lib, range: [...p.range], comfort: [...p.sweet], profile: p };
}

export const inRange = (midi, p) => midi >= p.range[0] && midi <= p.range[1];

// Ton stufenweise (Oktave für Oktave) in den absoluten Bereich versetzen
export function fitPitch(midi, p) {
  let m = midi;
  let guard = 0;
  while (m > p.range[1] && guard++ < 12) m -= 12;
  while (m < p.range[0] && guard++ < 24) m += 12;
  return m;
}

// Oktavlage von midi, die einem Bezugston am nächsten liegt (und im Bereich) – bevorzugt den Sweet Spot
export function nearestOctave(midi, near, p) {
  let best = null;
  for (let k = -5; k <= 5; k++) {
    const m = midi + 12 * k;
    if (!inRange(m, p)) continue;
    let cost = Math.abs(m - near);
    if (m < p.sweet[0]) cost += (p.sweet[0] - m) * 0.8;
    if (m > p.sweet[1]) cost += (m - p.sweet[1]) * 0.8;
    if (!best || cost < best.cost) best = { m, cost };
  }
  return best ? best.m : fitPitch(midi, p);
}

// ---------------------------------------------------------------------------------------------
// Besetzungen 1..15 (Partituranordnung von oben nach unten).
// group: S = Sopran/Melodie-Register, AT = Alt/Tenor, BAR = Bariton, BASS = Bass (nur ab N = 9 benannt)
// role: lead | double8 (Oktavverdopplung nach oben) | doubleU (Unisono) | inner | counter | bass | bass8vb
const V = (profile, role, group = null) => ({ profile, role, group });

export const ENSEMBLES = {
  1: [V('trumpet', 'lead')],
  2: [V('trumpet', 'lead'), V('trombone', 'bass')],
  3: [V('trumpet', 'lead'), V('horn', 'counter'), V('trombone', 'bass')],
  4: [V('trumpet', 'lead'), V('horn', 'inner'), V('trombone', 'inner'), V('tuba', 'bass')],
  5: [V('trumpet', 'lead'), V('trumpet', 'inner'), V('horn', 'inner'), V('trombone', 'inner'), V('tuba', 'bass')],
  6: [V('trumpet', 'lead'), V('trumpet', 'inner'), V('horn', 'inner'), V('trombone', 'inner'), V('euphonium', 'inner'), V('tuba', 'bass')],
  7: [V('trumpet', 'lead'), V('trumpet', 'inner'), V('horn', 'inner'), V('horn', 'inner'), V('trombone', 'inner'), V('euphonium', 'inner'), V('tuba', 'bass')],
  8: [V('trumpet', 'lead'), V('trumpet', 'inner'), V('trumpet', 'inner'), V('horn', 'inner'), V('trombone', 'inner'), V('trombone', 'inner'), V('euphonium', 'inner'), V('tuba', 'bass')],
};

// Ab 9 Stimmen: vier Register-Schichten (group). Jede Stufe fügt der vorigen eine Stimme hinzu; die
// Reihenfolge der Liste ist die Wachstumsfolge. Die Partitur steht in der üblichen Ordnung
// Holz – Saxophone – Blech (`order`), die Schicht steckt in `group`.
const GROW = [
  { order: 8, ...V('trumpet', 'lead', 'S') },
  { order: 0, ...V('flute', 'double8', 'S') },
  { order: 2, ...V('clarinet', 'doubleU', 'S') },
  { order: 9, ...V('trumpet', 'inner', 'AT') },
  { order: 3, ...V('altoSax', 'inner', 'AT') },
  { order: 7, ...V('horn', 'inner', 'AT') },
  { order: 10, ...V('trombone', 'inner', 'BAR') },
  { order: 12, ...V('euphonium', 'counter', 'BAR') },
  { order: 14, ...V('tuba', 'bass', 'BASS') },
  { order: 6, ...V('bariSax', 'bass', 'BASS') },
  { order: 5, ...V('tenorSax', 'counter', 'BAR') },
  { order: 1, ...V('flute', 'doubleU', 'S') },
  { order: 4, ...V('altoSax', 'inner', 'AT') },
  { order: 11, ...V('trombone', 'inner', 'BAR') },
  { order: 13, ...V('bassTrombone', 'bass', 'BASS') },
];

// Schicht-Namen der Gruppen (für Partitur-Hinweise und Berichte)
export const GROUP_NAMES = { S: 'Sopran/Melodie', AT: 'Alt/Tenor', BAR: 'Bariton', BASS: 'Bass' };

for (let n = 9; n <= 15; n++) {
  const voices = GROW.slice(0, n)
    .sort((a, b) => a.order - b.order)
    .map(({ profile, role, group }) => V(profile, role, group));
  // Bass-Register: mit mehreren Stimmen spielt die tiefste die 8vb-Oktavierung, die übrigen das Fundament
  const bass = voices.filter((v) => v.group === 'BASS');
  if (bass.length > 1) {
    const lowest = bass.reduce((a, b) => (PROFILES[b.profile].range[0] < PROFILES[a.profile].range[0] ? b : a));
    lowest.role = 'bass8vb';
  }
  ENSEMBLES[n] = voices;
}

// Besetzung für N Stimmen; instruments: eigene Profil-Schlüssel (Länge N) – die Rollen bleiben
export function ensembleFor(n, instruments = null) {
  if (!Number.isInteger(n) || n < 1 || n > 15) throw new Error('Bitte 1 bis 15 Stimmen wählen');
  const base = ENSEMBLES[n].map((v) => ({ ...v }));
  if (!instruments) return base;
  if (!Array.isArray(instruments) || instruments.length !== n) throw new Error(`Die Besetzung braucht genau ${n} Instrumente`);
  return base.map((v, i) => ({ ...v, profile: getProfile(instruments[i]).key }));
}
