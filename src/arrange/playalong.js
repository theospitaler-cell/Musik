// Solo-Noten mit Playback (Play-along): Stimmen 1:1 aus der Vorlage.
// Gleiche Taktzahl, gleicher Ablauf, gleiche Töne (nur eine Oktavlage pro Stimme),
// gleiches Tempo/Timing – kein zusätzliches Intro, keine Umstellung.
// Wählbar: welche Stimmen der Vorlage (Gesang, Bass, Gitarre, Schlagzeug …) übernommen
// werden und auf welchem Instrument sie gespielt werden – eine, mehrere oder alle.
// Beim Schlagzeug kommen auf Wunsch Fills dazu, die im Groove bleiben.
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
import { embellishLine } from './embellish.js';
import { genDrumsSegment, drumsFromNotes, addGrooveFills, varyDrums } from './gen/drums.js';
import { enforceRange, insertBreaths, applyDynamics, spellAll, simplifyForReading, addPerformanceMarks, tempoHeading, newReport, keyAtFactory } from './post.js';

function letterOf(n) {
  return n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(65 + (n % 26)) + (Math.floor(n / 26) + 1);
}

const avgPitch = (notes) => (notes.length ? notes.reduce((s, n) => s + n.midi, 0) / notes.length : 60);

// Vorschlag: passendes Instrument für eine Spur (GM-Programm, sonst Lage)
export function suggestInstrument(track) {
  const p = track.program ?? 0;
  const avg = avgPitch(track.notes || []);
  if (p >= 32 && p <= 39) return 'ebass';
  const byProg = { 40: 'violin', 41: 'viola', 42: 'cello', 43: 'contrabass', 56: 'trumpet', 57: 'trombone', 58: 'tuba', 59: 'trumpet', 60: 'horn', 64: 'sopranoSax', 65: 'altoSax', 66: 'tenorSax', 67: 'bariSax', 68: 'oboe', 70: 'bassoon', 71: 'clarinet', 73: 'flute', 72: 'flute', 74: 'flute' };
  if (byProg[p]) return byProg[p];
  if (avg < 48) return 'tuba';
  if (avg < 55) return 'trombone';
  if (avg < 62) return 'tenorSax';
  if (avg < 70) return 'altoSax';
  return 'trumpet';
}

function cleanName(n, i) {
  const s = (n || '').trim();
  return s && !/^(Spur|Track|Stimme|P)\s*\d+$/i.test(s) ? s : `Spur ${i + 1}`;
}

// Stimmen der Vorlage, die man übernehmen kann
export function playAlongSources(song) {
  const out = [];
  const tracks = song.tracks || [];
  const melTrack = tracks.find((t) => t.mel);
  out.push({
    id: 'melody',
    name: song.source === 'audio' ? 'Gesang / Melodie (erkannt)' : melTrack ? `${cleanName(melTrack.name, tracks.indexOf(melTrack))} (Melodie)` : 'Melodie',
    kind: 'melody',
    suggest: null,
    count: song.melody.length,
  });
  tracks.forEach((t, i) => {
    if (t.mel) return;
    const sug = suggestInstrument(t);
    out.push({ id: t.id, name: cleanName(t.name, i), kind: ['ebass', 'tuba', 'contrabass'].includes(sug) ? 'bass' : 'part', suggest: sug, count: t.notes.length });
  });
  const hasDrums = song.drumNotes && song.drumNotes.length;
  out.push({ id: 'drums', name: hasDrums ? (song.source === 'audio' ? 'Schlagzeug (erkannt)' : 'Schlagzeug') : 'Schlagzeug (Groove im Stil – Vorlage hat keins)', kind: 'drums', suggest: 'drums', count: hasDrums ? song.drumNotes.length : 0 });
  return out;
}

// Einstimmige Linie aus einer (evtl. mehrstimmigen) Spur: oben (Melodie) oder unten (Bass)
function monoLine(notes, low) {
  const s = [...notes].sort((a, b) => a.start - b.start || (low ? a.midi - b.midi : b.midi - a.midi));
  const out = [];
  for (const n of s) {
    const prev = out[out.length - 1];
    if (prev && prev.start === n.start) continue;
    if (prev && prev.start + prev.dur > n.start) prev.dur = n.start - prev.start;
    out.push({ ...n });
  }
  return out.filter((n) => n.dur > 0);
}

export function defaultPlayParts(opts) {
  if (opts.soloInstrument === 'drums') return [{ source: 'drums', inst: 'drums' }];
  return [{ source: 'melody', inst: opts.soloInstrument || 'trumpet' }];
}

// Tempo je Takt aus den Schlagzeiten der Aufnahme (in Vierteln; 12/8: punktierte Viertel × 1,5)
function tempoMapFromTiming(song, { leadBars, mt, tempo, compound }) {
  const tg = song.timing;
  // Datei mit ausdrücklichen Tempowechseln (MIDI/MusicXML): genau diese übernehmen
  if ((!tg || !tg.beatSec) && song.tempoEvents && song.tempoEvents.length > 1) {
    const scale = tempo / song.tempoEvents[0].bpm; // vom Benutzer geändertes Grundtempo
    return song.tempoEvents.map((e, i) => ({ t: i ? e.t + leadBars * mt : 0, bpm: Math.round(e.bpm * scale) }));
  }
  if (!tg || !tg.beatSec || tg.beatSec.length < 2) return [{ t: 0, bpm: tempo }];
  const map = [];
  const bt = tg.beatTicks || DIV;
  const beatsPerBar = mt / bt;
  let last = 0;
  for (let bar = 0; bar < song.measureCount; bar++) {
    const a = tg.firstBeat + bar * beatsPerBar;
    const z = a + beatsPerBar;
    if (a < 0 || z >= tg.beatSec.length) continue;
    let bpm = (60 * beatsPerBar) / (tg.beatSec[z] - tg.beatSec[a]);
    if (compound) bpm *= 1.5;
    bpm = Math.round(bpm);
    if (!map.length || Math.abs(bpm - last) >= 1) {
      map.push({ t: map.length ? (leadBars + bar) * mt : 0, bpm });
      last = bpm;
    }
  }
  return map.length ? map : [{ t: 0, bpm: tempo }];
}

export function arrangePlayAlong(song, opts) {
  const style = getStyle(opts.style);
  const key = song.key; // keine Transposition: klingt wie die Datei
  const mt = songMeasureTicks(song);
  const M = song.measureCount;
  const rng = new Rng(opts.seed || 1);
  const tempo = Math.round(song.tempo || style.defaultTempo);
  const compound = song.meter.beatType === 8 && song.meter.beats % 3 === 0 && song.meter.beats > 3;
  const beat = compound ? (DIV * 3) / 2 : (DIV * 4) / song.meter.beatType;
  // Auftakt -> eigener Vorlauf-Takt, danach Takt 1 der Vorlage
  const leadBars = song.pickup > 0 ? Math.ceil(song.pickup / mt) : 0;
  const off = leadBars * mt;
  const totalBars = M + leadBars;
  const sections = song.sections.length ? song.sections : [{ label: 'A', start: 0, length: M }];
  const sources = playAlongSources(song);
  const srcName = (id) => sources.find((s) => s.id === id)?.name || id;
  let parts = (opts.playParts && opts.playParts.length ? opts.playParts : defaultPlayParts(opts)).filter((p) => p && p.source && p.inst);
  // Schlagzeug höchstens einmal, nur aus der Schlagzeug-Quelle
  parts = parts.filter((p, i) => (p.inst === 'drums') === (p.source === 'drums') && parts.findIndex((q) => q.source === p.source && q.inst === p.inst) === i);
  if (!parts.length) parts = defaultPlayParts(opts);
  const melodicParts = parts.filter((p) => p.inst !== 'drums');
  const drumPart = parts.find((p) => p.inst === 'drums');

  // ---- Formteile = Abschnitte der Vorlage (nur Probenbuchstaben, keine Umstellung) ----
  const nVoices = melodicParts.length;
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
    b.segments = [{ bars: b.measures, roles: nVoices ? melodicParts.map(() => 'melody') : ['rest'], startBar: 0 }];
  }
  const chordTrack = normalizeChords(
    songChords.map((c) => ({ ...c, start: c.start + off })).concat(leadBars && songChords.length ? [{ start: 0, dur: off, chord: songChords[0].chord }] : []),
    totalBars * mt,
  );

  // ---- Melodische Stimmen ----
  const voices = [];
  const levels = [];
  const notes = [];
  melodicParts.forEach((p, i) => {
    const lv = levelFor({ difficulty: opts.difficulty, voiceDifficulty: opts.voiceDifficulty }, i);
    levels.push(lv);
    const inst = withRange(difficultyRange(getInstrument(p.inst), lv), opts.ranges ? opts.ranges[i] : null);
    let src;
    if (p.source === 'melody') src = song.melody;
    else {
      const t = (song.tracks || []).find((x) => x.id === p.source);
      const low = inst.family === 'bass' || ['tuba', 'sousaphone', 'ebass', 'contrabass', 'bassTrombone', 'bassClarinet', 'bassoon', 'bariSax'].includes(inst.id);
      src = t ? monoLine(t.notes, low) : [];
    }
    const mel = src.filter((n) => n.start + off >= 0 && n.start < M * mt);
    const octave = fitOctave(mel, inst).shift; // eine Oktavlage für die ganze Stimme
    const ctx = new BlockCtx({ style, rng: rng.fork(`v${i}`), key, meter: song.meter, measures: totalBars, chords: chordTrack, tempo, inst: [inst], block: blocks[0], prevState: [{}] });
    let line = cleanLine(mel.map((n) => ev(n.start + off, n.dur, n.midi + octave, n.lof ?? null)));
    articulate(ctx, line, inst);
    line = line.map((e) => ({ ...e, role: 'melody' }));
    voices.push({ inst, events: line, dirs: [], label: srcName(p.source).replace(/\s*\((erkannt|Melodie)\)$/, ''), source: p.source });
    if (octave) notes.push(`${srcName(p.source)} → ${inst.name}: um ${Math.abs(octave / 12)} Oktave${Math.abs(octave) > 12 ? 'n' : ''} ${octave > 0 ? 'höher' : 'tiefer'} gesetzt (gleiche Töne wie die Vorlage).`);
  });

  // ---- Schlagzeug ----
  let drumEvents = [];
  const dLv = drumPart ? levelFor({ difficulty: opts.difficulty, voiceDifficulty: opts.voiceDifficulty }, melodicParts.length) : null;
  if (drumPart) {
    const total = totalBars * mt;
    const fromFile = song.drumNotes && song.drumNotes.length;
    if (fromFile) drumEvents = drumsFromNotes(song.drumNotes, { offset: off, totalTicks: total, beat });
    if (fromFile && song.source === 'audio') notes.push('Schlagzeug aus der Aufnahme erkannt (Bass Drum, Snare, Hi-Hat je Formteil) – bitte mit dem Original anhören.');
    if (!drumEvents.length) {
      // Vorlage ohne Schlagzeug: Stil-Groove über exakt dieselben Takte
      notes.push('Die Vorlage enthält kein Schlagzeug – der Groove ist im gewählten Stil über exakt dieselben Takte geschrieben.');
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
    }
    if (opts.drumMode === 'own') {
      // Eigener Rhythmus: Original-Groove als Grundlage, je Schwierigkeit einfacher oder reicher
      drumEvents = varyDrums(drumEvents, dLv || 3, { mt, beat, sections, leadBars, rng: rng.fork('vary') });
      notes.push(`Eigener Rhythmus auf Basis des Original-Grooves (${['', 'Sehr leicht', 'Leicht', 'Mittel', 'Fortgeschritten', 'Profi'][dLv || 3]}).`);
    } else if (drumEvents.length && song.drumNotes && song.drumNotes.length && opts.drumFills === true && dLv !== 1) {
      // Fills im Groove: am Ende jedes Formteils (2 Schläge) und nach 8-Takt-Phrasen (1 Schlag)
      const fillBars = [];
      sections.forEach((sec, i) => {
        const s0 = leadBars + sec.start;
        for (let k = 7; k < sec.length - 1; k += 8) fillBars.push({ bar: s0 + k, beats: 1 });
        if (i < sections.length - 1) fillBars.push({ bar: s0 + sec.length - 1, beats: dLv && dLv <= 2 ? 1 : 2 });
      });
      drumEvents = addGrooveFills(drumEvents, { mt, beat, fillBars, lv: dLv });
    }
  }

  // ---- Nachbearbeitung (ohne Verzierungen – Töne & Rhythmus bleiben wie in der Vorlage) ----
  const report = newReport();
  const arr = { voices, blocks, mt, beat, style, rng: rng.fork('post'), chordTrack, keyAt: keyAtFactory(blocks, mt), tempo, levels };
  voices.forEach((v, i) => {
    const lv = levels[i];
    v.events = embellishLine(v.events, lv, { chordTrack, keyAt: arr.keyAt, inst: v.inst, style, mt, beat, rng: rng.fork(`emb${i}`) });
    enforceRange(v.events, v.inst, report);
    if (lv && lv < 4) {
      v.events = limitLeaps(simplifyRhythm(v.events, lv, mt, beat), lv, v.inst);
      enforceRange(v.events, v.inst, report);
    }
    insertBreaths(v, v.inst, tempo, report, lv && lv <= 2 ? 0.75 : 1);
  });
  applyDynamics(arr);
  simplifyForReading(arr, song.meter);
  addPerformanceMarks(arr);
  spellAll(arr);
  for (const v of voices) v.dirs.sort((a, b) => a.t - b.t);
  const drums = drumPart ? { name: 'Schlagzeug', events: dedupeDrums(simplifyDrums(drumEvents, dLv)), dirs: [] } : null;
  if (drums) addPerformanceMarks({ ...arr, voices: [] }, drums);
  // Tempo wie in der Aufnahme: sichtbare Wechsel (♩ = …, rit., accel., a tempo) und eine
  // Tempo-Map je Takt für MIDI/MusicXML-Wiedergabe in anderen Programmen
  arr.tempoMap = tempoMapFromTiming(song, { leadBars, mt, tempo, compound });
  for (const tm of song.tempoMarks || []) {
    if (tm.kind === 'tempo' && tm.bar === 0) continue;
    const t = (leadBars + tm.bar) * mt;
    const scale = song.tempoEvents && !song.timing ? tempo / song.tempoEvents[0].bpm : 1;
    const dir = tm.kind === 'tempo' ? { t, kind: 'metro', bpm: Math.round(tm.bpm * scale), meter: song.meter } : { t, kind: 'words', text: { rit: 'rit.', accel: 'accel.', atempo: 'a tempo' }[tm.kind] };
    for (const v of voices) v.dirs.push({ ...dir });
    if (drums) drums.dirs.push({ ...dir });
  }
  for (const v of voices) v.dirs.sort((a, b) => a.t - b.t);
  if (drums) drums.dirs.sort((a, b) => a.t - b.t);
  const th = tempoHeading(style, tempo);
  report.notes = notes;
  const who = [...voices.map((v) => v.inst.name), ...(drums ? ['Schlagzeug'] : [])];
  return {
    meta: {
      title: opts.title || song.title,
      composer: song.composer,
      arranger: 'Play-along: NoteCode',
      subtitle: `${who.length === 1 ? `Solo für ${who[0]}` : who.join(', ')} – Originalablauf`,
      keyName: keyName(key),
      keyNameDe: keyNameDe(key),
      tempo,
      tempoText: th.text,
      styleHint: th.hint,
      swing: !!song.swing, // Feeling wie die Vorlage
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
    levels: drums ? [...levels, dLv] : levels,
    soloMode: true,
    playAlong: true,
    // Zeitbezug zur Vorlage: Takt "leadBars" = Takt 1 der Datei
    sourceOffset: off,
    timing: song.timing || null,
    backing: playAlongBacking(song, off, parts, srcName),
    roleNames: ROLE_NAMES,
  };
}

// Original zum Mitspielen: Aufnahme (synchron über song.timing) oder Noten aller Spuren.
// Die übernommenen Stimmen bekommen eigene Kanäle (zum Stummschalten), der Rest ist "Band".
function playAlongBacking(song, off, parts, srcName) {
  if (song.source === 'audio') return { kind: 'audio', channels: [{ key: 'orig', name: 'Original-Aufnahme' }] };
  const shift = (ns) => ns.map((n) => ({ start: n.start + off, dur: n.dur, midi: n.midi, vel: n.vel ?? 80 }));
  const chosen = new Set(parts.map((p) => p.source));
  const channels = [];
  const tracks = song.tracks || [];
  const melTrack = tracks.find((t) => t.mel);
  const band = [];
  if (!tracks.length && song.melody.length) channels.push({ key: 'orig:melody', name: `Original: ${srcName('melody')}`, notes: shift(song.melody), program: 0 });
  for (const t of tracks) {
    const id = t === melTrack ? 'melody' : t.id;
    if (chosen.has(id)) channels.push({ key: `orig:${id}`, name: `Original: ${srcName(id)}`, notes: shift(t.notes), program: t.program ?? 0 });
    else band.push(...shift(t.notes).map((n) => ({ ...n, program: t.program ?? 0 })));
  }
  if (band.length) channels.push({ key: 'orig:band', name: 'Original: Band', notes: band });
  if (song.drumNotes && song.drumNotes.length) channels.push({ key: 'orig:drums', name: 'Original: Schlagzeug', notes: shift(song.drumNotes), drum: true });
  if (!channels.length) return null;
  return { kind: 'notes', channels };
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
