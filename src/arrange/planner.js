// Formplanung & Rollenverteilung ("Regieplan").
import { mod } from '../core/constants.js';
import { buildChord, transposeChord } from '../theory/chords.js';
import { transposeKey } from '../theory/keys.js';
import { semisToLofDelta } from '../theory/pitch.js';
import { getInstrument, fitOctave } from './instruments.js';
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
  if (!transposing.length) return 0;
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
  return f.outOfRange === 0 && f.penalty < 3;
}

function soloIndex(opt) {
  if (opt === 'none' || opt === 'rotate') return null;
  const n = typeof opt === 'number' ? opt : Number(String(opt).replace(/\D/g, '')) - 1;
  return Number.isFinite(n) && n >= 0 && n < 4 ? n : 0;
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

// ---- Hauptfunktion -----------------------------------------------------
export function planArrangement(songIn, opts) {
  const style = getStyle(opts.style);
  const insts = opts.voices.map(getInstrument);
  const shift = chooseTransposition(songIn, opts.voices, opts);
  const song = transposeSong(songIn, shift);
  const key = song.key;
  const mt = songMeasureTicks(song);
  const M = song.measureCount;
  const length = opts.length || 'normal';
  const soloPref = soloIndex(opts.solo ?? 0);
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
  const introBars = length === 'short' ? 4 : style.id === 'ballad' || style.id === 'swing' ? 4 : 8;
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
      if (mode === 'theme') {
        if (i === 0) mv = 0;
        else if (!firstOfLabel.has(sec.label)) {
          // neue Formteil-Farbe: Solist oder Tenor
          mv = soloPref !== null && soloPref !== 0 && ![...firstOfLabel.values()].includes(soloPref) ? soloPref : rotation[(++rotIdx) % 4];
        } else {
          mv = rotation[(++rotIdx) % 4];
        }
        if (mv === prevVoice) mv = rotation[(++rotIdx) % 4];
        intensity = 0.45 + 0.1 * (i / Math.max(1, sections.length - 1));
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
      // passt die Melodie in das Instrument?
      const tryOrder = [mv, ...rotation.filter((x) => x !== mv)];
      mv = tryOrder.find((v) => melodyFits(melody, insts[v])) ?? 0;
      if (mode === 'theme' && !firstOfLabel.has(sec.label)) firstOfLabel.set(sec.label, mv);
      if (type === 'shout') roles = ['tutti', 'tutti', 'tutti', 'bass'];
      else roles = themeRoles(mv, insts, i + pass);
      // Steigerung: im allerersten Themenabschnitt setzt eine Nebenstimme aus
      if (mode === 'theme' && i === 0 && sections.length >= 2) {
        const idle = roles.findIndex((r, k) => k !== mv && (r === 'counter' || r === 'fill'));
        if (idle >= 0) roles = roles.map((r, k) => (k === idle ? 'rest' : r));
      }
      if (type === 'shout') mv = 0;
      prevVoice = mv;
      const block = {
        type,
        name,
        measures: sec.length,
        chords,
        melody,
        melodyVoice: mv,
        segments: [{ bars: sec.length, roles }],
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
  const soloBlock = () => {
    let chords;
    let bars;
    if (style.soloOver === 'vamp') {
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
        segs.push({ bars: Math.min(segLen, bars - b), roles: soloRoles(sv, insts), soloVoice: sv, note: `Solo: Stimme ${sv + 1} (${insts[sv].name})` });
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
    return { type: 'solo', name: 'Solo', measures: bars, chords, segments: segs, intensity: 0.6, dyn: style.dyn.solo, key, showChords: true };
  };

  // --- Coda ----------------------------------------------------------------
  const codaBlock = (keyShift, { withShout = false, compact = false } = {}) => {
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

  // --- Formablauf je Länge & Stil ------------------------------------------
  const compact = opts.form !== 'full';
  const firstChordOfSong = song.chords[0]?.chord || T;
  const form = { segnoBlock: null, toCodaBlock: null, dsAfterBlock: null, codaBlock: null };
  // D.S. al Coda: Rücksprung zum Segno (Thema), bei "To Coda" in die Coda
  const addDsReturn = (themeIdx) => {
    if (!themeIdx.length) return false;
    const upto = themeIdx.length >= 2 ? themeIdx.length - 1 : themeIdx.length;
    form.segnoBlock = themeIdx[0];
    form.toCodaBlock = themeIdx[upto - 1];
    form.dsAfterBlock = blocks.length - 1;
    for (let k = 0; k < upto; k++) {
      const src = blocks[themeIdx[k]];
      add({ ...src, copyOf: themeIdx[k], name: `${src.name} (D.S.)`, segments: src.segments.map((x) => ({ ...x })) });
    }
    return themeIdx.length >= 2;
  };
  const themeIdx = [];
  for (const b of themeBlocks(0, 0, 'theme')) {
    add(b);
    themeIdx.push(blocks.length - 1);
  }
  if (length === 'short') {
    add(codaBlock(0, { compact }));
  } else if (style.id === 'polka') {
    const trioShift = style.modulateTrio || 5;
    const trioFirst = transposeChord(firstChordOfSong, trioShift);
    add(interlude(trioShift, trioFirst, 4));
    for (const b of themeBlocks(1, trioShift, 'trio')) add(b);
    if (!noSolo && length === 'long') add(soloBlock());
    if (compact) {
      const shoutInCoda = addDsReturn(themeIdx);
      add(codaBlock(0, { withShout: shoutInCoda, compact }));
      form.codaBlock = blocks.length - 1;
    } else {
      add(interlude(0, firstChordOfSong, 4));
      for (const b of themeBlocks(2, 0, 'recap')) add(b);
      add(codaBlock(0, { compact }));
    }
  } else {
    add(interlude(0, firstChordOfSong));
    if (length === 'long') for (const b of themeBlocks(1, 0, 'variation')) add(b);
    if (!noSolo) add(soloBlock());
    else if (length !== 'long') for (const b of themeBlocks(1, 0, 'variation')) add(b);
    const mod = opts.modulate !== false && style.modulateFinal ? style.modulateFinal : 0;
    if (compact && !mod && length !== 'long') {
      const shoutInCoda = addDsReturn(themeIdx);
      add(codaBlock(0, { withShout: shoutInCoda, compact }));
      form.codaBlock = blocks.length - 1;
    } else {
      if (mod) add(interlude(mod, transposeChord(firstChordOfSong, mod), 2));
      // Reprise: bei langen Songs nur die letzten Abschnitte
      const recap = themeBlocks(2, mod, 'recap');
      const keep = length === 'long' ? recap : recap.slice(-Math.min(recap.length, M > 32 ? 2 : 3));
      for (const b of keep) add(b);
      add(codaBlock(mod, { compact }));
    }
  }

  // Probenbuchstaben & Taktpositionen
  let bar = 0;
  let letter = 0;
  for (const b of blocks) {
    b.startBar = bar;
    if (b.copyOf !== undefined) b.rehearsal = blocks[b.copyOf].rehearsal; // D.S.-Durchgang: gleiche Buchstaben
    else b.rehearsal = b.type === 'intro' ? null : String.fromCharCode(65 + (letter++ % 26));
    bar += b.measures;
    if (!b.key) b.key = key;
    // Segment-Startpositionen
    let s = 0;
    for (const seg of b.segments) {
      seg.startBar = s;
      s += seg.bars;
    }
  }
  return { blocks, song, key, shift, style, insts, totalBars: bar, mt, form };
}

export function describeKeyShift(semis) {
  if (!semis) return 'Originaltonart';
  const d = semisToLofDelta(semis);
  void d;
  return `${semis > 0 ? '+' : ''}${semis} Halbtöne (${mod(semis, 12)})`;
}
