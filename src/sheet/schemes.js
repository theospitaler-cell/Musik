// Besetzungs-Schemas: Maininstrument + 2.–6. Stimme. Mehrere Schemas lassen sich speichern und wechseln;
// das aktive Schema liefert die Vorlage für neue Stimmen, die Besetzung beim Arrangieren, die Reihenfolge
// in der Partitur und das Zielinstrument beim Umschreiben.
import { INSTRUMENTS } from '../arrange/instruments.js';

export const SLOT_COUNT = 6; // Maininstrument, 2., 3., 4., 5., 6. Stimme
export const SLOT_NAMES = ['Maininstrument', '2. Stimme', '3. Stimme', '4. Stimme', '5. Stimme', '6. Stimme'];

const isInstrument = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(INSTRUMENTS, id) && id !== 'drums';

export const DEFAULT_SCHEMES = [
  { id: 'quartett', name: 'Quartett (Trp, Trp, Pos, Tuba)', voices: ['trumpet', 'trumpet', 'trombone', 'tuba', null, null] },
  { id: 'brass5', name: 'Blechquintett', voices: ['trumpet', 'trumpet', 'horn', 'trombone', 'tuba', null] },
  { id: 'saxquartett', name: 'Saxophonquartett', voices: ['altoSax', 'altoSax', 'tenorSax', 'bariSax', null, null] },
];

// Ungültige Instrumente werden zu „keine“, die Länge wird auf SLOT_COUNT gebracht; das Maininstrument
// muss gesetzt sein (sonst Trompete).
export function normalizeScheme(s, fallbackId = 'schema') {
  const voices = Array.from({ length: SLOT_COUNT }, (_, i) => (isInstrument(s?.voices?.[i]) ? s.voices[i] : null));
  if (!voices[0]) voices[0] = 'trumpet';
  return { id: String(s?.id || fallbackId), name: String(s?.name || 'Schema').slice(0, 60), voices };
}

export function normalizeSchemes(settings) {
  let list = Array.isArray(settings?.schemes) ? settings.schemes.map((s, i) => normalizeScheme(s, `schema-${i + 1}`)) : [];
  // eindeutige IDs
  const seen = new Set();
  list = list.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  if (!list.length) {
    // erstes Schema aus den bisherigen Standardstimmen übernehmen (Abwärtskompatibilität)
    const legacy = (settings?.defaultVoices || []).filter(isInstrument).slice(0, SLOT_COUNT);
    list = DEFAULT_SCHEMES.map((s) => normalizeScheme(s));
    if (legacy.length >= 2) list.unshift(normalizeScheme({ id: 'standard', name: 'Mein Standard', voices: legacy }));
  }
  const active = list.some((s) => s.id === settings?.activeScheme) ? settings.activeScheme : list[0].id;
  return { schemes: list, activeScheme: active };
}

export const activeScheme = (settings) => {
  const n = normalizeSchemes(settings);
  return n.schemes.find((s) => s.id === n.activeScheme) || n.schemes[0];
};

// Gesetzte Stimmen in Reihenfolge (Lücken entfallen, damit keine Stimme „fehlt“)
export const schemeVoices = (scheme) => scheme.voices.filter(Boolean);
export const schemeMain = (scheme) => scheme.voices[0];

export function newSchemeId(list, base = 'schema') {
  let n = list.length + 1;
  while (list.some((s) => s.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function addScheme(list, { name = 'Neues Schema', voices = null, from = null } = {}) {
  const src = from ? list.find((s) => s.id === from) : null;
  const s = normalizeScheme({ id: newSchemeId(list), name, voices: voices || src?.voices || DEFAULT_SCHEMES[0].voices });
  return { list: [...list, s], id: s.id };
}

export function updateScheme(list, id, patch) {
  return list.map((s) => (s.id === id ? normalizeScheme({ ...s, ...patch, voices: patch.voices || s.voices }) : s));
}

export function setSlot(list, id, slot, instrument) {
  return list.map((s) => {
    if (s.id !== id) return s;
    const voices = [...s.voices];
    voices[slot] = instrument || null;
    if (slot === 0 && !voices[0]) voices[0] = s.voices[0];
    return normalizeScheme({ ...s, voices });
  });
}

export function removeScheme(list, id) {
  if (list.length <= 1) return list; // mindestens ein Schema bleibt
  return list.filter((s) => s.id !== id);
}
