// Formplanung & Rollenverteilung ("Regieplan").
import { mod } from '../core/constants.js';
import { buildChord, transposeChord } from '../theory/chords.js';
import { transposeKey } from '../theory/keys.js';
import { semisToLofDelta } from '../theory/pitch.js';
import { getInstrument, fitOctave, withRange } from './instruments.js';
import { difficultyRange, levelFor } from './difficulty.js';
import { getStyle } from './styles.js';
import {
  songMeasureTicks,
  sliceMelody,
  sliceChords,
  pickupNotes,
  transposeEvents,
  transposeChordList,
  transposeSong,
} from '../model/song.js';

export const ROLE_NAMES = {
  melody: 'Melodie',
  counter: 'Gegenstimme',
  fill: 'Fill-Ins',
  comp: 'Begleitung',
  stabs: 'Stabs/Einwürfe',
  pad: 'Liegeklänge',
  bass: 'Bass',
  solo: 'SOLO',
  background: 'Background',
  tutti: 'Tutti-Satz',
  hook: 'Hook-Motiv',
  hits: 'Tutti-Hits',
  riff: 'Riff',
  subject: 'Fugato-Thema',
  final: 'Schlussakkord',
  rest: 'Pause',
};

// ---- Tonart: bläserfreundlich wählen ------------------------------------
export function chooseTransposition(song, voices, opts) {
  if (typeof opts.transpose === 'number') return opts.transpose;
  if (opts.transpose !== 'auto') return 0;
  const insts = voices.map(getInstrument);
  const transposing = insts.filter((i) => i.transpose.semis % 12 !== 0 || i.family === 'brass' || i.family === 'sax');
  // Gitarren-Kreuztonarten (E, H, Fis, Cis …) sind für alle Bläser unbequem -> auch Holzbläser
  const sharpKey = song.key.fifths >= 4 || song.key.fifths <= -6;
  if (!transposing.length && !(sharpKey && insts.some((i) => i.family === 'woodwind'))) return 0;
  let best = { shift: 0, cost: Infinity };
  for (const shift of [0, -1, 1, -2, 2]) {
    const k = transposeKey(song.key, shift);
    let cost = Math.abs(k.fifths) * 0.6 + (k.fifths > 0 ? 0.4 : 0);
    for (const i of insts) {
      const f = k.fifths + i.transpose.lof;
      cost += Math.abs(f > 6 ? f - 12 : f) * (i.family === 'brass' ? 1.2 : 1);
    }
    // Melodie muss für Stimme 1 bequem bleiben
    const mel = transposeEvents(song.melody, shift);
    cost += fitOctave(mel, insts[0]).penalty * 0.5;
    cost += Math.abs(shift) * 0.8;
    if (cost < best.cost - 0.01) best = { shift, cost };
  }
  return best.shift;
}

// ---- Hilfen -------------------------------------------------------------
function tonicChord(key, style, seventh = true) {
  if (key.mode === 'minor') return buildChord(key.tonicLof, seventh ? 'minor-seventh' : 'minor');
  if (!seventh) return buildChord(key.tonicLof, 'major');
  if (style.id === 'funk' || style.id === 'secondline') return buildChord(key.tonicLof, 'dominant', ['9']);
  if (style.id === 'swing') return buildChord(key.tonicLof, 'major-sixth');
  return buildChord(key.tonicLof, 'major');
}

function degreeChord(key, semis, lofOff, kind, tensions = []) {
  void semis;
  return buildChord(key.tonicLof + lofOff, kind, tensions);
}

function chordsPerBar(list, mt) {
  // list: [chord | [chord, chord]] pro Takt
  const out = [];
  list.forEach((c, i) => {
    if (Array.isArray(c)) {
      const h = mt / c.length;
      c.forEach((cc, k) => out.push({ start: i * mt + k * h, dur: h, chord: cc }));
    } else out.push({ start: i * mt, dur: mt, chord: c });
  });
  return out;
}

function dominantOf(chord) {
  // V7 zum Zielakkord
  return buildChord(chord.rootLof + 1, 'dominant');
}

function melodyFits(notes, inst) {
  if (!notes.length) return true;
  const f = fitOctave(notes, inst);
  // einzelne Spitzentöne außerhalb des Umfangs (höchstens 5 %) werden später oktaviert
  return f.outOfRange <= 0.05 * notes.length && f.penalty < 3 + 50 * 0.05;
}

function soloIndex(opt, count = 4) {
  if (opt === 'none' || opt === 'rotate') return null;
  const n = typeof opt === 'number' ? opt : Number(String(opt).replace(/\D/g, '')) - 1;
  return Number.isFinite(n) && n >= 0 && n < count ? n : 0;
}

// Rollen für einen Themenabschnitt mit Melodie in Stimme mv
export function themeRoles(mv, insts, variant = 0) {
  const r = ['comp', 'comp', 'comp', 'bass'];
  if (mv === 0) return ['melody', 'counter', 'comp', 'bass'];
  if (mv === 1) return ['counter', 'melody', 'comp', 'bass'];
  if (mv === 2) return variant % 2 ? ['counter', 'comp', 'melody', 'bass'] : ['fill', 'comp', 'melody', 'bass'];
  // Melodie im Bass-Instrument: Stimme 3 übernimmt das Fundament, falls möglich
  if (insts[2].bassCapable) return ['fill', 'comp', 'bass', 'melody'];
  void r;
  return ['fill', 'pad', 'comp', 'melody'];
}

function soloRoles(sv, insts) {
  const roles = ['background', 'background', 'background', 'bass'];
  roles[sv] = 'solo';
  if (sv === 3) {
    if (insts[2].bassCapable) roles[2] = 'bass';
  }
  return roles;
}

// ---- Besetzung 2–8: vier musikalische Funktionen auf die echten Stimmen ----
// Lead (immer Stimme 1, oben), obere & untere Mittelstimme (Guide-Tones), Bass; weitere
// Stimmen verdoppeln/teilen je nach Dichte des Formteils.
const center = (inst) => (inst.comfort[0] + inst.comfort[1]) / 2;
export function voiceSlots(insts) {
  const n = insts.length;
  const lead = 0;
  const rest = insts.map((_, i) => i).filter((i) => i !== lead);
  // Bass: tiefstes bass-taugliches Instrument, sonst tiefstes überhaupt
  let bass = null;
  if (rest.length) {
    const cands = rest.filter((i) => insts[i].bassCapable);
    const pool = cands.length ? cands : rest;
    bass = pool.reduce((a, b) => (center(insts[b]) < center(insts[a]) ? b : a), pool[0]);
  }
  const middles = rest.filter((i) => i !== bass).sort((a, b) => center(insts[b]) - center(insts[a]) || a - b);
  const upper = middles[0] ?? null;
  const lower = middles[1] ?? null;
  const extras = middles.slice(2);
  // Klangreihenfolge von oben nach unten (für homophone Sätze)
  const order = [lead, ...middles, ...(bass !== null ? [bass] : [])];
  return { n, lead, upper, lower, bass, extras, order, slotVoice: [lead, upper, lower, bass] };
}

const LEAD_SLOT_ROLES = ['melody', 'hook', 'subject', 'solo'];
const GROUP_ROLES = ['tutti', 'hits', 'riff', 'final'];
const HARMONY_ROLES = ['comp', 'pad', 'stabs', 'background'];

// 4 Funktions-Rollen -> Rollen für n Stimmen
export function expandRoles(r4, slots, insts, density = null) {
  const out = new Array(slots.n).fill('rest');
  slots.slotVoice.forEach((v, s) => {
    if (v !== null && v !== undefined) out[v] = r4[s];
  });
  // weggefallene Mittelstimmen (Duo/Trio): Führungsrollen nicht verlieren
  for (const s of [1, 2]) {
    if (slots.slotVoice[s] !== null || !LEAD_SLOT_ROLES.includes(r4[s])) continue;
    const target = !LEAD_SLOT_ROLES.includes(out[slots.lead]) ? slots.lead : slots.upper;
    if (target !== null) out[target] = r4[s];
  }
  if (slots.n === 3 && slots.lower === null && r4[1] === 'rest' && r4[2] !== 'rest' && slots.upper !== null && !LEAD_SLOT_ROLES.includes(out[slots.upper])) out[slots.upper] = r4[2];
  // Duo ohne Bassinstrument: zweite Stimme als Gegenstimme statt Basslinie
  if (slots.n === 2 && slots.bass !== null && r4[3] === 'bass' && !insts[slots.bass].bassCapable) out[slots.bass] = r4[0] === 'melody' ? 'counter' : r4[1] !== 'rest' ? r4[1] : 'counter';
  const group = r4.find((r) => GROUP_ROLES.includes(r) && r !== 'riff') || (r4.filter((r) => r === 'riff').length >= 2 ? 'riff' : null);
  const harm = HARMONY_ROLES.includes(r4[2]) ? r4[2] : HARMONY_ROLES.includes(r4[1]) ? r4[1] : null;
  slots.extras.forEach((v, k) => {
    if (group) out[v] = group;
    else if (r4.includes('solo')) out[v] = harm && k < 2 ? harm : 'rest';
    else if (density === 'thin') out[v] = 'rest';
    else if (density === 'build') out[v] = k < 2 ? 'pad' : 'rest';
    else if (density === 'full' && r4[0] === 'melody' && k === 0) out[v] = 'double';
    else out[v] = harm || 'rest';
  });
  return out;
}

// Funktion/Dichte der Formteile wie in professionellen Arrangements:
// Strophe dünn (Melodie + Bass + Einwürfe), Pre-Chorus aufbauend (Vorhalte, Gegenbewegung),
// Refrain voll (breite Akkorde). Refrain = häufigster gesungener Formteil.
export function sectionDensity(sections, song) {
  const n = sections.length;
  const sung = sections.map((sec) => sliceMelody(song, sec.start, sec.start + sec.length).length >= Math.max(2, sec.length / 2));
  const count = {};
  sections.forEach((sec, i) => {
    if (sung[i]) count[sec.label] = (count[sec.label] || 0) + 1;
  });
  const meanPitch = (label) => {
    const ns = sections.filter((x) => x.label === label).flatMap((x) => sliceMelody(song, x.start, x.start + x.length));
    return ns.length ? ns.reduce((a, b) => a + b.midi, 0) / ns.length : 0;
  };
  const labels = Object.keys(count).filter((l) => count[l] >= 2);
  labels.sort((a, b) => count[b] - count[a] || meanPitch(b) - meanPitch(a));
  const chorus = labels[0] || null;
  // Aufnahme: die Dichte folgt der Lautstärke des Originals (leise Teile dünn, laute voll)
  if (sections.every((sec) => typeof sec.energy === 'number')) {
    const density = sections.map((sec) => (sec.energy < 0.4 ? 'thin' : sec.energy < 0.66 ? 'build' : 'full'));
    return { density, chorus, byEnergy: true };
  }
  const out = new Array(n).fill('full');
  const seen = {};
  sections.forEach((sec, i) => {
    const occ = (seen[sec.label] = (seen[sec.label] || 0) + 1) - 1;
    if (!chorus) out[i] = i < n / 3 ? 'thin' : i < (2 * n) / 3 ? 'build' : 'full';
    else if (sections[0].label === chorus) {
      // Strophenlied/AABA: erst dünn, dann aufbauen, ab der 3. Wiederholung voll
      out[i] = sec.label === chorus ? (occ === 0 ? 'thin' : occ === 1 ? 'build' : 'full') : 'build';
    } else if (sec.label === chorus) out[i] = 'full';
    else if (sections[i + 1] && sections[i + 1].label === chorus) out[i] = occ === 0 && i === 0 ? 'thin' : 'build';
    else out[i] = occ === 0 ? 'thin' : 'build';
  });
  return { density: out, chorus };
}

// Rollen (4 Funktionen) je Dichte, stilgerecht
function densityRoles(density, style) {
  const harm = style.id === 'ballad' || style.id === 'classical' ? 'pad' : style.id === 'funk' || style.id === 'secondline' ? 'stabs' : 'comp';
  if (density === 'thin') return ['melody', 'fill', 'rest', 'bass'];
  if (density === 'build') return ['melody', 'pad', 'counter', 'bass'];
  return ['melody', harm, harm === 'pad' ? 'pad' : 'comp', 'bass'];
}

// ---- Hauptfunktion -----------------------------------------------------
export function planArrangement(songIn, opts) {
  const style = getStyle(opts.style);
  // Schwierigkeit (Lage) zuerst, eigener Tonumfang hat Vorrang
  const realInsts = opts.voices.map((id, i) => withRange(difficultyRange(getInstrument(id), levelFor(opts, i)), opts.ranges ? opts.ranges[i] : null));
  const slots = voiceSlots(realInsts);
  // Planung mit 4 Funktionen; fehlende Funktionen (Duo/Trio) leihen sich ein vorhandenes Instrument
  const insts = slots.slotVoice.map((v, s) => realInsts[v ?? (s === 2 ? slots.upper ?? slots.lead : s === 1 ? slots.lead : slots.bass ?? slots.lead)]);
  const shift = chooseTransposition(songIn, opts.voices, opts);
  const song = transposeSong(songIn, shift);
  const key = song.key;
  const mt = songMeasureTicks(song);
  const M = song.measureCount;
  const length = opts.length || 'normal';
  // Solist: echte Stimme -> Funktion (Zusatzstimmen solieren als obere Mittelstimme)
  const soloReal = soloIndex(opts.solo ?? 0, realInsts.length);
  const soloPref = soloReal === null ? null : Math.max(0, slots.slotVoice.indexOf(soloReal)) || (soloReal === slots.lead ? 0 : 1);
  const rotate = opts.solo === 'rotate';
  const noSolo = opts.solo === 'none';
  const steps = mt / 6;
  const fourFour = steps === 16;

  const blocks = [];
  const add = (b) => {
    blocks.push({ keyShift: 0, segments: null, leadIn: null, notes: [], ...b });
    return blocks[blocks.length - 1];
  };

  const sections = song.sections.length ? song.sections : [{ label: 'A', start: 0, length: M }];
  const pickup = pickupNotes(song);
  const firstMelody = sliceMelody(song, 0, Math.min(2, M));

  // --- Intro -------------------------------------------------------------
  // Originallänge: kurzes Intro (4 Takte), nur auf Wunsch länger
  const introBars = length === 'long' && style.id !== 'ballad' && style.id !== 'swing' ? 8 : 4;
  const T = tonicChord(key, style);
  const hookVoice = soloPref !== null && style.id === 'ballad' ? soloPref : style.id === 'ballad' ? 2 : 0;
  {
    let chords;
    let segments;
    const IV = key.mode === 'minor' ? degreeChord(key, 5, -1, 'minor-seventh') : degreeChord(key, 5, -1, style.id === 'funk' || style.id === 'secondline' ? 'dominant' : 'major');
    const V7 = degreeChord(key, 7, 1, 'dominant');
    if (style.id === 'funk' || style.id === 'secondline') {
      if (introBars === 8) {
        chords = chordsPerBar([T, T, T, T, T, T, IV, V7], mt);
        segments = [
          { bars: 2, roles: ['rest', 'rest', 'rest', 'bass'], note: 'Bass-Riff allein (Groove etablieren)' },
          { bars: 2, roles: ['rest', 'stabs', 'stabs', 'bass'], note: 'Offbeat-Stabs kommen dazu' },
          { bars: 2, roles: ['hook', 'fill', 'stabs', 'bass'], note: 'Hook-Motiv aus dem Song (Call & Response)' },
          { bars: 2, roles: ['hits', 'hits', 'hits', 'hits'], note: 'Tutti-Build-up mit Hits, Crescendo', climax: true },
        ];
      } else {
        chords = chordsPerBar([T, T, IV, V7], mt);
        segments = [
          { bars: 2, roles: ['rest', 'stabs', 'stabs', 'bass'], note: 'Bass-Riff + Stabs' },
          { bars: 2, roles: ['hits', 'hits', 'hits', 'hits'], note: 'Tutti-Hits', climax: true },
        ];
      }
    } else if (style.id === 'swing') {
      const VI7 = degreeChord(key, 9, 3, 'dominant');
      const ii7 = degreeChord(key, 2, 2, key.mode === 'minor' ? 'half-diminished' : 'minor-seventh');
      const I6 = key.mode === 'minor' ? buildChord(key.tonicLof, 'minor-sixth') : buildChord(key.tonicLof, 'major-sixth');
      chords = chordsPerBar(fourFour ? [[I6, VI7], [ii7, V7], [I6, VI7], [ii7, V7]] : [I6, VI7, ii7, V7], mt);
      segments = [
        { bars: 2, roles: ['rest', 'comp', 'comp', 'bass'], note: 'Turnaround: Walking Bass + Charleston-Comping' },
        { bars: 2, roles: ['hook', 'fill', 'comp', 'bass'], note: 'Hook-Motiv, Hits zur Melodie' },
      ];
    } else if (style.id === 'ballad') {
      const IVb = key.mode === 'minor' ? degreeChord(key, 5, -1, 'minor') : degreeChord(key, 5, -1, 'major');
      const V = degreeChord(key, 7, 1, 'dominant-sus');
      chords = chordsPerBar([buildChord(key.tonicLof, key.mode === 'minor' ? 'minor' : 'major', ['9']), IVb, buildChord(key.tonicLof, key.mode === 'minor' ? 'minor' : 'major'), V], mt);
      const r1 = ['rest', 'pad', 'pad', 'bass'];
      const r2 = ['pad', 'pad', 'pad', 'bass'];
      r2[hookVoice] = 'hook';
      if (hookVoice === 3) r2[2] = insts[2].bassCapable ? 'bass' : 'pad';
      segments = [
        { bars: 2, roles: r1, note: 'Ruhige Liegeklänge, Bass-Fundament' },
        { bars: 2, roles: r2, note: 'Hook-Motiv solistisch' },
      ];
    } else if (style.id === 'classical') {
      if (introBars === 8 && firstMelody.length >= 3) {
        const subjChords = sliceChords(song, 0, 2);
        const ansChords = transposeChordList(subjChords, 7);
        chords = [
          ...subjChords.map((c) => ({ ...c })),
          ...ansChords.map((c) => ({ ...c, start: c.start + 2 * mt })),
          ...subjChords.map((c) => ({ ...c, start: c.start + 4 * mt })),
          ...ansChords.map((c) => ({ ...c, start: c.start + 6 * mt })),
        ];
        segments = [
          { bars: 2, roles: ['rest', 'rest', 'rest', 'subject'], note: 'Fugato: Thema im Bass' },
          { bars: 2, roles: ['rest', 'rest', 'subject', 'counter'], note: 'Antwort in der Dominante (Tenor)', subjectShift: 7 },
          { bars: 2, roles: ['rest', 'subject', 'counter', 'bass'], note: 'Thema im Alt' },
          { bars: 2, roles: ['subject', 'counter', 'comp', 'bass'], note: 'Antwort im Sopran', subjectShift: 7 },
        ];
      } else {
        const IVc = degreeChord(key, 5, -1, key.mode === 'minor' ? 'minor' : 'major');
        chords = chordsPerBar([buildChord(key.tonicLof, key.mode === 'minor' ? 'minor' : 'major'), IVc, V7, buildChord(key.tonicLof, key.mode === 'minor' ? 'minor' : 'major')], mt);
        segments = [{ bars: 4, roles: ['hits', 'hits', 'hits', 'hits'], note: 'Fanfare (homophon, punktierte Rhythmen)', climax: true }];
      }
    } else {
      // Polka / Marsch
      const I = buildChord(key.tonicLof, key.mode === 'minor' ? 'minor' : 'major');
      if (introBars === 8) {
        chords = chordsPerBar([I, V7, I, V7, I, I, V7, V7], mt);
        segments = [
          { bars: 4, roles: ['hits', 'hits', 'hits', 'hits'], note: 'Fanfare (Tutti)', climax: true },
          { bars: 4, roles: ['rest', 'comp', 'comp', 'bass'], note: 'Begleitung: Bass + Nachschlag' },
        ];
      } else {
        chords = chordsPerBar([I, V7, I, V7], mt);
        segments = [
          { bars: 2, roles: ['hits', 'hits', 'hits', 'hits'], note: 'Fanfare', climax: true },
          { bars: 2, roles: ['rest', 'comp', 'comp', 'bass'], note: 'Begleitung' },
        ];
      }
    }
    const bars = segments.reduce((s, x) => s + x.bars, 0);
    add({ type: 'intro', name: 'Intro', measures: bars, chords, segments, intensity: 0.55, dyn: style.dyn.intro, key, motif: firstMelody });
  }

  // --- Thema (Durchgang 1) ------------------------------------------------
  const themeBlocks = (pass, keyShift, mode) => {
    const firstOfLabel = new Map();
    // Melodie-Solos nur ab Quartett-Funktionen und wenn nicht ausdrücklich „nah am Original“
    const handoff = mode === 'theme' && slots.n >= 3 && Number(opts.adapt ?? 1) >= 1 && slots.lower !== null;
    const featureOrder = slots.n >= 4 ? [2, 1] : [1];
    let featureIdx = 0;
    let featuredLast = false;
    let prevVoice = -1;
    const rotation = [0, 2, 1, 3];
    let rotIdx = 0;
    const res = [];
    sections.forEach((sec, i) => {
      const from = sec.start;
      const to = sec.start + sec.length;
      let melody = transposeEvents(sliceMelody(song, from, to), keyShift);
      const chords = transposeChordList(sliceChords(song, from, to), keyShift);
      const isLast = i === sections.length - 1;
      let mv;
      let roles;
      let type = 'theme';
      let name = `Thema ${sec.label}`;
      let intensity = 0.5;
      let feature = false;
      if (mode === 'theme') {
        // Stimme 1 = Lead/Melodie, immer oben (wie in Verlagsarrangements) …
        mv = 0;
        intensity = { thin: 0.42, build: 0.58, full: 0.78 }[dens.density[i]] ?? 0.5;
        // … außer in den „Melodie-Solos“: ein wiederholter (oder jeder zweite ruhige) Formteil
        // gehört einer anderen Stimme – abwechselnd untere und obere Mittelstimme
        const repeat = sections.slice(0, i).some((x) => x.label === sec.label);
        const calm = dens.density[i] !== 'full';
        const due = dens.byEnergy ? calm && i > 0 && i < sections.length - 1 && !featuredLast : repeat && calm;
        if (handoff && due && melody.length >= sec.length) {
          const cand = featureOrder[featureIdx % featureOrder.length];
          if (melodyFits(melody, insts[cand])) {
            mv = cand;
            feature = true;
            featureIdx++;
          }
        }
        featuredLast = feature;
      } else if (mode === 'trio') {
        mv = 2;
        type = 'trio';
        name = `Trio ${sec.label}`;
        intensity = 0.45;
      } else if (mode === 'variation') {
        mv = i % 2 === 0 ? 2 : 3;
        type = 'variation';
        name = `Variation ${sec.label}`;
        intensity = 0.55;
      } else {
        // Reprise: erst Rollentausch in tiefen Stimmen, letzter Abschnitt = Shout Chorus (Tutti)
        mv = i === 0 ? 3 : i % 2 ? 2 : 1;
        type = 'recap';
        name = `Reprise ${sec.label}`;
        intensity = 0.65;
        if (isLast || (sections.length > 2 && i >= sections.length - 1)) {
          type = 'shout';
          name = `Shout Chorus ${sec.label}`;
          intensity = 0.95;
        }
      }
      // passt die Melodie gar nicht in Stimme 1, übernimmt eine andere Stimme
      if (!melodyFits(melody, insts[mv])) {
        const tryOrder = [mv, ...rotation.filter((x) => x !== mv)];
        mv = tryOrder.find((v) => melodyFits(melody, insts[v])) ?? 0;
      }
      if (mode === 'theme' && !firstOfLabel.has(sec.label)) firstOfLabel.set(sec.label, mv);
      if (type === 'shout') roles = ['tutti', 'tutti', 'tutti', 'bass'];
      else if (mode === 'theme' && mv === 0) roles = densityRoles(dens.density[i], style);
      else if (feature) roles = mv === 2 ? ['fill', 'rest', 'melody', 'bass'] : ['fill', 'melody', 'comp', 'bass'];
      else roles = themeRoles(mv, insts, i + pass);
      if (type === 'shout') mv = 0;
      prevVoice = mv;
      const density = mode === 'theme' ? dens.density[i] : null;
      const block = {
        type,
        name,
        measures: sec.length,
        chords,
        melody,
        melodyVoice: mv,
        density,
        // erste Vorstellung eines Formteils: Melodie exakt wie im Original (Wiedererkennung)
        firstStatement: mode === 'theme' && (firstOfLabel.get(sec.label) === mv && !res.some((x) => x.source.label === sec.label)),
        segments: [{ bars: sec.length, roles, density, susp: density === 'build', note: feature ? `Melodie-Solo: ${insts[mv].name} (Stimme 1 antwortet in den Pausen)` : undefined }],
        feature,
        intensity,
        dyn: style.dyn[type === 'trio' ? 'theme' : type] || style.dyn.theme,
        keyShift,
        key: transposeKey(key, keyShift),
        source: { from, to, label: sec.label },
      };
      if (from === 0 && pickup.length) block.leadIn = transposeEvents(pickup, keyShift);
      res.push(block);
    });
    return res;
  };

  // --- Interlude-Generator ----------------------------------------------------
  const interlude = (nextKeyShift, nextFirstChord, bars = style.id === 'ballad' ? 2 : 4) => {
    const k2 = transposeKey(key, nextKeyShift);
    const target = nextFirstChord || tonicChord(k2, style, false);
    const V = dominantOf(target);
    let list;
    if (bars === 2) list = [tonicChord(key, style), V];
    else if (style.id === 'funk' || style.id === 'secondline') list = [T, T, key.mode === 'minor' ? degreeChord(key, 5, -1, 'minor-seventh') : degreeChord(key, 5, -1, 'dominant'), V];
    else list = [tonicChord(key, style), degreeChord(key, 5, -1, key.mode === 'minor' ? 'minor' : 'major'), tonicChord(key, style), V];
    const chords = chordsPerBar(list, mt);
    let roles;
    let note;
    if (style.id === 'funk' || style.id === 'secondline' || style.id === 'polka') {
      roles = ['riff', 'riff', 'riff', 'bass'];
      note = 'Send-off-Riff (harmonisiert) über Bass-Groove';
    } else if (style.id === 'swing') {
      roles = ['riff', 'riff', 'comp', 'bass'];
      note = 'Send-off-Riff';
    } else {
      roles = ['counter', 'pad', 'pad', 'bass'];
      note = nextKeyShift ? 'Überleitung mit Modulation (Dominante der neuen Tonart)' : 'Überleitung';
    }
    return { type: 'interlude', name: 'Interlude', measures: bars, chords, segments: [{ bars, roles, note }], intensity: 0.6, dyn: style.dyn.interlude, key };
  };

  // --- Solo ----------------------------------------------------------------
  const soloBlock = (overSection = null) => {
    let chords;
    let bars;
    if (overSection) {
      bars = overSection.measures;
      chords = overSection.chords;
    } else if (style.soloOver === 'vamp') {
      bars = length === 'long' ? 16 : 8;
      const IV = key.mode === 'minor' ? degreeChord(key, 5, -1, 'minor-seventh') : degreeChord(key, 5, -1, 'dominant');
      const list = [];
      for (let i = 0; i < bars; i++) list.push(i % 4 === 2 ? IV : T);
      chords = chordsPerBar(list, mt);
    } else {
      // über die Akkorde des ersten Formteils (mind. 8 Takte)
      let from = sections[0].start;
      let to = from;
      let k = 0;
      const maxBars = length === 'long' ? 32 : 16;
      while (k < sections.length && to - from < 8) {
        to = sections[k].start + sections[k].length;
        k++;
      }
      if (to - from > maxBars) to = from + maxBars;
      bars = to - from;
      chords = sliceChords(song, from, to);
    }
    const segs = [];
    if (rotate) {
      const order = [0, 2, 1, 3];
      const segLen = bars >= 16 ? 8 : bars >= 8 ? 4 : bars;
      let i = 0;
      for (let b = 0; b < bars; b += segLen, i++) {
        const sv = order[i % 4];
        segs.push({ bars: Math.min(segLen, bars - b), roles: soloRoles(sv, insts), soloVoice: sv, note: `Solo: ${insts[sv].name}` });
      }
    } else {
      const sv = soloPref ?? 0;
      const open = bars >= 8 ? Math.max(2, Math.floor(bars / 4)) : 0;
      if (open) {
        const r0 = soloRoles(sv, insts).map((r) => (r === 'background' ? 'rest' : r));
        segs.push({ bars: open, roles: r0, soloVoice: sv, note: `Solo ${insts[sv].name}: zuerst nur mit Bass/Groove (Bläser pausieren)` });
      }
      segs.push({ bars: bars - open, roles: soloRoles(sv, insts), soloVoice: sv, note: `Solo geht weiter; Backgrounds: erst Liegeklänge, dann Riffs` });
    }
    return { type: 'solo', name: overSection ? `Solo (${overSection.source.label})` : 'Solo', measures: bars, chords, segments: segs, intensity: 0.6, dyn: style.dyn.solo, key, showChords: true, source: overSection?.source, paraphrase: overSection?.melody || null };
  };

  // --- Coda ----------------------------------------------------------------
  const codaBlock = (keyShift, { withShout = false, compact = false, finalOnly = false } = {}) => {
    const k2 = transposeKey(key, keyShift);
    const tagFrom = Math.max(0, M - 2);
    const tagMel = transposeEvents(sliceMelody(song, tagFrom, M), keyShift);
    const tagChords = transposeChordList(sliceChords(song, tagFrom, M), keyShift);
    const tagBars = M - tagFrom;
    const I = tonicChord(k2, style, style.id !== 'classical' && style.id !== 'polka');
    const finalChord = style.id === 'funk' || style.id === 'secondline' ? buildChord(k2.tonicLof, k2.mode === 'minor' ? 'minor-seventh' : 'dominant', k2.mode === 'minor' ? ['9'] : ['#9']) : style.id === 'swing' ? buildChord(k2.tonicLof, k2.mode === 'minor' ? 'minor-sixth' : 'major-sixth', ['9']) : I;
    const segs = [];
    let chords = [];
    let bars = 0;
    let melody = [];
    if (finalOnly) {
      const fin = [{ start: 0, dur: 2 * mt, chord: finalChord }];
      return { type: 'coda', name: 'Schluss', measures: 2, chords: fin, melody: [], melodyVoice: 0, segments: [{ bars: 2, roles: ['final', 'final', 'final', 'final'], note: 'Schlussakkord' }], intensity: 0.9, dyn: style.dyn.coda, key: k2, keyShift };
    }
    if (withShout) {
      const last = sections[sections.length - 1];
      const shMel = transposeEvents(sliceMelody(song, last.start, last.start + last.length), keyShift);
      const shCh = transposeChordList(sliceChords(song, last.start, last.start + last.length), keyShift);
      chords.push(...shCh);
      melody.push(...shMel);
      bars += last.length;
      segs.push({ bars: last.length, roles: ['tutti', 'tutti', 'tutti', 'bass'], note: `Shout Chorus (${last.label}) – Tutti-Höhepunkt`, shout: true });
    }
    if (style.id !== 'classical') {
      const reps = length === 'short' ? 1 : 2;
      const tagRoles = style.id === 'ballad' ? ['melody', 'pad', 'pad', 'bass'] : ['tutti', 'tutti', 'tutti', 'bass'];
      for (let r = 0; r < reps; r++) {
        chords.push(...tagChords.map((c) => ({ ...c, start: c.start + bars * mt })));
        melody.push(...tagMel.map((n) => ({ ...n, start: n.start + bars * mt })));
        bars += tagBars;
      }
      if (compact && reps > 1) {
        segs.push({ bars: tagBars, roles: tagRoles, note: `Tag: letzte Phrase ${reps}× (Wiederholung)`, repeatTimes: reps });
        for (let r = 1; r < reps; r++) segs.push({ bars: tagBars, roles: tagRoles, copyOfSeg: segs.length - 1 - (r - 1), hidden: true });
      } else segs.push({ bars: reps * tagBars, roles: tagRoles, note: reps > 1 ? 'Tag: letzte Phrase 2× (Steigerung)' : 'Tag' });
    } else {
      const ii = degreeChord(k2, 2, 2, k2.mode === 'minor' ? 'half-diminished' : 'minor');
      const V7 = degreeChord(k2, 7, 1, 'dominant');
      chords.push(...chordsPerBar([[ii, V7]], mt).map((c) => ({ ...c, start: c.start + bars * mt })));
      bars += 1;
      segs.push({ bars: 1, roles: ['hits', 'hits', 'hits', 'hits'], note: 'Kadenz ii–V' });
    }
    chords.push({ start: bars * mt, dur: 2 * mt, chord: finalChord });
    segs.push({ bars: 2, roles: ['final', 'final', 'final', 'final'], note: 'Schlussakkord: Fall-off/Glissando/Shake je nach Instrument' });
    bars += 2;
    return { type: 'coda', name: 'Coda', measures: bars, chords, melody, melodyVoice: 0, segments: segs, intensity: 0.9, dyn: style.dyn.coda, key: k2, keyShift, codaSign: compact && withShout };
  };

  // --- Formablauf: ca. Originallänge -----------------------------------------
  // Jeder Formteil des Liedes genau einmal in Originalreihenfolge. Das Solo ersetzt
  // einen instrumentalen oder wiederholten Mittelteil, der letzte Refrain wird zum
  // Shout Chorus; dazu nur ein kurzes Intro und ein kurzer Schluss.
  const form = { segnoBlock: null, toCodaBlock: null, dsAfterBlock: null, codaBlock: null };
  const dens = sectionDensity(sections, song);
  const theme = themeBlocks(0, 0, 'theme');
  for (const b of theme) b.instrumental = (b.melody || []).length < Math.max(2, b.measures / 2);
  const labelCount = {};
  for (const b of theme) labelCount[b.source.label] = (labelCount[b.source.label] || 0) + 1;
  const seenBefore = (i) => theme.slice(0, i).some((x) => x.source.label === theme[i].source.label);
  const n = theme.length;
  // Shout: letzte Wiederholung des häufigsten Formteils im letzten Drittel, sonst letzter Teil
  let shoutAt = -1;
  if (dens.byEnergy) {
    let best = -1;
    for (let i = Math.floor(n / 2); i < n; i++) if (!theme[i].instrumental && sections[i].energy >= 0.6 && (best < 0 || sections[i].energy >= sections[best].energy)) best = i;
    shoutAt = best;
  } else if (n >= 2) {
    const top = Object.entries(labelCount).sort((x, y) => y[1] - x[1])[0][0];
    for (let i = n - 1; i >= Math.floor((n * 2) / 3); i--) if (theme[i].source.label === top && !theme[i].instrumental) {
      shoutAt = i;
      break;
    }
    if (shoutAt < 0 && !theme[n - 1].instrumental) shoutAt = n - 1;
  }
  // Solo: instrumentaler Mittelteil bevorzugt, sonst eine Wiederholung in der Mitte
  let soloAt = -1;
  if (!noSolo && n >= 3) {
    const mid = (n - 1) / 2;
    const cands = [];
    for (let i = 1; i < n - 1; i++) if (i !== shoutAt) cands.push(i);
    const instr = cands.filter((i) => theme[i].instrumental);
    const reps = cands.filter((i) => seenBefore(i));
    const pickMid = (arr) => arr.sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid))[0];
    if (instr.length) soloAt = pickMid(instr);
    else if (reps.length) soloAt = pickMid(reps);
    else if (n >= 4) soloAt = pickMid(cands);
  }
  const instrumentalRoles = (bars, first) => {
    const funky = style.id === 'funk' || style.id === 'secondline' || style.id === 'polka' || style.id === 'swing';
    const h = Math.max(1, Math.floor(bars / 2));
    if (funky)
      return [
        { bars: h, roles: first ? ['rest', 'stabs', 'stabs', 'bass'] : ['riff', 'riff', 'comp', 'bass'], note: first ? 'Groove: Bass + Stabs' : 'Riff (instrumentaler Teil)' },
        ...(bars - h > 0 ? [{ bars: bars - h, roles: ['riff', 'riff', 'riff', 'bass'], note: 'Riff' }] : []),
      ];
    return [
      { bars: h, roles: ['rest', 'pad', 'pad', 'bass'], note: 'Liegeklänge' },
      ...(bars - h > 0 ? [{ bars: bars - h, roles: ['counter', 'pad', 'pad', 'bass'], note: 'Melodische Überleitung' }] : []),
    ];
  };
  // Hat das Lied selbst ein instrumentales Intro, ersetzt es das generierte Intro
  if (songIn.source === 'audio' && theme.length >= 3) {
    blocks.pop();
    theme[0].name = 'Intro';
  } else if (theme.length && theme[0].instrumental && theme[0].measures >= 2) {
    blocks.pop();
    const t0 = theme[0];
    add({ ...t0, type: 'intro', name: 'Intro', segments: instrumentalRoles(t0.measures, true), intensity: 0.55, dyn: style.dyn.intro, motif: firstMelody });
    theme.shift();
    if (soloAt >= 0) soloAt--;
    if (shoutAt >= 0) shoutAt--;
  }
  theme.forEach((b, i) => {
    if (i === soloAt) {
      const sb = soloBlock(b);
      add(sb);
    } else if (i === shoutAt) {
      add({ ...b, type: 'shout', name: `Shout Chorus ${b.source.label}`, melodyVoice: 0, segments: [{ bars: b.measures, roles: ['tutti', 'tutti', 'tutti', 'bass'], climax: true }], intensity: 0.95, dyn: style.dyn.shout });
    } else if (b.instrumental) {
      add({ ...b, type: 'interlude', name: `Zwischenspiel ${b.source.label}`, segments: instrumentalRoles(b.measures, false), intensity: 0.6, dyn: style.dyn.interlude });
    } else add(b);
  });
  add(codaBlock(0, { finalOnly: true }));

  // Dynamik nach Dichte: Strophe mf (Ballade mp), Aufbau mf, Refrain f
  const LEVELS = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];
  const up = (d, k) => LEVELS[Math.max(0, Math.min(LEVELS.length - 1, LEVELS.indexOf(d) + k))] || d;
  for (const b of blocks) {
    if (b.type !== 'theme' || !b.density) continue;
    const base = style.dyn.theme || 'mf';
    b.dyn = b.density === 'full' ? up(base, 1) : b.density === 'thin' && style.id === 'ballad' ? up(base, -1) : base;
  }
  // Rollen der 4 Funktionen auf die echten Stimmen (2–8) verteilen
  for (const b of blocks) {
    for (const seg of b.segments) {
      seg.slotRoles = seg.roles;
      seg.roles = expandRoles(seg.roles, slots, realInsts, seg.density ?? b.density ?? null);
      if (seg.soloVoice !== undefined && seg.soloVoice !== null) seg.soloVoice = slots.slotVoice[seg.soloVoice] ?? slots.lead;
    }
    if (b.melodyVoice !== undefined && b.melodyVoice !== null) b.melodyVoice = slots.slotVoice[b.melodyVoice] ?? slots.lead;
  }

  // Probenbuchstaben & Taktpositionen
  let bar = 0;
  let letter = 0;
  for (const b of blocks) {
    b.startBar = bar;
    if (b.copyOf !== undefined) b.rehearsal = blocks[b.copyOf].rehearsal; // D.S.-Durchgang: gleiche Buchstaben
    else if (b.type === 'intro') b.rehearsal = null;
    else {
      const n = letter++;
      b.rehearsal = n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(65 + (n % 26)) + (Math.floor(n / 26) + 1);
    }
    bar += b.measures;
    if (!b.key) b.key = key;
    // Segment-Startpositionen
    let s = 0;
    for (const seg of b.segments) {
      seg.startBar = s;
      s += seg.bars;
    }
  }
  return { blocks, song, key, shift, style, insts: realInsts, slots, totalBars: bar, mt, form };
}

export function describeKeyShift(semis) {
  if (!semis) return 'Originaltonart';
  const d = semisToLofDelta(semis);
  void d;
  return `${semis > 0 ? '+' : ''}${semis} Halbtöne (${mod(semis, 12)})`;
}
