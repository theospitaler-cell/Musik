// Orchestrator: Analyse -> Formplan -> Stimmgenerierung -> Nachbearbeitung.
import { DIV } from '../core/constants.js';
import { Rng } from '../core/rng.js';
import { normalizeChords, sliceMelody } from '../model/song.js';
import { keyName, keyNameDe } from '../theory/keys.js';
import { planArrangement, ROLE_NAMES } from './planner.js';
import { BlockCtx, cleanLine, shiftEvents } from './context.js';
import { placeMelody, adaptMelody, articulate } from './gen/melody.js';
import { genBass } from './gen/bass.js';
import { genCounter } from './gen/counter.js';
import { genComp, genBackground } from './gen/comp.js';
import { genTutti, genHits, genRiff, genFinal } from './gen/tutti.js';
import { genSolo } from './gen/solo.js';
import { genDrumsSegment } from './gen/drums.js';
import { fitOctave } from './instruments.js';
import { levelFor, simplifyRhythm, limitLeaps, simplifyDrums } from './difficulty.js';
import { arrangeSoloFree } from './solo-free.js';
import { enforceContraryMotion, motionStats } from './voicing.js';
import { embellishLine } from './embellish.js';
import { arrangePlayAlong } from './playalong.js';
import {
  enforceRange,
  ensureMovement,
  fixParallels,
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
import { transposeEvents } from '../model/song.js';

export const DEFAULT_OPTIONS = {
  voices: ['trumpet', 'trumpet', 'trombone', 'sousaphone'],
  style: 'funk',
  solo: 0, // 0..3 | 'rotate' | 'none'
  drums: false,
  length: 'normal', // short | normal | long
  adapt: 1, // 0 = nah am Original, 1 = stilisiert, 2 = frei
  seed: 1,
  ensemble: 'quartet', // quartet | solo
  soloInstrument: 'trumpet', // bei Solo: Instrument-ID oder 'drums'
  playback: false, // bei Solo: true = Play-along 1:1 wie die Vorlage, false = freies Solo-Arrangement
  playParts: null, // Play-along: [{source: 'melody'|'drums'|Spur-ID, inst: Instrument-ID|'drums'}]
  drumFills: false, // Play-along: zusätzliche Fills im Groove (Standard: Original 1:1)
  difficulty: 'auto', // 'auto' | 1..5
  tempo: null,
  transpose: 'auto', // 'auto' | Zahl (Halbtöne)
  modulate: true,
};

function sliceRel(events, a, b) {
  return events.filter((e) => e.start >= a && e.start < b).map((e) => ({ ...e, start: e.start - a, dur: Math.min(e.dur, b - e.start) }));
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

export function arrange(songIn, options = {}) {
  const opts = { ...DEFAULT_OPTIONS };
  for (const [k, v] of Object.entries(options)) if (v !== undefined && v !== null && v !== '') opts[k] = v;
  if (opts.ensemble === 'solo') return opts.playback ? arrangePlayAlong(songIn, opts) : arrangeSoloFree(songIn, opts);
  if (!Array.isArray(opts.voices) || opts.voices.length !== 4) throw new Error('Es müssen genau 4 Instrumente gewählt werden');
  const plan = planArrangement(songIn, opts);
  const { blocks, song, style, insts, mt } = plan;
  const rng = new Rng(opts.seed);
  // Tempo: Nutzerangabe > Vorlage (wenn stilgerecht) > Stil-Standard
  let tempo = opts.tempo || null;
  if (!tempo && song.tempo && style.tempoRange && song.tempo >= style.tempoRange[0] && song.tempo <= style.tempoRange[1]) tempo = song.tempo;
  tempo = Math.round(tempo || style.defaultTempo);
  const beat = song.meter.beatType === 8 && song.meter.beats % 3 === 0 && song.meter.beats > 3 ? (DIV * 3) / 2 : (DIV * 4) / song.meter.beatType;
  const prevState = [{}, {}, {}, {}];
  const voices = insts.map((inst, i) => ({ inst, events: [], dirs: [], label: `Stimme ${i + 1}` }));
  const drumEvents = [];
  const chordTrack = [];
  const songMotif = sliceMelody(song, 0, Math.min(2, song.measureCount));

  const copies = []; // {src, dst, len} in Ticks – nach der Nachbearbeitung kopiert
  blocks.forEach((b, bi) => {
    const blockStart = b.startBar * mt;
    b.chords = normalizeChords(b.chords, b.measures * mt);
    for (const c of b.chords) chordTrack.push({ start: c.start + blockStart, dur: c.dur, chord: c.chord });
    if (b.copyOf !== undefined) {
      // identische Wiederholung (D.S.): Inhalte werden später 1:1 kopiert
      const src = blocks[b.copyOf];
      b.melodyShift = src.melodyShift;
      copies.push({ src: src.startBar * mt, dst: blockStart, len: b.measures * mt });
      return;
    }
    const nextBlock = blocks[bi + 1];
    const nextChord = nextBlock ? normalizeChords(nextBlock.chords, nextBlock.measures * mt)[0]?.chord : null;
    // Solo über den ganzen Formteil am Stück erzeugen (eine Dramaturgie)
    const soloVs = [...new Set(b.segments.map((sg) => sg.roles.indexOf('solo')).filter((x) => x >= 0))];
    if (soloVs.length === 1) {
      const sctx = new BlockCtx({
        style,
        rng: rng.fork(`${bi}:solo`),
        key: b.key,
        meter: song.meter,
        measures: b.measures,
        chords: b.chords,
        tempo,
        inst: insts,
        block: b,
        intensity: b.intensity,
        songMotif,
        prevState,
      });
      const lvS = levelFor(opts, soloVs[0]);
      b.preSolo = { v: soloVs[0], line: genSolo(sctx, soloVs[0], { lyrical: style.id === 'ballad' || style.id === 'classical' || (lvS !== null && lvS <= 2), melody: b.paraphrase || null }) };
    }
    b.segments.forEach((seg, si) => {
      const s0 = seg.startBar * mt;
      const s1 = s0 + seg.bars * mt;
      if (seg.copyOfSeg !== undefined) {
        const srcSeg = b.segments[seg.copyOfSeg];
        copies.push({ src: blockStart + srcSeg.startBar * mt, dst: blockStart + s0, len: seg.bars * mt });
        return;
      }
      const segChords = sliceChordsRel(b.chords, s0, s1);
      const ctx = new BlockCtx({
        style,
        rng: rng.fork(`${bi}:${si}`),
        key: b.key,
        meter: song.meter,
        measures: seg.bars,
        chords: segChords.length ? segChords : [{ start: 0, dur: seg.bars * mt, chord: b.chords[0].chord }],
        tempo,
        inst: insts,
        block: b,
        intensity: seg.climax ? Math.max(0.8, b.intensity) : b.intensity,
        songMotif,
        prevState,
      });
      const nextSeg = b.segments[si + 1];
      ctx.nextBlockChord = nextSeg ? sliceChordsRel(b.chords, nextSeg.startBar * mt, nextSeg.startBar * mt + mt)[0]?.chord : nextChord;
      const roles = seg.roles;
      const lines = {};
      const melodySlice = b.melody ? sliceRel(b.melody, s0, s1) : [];
      const climax = b.type === 'shout' || b.type === 'coda';

      // 1) Führungsstimme
      const leadV = roles.findIndex((r) => r === 'melody' || r === 'hook' || r === 'subject' || r === 'solo');
      if (leadV >= 0) {
        const r = roles[leadV];
        if (r === 'melody') {
          const { line, shift } = placeMelody(ctx, leadV, melodySlice, { adapt: opts.adapt, climax });
          lines[leadV] = line;
          if (si === 0) b.melodyShift = shift;
        } else if (r === 'hook') {
          const motif = (b.motif || songMotif).filter((n) => n.start < s1 - s0);
          const { line } = placeMelody(ctx, leadV, motif, { adapt: Math.max(1, opts.adapt) + (style.id === 'funk' || style.id === 'secondline' ? 1 : 0) });
          lines[leadV] = line;
        } else if (r === 'subject') {
          let motif = songMotif.filter((n) => n.start < s1 - s0);
          if (seg.subjectShift) motif = transposeEvents(motif, seg.subjectShift);
          const inst = insts[leadV];
          const f = fitOctave(motif, inst);
          let line = cleanLine(motif.map((n) => ({ start: n.start, dur: n.dur, pitches: [n.midi + f.shift], lofs: [n.lof], art: [], fx: [] })));
          line = articulate(ctx, line, inst);
          lines[leadV] = line;
          if (line.length) ctx.setLast(leadV, line[line.length - 1].pitches[0]);
        } else if (r === 'solo') {
          if (b.preSolo && b.preSolo.v === leadV) lines[leadV] = sliceRel(b.preSolo.line, s0, s1);
          else lines[leadV] = genSolo(ctx, leadV, { lyrical: style.id === 'ballad' || style.id === 'classical' });
        }
        ctx.melodyLine = lines[leadV];
        ctx.melodyVoice = leadV;
      }

      // 2) Gruppenrollen (homophon)
      const groupOf = (role) => roles.map((r, i) => (r === role ? i : -1)).filter((i) => i >= 0);
      const tuttiVs = groupOf('tutti');
      if (tuttiVs.length) {
        const res = genTutti(ctx, tuttiVs, melodySlice, { adapt: opts.adapt, octaveUp: b.type === 'shout' });
        Object.assign(lines, res);
        ctx.melodyLine = res[tuttiVs[0]];
        ctx.melodyVoice = tuttiVs[0];
      }
      const hitsVs = groupOf('hits');
      if (hitsVs.length) {
        const res = genHits(ctx, hitsVs, { rising: !!seg.climax });
        Object.assign(lines, res);
        if (!ctx.melodyLine) {
          ctx.melodyLine = res[hitsVs[0]];
          ctx.melodyVoice = hitsVs[0];
        }
      }
      const riffVs = groupOf('riff');
      if (riffVs.length) {
        const res = genRiff(ctx, riffVs);
        Object.assign(lines, res);
        if (!ctx.melodyLine) {
          ctx.melodyLine = res[riffVs[0]];
          ctx.melodyVoice = riffVs[0];
        }
      }
      const finalVs = groupOf('final');
      if (finalVs.length) Object.assign(lines, genFinal(ctx, finalVs));

      // 3) Bass – die Mittelstimmen richten sich danach (Gegenbewegung)
      for (const v of groupOf('bass')) {
        lines[v] = genBass(ctx, v);
        if (!ctx.bassLine) ctx.bassLine = lines[v];
      }

      // 4) Gegenstimme & Fill-Ins
      for (const v of groupOf('counter')) {
        if (ctx.melodyLine && ctx.melodyLine.length) lines[v] = genCounter(ctx, v, ctx.melodyLine, { mode: 'counter' });
        else {
          // melodische Überleitung ohne Führungsstimme
          lines[v] = genSolo(ctx, v, { lyrical: true });
          ctx.melodyLine = lines[v];
          ctx.melodyVoice = v;
        }
      }
      for (const v of groupOf('fill')) {
        if (ctx.melodyLine && ctx.melodyLine.length) lines[v] = genCounter(ctx, v, ctx.melodyLine, { mode: 'fill' });
      }

      // 5) Begleitung
      const compRoles = ['comp', 'stabs', 'pad', 'background'];
      const generatedComps = [];
      let rank = 0;
      for (let v = 0; v < 4; v++) {
        const r = roles[v];
        if (!compRoles.includes(r)) continue;
        const partners = generatedComps.map((x) => lines[x]);
        // Gegenstimme als Partner einbeziehen, um Dopplungen zu vermeiden
        for (let k = 0; k < 4; k++) if (roles[k] === 'counter' && lines[k]) partners.push(lines[k]);
        if (r === 'background') lines[v] = genBackground(ctx, v, { partners, rank });
        else lines[v] = genComp(ctx, v, r, { partners, rank });
        generatedComps.push(v);
        rank++;
      }

      // in absolute Zeit übertragen
      for (let v = 0; v < 4; v++) {
        const l = lines[v];
        if (!l) continue;
        for (const e of l) e.role = e.role || roles[v];
        voices[v].events.push(...shiftEvents(l, blockStart + s0).map((e) => ({ ...e, role: roles[v] })));
      }

      // Schlagzeug
      if (opts.drums) {
        const active = roles.filter((r) => r !== 'rest').length;
        let mode = 'groove';
        if (roles.includes('final')) mode = 'final';
        else if (roles.every((r) => r === 'hits')) mode = 'hits';
        else if ((style.id === 'ballad' || style.id === 'classical') && b.type === 'intro' && si === 0) mode = 'rest';
        else if (active <= 1 && style.id !== 'funk' && style.id !== 'secondline') mode = 'rest';
        const hitsLine = lines[roles.findIndex((r) => r === 'hits' || r === 'final')] || null;
        const dctx = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { rng: ctx.rng.fork('drums') });
        const dEv = genDrumsSegment(dctx, {
          mode,
          bars: seg.bars,
          isBlockStart: si === 0 && b.type !== 'intro',
          isBlockEnd: si === b.segments.length - 1,
          hitsLine,
          intensity: ctx.intensity,
        });
        drumEvents.push(...dEv.map((e) => ({ ...e, start: e.start + blockStart + s0 })));
      }
    });
  });

  // Auftakte (Pickups) in den vorherigen Formteil einsetzen
  for (const b of blocks) {
    if (!b.leadIn || !b.leadIn.length || b.melodyVoice === undefined || b.startBar === 0) continue;
    const mv = b.segments[0].roles.indexOf('melody') >= 0 ? b.segments[0].roles.indexOf('melody') : b.segments[0].roles.indexOf('tutti');
    if (mv < 0) continue;
    const blockStart = b.startBar * mt;
    const shift = b.melodyShift ?? 0;
    const notes = b.leadIn.map((n) => ({ start: blockStart + n.start, dur: n.dur, pitches: [n.midi + shift], lofs: [n.lof], art: [], fx: [], role: 'melody' }));
    const from = Math.min(...notes.map((n) => n.start));
    const line = voices[mv];
    line.events = line.events
      .filter((e) => !(e.start >= from && e.start < blockStart))
      .map((e) => (e.start < from && e.start + e.dur > from ? { ...e, dur: from - e.start } : e));
    line.events.push(...notes);
  }

  // Nachbearbeitung
  for (const v of voices) v.events = cleanLine(v.events);
  const report = newReport();
  const keyAt = keyAtFactory(blocks, mt);
  const arr = {
    voices,
    blocks,
    mt,
    beat,
    style,
    rng: rng.fork('post'),
    chordTrack: normalizeChords(chordTrack, plan.totalBars * mt),
    keyAt,
    tempo,
  };
  arr.levels = voices.map((_, i) => levelFor(opts, i));
  for (const v of voices) enforceRange(v.events, v.inst, report);
  // Schwierigkeit: Rhythmus & Sprünge vereinfachen
  voices.forEach((v, i) => {
    const lv = arr.levels[i];
    if (lv && lv >= 4) {
      // Fortgeschritten/Profi: Läufe, Sprünge, Verzierungen in Melodie & Gegenstimmen
      v.events = embellishLine(v.events, lv, { chordTrack: arr.chordTrack, keyAt, inst: v.inst, style, mt, beat, rng: rng.fork(`emb${i}`) });
      enforceRange(v.events, v.inst, report);
      return;
    }
    if (!lv) return;
    v.events = limitLeaps(simplifyRhythm(v.events, lv, mt, beat), lv, v.inst);
    enforceRange(v.events, v.inst, report);
  });
  if (opts.drums) {
    const dl = levelFor({ difficulty: opts.difficulty, voiceDifficulty: [opts.drumDifficulty ?? null] }, 0);
    const simple = [...simplifyDrums(drumEvents, dl)];
    drumEvents.length = 0;
    drumEvents.push(...simple);
  }
  ensureMovement(arr, report);
  enforceContraryMotion(arr, report);
  fixParallels(arr, report);
  voices.forEach((v, i) => insertBreaths(v, v.inst, tempo, report, arr.levels[i] && arr.levels[i] <= 2 ? 0.75 : 1));
  decorate(arr, report);
  applyDynamics(arr);
  simplifyForReading(arr, song.meter);
  addPerformanceMarks(arr);
  spellAll(arr);
  // Kopien (D.S.-Durchgang, wiederholte Tags) einsetzen
  const copyRange = (list, getT, setT, c) => {
    const inDst = (x) => getT(x) >= c.dst && getT(x) < c.dst + c.len;
    const kept = list.filter((x) => !inDst(x));
    const add = list
      .filter((x) => getT(x) >= c.src && getT(x) < c.src + c.len)
      .map((x) => {
        const y = { ...x, art: x.art ? [...x.art] : x.art, fx: x.fx ? [...x.fx] : x.fx };
        setT(y, getT(x) - c.src + c.dst);
        if (y.dur !== undefined && getT(x) + x.dur > c.src + c.len) y.dur = c.src + c.len - getT(x);
        return y;
      });
    return [...kept, ...add];
  };
  for (const c of copies) {
    for (const v of voices) {
      v.events = cleanLine(copyRange(v.events, (x) => x.start, (x, t) => (x.start = t), c));
      v.dirs = copyRange(v.dirs, (x) => x.t, (x, t) => (x.t = t), c);
    }
    if (opts.drums) {
      const d = copyRange(drumEvents, (x) => x.start, (x, t) => (x.start = t), c);
      drumEvents.length = 0;
      drumEvents.push(...d);
    }
  }
  // Atemraum an den Nahtstellen nach eingesetzten Kopien (z. B. Tag -> Schlussakkord)
  for (const c of copies) {
    const t = c.dst + c.len;
    for (const v of voices) {
      if (!v.inst.breath) continue;
      const e = v.events.find((x) => x.start < t && x.start + x.dur === t);
      const next = v.events.find((x) => x.start === t);
      if (e && next && e.dur >= 18) {
        const cut = e.dur >= 36 ? 12 : 6;
        e.dur -= cut;
        if (e.playDur) e.playDur = Math.min(e.playDur, e.dur);
        report.breaths++;
      }
    }
  }
  for (const v of voices) v.dirs.sort((a, b) => a.t - b.t);
  // Formangaben für den Notensatz (Wiederholungen, Segno, Coda)
  const form = { repeats: [], segnoBar: null, toCodaBar: null, dsBar: null, skip: null, codaBar: null };
  if (plan.form.segnoBlock !== null && plan.form.codaBlock !== null) {
    const sb = blocks[plan.form.segnoBlock];
    const tb = blocks[plan.form.toCodaBlock];
    const db = blocks[plan.form.dsAfterBlock];
    const cb = blocks[plan.form.codaBlock];
    form.segnoBar = sb.startBar;
    form.toCodaBar = tb.startBar + tb.measures - 1;
    form.dsBar = db.startBar + db.measures - 1;
    form.skip = { from: db.startBar + db.measures, to: cb.startBar };
    form.codaBar = cb.startBar;
  }
  for (const b of blocks) {
    b.segments.forEach((seg) => {
      if (seg.repeatTimes > 1) form.repeats.push({ start: b.startBar + seg.startBar, len: seg.bars, times: seg.repeatTimes });
    });
  }

  const drumsObj = opts.drums ? { name: 'Schlagzeug', events: cleanDrums(drumEvents), dirs: [] } : null;
  if (drumsObj) addPerformanceMarks({ ...arr, voices: [] }, drumsObj);
  const th = tempoHeading(style, tempo);
  const keyChanges = [];
  let lastKey = null;
  for (const b of blocks) {
    if (!lastKey || b.key.fifths !== lastKey.fifths || b.key.mode !== lastKey.mode) keyChanges.push({ bar: b.startBar, key: b.key });
    lastKey = b.key;
  }

  return {
    meta: {
      title: opts.title || song.title,
      composer: song.composer,
      arranger: 'Arr.: NoteCode',
      subtitle: `${style.name} – Quartett`,
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
    totalBars: plan.totalBars,
    voices,
    drums: drumsObj,
    blocks,
    chordTrack: arr.chordTrack,
    keyAt,
    keyChanges,
    transposeShift: plan.shift,
    form,
    report,
    motion: motionStats(arr),
    options: opts,
    levels: arr.levels,
    roleNames: ROLE_NAMES,
  };
}

function cleanDrums(events) {
  const seen = new Set();
  const out = [];
  for (const e of events.sort((a, b) => a.start - b.start)) {
    const k = `${e.start}:${e.pitches[0]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export { adaptMelody };
