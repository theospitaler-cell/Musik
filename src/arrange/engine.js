// Orchestrator: Analyse -> Formplan -> Stimmgenerierung -> Nachbearbeitung.
import { DIV } from '../core/constants.js';
import { Rng } from '../core/rng.js';
import { normalizeChords, sliceMelody } from '../model/song.js';
import { keyName, keyNameDe } from '../theory/keys.js';
import { planArrangement, ROLE_NAMES } from './planner.js';
import { autoStyle } from './styles.js';
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
import { arrangePlayAlong, originalEnsembleParts } from './playalong.js';
import { voiceSlots } from './planner.js';
import { getInstrument } from './instruments.js';
import { voiceBelow } from './gen/tutti.js';
import { keepLeadOnTop, ensureGuideTones, addSuspensions, reduceSyllableRepeats } from './rules.js';
import { hasMeterChanges } from '../model/song.js';
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
import { sourceLinesOf, bassOctave } from './original.js';
import { sourceBass, sourceComp, enoughSource } from './gen/source.js';

const ENSEMBLE_NAMES = { 2: 'Duett', 3: 'Trio', 4: 'Quartett', 5: 'Quintett', 6: 'Sextett', 7: 'Septett', 8: 'Oktett' };

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
  original: false, // Mehrere: true = Groove & Melodie 1:1 auf die Instrumente (Original übernehmen)
  playParts: null, // Play-along: [{source: 'melody'|'drums'|Spur-ID, inst: Instrument-ID|'drums'}]
  drumFills: false, // Play-along: zusätzliche Fills im Groove (Standard: Original 1:1)
  drumMode: 'original', // Schlagzeug: 'original' (1:1) | 'own' (eigener Rhythmus im Charakter, je Schwierigkeit)
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
  // Stil "Automatisch": aus dem Song ableiten
  if (opts.style === 'auto') {
    opts.style = autoStyle(songIn);
    opts.styleAuto = true;
  }
  // Schlagzeug: immer mit Playback (1:1 wie im Original oder eigener Rhythmus im Charakter des Songs)
  if (opts.ensemble === 'drums') return arrangePlayAlong(songIn, { ...opts, playback: true, soloInstrument: 'drums', playParts: [{ source: 'drums', inst: 'drums' }] });
  // Taktartwechsel: Solo folgt dem Original 1:1 (Form & Takte wie in der Vorlage, Verzierungen je Schwierigkeit)
  if (opts.ensemble === 'solo' && !opts.playback && hasMeterChanges(songIn)) {
    const a = arrangePlayAlong(songIn, { ...opts, playParts: [{ source: 'melody', inst: opts.soloInstrument || 'trumpet' }] });
    a.report.notes = [...(a.report.notes || []), 'Taktartwechsel im Stück: das Solo folgt dem Originalablauf Takt für Takt.'];
    return a;
  }
  if (opts.ensemble === 'solo') return opts.playback ? arrangePlayAlong(songIn, opts) : arrangeSoloFree(songIn, opts);
  if (!Array.isArray(opts.voices) || opts.voices.length < 2 || opts.voices.length > 8) throw new Error('Bitte 2 bis 8 Instrumente wählen');
  // Original übernehmen: Groove & Melodie 1:1 auf die Instrumente (Form und Takte wie die Vorlage)
  if (opts.original || hasMeterChanges(songIn)) {
    const insts = opts.voices.map((id) => getInstrument(id));
    const parts = originalEnsembleParts(songIn, opts.voices, voiceSlots(insts));
    if (opts.drums) parts.push({ source: 'drums', inst: 'drums' });
    const a = arrangePlayAlong(songIn, { ...opts, playParts: parts });
    if (!opts.original) a.report.notes = [...(a.report.notes || []), 'Taktartwechsel im Stück: das Arrangement folgt dem Originalablauf Takt für Takt.'];
    a.meta.subtitle = `${ENSEMBLE_NAMES[opts.voices.length] || ''} – Original übernommen`.replace(/^ – /, '');
    a.originalEnsemble = true;
    return a;
  }
  const plan = planArrangement(songIn, opts);
  const { blocks, song, style, insts, mt, slots } = plan;
  const N = insts.length;
  // Klangreihenfolge (oben -> unten) für homophone Sätze
  const regPos = new Map(slots.order.map((v, k) => [v, k]));
  const byRegister = (vs) => [...vs].sort((a, b) => (regPos.get(a) ?? a) - (regPos.get(b) ?? b));
  const rng = new Rng(opts.seed);
  // Tempo: Nutzerangabe > Tempo des Liedes (es soll wiedererkannt werden) > Stil-Standard.
  // Nur bei „frei“ (adapt 2) bestimmt der Stil das Tempo, wenn das Lied nicht in seinen Bereich passt.
  let tempo = opts.tempo || null;
  const inStyle = style.tempoRange && song.tempo >= style.tempoRange[0] && song.tempo <= style.tempoRange[1];
  if (!tempo && song.tempo && (inStyle || Number(opts.adapt ?? 1) < 2)) tempo = song.tempo;
  tempo = Math.round(tempo || style.defaultTempo);
  const beat = song.meter.beatType === 8 && song.meter.beats % 3 === 0 && song.meter.beats > 3 ? (DIV * 3) / 2 : (DIV * 4) / song.meter.beatType;
  const prevState = insts.map(() => ({}));
  const voices = insts.map((inst, i) => ({ inst, events: [], dirs: [], label: `Stimme ${i + 1}` }));
  const drumEvents = [];
  const chordTrack = [];
  const songMotif = sliceMelody(song, 0, Math.min(2, song.measureCount));

  // Bass & Begleitstimmen der Vorlage (in die Tonart des Arrangements transponiert): der Groove
  // des Liedes bleibt erhalten. Nur bei „frei“ (adapt 2) schreibt der Stil eigene Muster.
  const useSource = Number(opts.adapt ?? 1) < 2;
  const srcAll = useSource ? sourceLinesOf(songIn) : { bass: null, guides: [] };
  const trLine = (line) => (line ? line.map((n) => ({ start: n.start, dur: n.dur, midi: n.midi + plan.shift })) : null);
  const srcLines = { bass: trLine(srcAll.bass), guides: srcAll.guides.map(trLine) };
  const kicksAll = (songIn.drumNotes || []).filter((d) => d.midi === 36 || d.midi === 35).map((d) => d.start);
  const bassShifts = new Map();
  const bassShiftFor = (v) => {
    if (!bassShifts.has(v)) bassShifts.set(v, srcLines.bass && srcLines.bass.length ? bassOctave(srcLines.bass, insts[v]) : 0);
    return bassShifts.get(v);
  };

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
      b.preSolo = { v: soloVs[0], line: genSolo(sctx, soloVs[0], { lyrical: style.id === 'ballad' || style.id === 'classical' || (lvS !== null && lvS <= 2), melody: b.paraphrase || null, full: Number(opts.adapt ?? 1) < 2 }) };
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
        bassVoice: slots.bass,
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
      // Ausschnitt der Vorlage für diesen Abschnitt (Bass, Begleitstimmen, Bass Drum)
      let segSrc = null;
      if (useSource && b.source && (srcLines.bass || srcLines.guides.length)) {
        const a0 = b.source.from * mt + s0;
        const a1 = b.source.from * mt + s1;
        const ks = b.keyShift || 0;
        const cut = (line) => (line ? sliceRel(line, a0, a1).map((n) => ({ ...n, midi: n.midi + ks })) : null);
        segSrc = { bass: cut(srcLines.bass), guides: srcLines.guides.map(cut), kicks: kicksAll.filter((k) => k >= a0 && k < a1).map((k) => k - a0) };
      }
      const melodySlice = b.melody ? sliceRel(b.melody, s0, s1) : [];
      const climax = b.type === 'shout' || b.type === 'coda';

      // 1) Führungsstimme
      const leadV = roles.findIndex((r) => r === 'melody' || r === 'hook' || r === 'subject' || r === 'solo');
      if (leadV >= 0) {
        const r = roles[leadV];
        if (r === 'melody') {
          // erste Vorstellung eines Formteils: exakt wie im Original (Wiedererkennung)
          const { line, shift } = placeMelody(ctx, leadV, melodySlice, { adapt: b.firstStatement ? 0 : opts.adapt, climax });
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
      const groupOf = (role) => byRegister(roles.map((r, i) => (r === role ? i : -1)).filter((i) => i >= 0));
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
        lines[v] = segSrc && enoughSource(segSrc.bass, seg.bars) ? sourceBass(ctx, v, segSrc.bass, { shift: bassShiftFor(v), kicks: segSrc.kicks }) : genBass(ctx, v);
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
      // Verdopplung der Melodie (große Besetzung im Refrain): Oktave tiefer bzw. Terz darunter
      for (const v of groupOf('double')) {
        if (ctx.melodyLine && ctx.melodyLine.length) lines[v] = doubleMelody(ctx, v, ctx.melodyLine, { harmony: v === slots.upper });
      }

      // 5) Begleitung
      const compRoles = ['comp', 'stabs', 'pad', 'background'];
      const generatedComps = [];
      let rank = 0;
      for (const v of byRegister(roles.map((_, i) => i))) {
        const r = roles[v];
        if (!compRoles.includes(r)) continue;
        const partners = generatedComps.map((x) => lines[x]);
        // Gegenstimme als Partner einbeziehen, um Dopplungen zu vermeiden
        for (let k = 0; k < N; k++) if (roles[k] === 'counter' && lines[k]) partners.push(lines[k]);
        const guide = segSrc ? segSrc.guides[rank] : null;
        const fromSource = segSrc && r !== 'background' && segSrc.guides.some((g) => enoughSource(g, seg.bars));
        if (r === 'background') lines[v] = genBackground(ctx, v, { partners, rank });
        else if (fromSource)
          lines[v] = sourceComp(ctx, v, r, {
            guide: guide && guide.length ? guide : null,
            others: segSrc.guides.filter((g) => g && g !== guide),
            partners: generatedComps.map((x) => lines[x]),
            melShift: b.melodyShift ?? 0,
          });
        else lines[v] = genComp(ctx, v, r, { partners, rank });
        generatedComps.push(v);
        rank++;
      }

      // Melodie-Solo einer tieferen Stimme: leise Liegeklänge der höheren Stimmen dürfen darüber
      // liegen (Background über dem Solisten – wie in gedruckten Sätzen)
      if (b.feature && ctx.melodyVoice !== undefined)
        for (let v = 0; v < N; v++) if (lines[v] && v !== ctx.melodyVoice && ['pad', 'comp'].includes(roles[v]) && regPos.get(v) < regPos.get(ctx.melodyVoice)) for (const e of lines[v]) e.above = true;
      // in absolute Zeit übertragen
      for (let v = 0; v < N; v++) {
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
    bassVoice: slots.bass,
    slots,
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
  // Profi-Regeln: Vorhalte im Aufbau-Teil, Guide-Tones, Lead immer oben – danach Stimmführung
  // (Gegenbewegung zum Bass, keine Quint-/Oktavparallelen) und nochmals Lead oben
  addSuspensions(arr, report);
  ensureGuideTones(arr, report);
  keepLeadOnTop(arr, report);
  enforceContraryMotion(arr, report);
  keepLeadOnTop(arr, report);
  fixParallels(arr, report);
  keepLeadOnTop(arr, report);
  enforceContraryMotion(arr, report);
  keepLeadOnTop(arr, report);
  // Gesangslinie lesbar: Silbenwiederholungen zusammenfassen (wie in gedruckten Noten)
  voices.forEach((v, i) => {
    const lead = v.events.filter((e) => e.role === 'melody');
    if (lead.length < 3) return;
    const r = reduceSyllableRepeats(lead, arr.levels[i], beat);
    if (!r.merged) return;
    v.events = cleanLine([...v.events.filter((e) => e.role !== 'melody'), ...r.events]);
    report.syllables = (report.syllables || 0) + r.merged;
  });
  voices.forEach((v, i) => insertBreaths(v, v.inst, tempo, report, arr.levels[i] && arr.levels[i] <= 2 ? 0.75 : 1, 4 * mt));
  decorate(arr, report);
  applyDynamics(arr);
  simplifyForReading(arr, song.meter);
  addPerformanceMarks(arr);
  // Tempoverlauf der Vorlage (rit., accel., neues Tempo) – die Wiedergabe wird langsamer und
  // schneller wie das Lied, in den Noten stehen die Angaben an denselben Stellen
  const stm = sourceTempoMap(song, blocks, mt, tempo);
  if (stm) {
    arr.tempoMap = stm.map;
    for (const m of stm.marks) for (const v of voices) v.dirs.push({ ...m });
  }
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
      subtitle: `${style.name} – ${ENSEMBLE_NAMES[voices.length] || `${voices.length} Stimmen`}`,
      keyName: keyName(song.key),
      keyNameDe: keyNameDe(song.key),
      tempo,
      tempoText: th.text,
      styleHint: th.hint,
      swing: style.feel === 'swing8' || !!song.swing, // auch das Swing-Gefühl der Vorlage
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

// Tempo je Takt aus der Vorlage, übertragen auf die Takte des Arrangements. Nur echte Änderungen
// (ab 4 % Abweichung vom Grundtempo) – kleines Schwanken einer Aufnahme bleibt unberücksichtigt.
function sourceTempoMap(song, blocks, mt, tempo) {
  const marks = (song.tempoMarks || []).filter((x) => !(x.kind === 'tempo' && x.bar === 0));
  if (!marks.length) return null;
  const scale = song.tempo ? tempo / song.tempo : 1;
  let barBpm = () => null;
  const tg = song.timing;
  if (tg && tg.beatSec && tg.beatSec.length > 2) {
    const bt = tg.beatTicks || DIV;
    const bpb = mt / bt;
    const compound = song.meter.beatType === 8 && song.meter.beats % 3 === 0 && song.meter.beats > 3;
    barBpm = (bar) => {
      const a = tg.firstBeat + bar * bpb;
      const z = a + bpb;
      if (a < 0 || z >= tg.beatSec.length || a !== Math.floor(a)) return null;
      const bpm = (60 * bpb) / (tg.beatSec[z] - tg.beatSec[a]);
      return compound ? bpm * 1.5 : bpm;
    };
  } else if (song.tempoEvents && song.tempoEvents.length > 1) {
    barBpm = (bar) => {
      let v = song.tempoEvents[0].bpm;
      for (const e of song.tempoEvents) if (e.t <= bar * mt) v = e.bpm;
      return v;
    };
  } else return null;
  const map = [];
  let last = null;
  for (const b of blocks) {
    for (let k = 0; k < b.measures; k++) {
      let bpm = b.source ? barBpm(b.source.from + k) : null;
      if (bpm === null || Math.abs(bpm - song.tempo) / song.tempo < 0.04) bpm = song.tempo;
      const v = Math.round(bpm * scale);
      if (last === null || v !== last) {
        map.push({ t: (b.startBar + k) * mt, bpm: v });
        last = v;
      }
    }
  }
  if (!map.length || map[0].t !== 0) map.unshift({ t: 0, bpm: Math.round(tempo) });
  const out = [];
  for (const tm of marks) {
    for (const b of blocks) {
      if (!b.source || tm.bar < b.source.from || tm.bar >= b.source.to) continue;
      const t = (b.startBar + tm.bar - b.source.from) * mt;
      out.push(tm.kind === 'tempo' ? { t, kind: 'metro', bpm: Math.round(tm.bpm * scale), meter: song.meter } : { t, kind: 'words', text: { rit: 'rit.', accel: 'accel.', atempo: 'a tempo' }[tm.kind] });
    }
  }
  return { map, marks: out };
}

// Melodie-Verdopplung für große Besetzungen: Oktave tiefer, wenn bequem spielbar, sonst eine
// Terz (nächster Akkord-/Skalenton) darunter – bleibt immer unter der Melodie
function doubleMelody(ctx, v, melLine, { harmony = false } = {}) {
  const inst = ctx.inst[v];
  const ps = melLine.map((e) => e.pitches[0] - 12);
  const inComfort = ps.filter((m) => m >= inst.comfort[0] - 2 && m <= inst.comfort[1] + 1).length;
  // harmony: Parallelstimme in Terzen/Sexten (Akkordtöne) statt Oktav-Verdopplung
  const octave = !harmony && ps.length && inComfort / ps.length >= 0.85;
  const out = [];
  for (const e of melLine) {
    const top = e.pitches[0];
    let m;
    let lof = e.lofs ? e.lofs[0] : null;
    if (octave) m = top - 12;
    else {
      const chord = ctx.chordAt(e.start);
      const vc = voiceBelow(chord, top, [inst], ctx.style.id, [out.length ? out[out.length - 1].pitches[0] : null]);
      m = vc[0].midi;
      lof = vc[0].lof;
      while (m >= top) m -= 12;
    }
    if (m < inst.range[0]) m += 12;
    if (m >= top) continue;
    out.push({ ...e, pitches: [m], lofs: [lof], role: 'double', grace: null, orn: null, fx: [...(e.fx || [])], art: [...(e.art || [])] });
  }
  const line = cleanLine(out);
  if (line.length) ctx.setLast(v, line[line.length - 1].pitches[0]);
  return line;
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
