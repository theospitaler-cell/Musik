// Solo-Noten (ohne Playback): ein vollwertiges Notenblatt für GENAU EIN Instrument.
// "Solo" heißt hier: das Instrument spielt durchgehend die tragende Hauptmelodie des Songs
// (Gesangs-/Lead-Linie) – keine Improvisation, keine Begleitfiguren, keine Läufe.
// Form: kurzes Intro aus der Schlussphrase des Songs – alle Formteile mit Melodie in
// Originalreihenfolge – Höhepunkt (letzter Teil, wenn spielbar eine Oktave höher) – Schlusston.
// Die Melodie liegt in EINER Oktavlage im Kernbereich des Instruments; Effekte werden
// idiomatisch und sparsam gesetzt (Posaune: Glissando nur wo zugtechnisch möglich,
// Trompete: Akzente/Fall-off/Shake, Sax: Scoops, Horn: Rip, Streicher: Bögen).
// Beim Schlagzeug: Drum-Chart über die Form des Songs (Groove, Fills, Hits zur Melodie).
import { DIV, mod } from '../core/constants.js';
import { Rng } from '../core/rng.js';
import { buildChord } from '../theory/chords.js';
import { keyName, keyNameDe } from '../theory/keys.js';
import { normalizeChords, sliceMelody, sliceChords, songMeasureTicks, pickupNotes, transposeSong } from '../model/song.js';
import { getStyle } from './styles.js';
import { getInstrument, withRange, fitOctave, slideGlissPossible, hasFx, trombonePartialFor } from './instruments.js';
import { chooseTransposition, ROLE_NAMES } from './planner.js';
import { difficultyRange, levelFor, simplifyRhythm, limitLeaps, simplifyDrums, fxAllowed } from './difficulty.js';
import { BlockCtx, cleanLine, ev, addArt, addFx } from './context.js';
import { articulate } from './gen/melody.js';
import { embellishLine } from './embellish.js';
import { genDrumsSegment, genDrumHits } from './gen/drums.js';
import { enforceRange, insertBreaths, applyDynamics, spellAll, simplifyForReading, addPerformanceMarks, tempoHeading, newReport, keyAtFactory } from './post.js';

function letterOf(n) {
  return n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(65 + (n % 26)) + (Math.floor(n / 26) + 1);
}

// Melodie eines Taktbereichs (relativ), Noten über das Ende hinaus gekürzt
function melodyBars(song, fromM, toM) {
  const mt = songMeasureTicks(song);
  return sliceMelody(song, fromM, toM).map((n) => ({ ...n, dur: Math.min(n.dur, (toM - fromM) * mt - n.start) }));
}

export function arrangeSoloFree(songIn, opts) {
  const style = getStyle(opts.style);
  const isDrums = opts.soloInstrument === 'drums';
  const lv = levelFor({ difficulty: opts.difficulty, voiceDifficulty: opts.voiceDifficulty }, 0);
  const instId = isDrums ? null : opts.soloInstrument || 'trumpet';
  const shift = isDrums ? 0 : chooseTransposition(songIn, [instId], opts);
  const song = transposeSong(songIn, shift);
  const key = song.key;
  const mt = songMeasureTicks(song);
  const M = song.measureCount;
  const rng = new Rng(opts.seed || 1);
  let tempo = opts.tempo || null;
  if (!tempo && song.tempo && style.tempoRange && song.tempo >= style.tempoRange[0] && song.tempo <= style.tempoRange[1]) tempo = song.tempo;
  tempo = Math.round(tempo || style.defaultTempo);
  const compound = song.meter.beatType === 8 && song.meter.beats % 3 === 0 && song.meter.beats > 3;
  const beat = compound ? (DIV * 3) / 2 : (DIV * 4) / song.meter.beatType;
  const inst = isDrums ? null : withRange(difficultyRange(getInstrument(instId), lv), opts.ranges ? opts.ranges[0] : null);
  const sections = song.sections.length ? song.sections : [{ label: 'A', start: 0, length: M }];
  const tonic = buildChord(key.tonicLof, key.mode === 'minor' ? 'minor' : 'major');

  // ---- Oktavlage: EINE Lage für die ganze Melodie (Kernbereich des Instruments) ----
  const allMel = song.melody;
  const octave = isDrums ? 0 : fitOctave(allMel, inst).shift;
  // Höhepunkt eine Oktave höher nur, wenn er dort noch bequem liegt
  const fitsUp = (mel) => !isDrums && mel.length > 0 && mel.every((n) => n.midi + octave + 12 <= inst.comfort[1] + 1) && (lv === null || lv >= 3);

  // ---- Formplan ----
  const blocks = [];
  const add = (b) => blocks.push({ keyShift: 0, key, intensity: 0.55, ...b });
  const secInfo = sections.map((sec) => {
    const mel = melodyBars(song, sec.start, sec.start + sec.length);
    return { sec, mel, hasMelody: mel.length >= Math.max(2, sec.length / 2) };
  });
  const melodic = secInfo.filter((x) => x.hasMelody);
  const playable = isDrums ? secInfo : melodic.length ? melodic : secInfo;
  // Intro: Schlussphrase des Songs (die letzten 2 Takte mit Melodie) – bekanntes Material
  const introBars = opts.length === 'short' || M < 6 ? 0 : 2;
  if (introBars) {
    if (isDrums) add({ type: 'intro', name: 'Intro', measures: introBars, chords: [{ start: 0, dur: introBars * mt, chord: tonic }], role: 'groove-build', dyn: style.dyn.intro });
    else {
      const lastBar = Math.max(...allMel.map((n) => Math.floor((n.start + n.dur - 1) / mt)), introBars - 1);
      const from = Math.max(0, Math.min(M - introBars, lastBar - introBars + 1));
      const mel = melodyBars(song, from, from + introBars);
      if (mel.length >= 2) add({ type: 'intro', name: 'Intro', measures: introBars, chords: sliceChords(song, from, from + introBars), melody: mel, role: 'melody', dyn: style.dyn.intro === 'p' ? 'mp' : style.dyn.intro });
    }
  }
  const seen = new Set();
  playable.forEach(({ sec, mel }, i) => {
    const isLast = i === playable.length - 1;
    const chords = sliceChords(song, sec.start, sec.start + sec.length);
    const repeat = seen.has(sec.label);
    seen.add(sec.label);
    const climax = isLast && playable.length >= 3;
    add({
      type: climax ? 'shout' : repeat ? 'variation' : 'theme',
      name: climax ? `Höhepunkt ${sec.label}` : `${sec.label}`,
      label: sec.label,
      measures: sec.length,
      chords,
      melody: mel,
      role: isDrums ? (climax ? 'hits' : repeat ? 'groove-hot' : 'groove') : 'melody',
      source: sec,
      octUp: climax && fitsUp(mel),
      intensity: climax ? 0.9 : repeat ? 0.7 : 0.55,
      dyn: climax ? style.dyn.shout : repeat ? style.dyn.variation || style.dyn.theme : style.dyn.theme,
      leadIn: sec.start === 0 ? pickupNotes(song) : null,
      showChords: true,
    });
  });
  let bar = 0;
  let letter = 0;
  for (const b of blocks) {
    b.startBar = bar;
    b.rehearsal = b.type === 'intro' ? null : letterOf(letter++);
    b.chords = normalizeChords(b.chords, b.measures * mt);
    if (!b.chords.length) b.chords = [{ start: 0, dur: b.measures * mt, chord: tonic }];
    b.segments = [{ bars: b.measures, roles: [isDrums ? 'rest' : 'melody'], startBar: 0, climax: isDrums && b.type === 'shout' }];
    // Überschrift nur, wenn sie mehr sagt als der Probenbuchstabe (z. B. "wie A")
    b.heading = !b.label || b.label === b.rehearsal ? '' : `wie ${b.label}`;
    bar += b.measures;
  }
  const totalBars = bar;

  // ---- Stimme: die Hauptmelodie ----
  const voices = isDrums ? [] : [{ inst, events: [], dirs: [], label: 'Solo' }];
  const drumEvents = [];
  const chordTrack = [];
  const prevState = [{}];
  for (const [bi, b] of blocks.entries()) {
    const t0 = b.startBar * mt;
    for (const c of b.chords) chordTrack.push({ start: c.start + t0, dur: c.dur, chord: c.chord });
    const ctx = new BlockCtx({ style, rng: rng.fork(`s${bi}`), key, meter: song.meter, measures: b.measures, chords: b.chords, tempo, inst: [inst], block: b, intensity: b.intensity, songMotif: null, prevState });
    if (isDrums) {
      let evs;
      if (b.role === 'hits') evs = genDrumHits(ctx, b.melody || [], b.measures);
      else {
        ctx.intensity = b.role === 'groove-hot' ? 0.85 : b.role === 'groove-build' ? 0.4 : 0.6;
        evs = genDrumsSegment(ctx, { mode: 'groove', bars: b.measures, isBlockStart: b.type !== 'intro', isBlockEnd: true, intensity: ctx.intensity });
        if (b.role === 'groove-build') evs = evs.filter((e) => e.start >= mt || ['hh', 'ride', 'hhPedal'].includes(e.drum));
      }
      drumEvents.push(...evs.map((e) => ({ ...e, start: e.start + t0 })));
      continue;
    }
    const sh = octave + (b.octUp ? 12 : 0);
    let line = cleanLine((b.melody || []).map((n) => ev(n.start, n.dur, n.midi + sh, n.lof ?? null)));
    articulate(ctx, line, inst);
    if (b.type === 'variation') varyPhrasing(line, ctx, inst);
    b.melodyShift = sh;
    voices[0].events.push(...line.map((e) => ({ ...e, start: e.start + t0, role: 'melody' })));
  }
  if (!isDrums) {
    const v = voices[0];
    // Auftakt ans Ende des vorherigen Teils (Intro) setzen
    const th = blocks.find((b) => b.leadIn && b.leadIn.length && b.startBar > 0);
    if (th) {
      const start = th.startBar * mt;
      const notes = th.leadIn.map((n) => ({ start: start + n.start, dur: n.dur, pitches: [n.midi + (th.melodyShift ?? octave)], lofs: [n.lof], art: [], fx: [], role: 'melody' }));
      const from = Math.min(...notes.map((n) => n.start));
      v.events = v.events.filter((e) => !(e.start >= from && e.start < start)).map((e) => (e.start < from && e.start + e.dur > from ? { ...e, dur: from - e.start } : e));
      v.events.push(...notes);
    }
    // Schlusston: bis zum Taktende halten, Fermate
    v.events = cleanLine(v.events);
    const last = v.events[v.events.length - 1];
    if (last) {
      const end = totalBars * mt;
      if (last.start + last.dur < end && end - last.start <= 2 * mt) last.dur = end - last.start;
      last.fermata = true;
      last.finalHold = true;
      last.art = last.art.filter((a) => a !== 'staccato');
    }
  } else {
    // Drum-Chart: Schlussschlag im letzten Takt
    const lastBar = (totalBars - 1) * mt;
    const fin = genDrumsSegment(new BlockCtx({ style, rng: rng.fork('fin'), key, meter: song.meter, measures: 1, chords: [], tempo, inst: [null], block: blocks[0], prevState }), { mode: 'final', bars: 1, isBlockStart: false, isBlockEnd: true, hitsLine: [{ start: 0, dur: mt, finalHit: true }], intensity: 1 });
    const keep = drumEvents.filter((e) => e.start < lastBar);
    drumEvents.length = 0;
    drumEvents.push(...keep, ...fin.map((e) => ({ ...e, start: e.start + lastBar })));
  }

  // ---- Nachbearbeitung ----
  const report = newReport();
  const arr = { voices, blocks, mt, beat, style, rng: rng.fork('post'), chordTrack: normalizeChords(chordTrack, totalBars * mt), keyAt: keyAtFactory(blocks, mt), tempo, levels: [lv] };
  for (const v of voices) {
    // Schwierigkeit nach oben: Läufe, Sprünge, Verzierungen (Originaltöne bleiben an ihrem Platz)
    v.events = embellishLine(v.events, lv, { chordTrack: arr.chordTrack, keyAt: arr.keyAt, inst: v.inst, style, mt, beat, rng: rng.fork('emb') });
    enforceRange(v.events, v.inst, report);
    if (lv && lv < 4) {
      v.events = limitLeaps(simplifyRhythm(v.events, lv, mt, beat), lv, v.inst);
      enforceRange(v.events, v.inst, report);
    }
    insertBreaths(v, v.inst, tempo, report, lv && lv <= 2 ? 0.75 : 1);
    decorateSolo(v, { style, mt, beat, lv, rng: rng.fork('fx'), report });
  }
  applyDynamics(arr);
  simplifyForReading(arr, song.meter);
  addPerformanceMarks(arr);
  spellAll(arr);
  for (const v of voices) v.dirs.sort((a, b) => a.t - b.t);
  const drums = isDrums ? { name: 'Schlagzeug', events: dedupeDrums(simplifyDrums(drumEvents, lv)), dirs: [] } : null;
  if (drums) addPerformanceMarks({ ...arr, voices: [] }, drums);
  const notes = [];
  const dropped = secInfo.filter((x) => !x.hasMelody).length;
  if (!isDrums && dropped && melodic.length) notes.push(`${dropped} rein instrumentale${dropped > 1 ? ' Formteile' : 'r Formteil'} ohne Melodie ausgelassen – das Solo-Blatt spielt durchgehend die Hauptmelodie.`);
  if (!isDrums && octave) notes.push(`Melodie für ${inst.name} um ${Math.abs(octave / 12)} Oktave${Math.abs(octave) > 12 ? 'n' : ''} ${octave > 0 ? 'höher' : 'tiefer'} gesetzt (Kernbereich des Instruments).`);
  report.notes = notes;
  const th = tempoHeading(style, tempo);
  return {
    meta: {
      title: song.title,
      composer: song.composer,
      arranger: 'Arr.: NoteCode',
      subtitle: `Solo für ${isDrums ? 'Schlagzeug' : inst.name}`,
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
    melodyOctave: octave,
    form: { repeats: [], segnoBar: null, toCodaBar: null, dsBar: null, skip: null, codaBar: null },
    report,
    options: opts,
    levels: [lv],
    soloMode: true,
    roleNames: ROLE_NAMES,
  };
}

// Wiederholter Formteil: gleiche Töne, andere Phrasierung (mehr Bindung bzw. mehr Akzente)
function varyPhrasing(line, ctx, inst) {
  const legato = ctx.style.id === 'ballad' || ctx.style.id === 'classical' || inst.family === 'string';
  for (let i = 0; i < line.length; i++) {
    const e = line[i];
    const n = line[i + 1];
    if (legato) {
      if (e.art.includes('staccato') && n && n.start === e.start + e.dur) e.art = e.art.filter((a) => a !== 'staccato');
    } else if (e.dur >= ctx.beat && e.start % ctx.beat !== 0) addArt(e, 'accent'); // Synkopen betonen
  }
}

// Idiomatische Effekte für die Solo-Melodie – sparsam und spielbar
function decorateSolo(line, { style, mt, beat, lv, rng, report }) {
  const inst = line.inst;
  const evs = line.events;
  const ok = (fx) => fxAllowed(lv, fx);
  const jazzy = ['funk', 'secondline', 'swing'].includes(style.id);
  const legatoStyle = style.id === 'ballad' || style.id === 'classical';
  // Phrasen
  const phrases = [];
  let cur = [];
  evs.forEach((e, i) => {
    const p = evs[i - 1];
    if (p && e.start - (p.start + p.dur) >= beat / 2) {
      phrases.push(cur);
      cur = [];
    }
    cur.push(e);
  });
  if (cur.length) phrases.push(cur);
  const isTpt = ['trumpet', 'cornet', 'flugelhorn'].includes(inst.id);
  const isTbn = hasFx(inst, 'gliss') && inst.family === 'brass';
  const isSax = inst.family === 'sax';
  let lastGliss = -Infinity;
  for (const ph of phrases) {
    const first = ph[0];
    const last = ph[ph.length - 1];
    const peak = ph.reduce((a, b) => (b.pitches[0] > a.pitches[0] ? b : a), ph[0]);
    // Trompete: Akzent auf dem Phrasen-Höhepunkt und auf Synkopen, Fall-off am Phrasenende
    if (isTpt) {
      if (!legatoStyle && peak.dur >= beat / 2) addArt(peak, 'accent');
      for (const e of ph) if (!legatoStyle && e.dur >= beat && e.start % beat !== 0) addArt(e, 'accent');
      if (jazzy && ok('falloff') && last !== evs[evs.length - 1] && last.dur >= beat && rng.chance(0.35)) {
        addFx(last, 'falloff');
        report.fx.falloff++;
      }
    }
    // Sax / Posaune (jazzig): Scoop in lange Phrasenanfänge
    if ((isSax || (isTbn && jazzy)) && !legatoStyle && ok('scoop') && first.dur >= beat && rng.chance(0.35)) {
      addFx(first, 'scoop');
      report.fx.scoop++;
    }
  }
  // Posaune: Glissando an geeigneten Sprüngen (Terz bis Quinte, gebunden, gleicher Naturton)
  if (isTbn && ok('gliss') && style.id !== 'polka') {
    for (let i = 0; i < evs.length - 1; i++) {
      const a = evs[i];
      const b = evs[i + 1];
      // nur in einen langen Zielton (mind. halbe Note) – nicht in jede Bewegung
      if (a.start + a.dur !== b.start || a.dur < beat / 2 || b.dur < 2 * beat) continue;
      const iv = Math.abs(b.pitches[0] - a.pitches[0]);
      if (iv < 3 || iv > 7) continue;
      if (b.start - lastGliss < mt * 4) continue;
      if (!slideGlissPossible(a.pitches[0], b.pitches[0], inst)) continue;
      if (!rng.chance(style.id === 'classical' ? 0.3 : 0.7)) continue;
      addFx(a, 'glissStart');
      addFx(b, 'glissStop');
      lastGliss = b.start;
      report.fx.gliss++;
    }
  }
  // Schlusston
  const fin = evs[evs.length - 1];
  if (fin && jazzy && ok('shake')) {
    if (isTpt && fin.pitches[0] >= inst.comfort[1] - 7) {
      fin.orn = ['shake'];
      report.fx.shake++;
    } else if (isTbn && !fin.grace) {
      const opts = trombonePartialFor(fin.pitches[0]);
      const from = opts.length ? opts[0].partial - 6 : null;
      if (from !== null && from < fin.pitches[0] - 2 && from >= inst.range[0]) {
        fin.grace = { midi: from, lof: null, slash: false, gliss: true };
        report.fx.gliss++;
      }
    } else if (inst.id === 'horn' && !fin.grace) {
      fin.grace = { midi: fin.pitches[0] - 7, lof: null, slash: false, gliss: true, rip: true };
      report.fx.rip++;
    }
  }
  void mod;
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
