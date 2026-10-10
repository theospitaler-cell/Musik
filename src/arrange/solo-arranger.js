// Solo-Noten: Fassung für EIN Instrument (melodisch) oder ein Schlagzeug-Solo-Chart.
// Form: Intro (Hook) – Thema (mit eigenen Fill-Ins) – Variation – ausgeschriebenes
// Solo über die Akkorde – Reprise als Höhepunkt – Coda.
import { DIV } from '../core/constants.js';
import { Rng } from '../core/rng.js';
import { buildChord } from '../theory/chords.js';
import { keyName, keyNameDe } from '../theory/keys.js';
import {
  normalizeChords,
  sliceMelody,
  sliceChords,
  songMeasureTicks,
  pickupNotes,
  transposeSong,
} from '../model/song.js';
import { getStyle } from './styles.js';
import { getInstrument, withRange } from './instruments.js';
import { chooseTransposition, ROLE_NAMES } from './planner.js';
import { difficultyRange, levelFor, simplifyRhythm, limitLeaps, simplifyDrums } from './difficulty.js';
import { BlockCtx, cleanLine, shiftEvents, ev, addArt, placePc } from './context.js';
import { placeMelody } from './gen/melody.js';
import { genCounter } from './gen/counter.js';
import { genSolo } from './gen/solo.js';
import { genDrumsSegment, genDrumSolo, genDrumHits } from './gen/drums.js';
import {
  enforceRange,
  insertBreaths,
  decorate,
  applyDynamics,
  spellAll,
  simplifyForReading,
  addPerformanceMarks,
  tempoHeading,
  newReport,
  keyAtFactory,
} from './post.js';

function chordsPerBar(list, mt) {
  return list.map((c, i) => ({ start: i * mt, dur: mt, chord: c }));
}

// Fill-Ins in Melodie-Lücken in dieselbe Linie einbauen (Solist füllt selbst)
function mergeFills(mel, fills, beat) {
  const out = mel.map((e) => ({ ...e, art: [...e.art], fx: [...e.fx] }));
  const attacks = out.map((e) => e.start);
  const keep = [];
  for (const f of fills) {
    const end = f.start + f.dur;
    if (attacks.some((a) => a >= f.start && a < end)) continue; // nie in eine Melodienote hinein
    const held = out.find((m) => m.start < f.start && m.start + m.dur > f.start);
    if (held) {
      if (f.start - held.start < beat) continue; // Melodieton soll erst klingen
      held.dur = f.start - held.start;
    }
    keep.push({ ...f, role: 'fill' });
  }
  return cleanLine([...out, ...keep]);
}

export function arrangeSolo(songIn, opts) {
  const style = getStyle(opts.style);
  const isDrums = opts.soloInstrument === 'drums';
  const lv = levelFor({ difficulty: opts.difficulty, voiceDifficulty: opts.voiceDifficulty }, 0);
  const instId = isDrums ? null : opts.soloInstrument || 'trumpet';
  const shift = isDrums ? 0 : chooseTransposition(songIn, [instId], opts);
  const song = transposeSong(songIn, shift);
  const key = song.key;
  const mt = songMeasureTicks(song);
  const M = song.measureCount;
  const length = opts.length || 'normal';
  const rng = new Rng(opts.seed || 1);
  let tempo = opts.tempo || null;
  if (!tempo && song.tempo && style.tempoRange && song.tempo >= style.tempoRange[0] && song.tempo <= style.tempoRange[1]) tempo = song.tempo;
  tempo = Math.round(tempo || style.defaultTempo);
  const beat = song.meter.beatType === 8 && song.meter.beats % 3 === 0 && song.meter.beats > 3 ? (DIV * 3) / 2 : (DIV * 4) / song.meter.beatType;
  const inst = isDrums ? null : withRange(difficultyRange(getInstrument(instId), lv), opts.ranges ? opts.ranges[0] : null);
  const sections = song.sections.length ? song.sections : [{ label: 'A', start: 0, length: M }];
  const T = buildChord(key.tonicLof, key.mode === 'minor' ? 'minor' : style.id === 'funk' || style.id === 'secondline' ? 'dominant' : 'major');
  const V7 = buildChord(key.tonicLof + 1, 'dominant');
  const withImpro = opts.solo !== 'none' && length !== 'short';

  // ---- Formplan ----
  const blocks = [];
  const add = (b) => blocks.push({ keyShift: 0, key, intensity: 0.55, ...b });
  const introBars = length === 'short' ? 2 : 4;
  const motif = sliceMelody(song, 0, Math.min(2, M));
  add({
    type: 'intro',
    name: 'Intro',
    measures: introBars,
    chords: chordsPerBar(introBars === 2 ? [T, V7] : [T, T, T, V7], mt),
    role: isDrums ? 'groove-build' : 'hook',
    dyn: style.dyn.intro,
  });
  sections.forEach((sec) => {
    add({
      type: 'theme',
      name: `Thema ${sec.label}`,
      measures: sec.length,
      chords: sliceChords(song, sec.start, sec.start + sec.length),
      melody: sliceMelody(song, sec.start, sec.start + sec.length),
      role: isDrums ? 'groove' : 'melody',
      source: sec,
      dyn: style.dyn.theme,
      leadIn: sec.start === 0 ? pickupNotes(song) : null,
    });
  });
  if (length !== 'short') {
    sections.forEach((sec, i) => {
      if (length === 'normal' && i > 0 && sections.length > 2 && i !== sections.length - 1) return;
      add({
        type: 'variation',
        name: `Variation ${sec.label}`,
        measures: sec.length,
        chords: sliceChords(song, sec.start, sec.start + sec.length),
        melody: sliceMelody(song, sec.start, sec.start + sec.length),
        role: isDrums ? 'groove-hot' : 'melodyVar',
        source: sec,
        intensity: 0.7,
        dyn: style.dyn.variation || style.dyn.theme,
      });
    });
  }
  if (withImpro) {
    const bars = Math.min(length === 'long' ? 16 : 8, Math.max(8, sections[0].length));
    let chords = sliceChords(song, sections[0].start, sections[0].start + Math.min(bars, M));
    if (sections[0].length < bars) {
      const more = sliceChords(song, 0, Math.min(M, bars));
      chords = more;
    }
    add({ type: 'solo', name: isDrums ? 'Drum-Solo' : 'Solo', measures: bars, chords, role: isDrums ? 'drumsolo' : 'solo', intensity: 0.75, dyn: style.dyn.solo === 'mp' ? 'mf' : style.dyn.solo, showChords: true });
  }
  const last = sections[sections.length - 1];
  if (length !== 'short') {
    add({
      type: 'shout',
      name: `Reprise ${last.label}`,
      measures: last.length,
      chords: sliceChords(song, last.start, last.start + last.length),
      melody: sliceMelody(song, last.start, last.start + last.length),
      role: isDrums ? 'hits' : 'melodyClimax',
      source: last,
      intensity: 0.95,
      dyn: style.dyn.shout,
    });
  }
  const tagFrom = Math.max(0, M - 2);
  add({
    type: 'coda',
    name: 'Coda',
    measures: M - tagFrom + 2,
    chords: [...sliceChords(song, tagFrom, M), { start: (M - tagFrom) * mt, dur: 2 * mt, chord: buildChord(key.tonicLof, key.mode === 'minor' ? 'minor' : 'major') }],
    melody: sliceMelody(song, tagFrom, M),
    role: isDrums ? 'hits' : 'melody',
    tagBars: M - tagFrom,
    intensity: 0.9,
    dyn: style.dyn.coda,
  });
  let bar = 0;
  let letter = 0;
  for (const b of blocks) {
    b.startBar = bar;
    b.rehearsal = b.type === 'intro' ? null : String.fromCharCode(65 + (letter++ % 26));
    b.chords = normalizeChords(b.chords, b.measures * mt);
    // Segmente (für Notensatz/Dynamik): eine Rolle pro Stimme
    const roleName = b.role === 'melodyVar' || b.role === 'melodyClimax' ? 'melody' : b.role;
    if (b.type === 'coda' && !isDrums) b.segments = [{ bars: b.tagBars, roles: ['melody'], startBar: 0 }, { bars: 2, roles: ['final'], startBar: b.tagBars }];
    else b.segments = [{ bars: b.measures, roles: [isDrums ? 'rest' : roleName], startBar: 0, climax: b.type === 'shout' }];
    bar += b.measures;
  }
  const totalBars = bar;

  // ---- Generierung ----
  const voices = isDrums ? [] : [{ inst, events: [], dirs: [], label: 'Solo' }];
  const drumEvents = [];
  const chordTrack = [];
  const prevState = [{}];
  const songMotif = motif;
  const adapt = opts.adapt ?? 1;
  const easy = lv !== null && lv <= 2;
  for (const [bi, b] of blocks.entries()) {
    const t0 = b.startBar * mt;
    for (const c of b.chords) chordTrack.push({ start: c.start + t0, dur: c.dur, chord: c.chord });
    const ctx = new BlockCtx({ style, rng: rng.fork(`s${bi}`), key, meter: song.meter, measures: b.measures, chords: b.chords, tempo, inst: [inst], block: b, intensity: b.intensity, songMotif, prevState });
    ctx.melodyVoice = 0;
    if (isDrums) {
      let evs;
      if (b.role === 'drumsolo') evs = genDrumSolo(ctx, b.measures);
      else if (b.role === 'hits') {
        evs = genDrumHits(ctx, b.melody || [], b.measures);
        if (b.type === 'coda') evs = evs.filter((e) => e.start < (b.measures - 2) * mt).concat(genDrumsSegment(ctx, { mode: 'final', bars: 2, isBlockStart: false, isBlockEnd: true, hitsLine: [{ start: 0, dur: mt }, { start: mt, dur: 12, finalHit: true }], intensity: 1 }).map((e) => ({ ...e, start: e.start + (b.measures - 2) * mt })));
      } else {
        const hot = b.role === 'groove-hot';
        ctx.intensity = hot ? 0.85 : b.role === 'groove-build' ? 0.4 : 0.6;
        evs = genDrumsSegment(ctx, { mode: 'groove', bars: b.measures, isBlockStart: b.type !== 'intro', isBlockEnd: true, intensity: ctx.intensity });
        if (b.role === 'groove-build') evs = evs.filter((e) => e.start >= mt || ['hh', 'ride', 'hhPedal'].includes(e.drum));
      }
      drumEvents.push(...evs.map((e) => ({ ...e, start: e.start + t0 })));
      continue;
    }
    let line = [];
    if (b.role === 'hook') {
      line = placeMelody(ctx, 0, songMotif, { adapt: Math.max(1, adapt) }).line;
      if (b.measures > 2) {
        const sctx = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { chords: normalizeChords(sliceChordsRel(b.chords, 2 * mt, b.measures * mt), (b.measures - 2) * mt), measures: b.measures - 2, len: (b.measures - 2) * mt });
        line = line.concat(shiftEvents(genSolo(sctx, 0, { lyrical: true }), 2 * mt));
      }
    } else if (b.role === 'melody' || b.role === 'melodyVar' || b.role === 'melodyClimax') {
      const climax = b.role === 'melodyClimax';
      const placed = placeMelody(ctx, 0, b.melody || [], { adapt: b.role === 'melodyVar' ? 2 : adapt, climax, preferUp: climax || b.role === 'melodyVar' });
      line = placed.line;
      b.melodyShift = placed.shift;
      if (!easy) {
        ctx.melodyLine = line;
        const fills = genCounter(ctx, 0, line, { mode: 'fill', above: false });
        line = mergeFills(line, fills, beat);
      }
      if (b.type === 'coda') {
        // Schlusston
        const fin = b.tagBars * mt;
        line = line.filter((e) => e.start < fin);
        const ch = b.chords[b.chords.length - 1].chord;
        const target = Math.round((inst.comfort[0] + inst.comfort[1]) / 2 + (style.id === 'ballad' ? 0 : 4));
        const m = placePc(ch.rootPc, target, inst.comfort[0], inst.range[1] - 1);
        const hold = ev(fin, style.id === 'ballad' || style.id === 'classical' ? 2 * mt : mt - beat / 2, m, ch.rootLof);
        hold.finalHold = true;
        hold.role = 'final';
        line.push(hold);
        if (!(style.id === 'ballad' || style.id === 'classical')) {
          const hit = ev(fin + mt, beat / 2, m, ch.rootLof);
          addArt(hit, 'accent');
          addArt(hit, 'staccato');
          hit.finalHit = true;
          hit.role = 'final';
          line.push(hit);
        }
      }
    } else if (b.role === 'solo') {
      line = genSolo(ctx, 0, { lyrical: easy || style.id === 'ballad' || style.id === 'classical' });
    }
    const roleName = b.role === 'melodyVar' || b.role === 'melodyClimax' ? 'melody' : b.role;
    voices[0].events.push(...shiftEvents(line, t0).map((e) => ({ ...e, role: e.role || roleName })));
  }
  // Auftakt ins Intro-Ende
  if (!isDrums) {
    const th = blocks.find((b) => b.leadIn && b.leadIn.length);
    if (th) {
      const start = th.startBar * mt;
      const notes = th.leadIn.map((n) => ({ start: start + n.start, dur: n.dur, pitches: [n.midi + (th.melodyShift || 0)], lofs: [n.lof], art: [], fx: [], role: 'melody' }));
      const from = Math.min(...notes.map((n) => n.start));
      const v = voices[0];
      v.events = v.events.filter((e) => !(e.start >= from && e.start < start)).map((e) => (e.start < from && e.start + e.dur > from ? { ...e, dur: from - e.start } : e));
      v.events.push(...notes);
    }
  }

  // ---- Nachbearbeitung ----
  const report = newReport();
  for (const v of voices) v.events = cleanLine(v.events);
  const arr = { voices, blocks, mt, beat, style, rng: rng.fork('post'), chordTrack: normalizeChords(chordTrack, totalBars * mt), keyAt: keyAtFactory(blocks, mt), tempo, levels: [lv] };
  for (const v of voices) {
    enforceRange(v.events, v.inst, report);
    if (lv && lv < 4) {
      v.events = limitLeaps(simplifyRhythm(v.events, lv, mt, beat), lv, v.inst);
      enforceRange(v.events, v.inst, report);
    }
    insertBreaths(v, v.inst, tempo, report, easy ? 0.75 : 1);
  }
  decorate(arr, report);
  applyDynamics(arr);
  simplifyForReading(arr, song.meter);
  addPerformanceMarks(arr);
  spellAll(arr);
  for (const v of voices) v.dirs.sort((a, b) => a.t - b.t);
  const drums = isDrums ? { name: 'Schlagzeug', events: dedupeDrums(simplifyDrums(drumEvents, lv)), dirs: [] } : null;
  if (drums) addPerformanceMarks({ ...arr, voices: [] }, drums);
  const th = tempoHeading(style, tempo);
  return {
    meta: {
      title: song.title,
      composer: song.composer,
      arranger: 'Arr.: NoteCode',
      subtitle: `${style.name} – Solo für ${isDrums ? 'Schlagzeug' : inst.name}`,
      keyName: keyName(song.key),
      keyNameDe: keyNameDe(song.key),
      tempo,
      tempoText: th.text,
      styleHint: th.hint,
      swing: style.feel === 'swing8',
    },
    song,
    style,
    key: song.key,
    meter: song.meter,
    mt,
    beat,
    tempo,
    tempoMap: arr.tempoMap,
    totalBars,
    voices,
    drums,
    blocks,
    chordTrack: arr.chordTrack,
    keyAt: arr.keyAt,
    keyChanges: [{ bar: 0, key }],
    transposeShift: shift,
    form: { repeats: [], segnoBar: null, toCodaBar: null, dsBar: null, skip: null, codaBar: null },
    report,
    options: opts,
    levels: [lv],
    soloMode: true,
    roleNames: ROLE_NAMES,
  };
}

function sliceChordsRel(chords, a, b) {
  const out = [];
  for (const c of chords) {
    const s = Math.max(a, c.start);
    const e = Math.min(b, c.start + c.dur);
    if (e > s) out.push({ start: s - a, dur: e - s, chord: c.chord });
  }
  return out;
}

function dedupeDrums(events) {
  const seen = new Set();
  return events
    .sort((a, b) => a.start - b.start)
    .filter((e) => {
      const k = `${e.start}:${e.pitches[0]}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}
