// Standard-MIDI-Datei (Typ 0/1) -> Song. Quantisiert auf 16tel bzw. Triolen.
import { DIV } from '../core/constants.js';
import { pickLead } from './lead.js';
import { marksFromEvents } from './tempo-marks.js';
import { makeKey } from '../theory/keys.js';
import { finalizeSong } from '../theory/analysis.js';

function readVarLen(d, p) {
  let v = 0;
  let b;
  do {
    b = d[p.i++];
    v = (v << 7) | (b & 0x7f);
  } while (b & 0x80 && p.i < d.length);
  return v;
}

export function parseMidi(buffer) {
  const d = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const str = (i, n) => String.fromCharCode(...d.subarray(i, i + n));
  if (str(0, 4) !== 'MThd') throw new Error('Keine MIDI-Datei');
  const u16 = (i) => (d[i] << 8) | d[i + 1];
  const u32 = (i) => ((d[i] << 24) >>> 0) + (d[i + 1] << 16) + (d[i + 2] << 8) + d[i + 3];
  const hlen = u32(4);
  const ntrks = u16(10);
  const division = u16(12);
  if (division & 0x8000) throw new Error('SMPTE-Zeitbasis wird nicht unterstützt');
  let p = 8 + hlen;
  const tracks = [];
  const meta = { tempo: null, timeSig: null, keySig: null, tempos: [], timeSigs: [] };
  for (let t = 0; t < ntrks && p < d.length; t++) {
    if (str(p, 4) !== 'MTrk') break;
    const len = u32(p + 4);
    const end = p + 8 + len;
    const ptr = { i: p + 8 };
    let tick = 0;
    let status = 0;
    const open = new Map();
    const notes = [];
    let name = null;
    let program = null;
    const programs = {};
    while (ptr.i < end) {
      tick += readVarLen(d, ptr);
      let b = d[ptr.i];
      if (b & 0x80) {
        status = b;
        ptr.i++;
      }
      const type = status & 0xf0;
      const ch = status & 0x0f;
      if (status === 0xff) {
        const mt = d[ptr.i++];
        const ml = readVarLen(d, ptr);
        const md = d.subarray(ptr.i, ptr.i + ml);
        ptr.i += ml;
        if (mt === 0x51) {
          const bpm = 60000000 / ((md[0] << 16) | (md[1] << 8) | md[2]);
          if (!meta.tempo) meta.tempo = bpm;
          meta.tempos.push({ tick, bpm });
        } else if (mt === 0x58) {
          const ts = { beats: md[0], beatType: 2 ** md[1] };
          if (!meta.timeSig) meta.timeSig = ts;
          meta.timeSigs.push({ tick, ...ts });
        }
        else if (mt === 0x59 && !meta.keySig) meta.keySig = { fifths: (md[0] << 24) >> 24, minor: md[1] === 1 };
        else if (mt === 0x03 && !name) name = new TextDecoder().decode(md);
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const l = readVarLen(d, ptr);
        ptr.i += l;
        continue;
      }
      if (type === 0x90 || type === 0x80) {
        const key = d[ptr.i++];
        const vel = d[ptr.i++];
        const id = ch * 128 + key;
        if (type === 0x90 && vel > 0) {
          if (open.has(id)) {
            const o = open.get(id);
            notes.push({ ...o, end: tick });
          }
          open.set(id, { start: tick, key, vel, ch });
        } else if (open.has(id)) {
          const o = open.get(id);
          open.delete(id);
          notes.push({ ...o, end: tick });
        }
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) ptr.i += 2;
      else if (type === 0xc0) {
        program = d[ptr.i++];
        if (programs[ch] === undefined) programs[ch] = program;
      } else if (type === 0xd0) ptr.i += 1;
      else ptr.i++;
    }
    tracks.push({ name: name || `Spur ${t + 1}`, notes, program, programs, drum: notes.length > 0 && notes.every((n) => n.ch === 9) });
    p = end;
  }
  return { division, tracks, meta };
}

function quantizeTick(q, beat) {
  const b = Math.floor(q / beat) * beat;
  const r = q - b;
  const s16 = Math.round(r / (beat / 4)) * (beat / 4);
  const s3 = Math.round(r / (beat / 3)) * (beat / 3);
  return b + (Math.abs(r - s16) <= Math.abs(r - s3) + 1 ? s16 : s3);
}

// Stimmen = Spur × Kanal (Format-0-Dateien haben alle Instrumente in einer Spur);
// Kanal 10 (Schlagzeug) ist keine Stimme.
export function midiParts(parsed) {
  const parts = [];
  parsed.tracks.forEach((t, ti) => {
    const byCh = new Map();
    for (const n of t.notes) {
      if (n.ch === 9) continue;
      if (!byCh.has(n.ch)) byCh.set(n.ch, []);
      byCh.get(n.ch).push(n);
    }
    const multi = byCh.size > 1;
    for (const [ch, notes] of [...byCh].sort((a, b) => a[0] - b[0])) {
      parts.push({ index: parts.length, track: ti, ch, name: multi ? `${t.name} (Kanal ${ch + 1})` : t.name, program: t.programs?.[ch] ?? t.program ?? 0, notes });
    }
  });
  return parts;
}

export function describeMidiTracks(parsed) {
  return midiParts(parsed).map((p) => {
    const avg = p.notes.reduce((s, n) => s + n.key, 0) / p.notes.length;
    return { index: p.index, name: p.name, noteCount: p.notes.length, avgPitch: avg, unpitched: false };
  });
}

export function songFromMidi(buffer, { melodyPart = null, title = null } = {}) {
  const parsed = parseMidi(buffer);
  const parts = midiParts(parsed);
  const desc = describeMidiTracks(parsed);
  if (!parts.length) throw new Error('Die MIDI-Datei enthält keine Noten');
  const conv = (tk) => (tk * DIV) / parsed.division;
  const toEvents = (notes) =>
    notes
      .filter((n) => n.ch !== 9)
      .map((n) => {
        const s = quantizeTick(conv(n.start), DIV);
        let e = quantizeTick(conv(n.end), DIV);
        if (e <= s) e = s + DIV / 4;
        return { start: Math.round(s), dur: Math.round(e - s), midi: n.key, vel: n.vel };
      });
  const meter = parsed.meta.timeSig || { beats: 4, beatType: 4 };
  const mt = (meter.beats * DIV * 4) / meter.beatType;
  const partEvents = parts.map((p) => toEvents(p.notes));
  const totalTicks = Math.max(0, ...partEvents.flat().map((n) => n.start + n.dur));
  // Lead-Spur: Einstimmigkeit, Lage, Melodiedichte, Präsenz, Name/Instrument
  let melIdx = melodyPart;
  if (melIdx === null || melIdx === undefined || !parts[melIdx]) {
    melIdx = pickLead(parts.map((p, i) => ({ index: i, name: p.name, program: p.program, notes: partEvents[i] })), { mt, totalTicks });
  }
  const melody = partEvents[melIdx].map(({ vel, ...n }) => (void vel, n));
  const allNotes = partEvents.flat();
  const key = parsed.meta.keySig ? makeKey(parsed.meta.keySig.fifths, parsed.meta.keySig.minor ? 'minor' : 'major') : null;
  // Zeitachse bleibt 1:1 wie in der Datei (wichtig zum Mitspielen)
  // Schlagzeug (Kanal 10) und Original-Noten aller Stimmen für die Wiedergabe
  const drumNotes = [];
  for (const t of parsed.tracks)
    for (const n of t.notes) {
      if (n.ch !== 9) continue;
      const s0 = Math.round(quantizeTick(conv(n.start), DIV));
      let e0 = Math.round(quantizeTick(conv(n.end), DIV));
      if (e0 <= s0) e0 = s0 + DIV / 4;
      drumNotes.push({ start: s0, dur: Math.min(e0 - s0, DIV / 2), midi: n.key, vel: n.vel });
    }
  const tracks = parts.map((p, i) => ({ id: `t${i}`, name: p.name, program: p.program ?? 0, mel: i === melIdx, notes: partEvents[i] }));
  const lastEnd = Math.max(0, ...[...tracks.flatMap((t) => t.notes), ...drumNotes].map((n) => n.start + n.dur));
  const song = {
    title: title || parsed.tracks.find((t) => t.name && !/^Spur/.test(t.name))?.name || 'MIDI-Import',
    composer: null,
    key,
    meter,
    tempo: parsed.meta.tempo ? Math.round(parsed.meta.tempo) : 100,
    swing: false,
    pickup: 0,
    measureCount: Math.max(1, Math.ceil(lastEnd / mt - 0.01)),
    melody,
    chords: [],
    sections: [],
    warnings: ['MIDI enthält keine Akkordsymbole – Harmonik wurde automatisch analysiert.'],
    source: 'midi',
    drumNotes,
    tracks,
    parts: desc,
    melodyPart: melIdx,
  };
  // Taktartwechsel der Datei -> [{bar, meter}]
  const sigs = parsed.meta.timeSigs.map((x) => ({ t: Math.round(conv(x.tick)), meter: { beats: x.beats, beatType: x.beatType } })).sort((a, b) => a.t - b.t);
  if (sigs.some((x) => x.meter.beats !== meter.beats || x.meter.beatType !== meter.beatType)) {
    const meterMap = [{ bar: 0, meter }];
    let bar = 0;
    let t0 = 0;
    let cur = meter;
    for (const x of sigs) {
      if (x.t <= 0 || (x.meter.beats === cur.beats && x.meter.beatType === cur.beatType)) continue;
      const len = (cur.beats * DIV * 4) / cur.beatType;
      bar += Math.round((x.t - t0) / len);
      meterMap.push({ bar, meter: x.meter });
      t0 = x.t;
      cur = x.meter;
    }
    if (meterMap.length > 1) {
      const len = (cur.beats * DIV * 4) / cur.beatType;
      song.meterMap = meterMap;
      song.measureCount = Math.max(1, bar + Math.ceil((lastEnd - t0) / len - 0.01));
      song.warnings.push(`Taktartwechsel: ${meterMap.slice(1).map((x) => `Takt ${x.bar + 1} ${x.meter.beats}/${x.meter.beatType}`).join(', ')} – wird so übernommen.`);
    }
  }
  // Tempowechsel der Datei (rit./accel. als viele kleine Schritte)
  if (parsed.meta.tempos.length > 1) {
    const { marks, map } = marksFromEvents(parsed.meta.tempos.map((e) => ({ t: Math.round(conv(e.tick)), bpm: e.bpm })), [], mt);
    if (map.length > 1) {
      song.tempoMarks = marks;
      song.tempoEvents = map;
    }
  }
  return finalizeSong(song, { allNotes: allNotes.filter((n) => n.start >= 0) });
}
