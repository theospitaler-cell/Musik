// NoteCode – Besetzung mit 2 bis 8 Stimmen: Namen der Stimmen, Vorlagen auf jede
// Anzahl bringen und beim Vergrößern ein sinnvolles Instrument ergänzen.
import { INSTRUMENTS, PRESETS } from '../arrange/instruments.js';

export const MIN_VOICES = 2;
export const MAX_VOICES = 8;
export const ENSEMBLE_NAMES = ['', 'Solo', 'Duo', 'Trio', 'Quartett', 'Quintett', 'Sextett', 'Septett', 'Oktett'];

const ROLES = {
  2: ['Oberstimme', 'Unterstimme'],
  3: ['Sopran', 'Alt', 'Bass'],
  4: ['Sopran', 'Alt', 'Tenor', 'Bass'],
  5: ['Sopran 1', 'Sopran 2', 'Alt', 'Tenor', 'Bass'],
  6: ['Sopran 1', 'Sopran 2', 'Alt', 'Tenor 1', 'Tenor 2', 'Bass'],
  7: ['Sopran 1', 'Sopran 2', 'Alt 1', 'Alt 2', 'Tenor', 'Bariton', 'Bass'],
  8: ['Sopran 1', 'Sopran 2', 'Alt 1', 'Alt 2', 'Tenor 1', 'Tenor 2', 'Bariton', 'Bass'],
};

// Lage der Stimme i in einer Besetzung mit n Stimmen (von oben nach unten)
export function voiceRole(i, n) {
  return (ROLES[n] || ROLES[4])[i] || '';
}

export function ensembleName(n) {
  return ENSEMBLE_NAMES[n] || `${n} Stimmen`;
}

// Reihenfolge, in der je Familie Instrumente ergänzt werden. "a|b" = a wird
// ergänzt, b zählt als gleichwertig (z. B. Sousaphon statt Tuba).
const ADD_ORDER = {
  brass: [
    'trumpet|cornet|flugelhorn',
    'trumpet|cornet|flugelhorn',
    'trombone|bassTrombone',
    'horn|tenorhorn|baritoneTC',
    'tuba|sousaphone|euphonium',
    'trumpet|cornet|flugelhorn',
    'trombone|bassTrombone',
    'horn|tenorhorn|baritoneTC',
  ],
  sax: ['altoSax|sopranoSax', 'tenorSax', 'altoSax|sopranoSax', 'tenorSax', 'bariSax', 'altoSax|sopranoSax', 'tenorSax', 'bariSax'],
  woodwind: ['flute', 'oboe', 'clarinet', 'bassoon|bassClarinet', 'clarinet', 'flute', 'bassClarinet', 'oboe'],
  string: ['violin', 'violin', 'viola', 'cello', 'violin', 'viola', 'cello', 'contrabass|ebass'],
};

const mid = (id) => {
  const c = INSTRUMENTS[id]?.comfort || [60, 60];
  return (c[0] + c[1]) / 2;
};

function mainFamily(voices) {
  const count = {};
  for (const id of voices) {
    const f = INSTRUMENTS[id]?.family;
    if (f && ADD_ORDER[f]) count[f] = (count[f] || 0) + 1;
  }
  const first = INSTRUMENTS[voices[0]]?.family;
  let best = ADD_ORDER[first] ? first : 'brass';
  for (const [f, c] of Object.entries(count)) if (c > (count[best] || 0)) best = f;
  return best;
}

// nächstes sinnvolles Instrument für diese Besetzung
export function nextInstrument(voices) {
  const order = ADD_ORDER[mainFamily(voices)];
  const need = {};
  for (const entry of order) {
    const set = entry.split('|');
    const key = set[0];
    need[key] = (need[key] || 0) + 1;
    const have = voices.filter((v) => set.includes(v)).length;
    if (have < need[key]) return key;
  }
  return order[voices.length % order.length].split('|')[0];
}

// Instrument passend zur Lage einsortieren – die erste Stimme (Melodie) bleibt oben
function insertByRegister(voices, id) {
  const m = mid(id);
  let pos = 0;
  voices.forEach((v, i) => {
    if (mid(v) >= m) pos = i + 1;
  });
  pos = Math.max(voices.length ? 1 : 0, pos);
  return [...voices.slice(0, pos), id, ...voices.slice(pos)];
}

export function extendVoices(voices, n) {
  let out = [...voices];
  while (out.length < n) out = insertByRegister(out, nextInstrument(out));
  return out;
}

// Vorlage (4 Stimmen) auf n Stimmen: weniger = Ober- und Unterstimme behalten
export function presetVoices(preset, n) {
  const v = preset.voices;
  if (n >= v.length) return extendVoices(v, n);
  if (n === 3) return [v[0], v[2], v[3]];
  if (n === 2) return [v[0], v[v.length - 1]];
  return v.slice(0, n);
}

export function matchingPreset(voices) {
  const key = voices.join();
  return PRESETS.find((p) => presetVoices(p, voices.length).join() === key) || null;
}

// Anzahl ändern: entspricht die Besetzung einer Vorlage, folgt sie der Vorlage
// (so heben sich + und − auf); sonst wird ergänzt bzw. die letzte Stimme entfernt.
export function resizeVoices(voices, n) {
  n = Math.max(MIN_VOICES, Math.min(MAX_VOICES, n));
  if (n === voices.length) return [...voices];
  const preset = matchingPreset(voices);
  if (preset) return presetVoices(preset, n);
  return n > voices.length ? extendVoices(voices, n) : voices.slice(0, n);
}

// Feineinstellungen je Stimme (Schwierigkeit, Tonumfang) beim Umbau mitnehmen:
// gleiches Instrument (gleiche Nummer unter Gleichen) behält seine Werte.
export function carryPerVoice(oldVoices, newVoices, values) {
  const seen = {};
  return newVoices.map((id) => {
    const k = (seen[id] = (seen[id] || 0) + 1);
    let c = 0;
    for (let i = 0; i < oldVoices.length; i++) if (oldVoices[i] === id && ++c === k) return values?.[i] ?? null;
    return null;
  });
}
