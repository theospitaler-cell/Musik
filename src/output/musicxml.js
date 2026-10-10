// MusicXML 4.0 (score-partwise) – Partitur & Einzelstimmen.
// Direkt importierbar in MuseScore, Dorico, Sibelius, Finale.
import { DIV, mod } from '../core/constants.js';
import { XmlWriter } from '../core/xml.js';
import { spelled, lofLetter, lofAlter, lofPc } from '../theory/pitch.js';
import { buildChord, kindXml, kindText } from '../theory/chords.js';
import { chordAt } from '../model/song.js';
import { layoutVoice, meterInfo, singleValueDur } from './notation.js';
import { fitOctave } from '../arrange/instruments.js';
import { KIT } from '../arrange/gen/drums.js';
import { pageLayout } from './layout.js';
import { printedMeasures } from './form.js';

const LEAD = new Set(['melody', 'solo', 'hook', 'subject', 'tutti']);

const DRUM_DISPLAY = {
  36: { step: 'F', octave: 4, voice: 2, name: 'Bass Drum' },
  44: { step: 'D', octave: 4, voice: 2, head: 'x', name: 'Hi-Hat (Pedal)' },
  38: { step: 'C', octave: 5, voice: 1, name: 'Snare' },
  37: { step: 'C', octave: 5, voice: 1, head: 'x', name: 'Side Stick' },
  42: { step: 'G', octave: 5, voice: 1, head: 'x', name: 'Hi-Hat (geschl.)' },
  46: { step: 'G', octave: 5, voice: 1, head: 'circle-x', name: 'Hi-Hat (offen)' },
  49: { step: 'A', octave: 5, voice: 1, head: 'x', name: 'Crash' },
  51: { step: 'F', octave: 5, voice: 1, head: 'x', name: 'Ride' },
  48: { step: 'E', octave: 5, voice: 1, name: 'Tom hoch' },
  45: { step: 'D', octave: 5, voice: 1, name: 'Tom mittel' },
  41: { step: 'A', octave: 4, voice: 1, name: 'Standtom' },
};

const CLEFS = {
  G2: { sign: 'G', line: 2 },
  F4: { sign: 'F', line: 4 },
  C3: { sign: 'C', line: 3 },
  C4: { sign: 'C', line: 4 },
  perc: { sign: 'percussion', line: null },
};

const ACC = { 2: 'double-sharp', 1: 'sharp', 0: 'natural', '-1': 'flat', '-2': 'flat-flat' };

function keyAlterMap(fifths) {
  const map = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  const sharps = 'FCGDAEB';
  const flats = 'BEADGCF';
  for (let i = 0; i < Math.min(7, Math.max(0, fifths)); i++) map[sharps[i]] = 1;
  for (let i = 0; i < Math.min(7, Math.max(0, -fifths)); i++) map[flats[i]] = -1;
  return map;
}

function transposeInfo(inst, concert) {
  if (concert || !inst) return { semis: 0, lof: 0 };
  return inst.transpose;
}

function partKeyFifths(keyFifths, tr) {
  let f = keyFifths + tr.lof;
  let enh = 0;
  if (f > 6) {
    f -= 12;
    enh = -12;
  } else if (f < -6) {
    f += 12;
    enh = 12;
  }
  // Grenzfall: 6 Kreuze -> 6 b bevorzugen (Gb statt F#)
  if (f === 6) {
    f = -6;
    enh -= 12;
  }
  return { fifths: f, enh };
}

function typeDivisions(type) {
  return { whole: 96, half: 48, quarter: 24, eighth: 12, '16th': 6, '32nd': 3 }[type];
}

function voiceLabel(i) {
  return `Stimme ${i + 1}`;
}

// Takte, in denen die Stimme pausiert
function emptyBars(events, totalBars, mt) {
  const busy = new Array(totalBars).fill(false);
  for (const e of events) {
    const a = Math.floor(e.start / mt);
    const b = Math.floor((e.start + e.dur - 1) / mt);
    for (let m = a; m <= b && m < totalBars; m++) busy[m] = true;
  }
  return busy.map((x) => !x);
}

function clefForBlock(events, inst, a0, a1) {
  if (!inst || !inst.highClef) return inst ? inst.clef : 'G2';
  const ps = events.filter((e) => e.start >= a0 && e.start < a1).flatMap((e) => e.pitches);
  if (ps.length < 3) return null; // unverändert lassen
  const sorted = [...ps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  if (inst.highClef === 'C4') {
    // Tenorschlüssel bei hoher Lage (Posaune, Cello, Fagott, Euphonium)
    return median >= 63 && min >= 52 ? 'C4' : inst.clef;
  }
  if (inst.highClef === 'G2') return median >= 74 && min >= 62 ? 'G2' : inst.clef;
  return inst.clef;
}

// ---------------------------------------------------------------------------
export function exportMusicXML(arr, opts = {}) {
  const { mode = 'score', partIndex = 0, concert = false, paper = 'A4', chords = 'solo' } = opts;
  const isPart = mode === 'part';
  const partSpecs = [];
  if (isPart) {
    if (partIndex === 'drums') partSpecs.push({ kind: 'drums', idx: 4 });
    else partSpecs.push({ kind: 'voice', idx: partIndex });
  } else {
    arr.voices.forEach((_, i) => partSpecs.push({ kind: 'voice', idx: i }));
    if (arr.drums) partSpecs.push({ kind: 'drums', idx: 4 });
  }
  const layout = pageLayout(paper, isPart ? 7.0 : 5.6);
  const w = new XmlWriter();
  w.raw('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  w.raw('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  w.open('score-partwise', { version: '4.0' });
  w.open('work');
  w.el('work-title', arr.meta.title);
  w.close('work');
  if (isPart) w.el('movement-title', partTitle(arr, partSpecs[0]));
  w.open('identification');
  if (arr.meta.composer) w.el('creator', arr.meta.composer, { type: 'composer' });
  w.el('creator', 'Maestro-Arranger', { type: 'arranger' });
  w.open('encoding');
  w.el('software', 'Maestro-Arranger Quartett-Engine');
  w.el('encoding-date', new Date().toISOString().slice(0, 10));
  w.el('supports', null, { element: 'accidental', type: 'yes' });
  w.el('supports', null, { element: 'beam', type: 'yes' });
  w.el('supports', null, { element: 'print', attribute: 'new-system', type: 'yes', value: 'yes' });
  w.el('supports', null, { element: 'stem', type: 'no' });
  w.close('encoding');
  w.close('identification');
  writeDefaults(w, layout);
  writeCredits(w, arr, layout, isPart ? partTitle(arr, partSpecs[0]) : null);
  // Part-List
  w.open('part-list');
  const nameCount = {};
  for (const ps of partSpecs) if (ps.kind === 'voice') nameCount[arr.voices[ps.idx].inst.name] = (nameCount[arr.voices[ps.idx].inst.name] || 0) + 1;
  const seen = {};
  partSpecs.forEach((ps, k) => {
    const pid = `P${k + 1}`;
    ps.pid = pid;
    if (ps.kind === 'drums') {
      w.open('score-part', { id: pid });
      w.el('part-name', 'Schlagzeug');
      w.el('part-abbreviation', 'Schlz.');
      for (const [num, d] of Object.entries(DRUM_DISPLAY)) {
        w.open('score-instrument', { id: `${pid}-X${num}` });
        w.el('instrument-name', d.name);
        w.close('score-instrument');
      }
      for (const num of Object.keys(DRUM_DISPLAY)) {
        w.open('midi-instrument', { id: `${pid}-X${num}` });
        w.el('midi-channel', 10);
        w.el('midi-program', 1);
        w.el('midi-unpitched', Number(num) + 1);
        w.close('midi-instrument');
      }
      w.close('score-part');
      return;
    }
    const v = arr.voices[ps.idx];
    const base = v.inst.name;
    seen[base] = (seen[base] || 0) + 1;
    const nm = nameCount[base] > 1 ? `${base} ${seen[base]}` : base;
    w.open('score-part', { id: pid });
    w.el('part-name', isPart ? `${nm} (${voiceLabel(ps.idx)})` : nm);
    w.el('part-abbreviation', v.inst.short + (nameCount[base] > 1 ? ` ${seen[base]}` : ''));
    w.open('score-instrument', { id: `${pid}-I1` });
    w.el('instrument-name', base);
    w.close('score-instrument');
    w.open('midi-instrument', { id: `${pid}-I1` });
    w.el('midi-channel', (ps.idx % 9) + 1);
    w.el('midi-program', v.inst.midiProgram + 1);
    w.close('midi-instrument');
    w.close('score-part');
  });
  w.close('part-list');

  partSpecs.forEach((ps, k) => {
    w.open('part', { id: ps.pid });
    if (ps.kind === 'drums') writeDrumPart(w, arr, ps, { isPart, layout, first: k === 0 });
    else writeVoicePart(w, arr, ps, { isPart, concert, layout, chords, first: k === 0 });
    w.close('part');
  });
  w.close('score-partwise');
  return w.toString();
}

function partTitle(arr, ps) {
  if (ps.kind === 'drums') return 'Schlagzeug';
  const v = arr.voices[ps.idx];
  return `${voiceLabel(ps.idx)} – ${v.inst.name}`;
}

function writeDefaults(w, L) {
  w.open('defaults');
  w.open('scaling');
  w.el('millimeters', L.staffMm.toFixed(4));
  w.el('tenths', 40);
  w.close('scaling');
  w.open('page-layout');
  w.el('page-height', Math.round(L.height));
  w.el('page-width', Math.round(L.width));
  for (const type of ['both']) {
    w.open('page-margins', { type });
    w.el('left-margin', L.left);
    w.el('right-margin', L.right);
    w.el('top-margin', L.top);
    w.el('bottom-margin', L.bottom);
    w.close('page-margins');
  }
  w.close('page-layout');
  w.open('system-layout');
  w.open('system-margins');
  w.el('left-margin', 0);
  w.el('right-margin', 0);
  w.close('system-margins');
  w.el('system-distance', 110);
  w.el('top-system-distance', 170);
  w.close('system-layout');
  w.open('staff-layout');
  w.el('staff-distance', 80);
  w.close('staff-layout');
  w.el('word-font', null, { 'font-family': 'Edwin', 'font-size': 10 });
  w.close('defaults');
}

function writeCredits(w, arr, L, partName) {
  const cx = L.width / 2;
  const top = L.height - L.top * 0.45;
  const credit = (text, x, y, size, justify, type, weight) => {
    w.open('credit', { page: 1 });
    if (type) w.el('credit-type', type);
    w.el('credit-words', text, { 'default-x': Math.round(x), 'default-y': Math.round(y), justify, valign: 'top', 'font-size': size, 'font-weight': weight });
    w.close('credit');
  };
  credit(arr.meta.title, cx, top, 22, 'center', 'title', 'bold');
  credit(arr.meta.subtitle, cx, top - 45, 12, 'center', 'subtitle');
  if (arr.meta.composer) credit(arr.meta.composer, L.width - L.right, top - 70, 10, 'right', 'composer');
  credit(arr.meta.arranger, L.width - L.right, top - 88, 10, 'right', 'arranger');
  if (partName) credit(partName, L.left, top - 70, 13, 'left', 'part name', 'bold');
}

function chordForPart(chord, tr, enh) {
  if (!chord) return null;
  if (!tr.lof && !enh) return chord;
  const d = tr.lof + enh;
  return buildChord(chord.rootLof + d, chord.kind, chord.tensions, chord.bassLof === null ? null : chord.bassLof + d);
}

// MusicXML-Akkordart inkl. Optionstönen (9/11/13) – keine doppelten Angaben
function harmonyKind(chord) {
  const t = [...chord.tensions].filter((x) => x !== 'b5');
  const has = (...xs) => xs.every((x) => t.includes(x)) && t.length === xs.length;
  if (chord.kind === 'dominant' && has('9')) return { kind: 'dominant-ninth', text: '9', rest: [] };
  if (chord.kind === 'dominant' && has('9', '13')) return { kind: 'dominant-13th', text: '13', rest: [] };
  if (chord.kind === 'dominant' && has('9', '11')) return { kind: 'dominant-11th', text: '11', rest: [] };
  if (chord.kind === 'major-seventh' && has('9')) return { kind: 'major-ninth', text: 'maj9', rest: [] };
  if (chord.kind === 'minor-seventh' && has('9')) return { kind: 'minor-ninth', text: 'm9', rest: [] };
  if (chord.kind === 'minor-seventh' && has('9', '11')) return { kind: 'minor-11th', text: 'm11', rest: [] };
  if (chord.kind === 'major-sixth' && has('9')) return { kind: 'major-sixth', text: '6/9', rest: ['9'] };
  return { kind: kindXml(chord), text: kindText(chord), rest: t };
}

function writeHarmony(w, chord, offset) {
  w.open('harmony', { 'print-frame': 'no' });
  w.open('root');
  w.el('root-step', lofLetter(chord.rootLof));
  const a = lofAlter(chord.rootLof);
  if (a) w.el('root-alter', a);
  w.close('root');
  const hk = harmonyKind(chord);
  w.el('kind', hk.kind, { text: hk.text });
  if (chord.bassLof !== null) {
    w.open('bass');
    w.el('bass-step', lofLetter(chord.bassLof));
    const ba = lofAlter(chord.bassLof);
    if (ba) w.el('bass-alter', ba);
    w.close('bass');
  }
  for (const t of hk.rest) {
    const m = /^([b#]?)(\d+)$/.exec(t);
    if (!m) continue;
    w.open('degree', { 'print-object': hk.text === '6/9' ? 'no' : undefined });
    w.el('degree-value', m[2]);
    w.el('degree-alter', m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0);
    w.el('degree-type', 'add');
    w.close('degree');
  }
  if (offset) w.el('offset', offset);
  w.close('harmony');
}

function chordTextFor(c) {
  const sym = c.symbol || '';
  // Text nach dem Grundton (inkl. Zusätze), ohne Basston
  const m = /^[A-G][#b]?(.*?)(\/[A-G][#b]?)?$/.exec(sym);
  if (m && m[1] !== undefined && sym) {
    // Symbol bezieht sich evtl. auf andere Tonart -> neu aus Art bilden, wenn Grundton nicht passt
    return m[1];
  }
  return kindText(c);
}

function blockAtBar(arr, m) {
  let res = arr.blocks[0];
  for (const b of arr.blocks) if (b.startBar <= m) res = b;
  return res;
}

function blockHeading(arr, b, voiceIdx) {
  const seg = b.segments[0];
  const soloSeg = b.segments.find((sg) => sg.roles.includes('solo'));
  if (voiceIdx === null || voiceIdx === undefined) {
    const parts = [b.name.replace(/ \(D\.S\.\)$/, '')];
    const lead = seg.roles.findIndex((r) => r === 'melody' || r === 'hook' || r === 'subject');
    if (soloSeg) parts.push(`Solo: ${arr.voices[soloSeg.roles.indexOf('solo')].inst.short}`);
    else if (lead >= 0) parts.push(`Melodie: ${arr.voices[lead].inst.short}`);
    return parts.join(' – ');
  }
  const r = seg.roles[voiceIdx];
  if (soloSeg) {
    const sv = soloSeg.roles.indexOf('solo');
    if (sv === voiceIdx) return 'SOLO';
    return `Solo ${arr.voices[sv].inst.short} – ${r === 'bass' ? 'Bass/Groove' : 'Background'}`;
  }
  if (r === 'melody') return `${b.name} – Melodie`;
  return b.name;
}

function measureSig(items, dirs) {
  if (!items) return '';
  return JSON.stringify([
    items.map((it) => [it.kind, it.start, it.dur, it.pitches, it.tieStart, it.tieStop, it.ev ? [it.ev.art, it.ev.fx, it.ev.grace?.midi, it.ev.orn] : null]),
    dirs.length,
  ]);
}

const SIMILE_ROLES = new Set(['bass', 'comp', 'stabs', 'background', 'pad', 'riff']);

// Faulenzer (Takt-Wiederholungszeichen) für identische Begleittakte
function simileFlags(printed, measures, dirsByBar, roleAtBar, breaks, blockStarts) {
  const flags = new Array(printed.length).fill(false);
  let run = 0;
  for (let k = 1; k < printed.length; k++) {
    const cur = printed[k];
    const prev = printed[k - 1];
    const ok =
      cur.src === prev.src + 1 &&
      !breaks.has(k) &&
      !blockStarts.has(cur.src) &&
      !cur.startRepeat &&
      !prev.endRepeat &&
      SIMILE_ROLES.has(roleAtBar(cur.src)) &&
      (dirsByBar(cur.src) || []).length === 0 &&
      measures[cur.src].some((it) => it.kind === 'note') &&
      !measures[cur.src].some((it) => it.tieStop || it.tieStart) &&
      measureSig(measures[cur.src], []) === measureSig(measures[prev.src], []);
    if (ok && run < 3) {
      flags[k] = true;
      run++;
    } else run = 0;
  }
  return flags;
}

function printedBreaks(arr, printed, emptyPrinted) {
  // Systemumbruch: Formteil-Anfang, Coda, und alle 4 gedruckten Takte innerhalb eines Formteils
  const breaks = new Set();
  let sinceBreak = 0;
  for (let k = 0; k < printed.length; k++) {
    const m = printed[k];
    const isBlockStart = arr.blocks.some((b) => b.startBar === m.src);
    if (k > 0 && (isBlockStart || m.coda || m.startRepeat)) {
      breaks.add(k);
      sinceBreak = 0;
    } else if (k > 0 && sinceBreak >= 4) {
      breaks.add(k);
      sinceBreak = 0;
    }
    sinceBreak++;
  }
  if (emptyPrinted) for (const k of [...breaks]) if (emptyPrinted[k] && emptyPrinted[k - 1]) breaks.delete(k);
  return breaks;
}

function writeFormDirectionsStart(w, pm, showGlobal) {
  if (!showGlobal) return;
  if (pm.segno) {
    w.open('direction', { placement: 'above' });
    w.open('direction-type');
    w.el('segno');
    w.close('direction-type');
    w.el('sound', null, { segno: 'segno1' });
    w.close('direction');
  }
  if (pm.coda) {
    w.open('direction', { placement: 'above' });
    w.open('direction-type');
    w.el('coda');
    w.close('direction-type');
    w.open('direction-type');
    w.el('words', 'Coda', { 'font-weight': 'bold', 'font-size': 14 });
    w.close('direction-type');
    w.el('sound', null, { coda: 'coda1' });
    w.close('direction');
  }
  if (pm.startRepeat && pm.repeatTimes > 2) {
    w.open('direction', { placement: 'above' });
    w.open('direction-type');
    w.el('words', `${pm.repeatTimes}x`, { 'font-weight': 'bold' });
    w.close('direction-type');
    w.close('direction');
  }
}

function writeFormDirectionsEnd(w, pm, showGlobal) {
  if (!showGlobal) return;
  if (pm.toCoda) {
    w.open('direction', { placement: 'above' });
    w.open('direction-type');
    w.el('words', 'To Coda', { 'font-style': 'italic', 'font-weight': 'bold', justify: 'right' });
    w.close('direction-type');
    w.open('direction-type');
    w.el('coda');
    w.close('direction-type');
    w.el('sound', null, { tocoda: 'coda1' });
    w.close('direction');
  }
  if (pm.dalSegno) {
    w.open('direction', { placement: 'above' });
    w.open('direction-type');
    w.el('words', 'D.S. al Coda', { 'font-style': 'italic', 'font-weight': 'bold', justify: 'right' });
    w.close('direction-type');
    w.el('sound', null, { dalsegno: 'segno1' });
    w.close('direction');
  }
}

function writeBarlines(w, pm, isLast, nextPm, arr) {
  if (pm.startRepeat) {
    // linker Wiederholungsstrich wird am Taktanfang geschrieben (siehe writeLeftBarline)
  }
  if (pm.endRepeat) {
    w.open('barline', { location: 'right' });
    w.el('bar-style', 'light-heavy');
    w.el('repeat', null, { direction: 'backward', times: pm.endRepeat > 2 ? pm.endRepeat : undefined });
    w.close('barline');
    return;
  }
  if (isLast) {
    w.open('barline', { location: 'right' });
    w.el('bar-style', 'light-heavy');
    w.close('barline');
    return;
  }
  const nextIsBlock = nextPm && (nextPm.src !== pm.src + 1 || arr.blocks.some((b) => b.startBar === nextPm.src) || nextPm.coda);
  if (nextIsBlock || pm.dalSegno) {
    w.open('barline', { location: 'right' });
    w.el('bar-style', 'light-light');
    w.close('barline');
  }
}

function writeLeftBarline(w, pm) {
  if (!pm.startRepeat) return;
  w.open('barline', { location: 'left' });
  w.el('bar-style', 'heavy-light');
  w.el('repeat', null, { direction: 'forward' });
  w.close('barline');
}

function roleAtFactory(arr, idx) {
  return (bar) => {
    let blk = arr.blocks[0];
    for (const b of arr.blocks) if (b.startBar <= bar) blk = b;
    let seg = blk.segments[0];
    for (const sg of blk.segments) if (blk.startBar + sg.startBar <= bar) seg = sg;
    return idx === 'drums' ? 'bass' : seg.roles[idx];
  };
}

function writeVoicePart(w, arr, ps, { isPart, concert, layout, chords, first }) {
  void layout;
  const v = arr.voices[ps.idx];
  const inst = v.inst;
  const tr = transposeInfo(inst, concert);
  const mt = arr.mt;
  const mi = meterInfo(arr.meter);
  const total = arr.totalBars;
  const printed = printedMeasures(arr);
  const keyAtBar = (m) => blockAtBar(arr, m).key;
  const toWritten = (e) => {
    const m = Math.floor(e.start / mt);
    const pk = partKeyFifths(keyAtBar(m).fifths, tr);
    return {
      ...e,
      pitches: e.pitches.map((p) => p + tr.semis),
      lofs: e.lofs.map((l) => (l === null || l === undefined ? l : l + tr.lof + pk.enh)),
      grace: e.grace ? { ...e.grace, midi: e.grace.midi + tr.semis, lof: e.grace.lof === null || e.grace.lof === undefined ? null : e.grace.lof + tr.lof + pk.enh } : null,
    };
  };
  const events = v.events.map(toWritten);
  const measures = layoutVoice(events, arr.meter, total);
  const emptySrc = emptyBars(v.events, total, mt);
  const emptyPrinted = printed.map((pm) => emptySrc[pm.src] && !pm.startRepeat && !pm.endRepeat && !pm.segno && !pm.coda && !pm.toCoda && !pm.dalSegno);
  const blockStarts = new Set(arr.blocks.map((b) => b.startBar));
  // Stichnoten & Mehrtaktpausen (nur Einzelstimmen), auf gedruckter Folge
  const cueAt = new Map();
  const multiRest = new Map();
  if (isPart) {
    let k = 0;
    while (k < printed.length) {
      if (!emptyPrinted[k]) {
        k++;
        continue;
      }
      let e = k;
      // Mehrtaktpausen enden an Formteil-Anfängen (Probenbuchstaben bleiben sichtbar)
      while (e < printed.length && emptyPrinted[e] && (e === k || !blockStarts.has(printed[e].src))) e++;
      const len = e - k;
      // Stichnoten vor Einsätzen nach > 4 Takten Pause
      let cueBars = 0;
      if (len > 4 && e < printed.length && !emptyPrinted[e]) {
        for (let c = Math.max(k, e - 2); c < e; c++) {
          const cue = buildCue(arr, ps.idx, printed[c].src, tr);
          if (cue) {
            cueAt.set(c, cue);
            cueBars++;
          }
        }
      }
      // Takt 1 bleibt ausgeschrieben (Tempo- & Stilangabe gut sichtbar)
      const startK = k === 0 ? 1 : k;
      const restLen = len - cueBars - (startK - k);
      if (restLen >= 2) multiRest.set(startK, restLen);
      k = e;
    }
  }
  const breaks = printedBreaks(arr, printed, isPart ? emptyPrinted : null);
  const dirsAt = (bar) => v.dirs.filter((d) => d.t >= bar * mt && d.t < (bar + 1) * mt);
  const simile = simileFlags(printed, measures, dirsAt, roleAtFactory(arr, ps.idx), breaks, blockStarts);
  let currentClef = inst.clef;
  let currentKey = null;
  let inMultiRest = 0;
  let simileOpen = false;
  let lastCueLabel = null;
  for (let k = 0; k < printed.length; k++) {
    const pm = printed[k];
    const m = pm.src;
    w.open('measure', { number: pm.number });
    if (k === 0) {
      w.open('print');
      w.el('measure-numbering', 'system');
      w.close('print');
    } else if (breaks.has(k)) w.el('print', null, { 'new-system': 'yes' });
    writeLeftBarline(w, pm);
    const block = blockAtBar(arr, m);
    const blockStart = block.startBar === m;
    const pk = partKeyFifths(block.key.fifths, tr);
    let clef = null;
    if (blockStart) {
      const c = clefForBlock(v.events, inst, block.startBar * mt, (block.startBar + block.measures) * mt);
      if (c && c !== currentClef) clef = c;
    }
    const keyChanged = currentKey === null || currentKey.fifths !== pk.fifths || currentKey.mode !== block.key.mode;
    const mr = multiRest.get(k);
    const simStart = simile[k] && !simileOpen;
    const simStop = !simile[k] && simileOpen;
    if (k === 0 || keyChanged || clef || mr || simStart || simStop) {
      w.open('attributes');
      if (k === 0) w.el('divisions', DIV);
      if (keyChanged) {
        w.open('key');
        w.el('fifths', pk.fifths);
        w.el('mode', block.key.mode);
        w.close('key');
        currentKey = { fifths: pk.fifths, mode: block.key.mode };
      }
      if (k === 0) {
        w.open('time');
        w.el('beats', arr.meter.beats);
        w.el('beat-type', arr.meter.beatType);
        w.close('time');
      }
      if (k === 0 || clef) {
        const c = CLEFS[clef || currentClef];
        w.open('clef');
        w.el('sign', c.sign);
        if (c.line) w.el('line', c.line);
        w.close('clef');
        if (clef) currentClef = clef;
      }
      if (k === 0 && tr.semis) {
        const steps = mod(4 * tr.lof, 7);
        w.open('transpose');
        w.el('diatonic', -steps);
        w.el('chromatic', -mod(tr.semis, 12));
        if (tr.semis >= 12) w.el('octave-change', -Math.floor(tr.semis / 12));
        w.close('transpose');
      }
      if (mr) {
        w.open('measure-style');
        w.el('multiple-rest', mr);
        w.close('measure-style');
        inMultiRest = mr;
      }
      if (simStop) {
        w.open('measure-style');
        w.el('measure-repeat', null, { type: 'stop' });
        w.close('measure-style');
        simileOpen = false;
      }
      if (simStart) {
        w.open('measure-style');
        w.el('measure-repeat', '1', { type: 'start' });
        w.close('measure-style');
        simileOpen = true;
      }
      w.close('attributes');
    }
    const showGlobal = isPart || first;
    const pre = [];
    pre.push(() => writeFormDirectionsStart(w, pm, showGlobal));
    if (k === 0 && showGlobal) pre.push(() => writeTempoHeading(w, arr));
    if (blockStart && showGlobal && !pm.coda) {
      pre.push(() => {
        if (block.rehearsal) {
          w.open('direction', { placement: 'above' });
          w.open('direction-type');
          w.el('rehearsal', block.rehearsal, { enclosure: 'square', 'font-size': 20, 'font-weight': 'bold' });
          w.close('direction-type');
          w.close('direction');
        }
        if (k > 0) {
          w.open('direction', { placement: 'above' });
          w.open('direction-type');
          w.el('words', blockHeading(arr, block, isPart ? ps.idx : null), { 'font-size': 10, 'font-style': 'italic' });
          w.close('direction-type');
          w.close('direction');
        }
      });
    }
    const cue = cueAt.get(k);
    const inCue = isPart && !!cue;
    const items = inCue ? cue.items : measures[m];
    if (inCue && cue.label !== lastCueLabel) {
      pre.push(() => {
        w.open('direction', { placement: 'above' });
        w.open('direction-type');
        w.el('words', `Stichnoten: ${cue.label}`, { 'font-size': 8, 'font-style': 'italic' });
        w.close('direction-type');
        w.close('direction');
      });
    }
    lastCueLabel = inCue ? cue.label : null;
    const harmonies = [];
    const showChords = chords === 'all' || (chords === 'solo' && block.showChords && (block.segments.some((sg) => sg.roles[ps.idx] === 'solo') || (!isPart && first)));
    if (showChords) {
      const m0 = m * mt;
      for (const c of arr.chordTrack) {
        if (c.start >= m0 && c.start < m0 + mt) harmonies.push({ t: c.start - m0, chord: chordForPart(c.chord, tr, pk.enh) });
        else if (c.start < m0 && c.start + c.dur > m0 && (m === block.startBar || k === 0 || breaks.has(k))) harmonies.push({ t: 0, chord: chordForPart(c.chord, tr, pk.enh) });
      }
    }
    // Haltebögen über Sprünge hinweg entfernen
    const nextPm = printed[k + 1];
    const itemsFixed = items.map((it) => (it.tieStart && it.kind === 'note' && (!nextPm || nextPm.src !== m + 1) && it.start + it.dur >= mt ? { ...it, tieStart: false } : it));
    const dirs = dirsAt(m).map((d) => ({ ...d, t: d.t - m * mt }));
    writeMeasureItems(w, itemsFixed, { pre, dirs: inMultiRest > 0 && !dirs.length ? [] : dirs, harmonies, mi, keyFifths: pk.fifths, cue: inCue, isDrum: false, voice: 1, instRef: null });
    if (inMultiRest > 0) inMultiRest--;
    writeFormDirectionsEnd(w, pm, showGlobal);
    writeBarlines(w, pm, k === printed.length - 1, nextPm, arr);
    w.close('measure');
  }
}

function writeTempoHeading(w, arr) {
  w.open('direction', { placement: 'above' });
  w.open('direction-type');
  w.el('words', arr.meta.tempoText, { 'font-weight': 'bold', 'font-size': 12 });
  w.close('direction-type');
  w.open('direction-type');
  w.open('metronome', { parentheses: 'yes' });
  w.el('beat-unit', 'quarter');
  w.el('per-minute', arr.tempo);
  w.close('metronome');
  w.close('direction-type');
  w.el('sound', null, { tempo: arr.tempo });
  w.close('direction');
  if (arr.meta.styleHint) {
    w.open('direction', { placement: 'above' });
    w.open('direction-type');
    w.el('words', arr.meta.styleHint, { 'font-style': 'italic', 'font-size': 9 });
    w.close('direction-type');
    w.close('direction');
  }
}

function buildCue(arr, selfIdx, bar, tr) {
  const a = bar * arr.mt;
  const b = a + arr.mt;
  let best = null;
  arr.voices.forEach((v, i) => {
    if (i === selfIdx) return;
    const evs = v.events.filter((e) => e.start >= a && e.start < b);
    if (!evs.length) return;
    const lead = evs.filter((e) => LEAD.has(e.role)).length;
    const score = lead * 10 + evs.length;
    if (!best || score > best.score) best = { i, evs, score };
  });
  if (!best) return null;
  const self = arr.voices[selfIdx].inst;
  const src = best.evs.map((e) => ({ ...e, start: e.start - a, dur: Math.min(e.dur, b - e.start), pitches: [e.pitches[e.pitches.length - 1]], lofs: [e.lofs[e.lofs.length - 1]], grace: null, fx: [], art: [], tieFromPrev: false, slurStart: false, slurEnd: false, fermata: false, orn: null, breathAfter: false }));
  const fit = fitOctave(src.map((e) => ({ midi: e.pitches[0], dur: e.dur })), self);
  const pk = partKeyFifths(arr.keyAt(a).fifths, tr);
  const written = src.map((e) => ({ ...e, pitches: [e.pitches[0] + fit.shift + tr.semis], lofs: [e.lofs[0] === null || e.lofs[0] === undefined ? null : e.lofs[0] + tr.lof + pk.enh] }));
  const items = layoutVoice(written, arr.meter, 1)[0].map((it) => ({ ...it, tieStart: false, tieStop: false }));
  return { items, label: arr.voices[best.i].inst.short };
}

function writeMeasureItems(w, items, { pre, dirs, harmonies, mi, keyFifths, cue, isDrum, voice, instRef, drumMap }) {
  for (const f of pre || []) f();
  const keyMap = keyAlterMap(keyFifths);
  const state = {};
  let dirIdx = 0;
  let harmIdx = 0;
  const dirsSorted = (dirs || []).sort((a, b) => a.t - b.t);
  const harmSorted = (harmonies || []).sort((a, b) => a.t - b.t);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const itEnd = it.start + it.dur;
    // Richtungen, die in dieses Item fallen
    while (dirIdx < dirsSorted.length && dirsSorted[dirIdx].t < itEnd) {
      const d = dirsSorted[dirIdx++];
      writeDirection(w, d, Math.max(0, d.t - it.start));
    }
    while (harmIdx < harmSorted.length && harmSorted[harmIdx].t < itEnd) {
      const h = harmSorted[harmIdx++];
      if (h.chord) writeHarmony(w, h.chord, Math.max(0, h.t - it.start));
    }
    if (it.kind === 'rest') {
      w.open('note');
      if (it.measureRest) w.el('rest', null, { measure: 'yes' });
      else w.el('rest');
      w.el('duration', it.dur);
      w.el('voice', voice);
      if (!it.measureRest) {
        w.el('type', it.type);
        for (let d = 0; d < it.dots; d++) w.el('dot');
      }
      if (it.tuplet) writeTimeMod(w, it);
      if (it.tuplet && (it.tuplet.start || it.tuplet.stop)) {
        w.open('notations');
        if (it.tuplet.start) w.el('tuplet', null, { type: 'start', bracket: 'yes' });
        if (it.tuplet.stop) w.el('tuplet', null, { type: 'stop' });
        w.close('notations');
      }
      w.close('note');
      continue;
    }
    const e = it.ev;
    // Vorschlagsnote
    if (it.first && e.grace && !isDrum) {
      const g = e.grace;
      const sp = spelled(g.midi, g.lof ?? 0);
      w.open('note');
      w.el('grace', null, g.slash ? { slash: 'yes' } : {});
      if (cue) w.el('cue');
      w.open('pitch');
      w.el('step', sp.step);
      if (sp.alter) w.el('alter', sp.alter);
      w.el('octave', sp.octave);
      w.close('pitch');
      w.el('voice', voice);
      w.el('type', 'eighth', cue ? { size: 'cue' } : undefined);
      const accG = accidentalFor(sp, state, keyMap, false);
      if (accG) w.el('accidental', accG);
      if (g.gliss) {
        w.open('notations');
        w.el('glissando', g.rip ? 'rip' : 'gliss.', { type: 'start', 'line-type': g.rip ? 'wavy' : 'solid', number: 1 });
        w.close('notations');
      }
      w.close('note');
    }
    const pitches = it.pitches;
    pitches.forEach((p, k) => {
      w.open('note');
      if (cue) w.el('cue');
      if (k > 0) w.el('chord');
      let sp = null;
      if (isDrum) {
        const dd = drumMap[p] || DRUM_DISPLAY[38];
        w.open('unpitched');
        w.el('display-step', dd.step);
        w.el('display-octave', dd.octave);
        w.close('unpitched');
      } else {
        sp = spelled(p, it.lofs[k] ?? 0);
        w.open('pitch');
        w.el('step', sp.step);
        if (sp.alter) w.el('alter', sp.alter);
        w.el('octave', sp.octave);
        w.close('pitch');
      }
      w.el('duration', it.dur);
      if (!cue) {
        if (it.tieStop) w.el('tie', null, { type: 'stop' });
        if (it.tieStart) w.el('tie', null, { type: 'start' });
      }
      if (isDrum && instRef) w.el('instrument', null, { id: `${instRef}-X${p}` });
      w.el('voice', voice);
      w.el('type', it.type, cue ? { size: 'cue' } : undefined);
      for (let d = 0; d < it.dots; d++) w.el('dot');
      if (!isDrum) {
        const acc = accidentalFor(sp, state, keyMap, it.tieStop);
        if (acc) w.el('accidental', acc);
      }
      if (it.tuplet) writeTimeMod(w, it);
      if (isDrum) {
        w.el('stem', voice === 1 ? 'up' : 'down');
        const dd = drumMap[p];
        if (dd?.head) w.el('notehead', dd.head);
        else if (e.ghost) w.el('notehead', 'normal', { parentheses: 'yes' });
      }
      if (k === 0 && it.beams) it.beams.forEach((b, bi) => w.el('beam', b, { number: bi + 1 }));
      writeNotations(w, it, e, k, pitches.length, isDrum, cue);
      w.close('note');
    });
  }
  // restliche Richtungen am Taktende
  while (dirIdx < dirsSorted.length) {
    const d = dirsSorted[dirIdx++];
    writeDirection(w, d, 0);
  }
}

function writeTimeMod(w, it) {
  w.open('time-modification');
  w.el('actual-notes', it.tuplet.actual);
  w.el('normal-notes', it.tuplet.normal);
  w.close('time-modification');
}

function accidentalFor(sp, state, keyMap, isTieStop) {
  const k = sp.step + sp.octave;
  const cur = k in state ? state[k] : keyMap[sp.step];
  if (isTieStop) return null;
  if (cur === sp.alter) return null;
  state[k] = sp.alter;
  return ACC[sp.alter] || null;
}

function writeNotations(w, it, e, k, nPitches, isDrum, cue) {
  const n = [];
  if (!cue) {
    if (it.tieStop) n.push(() => w.el('tied', null, { type: 'stop' }));
    if (it.tieStart) n.push(() => w.el('tied', null, { type: 'start' }));
  }
  if (k === 0) {
    if (it.first && e.slurStart && !cue) n.push(() => w.el('slur', null, { type: 'start', number: 1 }));
    if (it.last && e.slurEnd && !cue) n.push(() => w.el('slur', null, { type: 'stop', number: 1 }));
    if (it.tuplet?.start) n.push(() => w.el('tuplet', null, { type: 'start', bracket: 'yes' }));
    if (it.tuplet?.stop) n.push(() => w.el('tuplet', null, { type: 'stop' }));
    if (!cue && !isDrum) {
      if (it.first && (e.fx.includes('glissStop') || (e.grace && e.grace.gliss))) n.push(() => w.el('glissando', null, { type: 'stop', 'line-type': e.grace?.rip ? 'wavy' : 'solid', number: 1 }));
      if (it.last && e.fx.includes('glissStart')) n.push(() => w.el('glissando', 'gliss.', { type: 'start', 'line-type': 'solid', number: 1 }));
      const orn = [];
      if (it.first && e.orn?.includes('shake')) orn.push('shake');
      if (it.first && e.orn?.includes('trill')) orn.push('trill-mark');
      if (orn.length)
        n.push(() => {
          w.open('ornaments');
          for (const o of orn) w.el(o);
          w.close('ornaments');
        });
      const tech = [];
      if (it.first && e.fx.includes('stopped')) tech.push('stopped');
      if (it.first && e.fx.includes('upbow')) tech.push('up-bow');
      if (it.first && e.fx.includes('downbow')) tech.push('down-bow');
      if (tech.length)
        n.push(() => {
          w.open('technical');
          for (const t of tech) w.el(t);
          w.close('technical');
        });
    }
    const arts = [];
    if (it.first) {
      if (e.art.includes('accent')) arts.push('accent');
      if (e.art.includes('marcato')) arts.push(['strong-accent', { type: 'up' }]);
      if (e.art.includes('staccato') && it.last) arts.push('staccato');
      if (e.art.includes('tenuto')) arts.push('tenuto');
      if (!isDrum && !cue && e.fx.includes('scoop')) arts.push('scoop');
      if (!isDrum && !cue && e.fx.includes('plop')) arts.push('plop');
    }
    if (it.last && !isDrum && !cue) {
      if (e.fx.includes('falloff')) arts.push('falloff');
      if (e.fx.includes('doit')) arts.push('doit');
      if (e.breathAfter) arts.push('breath-mark');
    }
    if (arts.length)
      n.push(() => {
        w.open('articulations');
        for (const a of arts) Array.isArray(a) ? w.el(a[0], null, a[1]) : w.el(a);
        w.close('articulations');
      });
    if (it.last && e.fermata && !cue) n.push(() => w.el('fermata', null, { type: 'upright' }));
  } else if (!cue) {
    // Akkordnoten: nur Bindebögen (oben bereits)
  }
  if (!n.length) return;
  w.open('notations');
  for (const f of n) f();
  w.close('notations');
  void nPitches;
}

function writeDirection(w, d, offset) {
  if (d.kind === 'dyn') {
    w.open('direction', { placement: 'below' });
    w.open('direction-type');
    w.open('dynamics');
    w.el(d.value);
    w.close('dynamics');
    w.close('direction-type');
    if (offset) w.el('offset', offset);
    w.el('sound', null, { dynamics: Math.round(([40, 52, 66, 80, 96, 112][['pp', 'p', 'mp', 'mf', 'f', 'ff'].indexOf(d.value)] ?? 80) / 0.9) });
    w.close('direction');
  } else if (d.kind === 'wedge') {
    w.open('direction', { placement: 'below' });
    w.open('direction-type');
    w.el('wedge', null, { type: d.type, number: 1 });
    w.close('direction-type');
    if (offset) w.el('offset', offset);
    w.close('direction');
  } else if (d.kind === 'words') {
    w.open('direction', { placement: 'above' });
    w.open('direction-type');
    w.el('words', d.text, { 'font-style': 'italic' });
    w.close('direction-type');
    if (offset) w.el('offset', offset);
    w.close('direction');
  }
}

// ---------- Schlagzeug ------------------------------------------------------
function drumVoices(events, mt, mi) {
  // nach Hände/Füße trennen, Gleichzeitiges zu Akkorden bündeln,
  // Dauer bis zum nächsten Schlag – aber immer als EIN Notenwert (keine Haltebögen)
  const out = { 1: [], 2: [] };
  const groups = { 1: new Map(), 2: new Map() };
  for (const e of events) {
    const d = DRUM_DISPLAY[e.pitches[0]];
    const v = d ? d.voice : 1;
    const g = groups[v];
    if (!g.has(e.start)) g.set(e.start, { start: e.start, pitches: [], art: [], fx: [], ghost: true, lofs: [] });
    const x = g.get(e.start);
    if (!x.pitches.includes(e.pitches[0])) x.pitches.push(e.pitches[0]);
    if (e.art.includes('accent') && !x.art.includes('accent')) x.art.push('accent');
    if (!e.ghost) x.ghost = false;
  }
  for (const v of [1, 2]) {
    const list = [...groups[v].values()].sort((a, b) => a.start - b.start);
    list.forEach((x, i) => {
      const next = list[i + 1];
      const barStart = Math.floor(x.start / mt) * mt;
      const beatEnd = (Math.floor(x.start / mi.beatTicks) + 1) * mi.beatTicks;
      const limit = Math.min(next ? next.start : Infinity, barStart + mt, Math.max(beatEnd, x.start + 6));
      x.dur = singleValueDur(x.start - barStart, limit - x.start, mi) || Math.min(6, limit - x.start);
      x.pitches.sort((a, b) => a - b);
      x.lofs = x.pitches.map(() => 0);
      out[v].push(x);
    });
  }
  return out;
}

function writeDrumPart(w, arr, ps, { isPart, first }) {
  void first;
  const mt = arr.mt;
  const mi = meterInfo(arr.meter);
  const total = arr.totalBars;
  const printed = printedMeasures(arr);
  const dv = drumVoices(arr.drums.events, mt, mi);
  const m1 = layoutVoice(dv[1], arr.meter, total);
  const m2 = layoutVoice(dv[2], arr.meter, total);
  const combined = m1.map((x, i) => [...x, ...m2[i]]);
  const emptySrc = combined.map((items) => !items.some((it) => it.kind === 'note'));
  const emptyPrinted = printed.map((pm) => emptySrc[pm.src] && !pm.startRepeat && !pm.endRepeat && !pm.segno && !pm.coda);
  const blockStarts = new Set(arr.blocks.map((b) => b.startBar));
  const breaks = printedBreaks(arr, printed, isPart ? emptyPrinted : null);
  const simile = simileFlags(printed, combined, () => [], () => 'bass', breaks, blockStarts);
  const multiRest = new Map();
  if (isPart) {
    let k = 0;
    while (k < printed.length) {
      if (!emptyPrinted[k]) {
        k++;
        continue;
      }
      let e = k;
      while (e < printed.length && emptyPrinted[e] && (e === k || !blockStarts.has(printed[e].src))) e++;
      const startK = k === 0 ? 1 : k;
      if (e - startK >= 2) multiRest.set(startK, e - startK);
      k = e;
    }
  }
  let simileOpen = false;
  for (let k = 0; k < printed.length; k++) {
    const pm = printed[k];
    const m = pm.src;
    w.open('measure', { number: pm.number });
    if (k === 0) {
      w.open('print');
      w.el('measure-numbering', 'system');
      w.close('print');
    } else if (breaks.has(k)) w.el('print', null, { 'new-system': 'yes' });
    writeLeftBarline(w, pm);
    const simStart = simile[k] && !simileOpen;
    const simStop = !simile[k] && simileOpen;
    const mr = multiRest.get(k);
    if (k === 0 || simStart || simStop || mr) {
      w.open('attributes');
      if (k === 0) {
        w.el('divisions', DIV);
        w.open('key');
        w.el('fifths', 0);
        w.close('key');
        w.open('time');
        w.el('beats', arr.meter.beats);
        w.el('beat-type', arr.meter.beatType);
        w.close('time');
        w.open('clef');
        w.el('sign', 'percussion');
        w.close('clef');
      }
      if (mr) {
        w.open('measure-style');
        w.el('multiple-rest', mr);
        w.close('measure-style');
      }
      if (simStop) {
        w.open('measure-style');
        w.el('measure-repeat', null, { type: 'stop' });
        w.close('measure-style');
        simileOpen = false;
      }
      if (simStart) {
        w.open('measure-style');
        w.el('measure-repeat', '1', { type: 'start' });
        w.close('measure-style');
        simileOpen = true;
      }
      w.close('attributes');
    }
    const block = blockAtBar(arr, m);
    const pre = [];
    pre.push(() => writeFormDirectionsStart(w, pm, isPart));
    if (isPart && k === 0) pre.push(() => writeTempoHeading(w, arr));
    if (isPart && block.startBar === m && !pm.coda) {
      pre.push(() => {
        if (block.rehearsal) {
          w.open('direction', { placement: 'above' });
          w.open('direction-type');
          w.el('rehearsal', block.rehearsal, { enclosure: 'square', 'font-size': 20, 'font-weight': 'bold' });
          w.close('direction-type');
          w.close('direction');
        }
        if (k > 0) {
          w.open('direction', { placement: 'above' });
          w.open('direction-type');
          w.el('words', block.name, { 'font-size': 10, 'font-style': 'italic' });
          w.close('direction-type');
          w.close('direction');
        }
      });
    }
    writeMeasureItems(w, m1[m], { pre, dirs: [], harmonies: [], mi, keyFifths: 0, cue: false, isDrum: true, voice: 1, instRef: ps.pid, drumMap: DRUM_DISPLAY });
    const hasFeet = m2[m].some((x) => x.kind === 'note');
    if (hasFeet) {
      w.open('backup');
      w.el('duration', mt);
      w.close('backup');
      writeMeasureItems(w, m2[m], { pre: [], dirs: [], harmonies: [], mi, keyFifths: 0, cue: false, isDrum: true, voice: 2, instRef: ps.pid, drumMap: DRUM_DISPLAY });
    }
    writeFormDirectionsEnd(w, pm, isPart);
    writeBarlines(w, pm, k === printed.length - 1, printed[k + 1], arr);
    w.close('measure');
  }
}
