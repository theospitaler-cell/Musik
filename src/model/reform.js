// Behutsame Form-Änderungen für „Neu arrangieren“: 90 % bleiben wie im Original.
// Erlaubt sind nur Eingriffe, wie sie ein Arrangeur an einem bestehenden Stück macht:
//   - ein kurzer Vorspann (2–4 Takte nur mit der Begleitung), wenn das Stück sofort mit der
//     Melodie beginnt,
//   - bei vielen gleichen Strophen/Teilen fallen einzelne Wiederholungen weg (erster und letzter
//     Teil bleiben),
//   - ein kurzer Anhang (die letzten 2 Takte noch einmal) als Schluss.
// Melodie, Bass, Begleitung und Schlagzeug der Vorlage bleiben Takt für Takt unverändert.
import { songMeasureTicks, hasMeterChanges } from './song.js';

const MIN_BARS = 16; // darunter wird nichts verändert
const MAX_DROP = 0.25; // höchstens ein Viertel der Takte darf wegfallen

const firstMelodyBar = (song, mt) => {
  const s = song.melody.filter((n) => n.start >= 0).map((n) => n.start);
  return s.length ? Math.floor(Math.min(...s) / mt) : 0;
};

// Plan: [{ kind: 'intro' | 'main' | 'tag', from, len, section }] in Ausgabereihenfolge
export function planFormEdits(song, opts = {}) {
  const notes = [];
  const M = song.measureCount;
  const mt = songMeasureTicks(song);
  const none = { segments: null, notes };
  if (M < MIN_BARS || hasMeterChanges(song)) return none;
  if (song.tempoEvents && song.tempoEvents.length > 1 && !song.timing) return none; // Tempowechsel der Datei
  const sections = (song.sections && song.sections.length ? song.sections : [{ label: 'A', start: 0, length: M }])
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.start - b.start);
  // 1) Wiederholungen weglassen
  const keep = new Set(sections.map((s) => s.i));
  const byLabel = new Map();
  for (const s of sections) {
    if (!byLabel.has(s.label)) byLabel.set(s.label, []);
    byLabel.get(s.label).push(s);
  }
  const dropped = [];
  if (opts.dropRepeats !== false && M > 64) {
    const budget = Math.floor(M * MAX_DROP);
    let used = 0;
    const groups = [...byLabel.entries()].filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length);
    for (const [label, list] of groups) {
      const toKeep = Math.max(2, Math.ceil(list.length / 2));
      let toDrop = list.length - toKeep;
      // von hinten nach vorn, erster und letzter Teil bleiben
      for (let k = list.length - 2; k >= 1 && toDrop > 0; k--) {
        const s = list[k];
        if (used + s.length > budget) continue;
        keep.delete(s.i);
        used += s.length;
        toDrop--;
        dropped.push({ label, bar: s.start + 1, len: s.length });
      }
    }
  }
  const segments = [];
  // 2) Vorspann
  const fm = firstMelodyBar(song, mt);
  if (opts.intro !== false && fm < 2) {
    const len = M >= 48 && song.meter.beats === 4 ? 4 : 2;
    segments.push({ kind: 'intro', from: 0, len, label: 'Intro' });
    notes.push(`Vorspann: ${len} Takte nur mit der Begleitung, bevor die Melodie einsetzt.`);
  }
  for (const s of sections) if (keep.has(s.i)) segments.push({ kind: 'main', from: s.start, len: s.length, label: s.label, energy: s.energy });
  if (dropped.length) {
    const bars = dropped.reduce((a, d) => a + d.len, 0);
    notes.push(`Gekürzt: ${dropped.length} Wiederholung${dropped.length > 1 ? 'en' : ''} (zusammen ${bars} Takte) weggelassen – ${dropped.map((d) => `Teil ${d.label} ab Takt ${d.bar}`).join(', ')}.`);
  }
  // 3) Anhang
  const last = song.melody.filter((n) => n.start >= (M - 2) * mt && n.start < M * mt);
  if (opts.tag !== false && last.length >= 3) {
    segments.push({ kind: 'tag', from: M - 2, len: 2, label: 'Schluss' });
    notes.push('Anhang: die letzten 2 Takte werden zum Schluss wiederholt.');
  }
  const changed = segments.some((s) => s.kind !== 'main') || dropped.length > 0;
  return changed ? { segments, notes } : none;
}

// Plan anwenden: neue Takte aus Ausschnitten der Vorlage zusammensetzen
export function applyFormEdits(songIn, segments) {
  const song = structuredClone(songIn);
  const mt = songMeasureTicks(song);
  // Ausgabeposition (Takte) je Segment
  let pos = 0;
  const segs = segments.map((s) => {
    const o = { ...s, out: pos, a: s.from * mt, b: (s.from + s.len) * mt, shift: pos * mt - s.from * mt };
    pos += s.len;
    return o;
  });
  const total = pos;
  const firstMain = segs.find((s) => s.kind === 'main' && s.from === 0);
  const remap = (list, { melody = false } = {}) => {
    const out = [];
    for (const n of list || []) {
      for (const s of segs) {
        if (melody && s.kind === 'intro') continue; // Vorspann: ohne Melodie
        if (n.start >= s.a && n.start < s.b) {
          out.push({ ...n, start: n.start + s.shift, dur: Math.max(1, Math.min(n.dur, s.b - n.start)) });
          if (s.kind === 'main' && s.from === 0) break;
        } else if (n.start < 0 && s === firstMain && n.start >= -mt) {
          out.push({ ...n, start: n.start + s.shift }); // Auftakt gehört zum ersten Takt der Vorlage
        }
      }
    }
    return out.sort((x, y) => x.start - y.start);
  };
  song.melody = remap(song.melody, { melody: true });
  for (const t of song.tracks || []) t.notes = remap(t.notes);
  song.drumNotes = remap(song.drumNotes);
  // Akkorde: Ausschnitte der Vorlage (Überlappungen am Rand abschneiden)
  const chords = [];
  for (const s of segs) {
    for (const c of songIn.chords || []) {
      const a = Math.max(c.start, s.a);
      const b = Math.min(c.start + c.dur, s.b);
      if (b > a) chords.push({ ...c, start: a + s.shift, dur: b - a });
    }
  }
  song.chords = chords.sort((x, y) => x.start - y.start);
  song.measureCount = total;
  // Formteile
  song.sections = segs.map((s) => ({ label: s.label, start: s.out, length: s.len, ...(typeof s.energy === 'number' ? { energy: s.energy } : s.kind === 'intro' ? { energy: 0.35 } : {}) }));
  // Tempo-Marken
  song.tempoMarks = (songIn.tempoMarks || [])
    .map((m) => {
      const s = segs.find((x) => x.kind === 'main' && m.bar >= x.from && m.bar < x.from + x.len);
      return s ? { ...m, bar: s.out + (m.bar - s.from) } : null;
    })
    .filter(Boolean);
  // Auftakt nur, wenn noch Töne vor Takt 1 stehen
  const neg = song.melody.filter((n) => n.start < 0);
  song.pickup = neg.length ? -Math.min(...neg.map((n) => n.start)) : 0;
  // Schlagzeiten der Aufnahme: neue, lückenlose Zeitachse in der Reihenfolge der Segmente
  if (song.timing && song.timing.beatSec) {
    const bs = songIn.timing.beatSec;
    const fb = songIn.timing.firstBeat;
    const bt = songIn.timing.beatTicks || 24;
    const bpb = mt / bt;
    const fallback = bs.length > 1 ? bs[bs.length - 1] - bs[bs.length - 2] : 0.5;
    const out = [];
    let cur = 0;
    for (const s of segs) {
      for (let k = 0; k < s.len * bpb; k++) {
        const idx = fb + s.from * bpb + k;
        const dt = idx >= 0 && idx + 1 < bs.length ? bs[idx + 1] - bs[idx] : fallback;
        out.push(cur);
        cur += dt;
      }
    }
    out.push(cur);
    song.timing = { ...song.timing, beatSec: out, firstBeat: 0 };
  }
  song.formEdited = true; // die Aufnahme läuft nicht mehr im Gleichschritt
  return song;
}

export function reformSong(song, opts = {}) {
  const plan = planFormEdits(song, opts);
  if (!plan.segments) return { song, notes: [], changed: false };
  return { song: applyFormEdits(song, plan.segments), notes: plan.notes, changed: true };
}
