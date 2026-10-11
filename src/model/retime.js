// Taktraster einer erkannten Aufnahme von Hand korrigieren.
// Aus einer Aufnahme lassen sich Taktanfang und „Zählweise“ nicht immer eindeutig hören
// (synkopische Stücke ohne Schlagzeug, Half-Time/Double-Time). Zwei Korrekturen genügen:
//   shiftDownbeat   – der Taktstrich rückt um einen Schlag (die „1“ liegt früher/später)
//   scaleNoteValues – doppeltes Tempo mit doppelten Notenwerten (Achtel statt Sechzehntel)
//                     bzw. halbes Tempo mit halben Notenwerten
// Töne, Rhythmus und der Bezug zur Aufnahme bleiben erhalten; Akkorde werden neu bestimmt.
import { DIV } from '../core/constants.js';
import { harmonize } from '../theory/analysis.js';

const mtOf = (song) => (song.meter.beats * DIV * 4) / song.meter.beatType;
const beatOf = (song) => song.timing?.beatTicks || (song.meter.beatType === 8 && song.meter.beats % 3 === 0 && song.meter.beats > 3 ? 36 : (DIV * 4) / song.meter.beatType);

function reharmonize(song) {
  const tracks = (song.tracks || []).filter((t) => !t.mel);
  const notes = [];
  for (const t of tracks) for (const n of t.notes) if (n.start >= 0) notes.push({ start: n.start, dur: Math.min(n.dur, 2 * DIV), midi: n.midi });
  const bass = tracks.find((t) => t.role === 'bass');
  if (bass) for (const n of bass.notes) if (n.start >= 0) notes.push({ start: n.start, dur: Math.min(n.dur, 2 * DIV), midi: n.midi });
  for (const n of song.melody) if (n.start >= 0) notes.push({ start: n.start, dur: n.dur, midi: n.midi });
  song.chords = harmonize(notes, { meter: song.meter, key: song.key, measureCount: song.measureCount, melodyOnly: !tracks.length });
}

function finish(song) {
  const mt = mtOf(song);
  const total = song.measureCount * mt;
  const bt = beatOf(song);
  const keep = (n) => n.start >= -mt + bt && n.start < total;
  song.melody = song.melody.filter(keep).map((n) => ({ ...n, dur: Math.min(n.dur, total - n.start) }));
  for (const t of song.tracks || []) t.notes = t.notes.filter((n) => n.start >= 0 && n.start < total);
  song.drumNotes = (song.drumNotes || []).filter((n) => n.start >= 0 && n.start < total);
  const pick = song.melody.filter((n) => n.start < 0);
  song.pickup = pick.length ? -Math.min(...pick.map((n) => n.start)) : 0;
  // Formteile lückenlos über die neue Taktzahl
  const secs = (song.sections || []).filter((s) => s.start < song.measureCount).sort((a, b) => a.start - b.start);
  if (!secs.length) secs.push({ label: 'A', start: 0, length: song.measureCount });
  secs[0].start = 0;
  secs.forEach((s, i) => (s.length = (i + 1 < secs.length ? secs[i + 1].start : song.measureCount) - s.start));
  song.sections = secs.filter((s) => s.length > 0);
  reharmonize(song);
  return song;
}

// k = +1: die „1“ liegt einen Schlag später (alles rückt einen Schlag nach vorn), k = -1: früher
export function shiftDownbeat(songIn, k) {
  const song = structuredClone(songIn);
  const bt = beatOf(song);
  const d = k * bt;
  const sh = (list) => (list || []).map((n) => ({ ...n, start: n.start - d }));
  song.melody = sh(song.melody);
  for (const t of song.tracks || []) t.notes = sh(t.notes);
  song.drumNotes = sh(song.drumNotes);
  const mt = mtOf(song);
  if (song.timing) {
    song.timing.firstBeat += k;
    song.measureCount = Math.max(1, Math.floor((song.timing.beatSec.length - song.timing.firstBeat) / (mt / bt)));
  }
  return finish(song);
}

// factor 2: doppeltes Tempo, doppelte Notenwerte; factor 0.5: halbes Tempo, halbe Notenwerte
export function scaleNoteValues(songIn, factor) {
  if (factor !== 2 && factor !== 0.5) return songIn;
  const song = structuredClone(songIn);
  const q = (t) => (factor === 2 ? t * 2 : Math.round(t / 2 / 6) * 6);
  const sc = (list) => (list || []).map((n) => ({ ...n, start: q(n.start), dur: Math.max(6, q(n.dur)) }));
  song.melody = sc(song.melody);
  for (const t of song.tracks || []) t.notes = sc(t.notes);
  song.drumNotes = sc(song.drumNotes);
  song.tempo = Math.round(song.tempo * factor);
  song.measureCount = factor === 2 ? song.measureCount * 2 : Math.max(1, Math.ceil(song.measureCount / 2));
  song.sections = (song.sections || []).map((s) => ({ ...s, start: factor === 2 ? s.start * 2 : Math.round(s.start / 2), length: 0 }));
  song.tempoMarks = (song.tempoMarks || []).map((m) => ({ ...m, bar: factor === 2 ? m.bar * 2 : Math.round(m.bar / 2), bpm: m.bpm ? Math.round(m.bpm * factor) : m.bpm }));
  // Schlagzeiten der Aufnahme: bei doppeltem Tempo liegt zwischen zwei Schlägen ein neuer, bei
  // halbem Tempo zählt nur jeder zweite (ab der „1“) – ein Schlag bleibt immer ein Grundschlag
  if (song.timing && song.timing.beatSec) {
    const bs = song.timing.beatSec;
    const fb = song.timing.firstBeat;
    if (factor === 2) {
      const out = [];
      for (let i = 0; i < bs.length; i++) {
        out.push(bs[i]);
        if (i + 1 < bs.length) out.push((bs[i] + bs[i + 1]) / 2);
      }
      song.timing.beatSec = out;
      song.timing.firstBeat = fb * 2;
    } else {
      const par = ((fb % 2) + 2) % 2;
      song.timing.beatSec = bs.filter((_, i) => i % 2 === par);
      song.timing.firstBeat = (fb - par) / 2;
    }
  }
  // gleiche Einsätze nach dem Runden: die längere Note bleibt
  const dedupe = (list) => {
    const by = new Map();
    for (const n of list) {
      const k = `${n.start}:${n.midi}`;
      if (!by.has(k) || by.get(k).dur < n.dur) by.set(k, n);
    }
    return [...by.values()].sort((a, b) => a.start - b.start);
  };
  song.melody = dedupe(song.melody).filter((n, i, a) => !i || a[i - 1].start !== n.start);
  for (const t of song.tracks || []) t.notes = dedupe(t.notes);
  return finish(song);
}
