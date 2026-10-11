// Akkordsymbole parsen, Akkordtöne & Skalen ableiten.
import { mod } from '../core/constants.js';
import { lofPc, parseNoteName, lofName, semisToLofDelta } from './pitch.js';

// Intervall-Tabelle: Halbtöne -> LOF-Offset (für korrekte Schreibung)
export const IV = {
  1: [0, 0],
  b2: [1, -5],
  2: [2, 2],
  '#2': [3, 9],
  b3: [3, -3],
  3: [4, 4],
  4: [5, -1],
  '#4': [6, 6],
  b5: [6, -6],
  5: [7, 1],
  '#5': [8, 8],
  b6: [8, -4],
  6: [9, 3],
  bb7: [9, -9],
  b7: [10, -2],
  7: [11, 5],
  b9: [1, -5],
  9: [2, 2],
  '#9': [3, 9],
  11: [5, -1],
  '#11': [6, 6],
  b13: [8, -4],
  13: [9, 3],
};

// Akkordarten: Grundtöne (role-Namen) + MusicXML-kind
const KINDS = {
  major: { tones: [['1', 'root'], ['3', 'third'], ['5', 'fifth']], xml: 'major', text: '' },
  minor: { tones: [['1', 'root'], ['b3', 'third'], ['5', 'fifth']], xml: 'minor', text: 'm' },
  augmented: { tones: [['1', 'root'], ['3', 'third'], ['#5', 'fifth']], xml: 'augmented', text: '+' },
  diminished: { tones: [['1', 'root'], ['b3', 'third'], ['b5', 'fifth']], xml: 'diminished', text: 'dim' },
  dominant: { tones: [['1', 'root'], ['3', 'third'], ['5', 'fifth'], ['b7', 'seventh']], xml: 'dominant', text: '7' },
  'major-seventh': { tones: [['1', 'root'], ['3', 'third'], ['5', 'fifth'], ['7', 'seventh']], xml: 'major-seventh', text: 'maj7' },
  'minor-seventh': { tones: [['1', 'root'], ['b3', 'third'], ['5', 'fifth'], ['b7', 'seventh']], xml: 'minor-seventh', text: 'm7' },
  'diminished-seventh': { tones: [['1', 'root'], ['b3', 'third'], ['b5', 'fifth'], ['bb7', 'seventh']], xml: 'diminished-seventh', text: 'dim7' },
  'augmented-seventh': { tones: [['1', 'root'], ['3', 'third'], ['#5', 'fifth'], ['b7', 'seventh']], xml: 'augmented-seventh', text: '7#5' },
  'half-diminished': { tones: [['1', 'root'], ['b3', 'third'], ['b5', 'fifth'], ['b7', 'seventh']], xml: 'half-diminished', text: 'm7b5' },
  'major-minor': { tones: [['1', 'root'], ['b3', 'third'], ['5', 'fifth'], ['7', 'seventh']], xml: 'major-minor', text: 'm(maj7)' },
  'major-sixth': { tones: [['1', 'root'], ['3', 'third'], ['5', 'fifth'], ['6', 'seventh']], xml: 'major-sixth', text: '6' },
  'minor-sixth': { tones: [['1', 'root'], ['b3', 'third'], ['5', 'fifth'], ['6', 'seventh']], xml: 'minor-sixth', text: 'm6' },
  'suspended-fourth': { tones: [['1', 'root'], ['4', 'third'], ['5', 'fifth']], xml: 'suspended-fourth', text: 'sus4' },
  'suspended-second': { tones: [['1', 'root'], ['2', 'third'], ['5', 'fifth']], xml: 'suspended-second', text: 'sus2' },
  'dominant-sus': { tones: [['1', 'root'], ['4', 'third'], ['5', 'fifth'], ['b7', 'seventh']], xml: 'suspended-fourth', text: '7sus4' },
  power: { tones: [['1', 'root'], ['5', 'fifth']], xml: 'power', text: '5' },
};

// Reihenfolge wichtig: längere Muster zuerst
const QUALITY_PATTERNS = [
  [/^(m7b5|min7b5|-7b5|ø7?|m7\(b5\))/, 'half-diminished'],
  [/^(m\(maj7\)|mmaj7|m\(ma7\)|-maj7|mM7|minmaj7|m\(M7\))/, 'major-minor'],
  [/^(maj7|ma7|M7|Δ7?|j7|\^7|maj)/, 'major-seventh', (rest, q) => (q === 'maj' && !/^7/.test(rest) ? 'major' : null)],
  [/^(maj9|ma9|M9|Δ9|j9)/, 'major-seventh', null, ['9']],
  [/^(m9|min9|-9)/, 'minor-seventh', null, ['9']],
  [/^(m11|min11|-11)/, 'minor-seventh', null, ['9', '11']],
  [/^(m7|min7|-7|mi7)/, 'minor-seventh'],
  [/^(m6|min6|-6)/, 'minor-sixth'],
  [/^(dim7|°7|o7)/, 'diminished-seventh'],
  [/^(dim|°|o)/, 'diminished'],
  [/^(7#5|7\+5|\+7|aug7)/, 'augmented-seventh'],
  [/^(aug|\+)/, 'augmented'],
  [/^(7sus4|7sus|9sus4|9sus)/, 'dominant-sus'],
  [/^(sus4|sus)/, 'suspended-fourth'],
  [/^sus2/, 'suspended-second'],
  [/^(13)/, 'dominant', null, ['9', '13']],
  [/^(11)/, 'dominant', null, ['9', '11']],
  [/^(9)/, 'dominant', null, ['9']],
  [/^(7)/, 'dominant'],
  [/^(69|6\/9)/, 'major-sixth', null, ['9']],
  [/^(6)/, 'major-sixth'],
  [/^(5)/, 'power'],
  [/^(m|min|mi|-)/, 'minor'],
];

export function parseChord(symbol) {
  if (!symbol) return null;
  let s = String(symbol).trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  if (!s || /^(N\.?C\.?|%|\/)$/i.test(s)) return null;
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(s);
  if (!m) return null;
  const rootLof = parseNoteName(m[1].toUpperCase() + m[2]);
  let rest = m[3];
  let bassLof = null;
  const slash = rest.lastIndexOf('/');
  if (slash >= 0) {
    const b = rest.slice(slash + 1);
    const bl = /^[A-Ga-g][#b]?$/.test(b) ? parseNoteName(b[0].toUpperCase() + b.slice(1)) : null;
    if (bl !== null) {
      bassLof = bl;
      rest = rest.slice(0, slash);
    }
  }
  let kind = 'major';
  let tensions = [];
  let q = rest;
  for (const [re, k, fix, tens] of QUALITY_PATTERNS) {
    const mm = re.exec(q);
    if (mm) {
      kind = (fix && fix(q.slice(mm[0].length), mm[0])) || k;
      if (tens) tensions.push(...tens);
      q = q.slice(mm[0].length);
      break;
    }
  }
  // Zusätze/Alterationen
  const extra = q.replace(/[()]/g, ' ');
  const tensRe = /(add9|add2|add11|b9|#9|#11|b13|b5|#5|9|11|13)/g;
  let t;
  while ((t = tensRe.exec(extra))) {
    const tok = t[1];
    if (tok === 'add9' || tok === 'add2') tensions.push('9');
    else if (tok === 'add11') tensions.push('11');
    else if (tok === 'b5' && kind === 'dominant') tensions.push('b5');
    else if (tok === '#5' && kind === 'dominant') kind = 'augmented-seventh';
    else tensions.push(tok);
  }
  tensions = [...new Set(tensions)];
  return buildChord(rootLof, kind, tensions, bassLof, String(symbol).trim());
}

// Akkordtöne ohne Doppel-Vorzeichen schreiben (Ges-Moll: A statt Heses) – so stehen sie in
// gedruckten Stimmen
const plain = (lof) => (lof <= -9 ? lof + 12 : lof >= 13 ? lof - 12 : lof);

export function buildChord(rootLof, kind, tensions = [], bassLof = null, symbol = null) {
  const def = KINDS[kind] || KINDS.major;
  const rootPc = lofPc(rootLof);
  const tones = def.tones.map(([iv, role]) => {
    let [semi, lofOff] = IV[iv];
    if (role === 'fifth' && tensions.includes('b5') && kind === 'dominant') [semi, lofOff] = IV.b5;
    return { pc: mod(rootPc + semi, 12), lof: plain(rootLof + lofOff), role, iv };
  });
  const tens = tensions
    .filter((x) => IV[x])
    .map((iv) => ({ pc: mod(rootPc + IV[iv][0], 12), lof: plain(rootLof + IV[iv][1]), role: 'tension', iv }));
  const chord = {
    rootLof,
    rootPc,
    kind,
    tensions,
    bassLof,
    bassPc: bassLof === null ? null : lofPc(bassLof),
    tones,
    tens,
    symbol: null,
  };
  chord.symbol = symbol || chordSymbol(chord);
  return chord;
}

export function chordSymbol(c) {
  const def = KINDS[c.kind] || KINDS.major;
  let s = lofName(c.rootLof) + def.text;
  const t = c.tensions.filter((x) => x !== 'b5');
  if (t.length) {
    if (c.kind === 'dominant' && t.length === 1 && (t[0] === '9' || t[0] === '13')) s = lofName(c.rootLof) + t[0];
    else if (c.kind === 'major-seventh' && t.join() === '9') s = lofName(c.rootLof) + 'maj9';
    else if (c.kind === 'minor-seventh' && t.join() === '9') s = lofName(c.rootLof) + 'm9';
    else if (c.kind === 'major-sixth' && t.join() === '9') s = lofName(c.rootLof) + '6/9';
    else if (c.kind === 'major' || c.kind === 'minor') s += '(add' + t.join(',') + ')';
    else s += '(' + t.join(',') + ')';
  }
  if (c.bassLof !== null) s += '/' + lofName(c.bassLof);
  return s;
}

export function kindXml(c) {
  return (KINDS[c.kind] || KINDS.major).xml;
}
export function kindText(c) {
  return (KINDS[c.kind] || KINDS.major).text;
}

export function transposeChord(c, semis) {
  if (!c || semis === 0) return c;
  let d = semisToLofDelta(semis);
  // Grundton nach der Transposition nicht in exotischer Schreibweise (Eis-Moll -> F-Moll)
  if (c.rootLof + d > 9) d -= 12;
  else if (c.rootLof + d < -8) d += 12;
  return buildChord(c.rootLof + d, c.kind, c.tensions, c.bassLof === null ? null : c.bassLof + d);
}

export function chordPcs(c, withTensions = false) {
  const pcs = c.tones.map((t) => t.pc);
  if (withTensions) for (const t of c.tens) pcs.push(t.pc);
  return [...new Set(pcs)];
}

export function toneByRole(c, role) {
  return c.tones.find((t) => t.role === role) || null;
}

export function isDominant(c) {
  return c.kind === 'dominant' || c.kind === 'augmented-seventh' || c.kind === 'dominant-sus';
}

export function isMinorish(c) {
  return ['minor', 'minor-seventh', 'minor-sixth', 'half-diminished', 'diminished', 'diminished-seventh', 'major-minor'].includes(c.kind);
}

// Leitton-/Guide-Tones (3 & 7, bei Dreiklängen 3 & 5)
export function guideTones(c) {
  const third = toneByRole(c, 'third');
  const seventh = toneByRole(c, 'seventh');
  const out = [];
  if (third) out.push(third);
  if (seventh) out.push(seventh);
  if (out.length < 2) {
    const fifth = toneByRole(c, 'fifth');
    if (fifth) out.push(fifth);
  }
  return out;
}

// Spannungen, die stilistisch passen (Jazz/Funk-Voicings)
export function colorTones(c, style) {
  const out = [];
  const add = (iv) => out.push({ pc: mod(c.rootPc + IV[iv][0], 12), lof: c.rootLof + IV[iv][1], role: 'tension', iv });
  if (style === 'classical' || style === 'polka') return out;
  if (c.kind === 'dominant') {
    add('9');
    if (style !== 'ballad') add('13');
  } else if (c.kind === 'minor-seventh' || c.kind === 'minor') {
    add('9');
    if (style === 'funk' || style === 'secondline') add('11');
  } else if (c.kind === 'major-seventh' || c.kind === 'major' || c.kind === 'major-sixth') {
    add('9');
  }
  for (const t of c.tens) out.push(t);
  return out;
}

// Diatonische Skala der Tonart, an Akkordtöne angepasst ("chord scale")
export function chordScale(c, key) {
  const tonic = mod(key.tonicPc, 12);
  const steps = key.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  let scale = steps.map((s) => mod(tonic + s, 12));
  if (!c) return scale.sort((a, b) => a - b);
  for (const t of c.tones) {
    if (scale.includes(t.pc)) continue;
    // nächstgelegenen Skalenton ersetzen
    let idx = scale.findIndex((p) => mod(p - t.pc, 12) === 1 || mod(t.pc - p, 12) === 1);
    if (idx >= 0) scale[idx] = t.pc;
    else scale.push(t.pc);
  }
  return [...new Set(scale)].sort((a, b) => a - b);
}

// Blues-/Pentatonik-Material für Soli
export function bluesScale(rootPc, minor = true) {
  const steps = minor ? [0, 3, 5, 6, 7, 10] : [0, 2, 3, 4, 7, 9];
  return steps.map((s) => mod(rootPc + s, 12));
}

export function pentatonic(rootPc, minor = false) {
  const steps = minor ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];
  return steps.map((s) => mod(rootPc + s, 12));
}

export function sameChord(a, b) {
  if (!a || !b) return a === b;
  return a.rootPc === b.rootPc && a.kind === b.kind && a.bassPc === b.bassPc && a.tensions.join() === b.tensions.join();
}

// Römische Stufen -> Akkord in Tonart
export function chordFromDegree(key, degree, kind, tensions = []) {
  // degree: 1..7, optional Alteration über 'b'/'#' Präfix als Zahl (z. B. -1 für bVII)
  const majorSteps = [0, 2, 4, 5, 7, 9, 11];
  const minorSteps = [0, 2, 3, 5, 7, 8, 10];
  const steps = key.mode === 'minor' ? minorSteps : majorSteps;
  const alt = degree.alter || 0;
  const semis = steps[(degree.n - 1) % 7] + alt;
  const majorLofs = [0, 2, 4, -1, 1, 3, 5];
  const minorLofs = [0, 2, -3, -1, 1, -4, -2];
  const lofs = key.mode === 'minor' ? minorLofs : majorLofs;
  const tonicLof = key.tonicLof;
  const rootLof = tonicLof + lofs[(degree.n - 1) % 7] + alt * 7;
  void semis;
  return buildChord(rootLof, kind, tensions);
}
