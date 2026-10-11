// Internes Leadsheet-Modell ("Song") + Hilfsfunktionen.
//
// song = {
//   title, composer,
//   key: {fifths, mode, tonicPc, tonicLof},
//   meter: {beats, beatType},
//   tempo,                 // Viertel pro Minute
//   swing: bool,
//   pickup,                // Auftakt-Länge in Ticks (0 = keiner)
//   measureCount,          // volle Takte (ohne Auftakt)
//   melody: [{start, dur, midi, lof}],   // start relativ zu Takt 1 (Auftakt < 0)
//   chords: [{start, dur, chord}],
//   sections: [{label, start, length}],   // in Takten
//   warnings: [], source: 'abc'|'musicxml'|'midi'
// }
import { DIV, mod } from '../core/constants.js';
import { transposeChord, sameChord } from '../theory/chords.js';
import { transposeKey } from '../theory/keys.js';
import { lofNear, keyCenter, semisToLofDelta } from '../theory/pitch.js';

export function measureTicks(meter) {
  return (meter.beats * DIV * 4) / meter.beatType;
}

// Taktraster mit Taktartwechseln: jeder Takt hat eigene Taktart & Länge.
// meterMap: [{bar, meter}] (Takt-Index der Vorlage, ab dem die Taktart gilt); leadBars: vorangestellte
// Takte (Auftakt-Takt im Arrangement) in der Anfangstaktart.
export function makeBarGrid(meter, meterMap, totalBars, leadBars = 0) {
  const meters = [];
  const starts = [0];
  const map = [...(meterMap || [])].sort((a, b) => a.bar - b.bar);
  for (let k = 0; k < totalBars; k++) {
    const b = k - leadBars;
    let mtr = meter;
    for (const x of map) if (x.bar <= b) mtr = x.meter;
    meters.push(mtr);
    starts.push(starts[k] + measureTicks(mtr));
  }
  const grid = {
    meters,
    starts,
    len: (k) => (k < totalBars ? starts[k + 1] - starts[k] : measureTicks(meters[meters.length - 1] || meter)),
    start: (k) => (k <= totalBars ? starts[k] : starts[totalBars] + (k - totalBars) * grid.len(totalBars)),
    barAt(t) {
      if (t < 0) return Math.floor(t / measureTicks(meter));
      let lo = 0;
      let hi = totalBars;
      if (t >= starts[totalBars]) return totalBars + Math.floor((t - starts[totalBars]) / grid.len(totalBars));
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= t) lo = mid;
        else hi = mid;
      }
      return lo;
    },
    changes: meters.map((m, k) => k === 0 || m.beats !== meters[k - 1].beats || m.beatType !== meters[k - 1].beatType),
  };
  return grid;
}

export function hasMeterChanges(song) {
  return !!(song.meterMap && song.meterMap.some((x) => x.meter.beats !== song.meter.beats || x.meter.beatType !== song.meter.beatType));
}

export function songMeasureTicks(song) {
  return measureTicks(song.meter);
}

export function sortEvents(evts) {
  return evts.sort((a, b) => a.start - b.start || (b.midi ?? 0) - (a.midi ?? 0));
}

// Monophone Linie erzwingen: bei Überlappung die frühere Note kürzen
export function monophonize(notes) {
  const s = [...notes].sort((a, b) => a.start - b.start || b.midi - a.midi);
  const out = [];
  for (const n of s) {
    const prev = out[out.length - 1];
    if (prev && prev.start === n.start) continue; // höchste Note gewinnt (Skyline)
    if (prev && prev.start + prev.dur > n.start) prev.dur = n.start - prev.start;
    if (n.dur > 0) out.push({ ...n });
  }
  return out.filter((n) => n.dur > 0);
}

// Akkordliste lückenlos machen und zusammenfassen
export function normalizeChords(chords, totalTicks, startTick = 0) {
  const s = chords.filter((c) => c.chord).sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    const start = Math.max(startTick, c.start);
    const end = next ? next.start : totalTicks;
    if (end <= start) continue;
    const prev = out[out.length - 1];
    if (prev && sameChord(prev.chord, c.chord) && prev.start + prev.dur === start) prev.dur = end - prev.start;
    else out.push({ start, dur: end - start, chord: c.chord });
  }
  if (out.length && out[0].start > startTick) {
    out[0].dur += out[0].start - startTick;
    out[0].start = startTick;
  }
  return out;
}

export function chordAt(chords, t) {
  let lo = 0;
  let hi = chords.length - 1;
  let res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chords[mid].start <= t) {
      res = chords[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return res ? res.chord : chords[0]?.chord ?? null;
}

export function chordSegmentAt(chords, t) {
  for (let i = chords.length - 1; i >= 0; i--) if (chords[i].start <= t) return chords[i];
  return chords[0] || null;
}

export function nextChordChange(chords, t) {
  for (const c of chords) if (c.start > t) return c;
  return null;
}

// Ausschnitt [fromMeasure, toMeasure) relativ zum Ausschnittsbeginn
export function sliceMelody(song, fromM, toM) {
  const mt = songMeasureTicks(song);
  const a = fromM * mt;
  const b = toM * mt;
  return song.melody
    .filter((n) => n.start >= a && n.start < b)
    .map((n) => ({ ...n, start: n.start - a, dur: Math.min(n.dur, b - n.start) }));
}

export function sliceChords(song, fromM, toM) {
  const mt = songMeasureTicks(song);
  const a = fromM * mt;
  const b = toM * mt;
  const out = [];
  for (const c of song.chords) {
    const s = Math.max(a, c.start);
    const e = Math.min(b, c.start + c.dur);
    if (e > s) out.push({ start: s - a, dur: e - s, chord: c.chord });
  }
  if (!out.length) {
    const ch = chordAt(song.chords, a);
    if (ch) out.push({ start: 0, dur: b - a, chord: ch });
  }
  return out;
}

export function pickupNotes(song) {
  return song.melody.filter((n) => n.start < 0);
}

// center: Quintenlage der Zieltonart – Töne, die dort weit außen lägen (Gis in C-Dur, His …),
// werden enharmonisch einfach geschrieben
export function transposeEvents(notes, semis, center = null) {
  if (!semis) return notes.map((n) => ({ ...n }));
  const d = semisToLofDelta(semis);
  const fix = (l) => (center === null ? l : l - center > 7 ? l - 12 : l - center < -7 ? l + 12 : l);
  return notes.map((n) => ({ ...n, midi: n.midi + semis, lof: n.lof === undefined || n.lof === null ? n.lof : fix(n.lof + d) }));
}

export function transposeChordList(chords, semis, center = null) {
  return chords.map((c) => ({ ...c, chord: transposeChord(c.chord, semis, center) }));
}

export function transposeSong(song, semis) {
  if (!semis) return song;
  const key = transposeKey(song.key, semis);
  const center = keyCenter(key);
  return {
    ...song,
    key,
    melody: transposeEvents(song.melody, semis, center),
    chords: transposeChordList(song.chords, semis, center),
  };
}

// Harmonie vereinfachen: ein Akkord je Takt (der, der den größten Teil des Takts klingt), zwei nur
// dort, wo beide Hälften je mindestens drei Viertel lang eigenständig sind. Reibungen zwischen
// Begleitstimmen entstehen oft aus zu schnell wechselnden, unsicher erkannten Akkorden.
export function simplifyHarmony(song) {
  if (hasMeterChanges(song) || !song.chords || !song.chords.length) return song;
  const mt = songMeasureTicks(song);
  const total = song.measureCount * mt;
  const out = [];
  for (let bar = 0; bar < song.measureCount; bar++) {
    const a = bar * mt;
    const b = a + mt;
    const segs = song.chords.filter((c) => c.start < b && c.start + c.dur > a).map((c) => ({ chord: c.chord, dur: Math.min(b, c.start + c.dur) - Math.max(a, c.start) }));
    if (!segs.length) continue;
    const best = segs.reduce((x, y) => (y.dur > x.dur ? y : x));
    out.push({ start: a, dur: mt, chord: best.chord });
  }
  return { ...song, chords: normalizeChords(out, total) };
}

// Fehlende Schreibweisen (lof) ergänzen
export function ensureSpelling(notes, key, chords = null) {
  const center = keyCenter(key);
  for (const n of notes) {
    if (n.lof !== undefined && n.lof !== null) continue;
    const pc = mod(n.midi, 12);
    let lof = null;
    if (chords) {
      const ch = chordAt(chords, n.start);
      const t = ch && [...ch.tones, ...ch.tens].find((x) => x.pc === pc);
      if (t) lof = t.lof;
    }
    n.lof = lof ?? lofNear(pc, center);
  }
  return notes;
}

export function songDurationTicks(song) {
  return song.measureCount * songMeasureTicks(song);
}

export function describeSong(song) {
  return {
    measures: song.measureCount,
    notes: song.melody.length,
    chords: song.chords.length,
    sections: song.sections.map((s) => `${s.label}(${s.length})`).join(' '),
  };
}
