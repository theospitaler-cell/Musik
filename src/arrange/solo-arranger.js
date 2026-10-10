// Solo-Noten zum Mitspielen (Play-along): EINE Stimme – Instrument oder Schlagzeug –
// 1:1 wie die Vorlage. Gleiche Taktzahl, gleicher Ablauf, gleiche Tonhöhen (nur eine
// Oktavlage für das Instrument), gleiches Tempo/Timing – kein zusätzliches Intro,
// keine Umstellung. Beim Schlagzeug kommen auf Wunsch Fills dazu, die im Groove bleiben.
import { DIV } from '../core/constants.js';
import { Rng } from '../core/rng.js';
import { keyName, keyNameDe } from '../theory/keys.js';
import { normalizeChords, songMeasureTicks } from '../model/song.js';
import { getStyle } from './styles.js';
import { getInstrument, withRange, fitOctave } from './instruments.js';
import { ROLE_NAMES } from './planner.js';
import { difficultyRange, levelFor, simplifyRhythm, limitLeaps, simplifyDrums } from './difficulty.js';
import { BlockCtx, cleanLine, ev } from './context.js';
import { articulate } from './gen/melody.js';
import { genDrumsSegment, drumsFromNotes, addGrooveFills } from './gen/drums.js';
import {
  enforceRange,
  insertBreaths,
  applyDynamics,
  spellAll,
  simplifyForReading,
  addPerformanceMarks,
  tempoHeading,
  newReport,
  keyAtFactory,
} from './post.js';

function letterOf(n) {
  return n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(65 + (n % 26)) + (Math.floor(n / 26) + 1);
}

export function arrangeSolo(song, opts) {
  const style = getStyle(opts.style);
  const isDrums = opts.soloInstrument === 'drums';
  const lv = levelFor({ difficulty: opts.difficulty, voiceDifficulty: opts.voiceDifficulty }, 0);
  const instId = isDrums ? null : opts.soloInstrument || 'trumpet';
  const key = song.key; // keine Transposition: klingt wie die Datei
  const mt = songMeasureTicks(song);
  const M = song.measureCount;
  const rng = new Rng(opts.seed || 1);
  // Tempo wie die Vorlage (zum Üben gibt es den Tempo-Regler im Player)
  const tempo = Math.round(song.tempo || style.defaultTempo);
  const compound = song.meter.beatType === 8 && song.meter.beats % 3 === 0 && song.meter.beats > 3;
  const beat = compound ? (DIV * 3) / 2 : (DIV * 4) / song.meter.beatType;
  const inst = isDrums ? null : withRange(difficultyRange(getInstrument(instId), lv), opts.ranges ? opts.ranges[0] : null);
  // Auftakt -> eigener Vorlauf-Takt, danach Takt 1 der Vorlage
  const leadBars = song.pickup > 0 ? Math.ceil(song.pickup / mt) : 0;
  const off = leadBars * mt;
  const totalBars = M + leadBars;
  const sections = song.sections.length ? song.sections : [{ label: 'A', start: 0, length: M }];

  // ---- Formteile = Abschnitte der Vorlage (nur Probenbuchstaben, keine Umstellung) ----
  const blocks = [];
  if (leadBars) blocks.push({ type: 'intro', name: 'Auftakt', heading: '', measures: leadBars, startBar: 0, rehearsal: null, dyn: style.dyn.theme, intensity: 0.5, key, keyShift: 0 });
  sections.forEach((sec, i) => {
    blocks.push({
      type: 'theme',
      name: `Teil ${sec.label}`,
      heading: sec.label !== letterOf(i) ? `wie ${sec.label}` : '',
      label: sec.label,
      measures: sec.length,
      startBar: leadBars + sec.start,
      rehearsal: letterOf(i),
      dyn: style.dyn.theme,
      intensity: 0.6,
      key,
      keyShift: 0,
      source: sec,
    });
  });
  const songChords = normalizeChords(song.chords, M * mt);
  for (const b of blocks) {
    const a = (b.startBar - leadBars) * mt;
    const e = a + b.measures * mt;
    b.chords = normalizeChords(
      songChords.filter((c) => c.start < e && c.start + c.dur > a).map((c) => ({ start: Math.max(0, c.start - a), dur: Math.min(e, c.start + c.dur) - Math.max(a, c.start), chord: c.chord })),
      b.measures * mt,
    );
    if (!b.chords.length && songChords.length) b.chords = [{ start: 0, dur: b.measures * mt, chord: songChords[0].chord }];
    b.segments = [{ bars: b.measures, roles: [isDrums ? 'rest' : 'melody'], startBar: 0 }];
  }
  const chordTrack = normalizeChords(
    songChords.map((c) => ({ ...c, start: c.start + off })).concat(leadBars && songChords.length ? [{ start: 0, dur: off, chord: songChords[0].chord }] : []),
    totalBars * mt,
  );

  // ---- Stimme ----
  const voices = [];
  let octave = 0;
  if (!isDrums) {
    const mel = song.melody.filter((n) => n.start + off >= 0 && n.start < M * mt);
    octave = fitOctave(mel, inst).shift; // eine Oktavlage für das ganze Stück
    const ctx = new BlockCtx({ style, rng: rng.fork('mel'), key, meter: song.meter, measures: totalBars, chords: chordTrack, tempo, inst: [inst], block: blocks[0], prevState: [{}] });
    let line = cleanLine(mel.map((n) => ev(n.start + off, n.dur, n.midi + octave, n.lof)));
    articulate(ctx, line, inst);
    line = line.map((e) => ({ ...e, role: 'melody' }));
    voices.push({ inst, events: line, dirs: [], label: 'Solo' });
  }

  // ---- Schlagzeug ----
  let drumEvents = [];
  let drumSource = null;
  if (isDrums) {
    const total = totalBars * mt;
    if (song.drumNotes && song.drumNotes.length) {
      drumEvents = drumsFromNotes(song.drumNotes, { offset: off, totalTicks: total, beat });
      drumSource = song.source === 'audio' ? 'audio' : 'file';
    }
    if (!drumEvents.length) {
      // Vorlage ohne Schlagzeug: Stil-Groove über exakt dieselben Takte
      drumSource = 'style';
      sections.forEach((sec, i) => {
        const ctx = new BlockCtx({ style, rng: rng.fork(`d${i}`), key, meter: song.meter, measures: sec.length, chords: [], tempo, inst: [null], block: blocks[0], prevState: [{}] });
        const evs = genDrumsSegment(ctx, { mode: 'groove', bars: sec.length, isBlockStart: true, isBlockEnd: i < sections.length - 1, intensity: 0.6 });
        drumEvents.push(...evs.map((e) => ({ ...e, start: e.start + (leadBars + sec.start) * mt })));
      });
      // Letzter Takt: Schlussschlag (Crash + Bass Drum auf "1"), kein Fill ins Leere
      const lastBar = (totalBars - 1) * mt;
      drumEvents = drumEvents.filter((e) => e.start < lastBar);
      const fin = genDrumsSegment(new BlockCtx({ style, rng: rng.fork('fin'), key, meter: song.meter, measures: 1, chords: [], tempo, inst: [null], block: blocks[0], prevState: [{}] }), { mode: 'final', bars: 1, isBlockStart: false, isBlockEnd: true, hitsLine: [{ start: 0, dur: mt, finalHit: true }], intensity: 1 });
      drumEvents.push(...fin.map((e) => ({ ...e, start: e.start + lastBar })));
    } else if (opts.drumFills !== false && lv !== 1) {
      // Fills im Groove: am Ende jedes Formteils (2 Schläge) und nach 8-Takt-Phrasen (1 Schlag)
      const fillBars = [];
      sections.forEach((sec, i) => {
        const s0 = leadBars + sec.start;
        for (let k = 7; k < sec.length - 1; k += 8) fillBars.push({ bar: s0 + k, beats: 1 });
        if (i < sections.length - 1) fillBars.push({ bar: s0 + sec.length - 1, beats: lv && lv <= 2 ? 1 : 2 });
      });
      drumEvents = addGrooveFills(drumEvents, { mt, beat, fillBars, lv });
    }
  }

  // ---- Nachbearbeitung (ohne Verzierungen – Töne & Rhythmus bleiben wie in der Vorlage) ----
  const report = newReport();
  const arr = { voices, blocks, mt, beat, style, rng: rng.fork('post'), chordTrack, keyAt: keyAtFactory(blocks, mt), tempo, levels: [lv] };
  for (const v of voices) {
    enforceRange(v.events, v.inst, report);
    if (lv && lv < 4) {
      v.events = limitLeaps(simplifyRhythm(v.events, lv, mt, beat), lv, v.inst);
      enforceRange(v.events, v.inst, report);
    }
    insertBreaths(v, v.inst, tempo, report, lv && lv <= 2 ? 0.75 : 1);
  }
  applyDynamics(arr);
  simplifyForReading(arr, song.meter);
  addPerformanceMarks(arr);
  spellAll(arr);
  for (const v of voices) v.dirs.sort((a, b) => a.t - b.t);
  const drums = isDrums ? { name: 'Schlagzeug', events: dedupeDrums(simplifyDrums(drumEvents, lv)), dirs: [] } : null;
  if (drums) addPerformanceMarks({ ...arr, voices: [] }, drums);
  // Pausentakte dürfen nicht "sim." bekommen – leere Takte bleiben leer
  const th = tempoHeading(style, tempo);
  const warnings = [];
  if (drumSource === 'style') warnings.push('Die Vorlage enthält kein Schlagzeug – der Groove ist im gewählten Stil über exakt dieselben Takte geschrieben.');
  if (drumSource === 'audio') warnings.push('Schlagzeug aus der Aufnahme erkannt (Bass Drum, Snare, Hi-Hat je Formteil) – bitte mit dem Original anhören.');
  if (!isDrums && octave) warnings.push(`Melodie für ${inst.name} um ${Math.abs(octave / 12)} Oktave${Math.abs(octave) > 12 ? 'n' : ''} ${octave > 0 ? 'höher' : 'tiefer'} gesetzt (gleiche Töne wie die Vorlage).`);
  report.notes = (report.notes || []).concat(warnings);
  return {
    meta: {
      title: song.title,
      composer: song.composer,
      arranger: 'Play-along: NoteCode',
      subtitle: `Solo für ${isDrums ? 'Schlagzeug' : inst.name} – Originalablauf`,
      keyName: keyName(key),
      keyNameDe: keyNameDe(key),
      tempo,
      tempoText: th.text,
      styleHint: th.hint,
      swing: !!song.swing || style.feel === 'swing8',
    },
    song,
    style,
    key,
    meter: song.meter,
    mt,
    beat,
    tempo,
    tempoMap: arr.tempoMap,
    totalBars,
    voices,
    drums,
    blocks,
    chordTrack,
    keyAt: arr.keyAt,
    keyChanges: [{ bar: 0, key }],
    transposeShift: 0,
    form: { repeats: [], segnoBar: null, toCodaBar: null, dsBar: null, skip: null, codaBar: null },
    report,
    options: opts,
    levels: [lv],
    soloMode: true,
    playAlong: true,
    // Zeitbezug zur Vorlage: Takt "leadBars" = Takt 1 der Datei
    sourceOffset: off,
    timing: song.timing || null,
    backing: playAlongBacking(song, off, isDrums),
    roleNames: ROLE_NAMES,
  };
}

// Original zum Mitspielen: Audio (über song.timing synchron) oder die Noten aller Spuren
function playAlongBacking(song, off, isDrums) {
  if (song.source === 'audio') return { kind: 'audio' };
  const notes = (song.backing?.notes || []).map((n) => ({ ...n, start: n.start + off }));
  const drums = (song.drumNotes || []).map((n) => ({ ...n, start: n.start + off }));
  if (!notes.length && !drums.length) return null;
  void isDrums;
  return { kind: 'notes', notes, drums };
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
