// Besetzungssteuerung (oberflächenunabhängig): Ensemble-Vorlagen, Standardbesetzungen für 1 … 15
// Stimmen, Anzahl ändern ohne eigene Wahl zu verlieren, Beschreibung jeder Stimme (Rolle, Schlüssel,
// Transposition). Die Oberfläche (src/web/app.js) und die Tests benutzen genau diese Funktionen.
import { ENSEMBLES, PROFILES, getProfile } from './profiles.js';

export const MIN_VOICES = 1;
export const MAX_VOICES = 15; // MIDI: 16 Kanäle, einer davon Schlagzeug

// ---- Namen ------------------------------------------------------------------------------------
const NAMES = ['', 'Lead Sheet', 'Duo', 'Trio', 'Quartett', 'Quintett', 'Sextett', 'Septett', 'Oktett', 'Nonett', 'Dezett', 'Kleines Blasorchester', 'Kleines Blasorchester', 'Blasorchester', 'Blasorchester', 'Blasorchester'];
export const ensembleLabel = (n) => NAMES[n] || `${n} Stimmen`;

// ---- Streicher (die Bläser-Besetzungen stehen in profiles.js: ENSEMBLES) -----------------------
// Rollen je Platz wie bei den Bläsern: oben Lead, unten Bass, dazwischen Harmonie/Riff.
const STRINGS = {
  4: ['violin', 'violin', 'viola', 'cello'],
  5: ['violin', 'violin', 'viola', 'cello', 'contrabass'],
  6: ['violin', 'violin', 'viola', 'viola', 'cello', 'contrabass'],
  7: ['violin', 'violin', 'violin', 'viola', 'viola', 'cello', 'contrabass'],
  8: ['violin', 'violin', 'violin', 'viola', 'viola', 'cello', 'cello', 'contrabass'],
};

// ---- Vorlagen -----------------------------------------------------------------------------------
// min/max: Stimmenzahlen, für die die Vorlage steht; def: Anzahl, wenn man sie anwählt
export const ENSEMBLE_PRESETS = [
  { id: 'leadsheet', name: 'Lead Sheet', info: '1 Stimme + Akkordsymbole', min: 1, max: 1, def: 1 },
  { id: 'duotrio', name: 'Duo / Trio', info: 'Lead + Kontrapunkt + Bass', min: 2, max: 3, def: 3 },
  { id: 'quartet', name: 'Klassisches Quartett', info: 'SATB / Bläser', min: 4, max: 4, def: 4 },
  { id: 'brass', name: 'Brass Ensemble', info: 'Quintett – Oktett', min: 5, max: 8, def: 5 },
  { id: 'orchestra', name: 'Großes Blasorchester / Bigband', info: '12 – 15 Stimmen (9 – 11: kleines Blasorchester)', min: 9, max: 15, def: 13 },
  { id: 'strings', name: 'Streichquartett / Streicherensemble', info: '4 – 8 Stimmen', min: 4, max: 8, def: 4 },
];

export const getPreset = (id) => ENSEMBLE_PRESETS.find((p) => p.id === id) || null;

const clampN = (n) => Math.max(MIN_VOICES, Math.min(MAX_VOICES, Math.round(n)));

// Standardbesetzung der Vorlage für n Stimmen (n wird in den Bereich der Vorlage gezogen)
export function defaultVoices(presetId, n) {
  const p = getPreset(presetId) || getPreset('quartet');
  const k = Math.max(p.min, Math.min(p.max, clampN(n)));
  if (p.id === 'leadsheet') return ['flute'];
  if (p.id === 'strings') return [...STRINGS[k]];
  if (p.id === 'quartet') return ENSEMBLES[4].map((v) => v.profile);
  return ENSEMBLES[k].map((v) => v.profile);
}

// passende Vorlage für eine Stimmenzahl (die bevorzugte zuerst, z. B. die aktuelle)
export function presetForCount(n, prefer = null) {
  const k = clampN(n);
  const fits = (p) => k >= p.min && k <= p.max;
  const pref = getPreset(prefer);
  if (pref && fits(pref)) return pref.id;
  const order = ['leadsheet', 'duotrio', 'quartet', 'brass', 'orchestra', 'strings'];
  return order.map(getPreset).find(fits).id;
}

// Wählt die Besetzung eine Vorlage? (sonst 'custom' = eigene Besetzung)
export function matchPreset(voices, prefer = null) {
  const n = voices.length;
  const key = voices.join();
  const list = [...ENSEMBLE_PRESETS].sort((a, b) => (a.id === prefer ? -1 : b.id === prefer ? 1 : 0));
  for (const p of list) if (n >= p.min && n <= p.max && defaultVoices(p.id, n).join() === key) return p.id;
  return 'custom';
}

// Vorlage anwählen: bleibt die aktuelle Anzahl im Bereich der Vorlage, bleibt sie; sonst gilt def
export function applyPreset(presetId, currentN) {
  const p = getPreset(presetId);
  const n = currentN >= p.min && currentN <= p.max ? currentN : p.def;
  return { preset: p.id, voices: defaultVoices(p.id, n) };
}

// Stimmenzahl ändern. Entspricht die Besetzung noch der Vorlage, folgt sie der (ggf. passenderen)
// Vorlage für die neue Zahl. Eigene Wahl bleibt erhalten: Lead und Bass bleiben, neue Plätze füllt die
// Standardbesetzung, beim Verkleinern fallen Mittelstimmen von hinten weg.
export function resizeEnsemble(voices, n, presetId = null) {
  const k = clampN(n);
  const cur = voices.length;
  if (k === cur) return { preset: matchPreset(voices, presetId), voices: [...voices] };
  const was = matchPreset(voices, presetId);
  if (was !== 'custom') {
    const pid = presetForCount(k, was);
    return { preset: pid, voices: defaultVoices(pid, k) };
  }
  const pid = presetForCount(k, presetId && presetId !== 'custom' ? presetId : null);
  const def = defaultVoices(pid, k);
  let out;
  if (k < cur) {
    // Lead und Bass bleiben, Mittelstimmen fallen von hinten weg
    out = k === 1 ? [voices[0]] : [...voices.slice(0, k - 1), voices[cur - 1]];
  } else {
    // neue Plätze vor dem Bass aus der Standardbesetzung für die neue Zahl
    const keepBass = cur > 1;
    const head = keepBass ? voices.slice(0, cur - 1) : [...voices];
    const fill = def.slice(head.length, keepBass ? k - 1 : k);
    out = keepBass ? [...head, ...fill, voices[cur - 1]] : [...head, ...fill];
  }
  return { preset: matchPreset(out, pid), voices: out };
}

// ---- Rollen ---------------------------------------------------------------------------------
// Rolle des Platzes i in einer Besetzung mit n Stimmen (Engine-Rolle aus profiles.js)
export function slotRole(i, n) {
  const list = ENSEMBLES[clampN(n)];
  return list[Math.min(i, list.length - 1)].role;
}

const ROLE_TEXT = {
  lead: { label: 'Lead', detail: 'Melodie' },
  double8: { label: 'Lead', detail: 'Melodie, Oktave höher' },
  doubleU: { label: 'Lead', detail: 'Melodie im Einklang' },
  counter: { label: 'Gegenmelodie', detail: 'Kontrapunkt, antwortet bei Pausen' },
  inner: { label: 'Harmonie / Riff', detail: 'Akkordtöne, Einwürfe' },
  bass: { label: 'Bass', detail: 'Fundament' },
  bass8vb: { label: 'Bass', detail: 'Fundament, Oktave tiefer' },
};

// ---- Schlüssel & Transposition -----------------------------------------------------------------
const CLEF_TEXT = { G2: 'G-Schlüssel', F4: 'F-Schlüssel', C3: 'Altschlüssel', C4: 'Tenorschlüssel' };

const SOUNDS = {
  2: 'eine große Sekunde',
  7: 'eine Quinte',
  9: 'eine große Sexte',
  12: 'eine Oktave',
  14: 'eine große None',
  21: 'eine Oktave und eine große Sexte',
};

// Schlüssel- und Transpositionsangaben einer Stimme, z. B.
//   „Trompete in B (G-Schlüssel)“ · „klingt eine große Sekunde tiefer“
export function describeInstrument(key) {
  const p = getProfile(key);
  const grand = p.staves > 1;
  const semis = -(p.transpose.chromatic || 0);
  const clef = grand ? 'Doppelsystem G/F' : CLEF_TEXT[p.clef] || p.clef;
  const base = /\bin [A-G](es|s|is)?\b/.test(p.name) || grand ? p.name : `${p.name} in C`;
  return {
    key: p.key,
    name: base,
    clef,
    title: `${base} (${clef})`,
    transposition: semis === 0 ? 'klingt wie notiert' : `klingt ${SOUNDS[semis] || `${semis} Halbtöne`} tiefer`,
    transposes: semis !== 0,
    family: p.family,
    range: p.range,
  };
}

// Alles, was die Oberfläche für eine Zeile braucht
export function slotInfo(voices, i) {
  const role = slotRole(i, voices.length);
  const t = ROLE_TEXT[role];
  const d = describeInstrument(voices[i]);
  return { index: i, role, roleLabel: t.label, roleDetail: t.detail, ...d };
}

// Instrumente für das Auswahlfeld: nach Familie geordnet, jede Familie mit Überschrift
const FAMILY_ORDER = ['woodwind', 'sax', 'brass', 'string', 'keys', 'rhythm'];
const FAMILY_NAMES = { woodwind: 'Holzbläser', sax: 'Saxophone', brass: 'Blechbläser', string: 'Streicher', keys: 'Tasten', rhythm: 'Rhythmusgruppe' };
export function instrumentOptions() {
  const groups = FAMILY_ORDER.map((f) => ({ family: f, label: FAMILY_NAMES[f], items: [] }));
  for (const p of Object.values(PROFILES)) {
    const g = groups.find((x) => x.family === p.family);
    if (g) g.items.push({ key: p.key, name: p.name });
  }
  return groups.filter((g) => g.items.length);
}
