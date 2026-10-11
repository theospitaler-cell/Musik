// Instrumenten-Bibliothek: klingende Tonumfänge (MIDI), Kernbereich,
// Transposition (notiert = klingend + semis; lof = Quintenreihen-Verschiebung),
// Schlüssel, Atem-Kapazität (Sekunden), verfügbare Spezialeffekte.
//
// Transpositionen (Spielstimmen):
//   B-Instrumente (Trompete, Flügelhorn, Klarinette, Sopransax): große Sekunde höher
//   Tenorsax, Tenorhorn, Bariton (Violinschlüssel), Bassklarinette: große None höher
//   Es-Instrumente: Altsax große Sexte höher, Baritonsax große Sexte + Oktave höher
//   Horn in F: reine Quinte höher
//   Posaune, Euphonium, Tuba, Fagott, Cello: klingend im Bassschlüssel
//   Kontrabass / E-Bass: Oktave höher notiert
//
// Hinweis: Die Master-Direktive nennt für das Tenorsax "große Sekunde höher" –
// in der Praxis wird das Tenorsax eine große None (Sekunde + Oktave) höher notiert.
// Die Engine verwendet die korrekte, in allen Verlagsausgaben übliche Transposition.

export const FAMILIES = {
  brass: 'Blechbläser',
  sax: 'Saxophone',
  woodwind: 'Holzbläser',
  string: 'Streicher',
  rhythm: 'Rhythmus',
};

const I = (o) => ({
  clef: 'G2',
  highClef: null,
  transpose: { semis: 0, lof: 0 },
  breath: 10,
  fx: [],
  bassCapable: false,
  midiProgram: 56,
  ...o,
});

export const INSTRUMENTS = {
  trumpet: I({
    id: 'trumpet', name: 'Trompete in B', short: 'Trp.', family: 'brass',
    range: [54, 82], comfort: [57, 77], transpose: { semis: 2, lof: 2 }, breath: 9, midiProgram: 56,
    fx: ['falloff', 'doit', 'scoop', 'shake', 'plop', 'mute:Cup Mute', 'mute:Harmon Mute', 'mute:Straight Mute'],
  }),
  cornet: I({
    id: 'cornet', name: 'Kornett in B', short: 'Kor.', family: 'brass',
    range: [54, 80], comfort: [57, 76], transpose: { semis: 2, lof: 2 }, breath: 9, midiProgram: 56,
    fx: ['falloff', 'doit', 'scoop', 'shake', 'mute:Cup Mute'],
  }),
  flugelhorn: I({
    id: 'flugelhorn', name: 'Flügelhorn in B', short: 'Flhn.', family: 'brass',
    range: [52, 77], comfort: [55, 74], transpose: { semis: 2, lof: 2 }, breath: 9, midiProgram: 56,
    fx: ['falloff', 'scoop', 'doit'],
  }),
  horn: I({
    id: 'horn', name: 'Horn in F', short: 'Hn.', family: 'brass',
    range: [41, 77], comfort: [48, 72], transpose: { semis: 7, lof: 1 }, breath: 9, midiProgram: 60,
    fx: ['rip', 'stopped', 'scoop', 'falloff'],
  }),
  tenorhorn: I({
    id: 'tenorhorn', name: 'Tenorhorn in B', short: 'Thn.', family: 'brass',
    range: [40, 70], comfort: [45, 66], transpose: { semis: 14, lof: 2 }, breath: 9, midiProgram: 57, bassCapable: true,
    fx: ['falloff', 'scoop'],
  }),
  baritoneTC: I({
    id: 'baritoneTC', name: 'Bariton in B (Violinschl.)', short: 'Bar.', family: 'brass',
    range: [40, 70], comfort: [43, 66], transpose: { semis: 14, lof: 2 }, breath: 9, midiProgram: 57, bassCapable: true,
    fx: ['falloff', 'scoop'],
  }),
  euphonium: I({
    id: 'euphonium', name: 'Euphonium', short: 'Euph.', family: 'brass', clef: 'F4', highClef: 'C4',
    range: [40, 72], comfort: [43, 67], breath: 9, midiProgram: 57, bassCapable: true,
    fx: ['falloff', 'scoop'],
  }),
  trombone: I({
    id: 'trombone', name: 'Posaune', short: 'Pos.', family: 'brass', clef: 'F4', highClef: 'C4',
    range: [40, 72], comfort: [43, 67], breath: 8, midiProgram: 57, bassCapable: true,
    fx: ['gliss', 'falloff', 'doit', 'scoop', 'mute:Plunger', 'mute:Cup Mute', 'pedal'],
  }),
  bassTrombone: I({
    id: 'bassTrombone', name: 'Bassposaune', short: 'B.-Pos.', family: 'brass', clef: 'F4',
    range: [31, 67], comfort: [36, 62], breath: 7, midiProgram: 57, bassCapable: true,
    fx: ['gliss', 'falloff', 'pedal'],
  }),
  tuba: I({
    id: 'tuba', name: 'Tuba', short: 'Tb.', family: 'brass', clef: 'F4',
    range: [28, 60], comfort: [31, 55], breath: 6, midiProgram: 58, bassCapable: true,
    fx: ['falloff'],
  }),
  sousaphone: I({
    id: 'sousaphone', name: 'Sousaphon', short: 'Sous.', family: 'brass', clef: 'F4',
    range: [28, 60], comfort: [33, 55], breath: 6, midiProgram: 58, bassCapable: true,
    fx: ['falloff', 'scoop'],
  }),
  sopranoSax: I({
    id: 'sopranoSax', name: 'Sopransaxophon in B', short: 'S.-Sax', family: 'sax',
    range: [56, 87], comfort: [58, 82], transpose: { semis: 2, lof: 2 }, breath: 11, midiProgram: 64,
    fx: ['scoop', 'falloff', 'grace', 'bend'],
  }),
  altoSax: I({
    id: 'altoSax', name: 'Altsaxophon in Es', short: 'A.-Sax', family: 'sax',
    range: [49, 80], comfort: [51, 75], transpose: { semis: 9, lof: 3 }, breath: 11, midiProgram: 65,
    fx: ['scoop', 'falloff', 'doit', 'grace', 'bend', 'growl'],
  }),
  tenorSax: I({
    id: 'tenorSax', name: 'Tenorsaxophon in B', short: 'T.-Sax', family: 'sax',
    range: [44, 75], comfort: [46, 70], transpose: { semis: 14, lof: 2 }, breath: 11, midiProgram: 66, bassCapable: true,
    fx: ['scoop', 'falloff', 'doit', 'grace', 'bend', 'growl'],
  }),
  bariSax: I({
    id: 'bariSax', name: 'Baritonsaxophon in Es', short: 'Bar.-Sax', family: 'sax',
    range: [36, 68], comfort: [38, 63], transpose: { semis: 21, lof: 3 }, breath: 9, midiProgram: 67, bassCapable: true,
    fx: ['scoop', 'falloff', 'grace', 'growl'],
  }),
  clarinet: I({
    id: 'clarinet', name: 'Klarinette in B', short: 'Klar.', family: 'woodwind',
    range: [50, 91], comfort: [50, 84], transpose: { semis: 2, lof: 2 }, breath: 11, midiProgram: 71,
    fx: ['grace', 'scoop', 'gliss-up', 'trill'],
  }),
  bassClarinet: I({
    id: 'bassClarinet', name: 'Bassklarinette in B', short: 'B.-Klar.', family: 'woodwind',
    range: [34, 70], comfort: [38, 65], transpose: { semis: 14, lof: 2 }, breath: 9, midiProgram: 71, bassCapable: true,
    fx: ['grace'],
  }),
  flute: I({
    id: 'flute', name: 'Flöte', short: 'Fl.', family: 'woodwind',
    range: [60, 96], comfort: [62, 91], breath: 8, midiProgram: 73,
    fx: ['grace', 'trill', 'flutter'],
  }),
  oboe: I({
    id: 'oboe', name: 'Oboe', short: 'Ob.', family: 'woodwind',
    range: [58, 91], comfort: [60, 86], breath: 12, midiProgram: 68,
    fx: ['grace', 'trill'],
  }),
  bassoon: I({
    id: 'bassoon', name: 'Fagott', short: 'Fg.', family: 'woodwind', clef: 'F4', highClef: 'C4',
    range: [34, 75], comfort: [36, 67], breath: 10, midiProgram: 70, bassCapable: true,
    fx: ['grace', 'trill'],
  }),
  violin: I({
    id: 'violin', name: 'Violine', short: 'Vl.', family: 'string',
    range: [55, 100], comfort: [55, 88], breath: null, midiProgram: 40, strings: [55, 62, 69, 76],
    fx: ['pizz', 'bowing', 'doublestop', 'tremolo', 'mute:con sord.', 'gliss'],
  }),
  viola: I({
    id: 'viola', name: 'Viola', short: 'Va.', family: 'string', clef: 'C3', highClef: 'G2',
    range: [48, 88], comfort: [48, 79], breath: null, midiProgram: 41, strings: [48, 55, 62, 69],
    fx: ['pizz', 'bowing', 'doublestop', 'tremolo', 'mute:con sord.', 'gliss'],
  }),
  cello: I({
    id: 'cello', name: 'Violoncello', short: 'Vc.', family: 'string', clef: 'F4', highClef: 'C4',
    range: [36, 81], comfort: [36, 69], breath: null, midiProgram: 42, bassCapable: true, strings: [36, 43, 50, 57],
    fx: ['pizz', 'bowing', 'doublestop', 'tremolo', 'mute:con sord.', 'gliss'],
  }),
  contrabass: I({
    id: 'contrabass', name: 'Kontrabass', short: 'Kb.', family: 'string', clef: 'F4',
    range: [28, 67], comfort: [28, 55], transpose: { semis: 12, lof: 0 }, breath: null, midiProgram: 43, bassCapable: true, strings: [28, 33, 38, 43],
    fx: ['pizz', 'bowing'],
  }),
  ebass: I({
    id: 'ebass', name: 'E-Bass', short: 'E-B.', family: 'rhythm', clef: 'F4',
    range: [28, 67], comfort: [28, 55], transpose: { semis: 12, lof: 0 }, breath: null, midiProgram: 33, bassCapable: true,
    fx: ['ghost'],
  }),
};

export const DRUMS = {
  id: 'drums',
  name: 'Schlagzeug',
  short: 'Schlz.',
  family: 'rhythm',
};

export const PRESETS = [
  { id: 'brassfunk', name: 'Brass-Funk (Trp, Trp, Pos, Sousaphon)', voices: ['trumpet', 'trumpet', 'trombone', 'sousaphone'], style: 'funk' },
  { id: 'brass', name: 'Blechbläserquartett (Trp, Trp, Hn, Pos)', voices: ['trumpet', 'trumpet', 'horn', 'trombone'], style: 'funk' },
  { id: 'brasstuba', name: 'Brass mit Tuba (Trp, Hn, Pos, Tuba)', voices: ['trumpet', 'horn', 'trombone', 'tuba'], style: 'funk' },
  { id: 'blasmusik', name: 'Blasmusik (Flhn, Trp, Thn, Tuba)', voices: ['flugelhorn', 'trumpet', 'tenorhorn', 'tuba'], style: 'polka' },
  { id: 'jazz', name: 'Jazz-Gemischt (Trp, A-Sax, T-Sax, Pos)', voices: ['trumpet', 'altoSax', 'tenorSax', 'trombone'], style: 'swing' },
  { id: 'sax', name: 'Saxophonquartett (S, A, T, Bar)', voices: ['sopranoSax', 'altoSax', 'tenorSax', 'bariSax'], style: 'swing' },
  { id: 'strings', name: 'Streichquartett (Vl, Vl, Va, Vc)', voices: ['violin', 'violin', 'viola', 'cello'], style: 'classical' },
  { id: 'woodwind', name: 'Holzbläserquartett (Fl, Ob, Klar, Fg)', voices: ['flute', 'oboe', 'clarinet', 'bassoon'], style: 'classical' },
  // Konzertpartitur: Partiturordnung Holz – Blech – Streicher. "keep" = Reihenfolge, in der Stimmen
  // bei kleinerer Besetzung erhalten bleiben (erst Melodieträger und Fundament, dann die Farben).
  {
    id: 'orchestra',
    name: 'Kammerorchester (Fl, Ob, Klar, Fg, Hn, Trp, Pos, Tuba, Vl, Vl, Va, Vc, Kb)',
    voices: ['flute', 'oboe', 'clarinet', 'bassoon', 'horn', 'trumpet', 'trombone', 'tuba', 'violin', 'violin', 'viola', 'cello', 'contrabass'],
    keep: [8, 11, 0, 5, 10, 4, 12, 1, 6, 2, 9, 3, 7],
    style: 'classical',
    orchestra: true,
  },
];

export function getInstrument(id) {
  const inst = INSTRUMENTS[id];
  if (!inst) throw new Error('Unbekanntes Instrument: ' + id);
  return inst;
}

export function hasFx(inst, fx) {
  return inst.fx.some((f) => f === fx || f.startsWith(fx + ':'));
}

export function mutes(inst) {
  return inst.fx.filter((f) => f.startsWith('mute:')).map((f) => f.slice(5));
}

export function isWind(inst) {
  return inst.breath !== null && inst.breath !== undefined;
}

// Posaunen-Physik: Zugpositionen 1..7 = 0..6 Halbtöne unter dem Naturton.
// Ein Glissando ist nur auf EINEM Naturton (Teilton) ohne Positionsumkehr
// möglich, d. h. beide Töne müssen auf demselben Teilton liegen (max. Tritonus).
const TROMBONE_PARTIALS = [34, 46, 53, 58, 62, 65, 68, 70, 72, 74]; // B-Grundreihe (Bb1 Pedal, Bb2, F3, Bb3, D4, F4, As4, Bb4, C5, D5)
const BASS_TROMBONE_PARTIALS = [34, 46, 53, 58, 62, 65, 68, 70];

export function trombonePartialFor(midi, partials = TROMBONE_PARTIALS) {
  const out = [];
  for (const p of partials) {
    const pos = p - midi; // 0..6 -> Zugposition 1..7
    if (pos >= 0 && pos <= 6) out.push({ partial: p, position: pos + 1 });
  }
  return out;
}

export function slideGlissPossible(a, b, inst) {
  if (a === b) return false;
  const partials = inst.id === 'bassTrombone' ? BASS_TROMBONE_PARTIALS : TROMBONE_PARTIALS;
  const pa = trombonePartialFor(a, partials);
  const pb = trombonePartialFor(b, partials);
  return pa.some((x) => pb.some((y) => y.partial === x.partial));
}

// Streicher-Doppelgriff: beide Töne auf benachbarten Saiten in tiefer Lage spielbar?
export function doubleStopPossible(lo, hi, inst) {
  if (!inst.strings || hi <= lo) return false;
  const iv = hi - lo;
  if (iv < 3 || iv > 12) return false;
  const s = inst.strings;
  for (let k = 0; k < s.length - 1; k++) {
    const okLo = lo >= s[k] && lo <= s[k] + 7;
    const okHi = hi >= s[k + 1] && hi <= s[k + 1] + 7;
    if (okLo && okHi) return true;
  }
  return false;
}

// Bestes Oktav-Verschieben einer Linie für ein Instrument
export function fitOctave(notes, inst, { allowClimax = false, prefer = 0 } = {}) {
  if (!notes.length) return { shift: 0, penalty: 0, outOfRange: 0 };
  let best = null;
  const [clo, chi] = inst.comfort;
  const [rlo, rhi] = inst.range;
  const topLimit = allowClimax ? rhi : Math.min(rhi, chi + 2);
  for (let k = -4; k <= 4; k++) {
    const sh = k * 12;
    let pen = 0;
    let out = 0;
    let total = 0;
    for (const n of notes) {
      const m = n.midi + sh;
      const w = Math.max(1, n.dur / 12);
      total += w;
      if (m < rlo || m > rhi) {
        out++;
        pen += 50 * w;
      } else if (m < clo) pen += (clo - m) * 1.5 * w;
      else if (m > topLimit) pen += (m - topLimit) * 2 * w;
      else if (m > chi) pen += (m - chi) * 0.6 * w;
    }
    pen = pen / total + Math.abs(k - prefer) * 0.01;
    if (!best || pen < best.penalty) best = { shift: sh, penalty: pen, outOfRange: out };
  }
  return best;
}

// Eigener Tonumfang (notierte Tonhöhe, wie der Spieler liest) -> Instrument-Kopie.
// r = {lo, hi} (MIDI, notiert) – null/undefined = automatisch
export function withRange(inst, r) {
  if (!r || ((r.lo === null || r.lo === undefined) && (r.hi === null || r.hi === undefined))) return inst;
  const semis = inst.transpose.semis;
  let lo = r.lo === null || r.lo === undefined ? inst.range[0] : r.lo - semis;
  let hi = r.hi === null || r.hi === undefined ? inst.range[1] : r.hi - semis;
  if (hi < lo) [lo, hi] = [hi, lo];
  // mindestens eine Oktave, damit Oktavierungen immer passen
  if (hi - lo < 12) {
    if (r.hi === null || r.hi === undefined) hi = lo + 12;
    else lo = hi - 12;
  }
  let comfort = [Math.max(inst.comfort[0], lo), Math.min(inst.comfort[1], hi)];
  if (comfort[1] - comfort[0] < 9) comfort = [lo + Math.min(2, (hi - lo) / 6), hi - Math.min(2, (hi - lo) / 6)].map(Math.round);
  return { ...inst, range: [lo, hi], comfort, customRange: { lo: r.lo ?? null, hi: r.hi ?? null } };
}

// Auswahlbereich für die Oberfläche (notiert): etwas über den Standard hinaus
export function writtenRangeChoices(inst) {
  const s = inst.transpose.semis;
  return { min: inst.range[0] + s - 3, max: inst.range[1] + s + 4, defLo: inst.range[0] + s, defHi: inst.range[1] + s };
}
