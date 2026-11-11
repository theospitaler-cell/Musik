// Instrumentenerkennung aus den Pegeln einer Instrumenten-Spurentrennung (MVSep Mega 53 Stems, BS-Roformer,
// MIT-Lizenz – läuft in der Desktop-App wie Demucs als Python-Umgebung). Das Modell trennt die Aufnahme in 53
// Spuren (Trompete, Horn, Posaune, Tuba, Flöte, Klarinette, Saxophon, Violine, Gesang, Schlagzeugteile …); ein
// Instrument „spielt mit“, wenn seine Spur laut genug ist (Pegel in dB relativ zur ganzen Aufnahme).
//
// Gemessen an sechs Aufnahmen mit bekannter Besetzung (Partituren der Notenvideos): Blechbläserquintett
// (Trompete, Horn, Posaune, Tuba – nichts sonst), Brass Band, zwei Blasorchester, Filmorchester mit Chor und
// eine Popband mit Streichern. Schwelle −22 dB: alle Instrumente der Besetzung bis auf leise Einzelstimmen,
// keine falschen – außer „Mundharmonika“ in Blasorchestern (Verwechslung mit Holzbläsern, siehe unten).

export const INSTRUMENT_THRESHOLD_DB = -22;

// Spuren des Modells -> Instrument (deutsch) und Gruppe. Sammelspuren (wind, brass, woodwind, strings …) zählen
// nicht als Instrument, nur für Prüfungen.
const SPEC = {
  trumpet: ['Trompete', 'brass'],
  'french-horn': ['Horn', 'brass'],
  trombone: ['Posaune', 'brass'],
  tuba: ['Tuba', 'brass'],
  flute: ['Flöte', 'woodwind'],
  oboe: ['Oboe', 'woodwind'],
  clarinet: ['Klarinette', 'woodwind'],
  bassoon: ['Fagott', 'woodwind'],
  saxophone: ['Saxophon', 'woodwind'],
  harmonica: ['Mundharmonika', 'other'],
  accordion: ['Akkordeon', 'other'],
  violin: ['Violine', 'strings'],
  viola: ['Viola', 'strings'],
  cello: ['Cello', 'strings'],
  'double-bass': ['Kontrabass', 'strings'],
  harp: ['Harfe', 'strings'],
  piano: ['Klavier', 'keys'],
  'digital-piano': ['E-Piano', 'keys'],
  organ: ['Orgel', 'keys'],
  harpsichord: ['Cembalo', 'keys'],
  synth: ['Synthesizer', 'keys'],
  'acoustic-guitar': ['Akustikgitarre', 'guitar'],
  'electric-guitar': ['E-Gitarre', 'guitar'],
  banjo: ['Banjo', 'guitar'],
  mandolin: ['Mandoline', 'guitar'],
  ukulele: ['Ukulele', 'guitar'],
  sitar: ['Sitar', 'guitar'],
  dobro: ['Dobro', 'guitar'],
  bass: ['Bass', 'bass'],
  'lead-vocal': ['Gesang', 'vocals'],
  'back-vocal': ['Chor', 'vocals'],
  timpani: ['Pauken', 'percussion'],
  glockenspiel: ['Glockenspiel', 'percussion'],
  marimba: ['Marimba', 'percussion'],
  bells: ['Glocken', 'percussion'],
};
// Schlagzeugteile und kleines Schlagwerk werden zusammengefasst
const DRUMS = ['drums', 'kick', 'snare', 'hh', 'toms'];
const PERC = ['percussion', 'congas', 'tambourine', 'triangle', 'wind-chimes'];

export const GROUPS = [
  ['vocals', 'Gesang'],
  ['brass', 'Blechbläser'],
  ['woodwind', 'Holzbläser'],
  ['strings', 'Streicher'],
  ['keys', 'Tasten'],
  ['guitar', 'Gitarren'],
  ['bass', 'Bass'],
  ['percussion', 'Schlagwerk'],
  ['other', 'Weitere'],
];

const lv = (levels, k) => (Number.isFinite(levels[k]) ? levels[k] : -120);

// levels: { stemName: dB relativ zur Aufnahme } -> [{ id, name, group, db }] (lauteste zuerst)
export function instrumentsFromLevels(levels, { threshold = INSTRUMENT_THRESHOLD_DB } = {}) {
  if (!levels) return [];
  const out = [];
  for (const [id, [name, group]] of Object.entries(SPEC)) {
    const db = lv(levels, id);
    if (db < threshold) continue;
    // Mundharmonika nur, wenn keine Holzbläser lauter klingen: das Modell hört Rohrblatt-Klang (Klarinetten,
    // Saxophone) im Blasorchester als Mundharmonika (Bond, Viva la Vida: −11 dB bei Holzbläsern −9/−7 dB)
    if (id === 'harmonica' && lv(levels, 'woodwind') >= db - 3) continue;
    out.push({ id, name, group, db });
  }
  const drums = Math.max(...DRUMS.map((k) => lv(levels, k)));
  if (drums >= threshold) out.push({ id: 'drums', name: 'Schlagzeug', group: 'percussion', db: drums });
  const perc = Math.max(...PERC.map((k) => lv(levels, k)));
  if (perc >= threshold) out.push({ id: 'percussion', name: 'Percussion', group: 'percussion', db: perc });
  // Streicher ohne erkennbares Einzelinstrument: als Streicher (Satz)
  if (!out.some((x) => x.group === 'strings') && Math.max(lv(levels, 'strings'), lv(levels, 'bowed_strings')) >= threshold) {
    out.push({ id: 'strings', name: 'Streicher', group: 'strings', db: Math.max(lv(levels, 'strings'), lv(levels, 'bowed_strings')) });
  }
  return out.sort((a, b) => b.db - a.db);
}

// deutscher Name einer Instrument-Id (auch Schlagzeug/Percussion/Streicher-Satz)
export function instrumentName(id) {
  if (SPEC[id]) return SPEC[id][0];
  return { drums: 'Schlagzeug', percussion: 'Percussion', strings: 'Streicher' }[id] || id;
}

// Gruppiert für die Anzeige: [{ group, label, items: [name …] }] in fester Reihenfolge
export function groupInstruments(list) {
  return GROUPS.map(([group, label]) => ({ group, label, items: list.filter((x) => x.group === group).map((x) => x.name) })).filter((g) => g.items.length);
}

// Pegel je Formteil: windows = { hop (s), mix: [dBFS je Fenster], stems: { name: [dBFS je Fenster] } },
// sections = song.sections (Takte), barSec(takt) = Sekunde des Taktanfangs.
// Ergebnis je Formteil: Liste der Instrument-Ids (gleiche Regeln, Pegel relativ zum Formteil).
export function instrumentsBySection(windows, { sections = [], barSec = null } = {}) {
  if (!windows || !windows.stems || !barSec || !sections.length) return [];
  const hop = windows.hop || 3;
  const pw = (db) => Math.pow(10, db / 10);
  const res = [];
  for (const s of sections) {
    const t0 = barSec(s.start);
    const t1 = barSec(s.start + s.length);
    if (!(t1 > t0)) continue;
    const idx = [];
    for (let w = 0; w < windows.mix.length; w++) if ((w + 0.5) * hop >= t0 && (w + 0.5) * hop < t1) idx.push(w);
    if (!idx.length) continue;
    const mixP = idx.reduce((a, w) => a + pw(windows.mix[w]), 0) / idx.length;
    if (mixP <= 0) continue;
    const levels = {};
    for (const [k, arr] of Object.entries(windows.stems)) {
      const p = idx.reduce((a, w) => a + pw(arr[w] ?? -120), 0) / idx.length;
      levels[k] = 10 * Math.log10(p / mixP + 1e-12);
    }
    res.push({ label: s.label, start: s.start, length: s.length, instruments: instrumentsFromLevels(levels).map((x) => x.id) });
  }
  return res;
}
