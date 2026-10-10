// MusicXML / MXL (z. B. aus MuseScore exportiert oder heruntergeladen) -> Song.
import { pickLead } from './lead.js';
import { DIV, mod } from '../core/constants.js';
import { parseXML } from '../core/xml.js';
import { unzip } from '../core/zip.js';
import { letterAlterToLof, stepAlterOctaveToMidi } from '../theory/pitch.js';
import { buildChord, parseChord } from '../theory/chords.js';
import { makeKey, transposeKey } from '../theory/keys.js';
import { finalizeSong } from '../theory/analysis.js';
import { measureTicks } from '../model/song.js';
import { expandOrder } from '../model/repeats.js';

const KIND_MAP = {
  major: 'major',
  minor: 'minor',
  augmented: 'augmented',
  diminished: 'diminished',
  dominant: 'dominant',
  'major-seventh': 'major-seventh',
  'minor-seventh': 'minor-seventh',
  'diminished-seventh': 'diminished-seventh',
  'augmented-seventh': 'augmented-seventh',
  'half-diminished': 'half-diminished',
  'major-minor': 'major-minor',
  'major-sixth': 'major-sixth',
  'minor-sixth': 'minor-sixth',
  'dominant-ninth': ['dominant', ['9']],
  'major-ninth': ['major-seventh', ['9']],
  'minor-ninth': ['minor-seventh', ['9']],
  'dominant-11th': ['dominant', ['9', '11']],
  'major-11th': ['major-seventh', ['9', '11']],
  'minor-11th': ['minor-seventh', ['9', '11']],
  'dominant-13th': ['dominant', ['9', '13']],
  'major-13th': ['major-seventh', ['9', '13']],
  'minor-13th': ['minor-seventh', ['9', '13']],
  'suspended-second': 'suspended-second',
  'suspended-fourth': 'suspended-fourth',
  power: 'power',
};

export async function readMusicXMLFile(bytesOrText, name = '') {
  let text;
  if (typeof bytesOrText === 'string') text = bytesOrText;
  else {
    const bytes = bytesOrText instanceof Uint8Array ? bytesOrText : new Uint8Array(bytesOrText);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const files = await unzip(bytes);
      let rootPath = null;
      const container = files.get('META-INF/container.xml');
      if (container) {
        const c = parseXML(new TextDecoder().decode(container));
        const rf = c.find('rootfile')[0];
        rootPath = rf?.attrs['full-path'] || null;
      }
      if (!rootPath) rootPath = [...files.keys()].find((k) => /\.(musicxml|xml)$/i.test(k) && !k.startsWith('META-INF'));
      if (!rootPath || !files.get(rootPath)) throw new Error('MXL-Datei enthält keine Partitur');
      text = new TextDecoder().decode(files.get(rootPath));
    } else {
      text = new TextDecoder().decode(bytes);
    }
  }
  return text;
}

function harmonyToChord(h) {
  const step = h.val('root/root-step');
  if (!step) return null;
  const alter = h.num('root/root-alter', 0);
  const rootLof = letterAlterToLof(step, Math.round(alter));
  const kindNode = h.child('kind');
  const kindVal = kindNode ? kindNode.text : 'major';
  if (kindVal === 'none') return null;
  // Text-Attribut bevorzugt parsen (enthält Zusätze wie 7b9)
  const textAttr = kindNode?.attrs?.text;
  let bassLof = null;
  const bs = h.val('bass/bass-step');
  if (bs) bassLof = letterAlterToLof(bs, Math.round(h.num('bass/bass-alter', 0)));
  const mapped = KIND_MAP[kindVal] ?? 'major';
  let kind = Array.isArray(mapped) ? mapped[0] : mapped;
  const tensions = Array.isArray(mapped) ? [...mapped[1]] : [];
  for (const d of h.all('degree')) {
    const v = d.num('degree-value');
    const a = d.num('degree-alter', 0);
    const t = d.val('degree-type');
    if (t === 'add' || t === 'alter') {
      const name = (a < 0 ? 'b' : a > 0 ? '#' : '') + v;
      if (['9', 'b9', '#9', '11', '#11', '13', 'b13'].includes(name)) tensions.push(name);
      if (name === 'b5' && kind === 'dominant') tensions.push('b5');
      if (name === '#5' && kind === 'dominant') kind = 'augmented-seventh';
    }
  }
  if (textAttr && /^[^\s]/.test(textAttr)) {
    const viaText = parseChord(lofLetterName(rootLof) + textAttr + (bassLof !== null ? '/' + lofLetterName(bassLof) : ''));
    if (viaText && viaText.kind) return viaText;
  }
  return buildChord(rootLof, kind, [...new Set(tensions)], bassLof);
}

function lofLetterName(lof) {
  const letters = 'FCGDAEB';
  const letter = letters[mod(lof + 1, 7)];
  const alter = Math.floor((lof + 1) / 7);
  return letter + (alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter));
}

// Rohdaten aller Stimmen lesen
export function scanScore(xmlText) {
  const root = parseXML(xmlText);
  if (root.name === 'score-timewise') throw new Error('score-timewise wird nicht unterstützt – bitte als "partwise" exportieren');
  if (root.name !== 'score-partwise') throw new Error('Keine MusicXML-Partitur gefunden');
  const title = root.val('work/work-title') || root.val('movement-title') || root.find('credit-words')[0]?.text || null;
  let composer = null;
  for (const c of root.find('creator')) if (c.attrs.type === 'composer') composer = c.text;
  const partInfo = {};
  for (const sp of root.find('score-part')) {
    const unp = {};
    for (const mi of sp.all('midi-instrument')) {
      const u = mi.num('midi-unpitched');
      if (u) unp[mi.attrs.id] = u - 1;
    }
    const prog = sp.all('midi-instrument').map((mi) => mi.num('midi-program')).find((x) => x);
    partInfo[sp.attrs.id] = { name: sp.val('part-name') || sp.attrs.id, unpitched: unp, program: prog ? prog - 1 : 0 };
  }

  const parts = [];
  let meter = null;
  let key = null;
  let rawKey = null;
  let tempo = null;
  let swing = false;
  const measureMeta = []; // aus erster Stimme: Wiederholungen, Länge, Abschnitte, Akkorde

  root.all('part').forEach((part, pIdx) => {
    let divisions = 1;
    let unpitchedCount = 0;
    const measures = [];
    let transposeChromatic = 0;
    let currentEnding = null;
    for (const m of part.all('measure')) {
      const mm = { notes: [], chords: [], len: 0, startRepeat: false, endRepeat: false, ending: null, label: null, implicit: m.attrs.implicit === 'yes', meter: null };
      let pos = 0;
      let maxPos = 0;
      let lastNoteStart = 0;
      if (currentEnding) mm.ending = currentEnding;
      for (const el of m.children) {
        switch (el.name) {
          case 'attributes': {
            const d = el.num('divisions');
            if (d) divisions = d;
            const k = el.child('key');
            if (k && !rawKey && pIdx === 0) {
              const f = k.num('fifths', 0);
              rawKey = makeKey(f, k.val('mode') === 'minor' ? 'minor' : 'major');
            }
            const t = el.child('time');
            if (t) {
              const beats = Number(String(t.val('beats') || '4').split('+').reduce((s, x) => s + Number(x), 0));
              const bt = t.num('beat-type', 4);
              mm.meter = { beats, beatType: bt };
              if (!meter) meter = { beats, beatType: bt };
            }
            const tr = el.child('transpose');
            if (tr) transposeChromatic = tr.num('chromatic', 0) + 12 * tr.num('octave-change', 0);
            break;
          }
          case 'direction': {
            const snd = el.child('sound');
            if (snd?.attrs.tempo && !tempo) tempo = Number(snd.attrs.tempo);
            const met = el.find('metronome')[0];
            if (met && !tempo) {
              const pm = met.num('per-minute');
              const bu = met.val('beat-unit');
              const dotted = met.has('beat-unit-dot');
              const f = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 }[bu] || 1;
              if (pm) tempo = Math.round(pm * f * (dotted ? 1.5 : 1));
            }
            const reh = el.find('rehearsal')[0];
            if (reh && reh.text) mm.label = reh.text.slice(0, 6);
            for (const w of el.find('words')) if (/swing|shuffle/i.test(w.text)) swing = true;
            if (snd && snd.find('swing').length) swing = true;
            break;
          }
          case 'harmony': {
            const ch = harmonyToChord(el);
            const off = el.num('offset', 0);
            if (ch) mm.chords.push({ start: Math.round(((pos + off) * DIV) / divisions), chord: ch });
            break;
          }
          case 'backup':
            pos -= el.num('duration', 0);
            break;
          case 'forward':
            pos += el.num('duration', 0);
            maxPos = Math.max(maxPos, pos);
            break;
          case 'note': {
            const isChord = el.has('chord');
            const dur = el.num('duration', 0);
            if (el.has('grace') || el.has('cue')) break;
            const start = isChord ? lastNoteStart : pos;
            if (!isChord) {
              lastNoteStart = pos;
              pos += dur;
              maxPos = Math.max(maxPos, pos);
            }
            if (el.has('rest')) break;
            if (el.has('unpitched')) {
              unpitchedCount++;
              const instId = el.child('instrument')?.attrs.id;
              let gm = instId ? partInfo[part.attrs.id]?.unpitched?.[instId] : undefined;
              if (gm === undefined) {
                const ds = el.val('unpitched/display-step');
                const dO = el.num('unpitched/display-octave', 4);
                gm = { F4: 36, E4: 36, C5: 38, B4: 38, G5: 42, A5: 49, F5: 51, E5: 48, D5: 45, A4: 41, D4: 44 }[`${ds}${dO}`] ?? 38;
              }
              mm.drums = mm.drums || [];
              mm.drums.push({ start: Math.round((start * DIV) / divisions), dur: Math.round((dur * DIV) / divisions), midi: gm, vel: 90 });
              break;
            }
            const step = el.val('pitch/step');
            if (!step) break;
            const alter = Math.round(el.num('pitch/alter', 0));
            const octave = el.num('pitch/octave', 4);
            const midi = stepAlterOctaveToMidi(step, alter, octave) + transposeChromatic;
            let lof = letterAlterToLof(step, alter);
            if (transposeChromatic) lof = null; // Schreibweise neu bestimmen
            const ties = el.all('tie').map((t) => t.attrs.type);
            mm.notes.push({
              start: Math.round((start * DIV) / divisions),
              dur: Math.round((dur * DIV) / divisions),
              midi,
              lof,
              voice: el.val('voice') || '1',
              staff: el.val('staff') || '1',
              tieStart: ties.includes('start'),
              tieStop: ties.includes('stop'),
            });
            break;
          }
          case 'barline': {
            const rep = el.child('repeat');
            if (rep?.attrs.direction === 'forward') mm.startRepeat = true;
            if (rep?.attrs.direction === 'backward') {
              mm.endRepeat = true;
              if (rep.attrs.times) mm.repeatTimes = Number(rep.attrs.times);
            }
            const end = el.child('ending');
            if (end) {
              const nums = String(end.attrs.number || '1').split(/[ ,]+/).map(Number).filter(Boolean);
              if (end.attrs.type === 'start') {
                currentEnding = nums;
                mm.ending = nums;
              } else {
                mm.ending = mm.ending || nums;
                currentEnding = null;
              }
            }
            break;
          }
          default:
            break;
        }
      }
      mm.len = Math.round((maxPos * DIV) / divisions);
      measures.push(mm);
    }
    const pitched = measures.reduce((s, m) => s + m.notes.length, 0);
    parts.push({ id: part.attrs.id, name: partInfo[part.attrs.id]?.name || `Stimme ${pIdx + 1}`, measures, unpitched: unpitchedCount > pitched, program: partInfo[part.attrs.id]?.program ?? 0 });
    if (pIdx === 0) {
      measureMeta.push(...measures);
      if (rawKey) key = transposeKey(rawKey, transposeChromatic % 12);
    }
  });
  return { title, composer, parts, meter: meter || { beats: 4, beatType: 4 }, key, tempo, swing, measureMeta };
}

// Stimmen-Übersicht für die Auswahl im UI
export function describeParts(scan) {
  return scan.parts.map((p, i) => {
    const all = p.measures.flatMap((m) => m.notes);
    const avg = all.length ? all.reduce((s, n) => s + n.midi, 0) / all.length : 0;
    return { index: i, name: p.name, noteCount: all.length, avgPitch: avg, unpitched: p.unpitched };
  });
}

// Lead-Stimme: Part 1 bevorzugt (Partitur-Konvention), sonst die Stimme mit den
// deutlichsten Melodie-Merkmalen (einstimmig, Melodielage, Name wie Gesang/Melodie)
export function guessMelodyPart(scan) {
  const mt = scan.meter ? (scan.meter.beats * DIV * 4) / scan.meter.beatType : DIV * 4;
  const cands = scan.parts
    .map((p, i) => ({
      index: i,
      name: p.name,
      program: p.program,
      unpitched: p.unpitched,
      notes: p.measures.flatMap((m, k) => m.notes.filter((n) => n.staff === '1' || n.staff === undefined || n.staff === null).map((n) => ({ start: k * mt + n.start, dur: n.dur, midi: n.midi }))),
    }))
    .filter((c) => !c.unpitched && c.notes.length);
  if (!cands.length) return 0;
  return pickLead(cands, { mt, totalTicks: Math.max(...scan.parts.map((p) => p.measures.length)) * mt, firstBonus: 1.2 });
}

export function songFromMusicXML(xmlText, { melodyPart = null } = {}) {
  const scan = scanScore(xmlText);
  const meter = scan.meter;
  const mt = measureTicks(meter);
  const order = expandOrder(scan.measureMeta);
  const melIdx = melodyPart ?? guessMelodyPart(scan);
  const warnings = [];
  if (scan.measureMeta.some((m, i) => i > 0 && m.meter && (m.meter.beats !== meter.beats || m.meter.beatType !== meter.beatType)))
    warnings.push('Taktwechsel im Stück erkannt: es wird durchgehend mit der ersten Taktart gearbeitet.');

  // Startzeiten der ausgeschriebenen Takte
  let pickup = 0;
  const first = scan.measureMeta[order[0]];
  if (first && first.len > 0 && first.len < mt && (first.implicit || order.length > 1)) pickup = first.len;
  const starts = [];
  let t = -pickup;
  for (const idx of order) {
    starts.push(t);
    const len = scan.measureMeta[idx].len || mt;
    t += len;
  }
  const total = t;

  const allNotes = [];
  let melodyRaw = [];
  scan.parts.forEach((p, pIdx) => {
    if (p.unpitched) return;
    order.forEach((mIdx, k) => {
      const m = p.measures[mIdx];
      if (!m) return;
      for (const n of m.notes) {
        const ev = { start: starts[k] + n.start, dur: n.dur, midi: n.midi, lof: n.lof, tieStart: n.tieStart, tieStop: n.tieStop, voice: n.voice, staff: n.staff, part: pIdx };
        allNotes.push(ev);
        if (pIdx === melIdx) melodyRaw.push(ev);
      }
    });
  });
  // Haltebögen zusammenführen (pro Stimme)
  const mergeTies = (notes) => {
    const s = [...notes].sort((a, b) => a.start - b.start);
    const out = [];
    const open = new Map();
    for (const n of s) {
      const keyId = `${n.part}|${n.staff}|${n.voice}|${n.midi}`;
      const o = open.get(keyId);
      if (n.tieStop && o && o.start + o.dur === n.start) {
        o.dur += n.dur;
        if (!n.tieStart) open.delete(keyId);
        continue;
      }
      const copy = { ...n };
      out.push(copy);
      if (n.tieStart) open.set(keyId, copy);
    }
    return out;
  };
  melodyRaw = mergeTies(melodyRaw);
  const merged = mergeTies(allNotes);
  // Melodie: oberstes System, Stimme mit höchster Durchschnittslage, Skyline
  const staff1 = melodyRaw.filter((n) => n.staff === '1');
  const byVoice = new Map();
  for (const n of staff1) {
    if (!byVoice.has(n.voice)) byVoice.set(n.voice, []);
    byVoice.get(n.voice).push(n);
  }
  let melVoice = null;
  let bestScore = -Infinity;
  for (const [v, ns] of byVoice) {
    const avg = ns.reduce((s, n) => s + n.midi, 0) / ns.length;
    const score = avg + Math.min(10, ns.length / 20);
    if (score > bestScore) {
      bestScore = score;
      melVoice = v;
    }
  }
  const melody = staff1.filter((n) => n.voice === melVoice).map((n) => ({ start: n.start, dur: n.dur, midi: n.midi, lof: n.lof }));

  // Schlagzeug & Original-Noten (für Play-along-Wiedergabe)
  const drumNotes = [];
  scan.parts.forEach((p) => {
    order.forEach((mIdx, k) => {
      for (const d of p.measures[mIdx]?.drums || []) drumNotes.push({ ...d, start: starts[k] + d.start });
    });
  });
  const tracks = scan.parts
    .map((p, pIdx) => ({ id: `p${pIdx}`, name: p.name, program: p.program ?? 0, mel: pIdx === melIdx, notes: merged.filter((n) => n.part === pIdx).map((n) => ({ start: n.start, dur: n.dur, midi: n.midi, vel: 80 })) }))
    .filter((t) => t.notes.length);

  // Akkorde: erste Stimme mit Harmonien
  const chords = [];
  for (const p of scan.parts) {
    const has = p.measures.some((m) => m.chords.length);
    if (!has) continue;
    order.forEach((mIdx, k) => {
      for (const c of p.measures[mIdx]?.chords || []) chords.push({ start: Math.max(0, starts[k] + c.start), chord: c.chord });
    });
    break;
  }
  // Abschnitte aus Probenzeichen
  const sections = [];
  order.forEach((mIdx, k) => {
    const lab = scan.measureMeta[mIdx].label;
    if (lab && starts[k] >= 0) sections.push({ label: lab, start: Math.round(starts[k] / mt) });
  });

  const song = {
    title: scan.title,
    composer: scan.composer,
    key: scan.key,
    meter,
    tempo: scan.tempo,
    swing: scan.swing,
    pickup,
    measureCount: Math.max(1, Math.ceil(total / mt - 0.01)),
    melody,
    chords,
    sections,
    warnings,
    source: 'musicxml',
    drumNotes,
    tracks,
    parts: describeParts(scan),
    melodyPart: melIdx,
  };
  return finalizeSong(song, { allNotes: merged.filter((n) => n.start >= 0) });
}
