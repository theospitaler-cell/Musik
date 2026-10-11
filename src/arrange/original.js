// „Original übernehmen“ für mehrere Instrumente: voller Satz wie in gedruckten Ausgaben.
//  - Stimme 1 spielt die Melodie.
//  - Die Bass-Stimme spielt die Basslinie der Vorlage; wo keine zu hören ist, den Grundton im
//    Rhythmus der Bass Drum (ohne Schlagzeug: auf den Takthälften).
//  - Die Mittelstimmen spielen die Begleitstimmen der Vorlage (Rhythmus und Töne 1:1, in der Lage
//    des Instruments). Fehlt einer Stimme an einer Stelle der Ton, ergänzt sie im selben Rhythmus
//    einen Ton unter der Stimme darüber (Terz/Sexte, Akkordton) – der Satz bleibt vollständig und
//    bewegt sich gemeinsam. Läuft eine Begleitstimme mit der Melodie mit (Parallelstimme), tut sie
//    das durchgehend.
import { DIV, mod } from '../core/constants.js';
import { chordAt, songMeasureTicks } from '../model/song.js';
import { scalePcs } from '../theory/keys.js';
import { fitOctave } from './instruments.js';

const medianOf = (xs) => {
  if (!xs.length) return 60;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// einstimmige Linie aus einer (evtl. mehrstimmigen) Spur: oberste bzw. unterste Töne
export function monoLine(notes, low = false) {
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

// Tonhöhe einer Linie zum Zeitpunkt t (klingend oder bis "hold" Ticks danach)
function pitchAt(line, { hold = 0 } = {}) {
  let i = 0;
  return (t) => {
    if (!line.length) return null;
    while (i < line.length - 1 && line[i + 1].start <= t) i++;
    while (i > 0 && line[i].start > t) i--;
    const n = line[i];
    return n.start <= t && n.start + n.dur + hold > t ? n.midi : null;
  };
}

// Notenlängen gut lesbar: kurze Töne klingen bis zum nächsten Einsatz (höchstens eine Achtel
// Pause dazwischen), sonst mindestens eine Achtel – Einsätze bleiben exakt.
// sustain: Töne klingen bis zum nächsten Einsatz (höchstens "sustain" Ticks) – Liegeklang im
// Rhythmus der Begleitung
export function tidy(line, total, { sustain = 0 } = {}) {
  line.sort((a, b) => a.start - b.start);
  line.forEach((n, i) => {
    const next = line[i + 1] ? line[i + 1].start : total;
    const end = n.start + n.dur;
    if (sustain) n.dur = Math.max(n.dur, Math.min(next - n.start, sustain));
    else if (next - end <= DIV / 2) n.dur = next - n.start;
    else n.dur = Math.min(next - n.start, Math.max(n.dur, DIV / 2));
    n.dur = Math.min(n.dur, next - n.start);
  });
  return line.filter((n) => n.dur > 0);
}

// Akkordton für einen Liegeklang: nahe am letzten Ton, bevorzugt Terz/Septime, keine Dopplung
export function chordToneFor(chord, last, lo, hi, taken, melPc, prefPc = null) {
  if (!chord) return null;
  let best = null;
  for (const t of chord.tones)
    for (let m = lo; m <= hi; m++) {
      if (mod(m, 12) !== t.pc) continue;
      let c = Math.abs(m - last);
      c += t.role === 'root' ? 1.5 : t.role === 'fifth' ? 0.8 : t.role === 'seventh' ? 0.2 : 0;
      if (taken.includes(t.pc)) c += 3;
      if (t.pc === melPc) c += 1.5;
      if (t.pc === prefPc) c -= 1.5;
      if (!best || c < best.c) best = { c, midi: m, lof: t.lof };
    }
  return best;
}

// Ton unter einer bewegten Oberstimme (Parallelführung): Terz bis Sexte darunter, Akkordton vor
// Tonleiterton, nahe am letzten Ton dieser Stimme
export function toneUnder(upper, chord, scale, last, lo, hi, taken, melPc) {
  let best = null;
  for (let m = Math.max(lo, upper - 9); m <= Math.min(hi, upper - 3); m++) {
    const pc = mod(m, 12);
    const tone = chord ? chord.tones.find((t) => t.pc === pc) : null;
    let c = tone ? 0 : scale.includes(pc) ? 0.9 : 3;
    c += 0.25 * Math.abs(m - last);
    const iv = upper - m;
    if (iv === 3 || iv === 4 || iv === 8 || iv === 9) c -= 0.3;
    if (pc === melPc) c += 0.6;
    if (taken.includes(pc)) c += 2;
    if (!best || c < best.c) best = { c, midi: m, lof: tone ? tone.lof : null };
  }
  return best;
}

// Läuft eine Begleitstimme mit der Melodie mit (Parallelstimme)? Gleiche Einsätze UND gleiche
// Bewegungsrichtung – Akkord-Einwürfe, die nur zufällig mit Melodietönen zusammenfallen, nicht.
// melody/guide: [{start, midi}] bzw. Ereignisse mit pitches
export function movesTogether(guide, melody) {
  if (!guide || guide.length < 8 || !melody || !melody.length) return false;
  const pitch = (n) => n.midi ?? n.pitches[0];
  const melBy = new Map(melody.map((n) => [n.start, pitch(n)]));
  const pairs = guide.filter((n) => melBy.has(n.start)).map((n) => [melBy.get(n.start), pitch(n)]);
  let moves = 0;
  let parallel = 0;
  for (let i = 1; i < pairs.length; i++) {
    const dm = Math.sign(pairs[i][0] - pairs[i - 1][0]);
    const dg = Math.sign(pairs[i][1] - pairs[i - 1][1]);
    if (!dm && !dg) continue;
    moves++;
    if (dm === dg) parallel++;
  }
  // Parallelstimmen liegen in Terzen und Sexten (auch Quarten) unter der Melodie
  const sweet = pairs.filter(([m, g]) => [3, 4, 5, 8, 9].includes((((m - g) % 12) + 12) % 12)).length;
  return pairs.length / guide.length >= 0.7 && pairs.length >= 0.4 * melody.length && moves >= 6 && parallel / moves >= 0.7 && sweet / pairs.length >= 0.6;
}

// Oktavlage für eine Basslinie: im Umfang, und so, dass auch die tiefen Töne der Linie noch im
// bequemen Bereich liegen (ein E-Bass reicht tiefer als Tuba/Posaune gut klingen)
export function bassOctave(notes, inst) {
  if (!notes.length) return 0;
  let shift = fitOctave(notes, inst).shift;
  const ps = notes.map((n) => n.midi).sort((a, b) => a - b);
  const low = ps[Math.floor(ps.length * 0.1)];
  const high = ps[Math.floor(ps.length * 0.95)];
  while (low + shift < inst.comfort[0] && high + shift + 12 <= inst.comfort[1]) shift += 12;
  return shift;
}

// Bass-Spur und Begleitstimmen der Vorlage (einstimmig, Ticks der Vorlage); bei MP3 von der KI
// gehört, bei MIDI/MusicXML die übrigen Spuren nach Lage
export function sourceLinesOf(song) {
  const total = song.measureCount * songMeasureTicks(song);
  const from = -(song.pickup || 0);
  const inSong = (n) => n.start >= from && n.start < total;
  const tracks = (song.tracks || []).filter((t) => !t.mel && t.notes && t.notes.length >= 4);
  const med = (t) => medianOf(t.notes.map((n) => n.midi));
  let bassTrack = tracks.find((t) => t.role === 'bass') || null;
  if (!bassTrack && tracks.length) {
    const lowest = tracks.reduce((a, b) => (med(b) < med(a) ? b : a));
    if (med(lowest) < 55) bassTrack = lowest;
  }
  const guides = tracks
    .filter((t) => t !== bassTrack)
    .sort((a, b) => med(b) - med(a))
    .map((t) => monoLine(t.notes.filter(inSong)));
  return { bass: bassTrack ? monoLine(bassTrack.notes.filter(inSong), true) : null, guides };
}

// song -> Linien je Stimme (klingend, Ticks der Vorlage). insts: Instrumente in Stimmen-
// Reihenfolge, slots: voiceSlots(insts). Ergebnis: { lines: [Noten | null], names: [Text] }
export function buildOriginalEnsemble(song, insts, slots) {
  const mt = songMeasureTicks(song);
  const compound = song.meter.beatType === 8 && song.meter.beats % 3 === 0 && song.meter.beats > 3;
  const beat = compound ? (DIV * 3) / 2 : (DIV * 4) / song.meter.beatType;
  const M = song.measureCount;
  const total = M * mt;
  const chords = song.chords || [];
  const scale = scalePcs(song.key);
  const lines = insts.map(() => null);
  const names = insts.map(() => '');
  const from = -(song.pickup || 0);
  const inSong = (n) => n.start >= from && n.start < total;

  // Melodie in der Lage von Stimme 1 (wie sie später gesetzt wird)
  const mel = (song.melody || []).filter(inSong);
  const melShift = fitOctave(mel, insts[slots.lead]).shift;
  const lead = insts[slots.lead];
  const inRange = (m) => {
    let x = m;
    while (x < lead.range[0]) x += 12;
    while (x > lead.range[1]) x -= 12;
    return x;
  };
  const melLine = mel.map((n) => ({ ...n, midi: inRange(n.midi + melShift) }));
  const melAt = pitchAt(melLine, { hold: DIV });
  const melOnsets = new Set(melLine.map((n) => n.start));

  // Quellen: Bass-Spur und Begleitstimmen der Vorlage (bei MP3 von der KI gehört)
  const src = sourceLinesOf(song);
  const bassTrack = src.bass;
  const guides = src.guides;

  // ---- Bass ----
  let bassLine = [];
  if (slots.bass !== null) {
    const inst = insts[slots.bass];
    const det = bassTrack || [];
    const shift = bassOctave(det, inst);
    bassLine = det.map((n) => ({ start: n.start, dur: n.dur, midi: n.midi + shift, lof: n.lof ?? null }));
    // einzelne Töne, die mehr als eine Oktave aus der Linie springen, in die Lage der Nachbarn
    for (let i = 0; i < bassLine.length; i++) {
      const around = bassLine.slice(Math.max(0, i - 3), i).concat(bassLine.slice(i + 1, i + 4));
      if (around.length < 2) continue;
      const ref = medianOf(around.map((n) => n.midi));
      const n = bassLine[i];
      if (Math.abs(n.midi - ref) <= 9) continue;
      const folded = n.midi - 12 * Math.round((n.midi - ref) / 12);
      if (folded >= inst.range[0] && folded <= inst.range[1]) n.midi = folded;
    }
    bassLine = tidy(bassLine, total);
    // Lücken (ab zwei Schlägen) ohne hörbaren Bass: Grundton im Rhythmus der Bass Drum, ohne
    // Schlagzeug auf den Takthälften bzw. beim Akkordwechsel
    const center = bassLine.length ? medianOf(bassLine.map((n) => n.midi)) : inst.comfort[0] + 5;
    const kicks = [...new Set((song.drumNotes || []).filter((d) => d.midi === 36 || d.midi === 35).map((d) => d.start))].sort((a, b) => a - b);
    const near = (pc) => {
      let m = center - 6;
      while (mod(m, 12) !== pc) m++;
      while (m < inst.range[0]) m += 12;
      while (m > inst.comfort[1]) m -= 12;
      return m;
    };
    const gaps = [];
    let cursor = 0;
    for (const n of [...bassLine, { start: total, dur: 0 }]) {
      if (n.start - cursor >= 2 * beat) gaps.push([cursor, n.start]);
      cursor = Math.max(cursor, n.start + n.dur);
    }
    const half = mt % (2 * beat) === 0 ? mt / 2 : mt;
    const fill = [];
    for (const [a, b] of gaps) {
      let starts = kicks.filter((k) => k >= a && k < b && k % (DIV / 2) === 0);
      if (starts.length < Math.max(1, (b - a) / mt) || starts.length > (4 * (b - a)) / mt) {
        starts = [];
        for (let t = Math.ceil(a / half) * half; t < b; t += half) starts.push(t);
      }
      for (const c of chords) if (c.start > a && c.start < b) starts.push(c.start);
      if (a === 0 || !starts.length) starts.push(a % beat === 0 ? a : Math.ceil(a / beat) * beat);
      starts = [...new Set(starts)].filter((t) => t >= a && t < b).sort((x, y) => x - y);
      starts.forEach((st, k) => {
        const end = k + 1 < starts.length ? starts[k + 1] : b;
        const ch = chordAt(chords, st);
        if (!ch || end <= st) return;
        const root = ch.tones.find((t) => t.role === 'root') || ch.tones[0];
        fill.push({ start: st, dur: end - st, midi: near(ch.bassPc ?? root.pc), lof: ch.bassLof ?? root.lof });
      });
    }
    bassLine = tidy(monoLine([...bassLine, ...fill], true), total);
    lines[slots.bass] = bassLine;
    names[slots.bass] = bassTrack ? 'Bass' : 'Bass (Grundtöne im Groove)';
  }
  const bassAt = pitchAt(bassLine, { hold: 2 * DIV });

  // ---- Mittelstimmen (von oben nach unten) ----
  const mids = slots.order.filter((v) => v !== slots.lead && v !== slots.bass);
  const done = []; // fertige Mittelstimmen (für Decke & Dopplungen)
  // Läuft die Begleitung mit der Melodie mit (Parallelstimmen)? Dann durchgehend im Melodie-Rhythmus
  const guideOnsets = guides.flatMap((g) => g.map((n) => n.start));
  // (gleiche Einsätze UND gleiche Bewegungsrichtung – Akkord-Einwürfe, die nur zufällig mit
  // Melodietönen zusammenfallen, zählen nicht)
  const together = movesTogether(guides[0], melLine);
  // Sonst sind es Akkord-Einwürfe (Gitarre/Klavier/Streicher): es zählt ihr gemeinsamer Rhythmus
  // – die Stellen, an denen mehrere Begleittöne zugleich einsetzen. Die Töne selbst werden als
  // Akkordtöne sauber geführt und klingen bis zum nächsten Einwurf (Liegeklang im Rhythmus).
  const hits = new Set();
  if (!together) {
    const count = new Map();
    for (const t of guideOnsets) count.set(t, (count.get(t) || 0) + 1);
    const need = guides.length >= 2 ? 2 : 1;
    let lastT = -Infinity;
    for (const t of [...count.keys()].sort((x, y) => x - y)) {
      if (count.get(t) < need || t - lastT < DIV / 2) continue;
      hits.add(t);
      lastT = t;
    }
  }
  const sustain = together ? 0 : mt;
  mids.forEach((v, k) => {
    const inst = insts[v];
    const guide = guides[k] || null;
    const others = guides.filter((g) => g !== guide);
    const upperAt = done.map((l) => pitchAt(l, { hold: DIV / 2 }));
    const guideBy = new Map((guide || []).map((n) => [n.start, n]));
    let last = Math.round((inst.comfort[0] + inst.comfort[1]) / 2);
    // Heimatlage: die Stimme kehrt nach tiefen Stellen der Melodie wieder in ihre gute Lage zurück
    const home = last;
    const out = [];
    for (let bar = Math.floor(from / mt); bar < M; bar++) {
      const a = bar * mt;
      const b = a + mt;
      const inBar = (n) => n.start >= a && n.start < b;
      // Rhythmus: eigene Begleitstimme, dazu die der anderen Stimmen; Parallelstimmen folgen der
      // Melodie; ohne Begleitung im Takt ein Liegeklang je Akkord
      const seen = new Set();
      const onsets = [];
      const add = (n, kind) => {
        if (seen.has(n.start)) return;
        seen.add(n.start);
        onsets.push([n.start, n.dur, kind]);
      };
      if (together) {
        for (const n of (guide || []).filter(inBar)) add(n, 'own');
        for (const g of others) for (const n of g.filter(inBar)) add(n, 'fill');
        for (const l of done) for (const n of l.filter(inBar)) add(n, 'fill');
        for (const n of melLine.filter(inBar)) add(n, 'fill');
      } else {
        const hs = [...hits].filter((t) => t >= a && t < b).sort((x, y) => x - y);
        // mindestens der Taktanfang, wenn im Takt überhaupt begleitet wird
        hs.forEach((t, i) => add({ start: t, dur: (i + 1 < hs.length ? hs[i + 1] : b) - t }, 'hit'));
        // Akkordwechsel ohne Einwurf: neu ansetzen (der Liegeton passt sonst nicht mehr)
        for (const c of chords) if (c.start >= a && c.start < b && !hs.some((t) => Math.abs(t - c.start) <= DIV / 2)) add({ start: c.start, dur: Math.min(b, c.start + c.dur) - c.start }, 'pad');
      }
      let pad = false;
      if (!onsets.length && a >= 0) {
        pad = true;
        for (const c of chords) {
          const s = Math.max(a, c.start);
          const e = Math.min(b, c.start + c.dur);
          if (e > s) onsets.push([s, e - s, 'pad']);
        }
      }
      onsets.sort((x, y) => x[0] - y[0]);
      for (const [t, d] of onsets) {
        const m = melAt(t);
        const ups = upperAt.map((f) => f(t)).filter((x) => x !== null);
        let hi = Math.min(inst.range[1], inst.comfort[1] + 2);
        if (m !== null) hi = Math.min(hi, m - 1);
        if (ups.length) hi = Math.min(hi, Math.min(...ups) - 1);
        const bs = bassAt(t);
        let lo = Math.max(inst.range[0], bs !== null ? bs + 1 : inst.range[0]);
        if (hi < lo + 2) {
          // kein Platz unter der Stimme darüber: im Umfang bleiben
          lo = inst.range[0];
          hi = Math.max(hi, lo + 4);
        }
        const melPc = m !== null ? mod(m, 12) : null;
        const taken = ups.map((x) => mod(x, 12));
        const chord = chordAt(chords, Math.max(0, t));
        const g = guideBy.get(t);
        let pick = null;
        if (g && together) {
          // gehörter Ton: im Verhältnis zur Melodie wie in der Vorlage, sonst die Oktave, die passt
          const want = g.midi + melShift;
          if (want >= lo && want <= hi) pick = { midi: want, lof: g.lof ?? null };
          else {
            let best = null;
            for (let mm = want - 48; mm <= want + 48; mm += 12) {
              if (mm < lo || mm > hi) continue;
              if (best === null || Math.abs(mm - last) < Math.abs(best - last)) best = mm;
            }
            if (best !== null) pick = { midi: best, lof: g.lof ?? null };
          }
        }
        if (!pick && !pad && together) {
          const upper = ups.length ? Math.min(...ups) : m;
          if (upper !== null) pick = toneUnder(upper, chord, scale, Math.min(Math.max(last, lo), hi), lo, hi, taken, melPc);
        }
        if (!pick) pick = chordToneFor(chord, Math.min(Math.max(Math.round(0.7 * last + 0.3 * home), lo), hi), lo, hi, taken, melPc, g ? mod(g.midi + melShift, 12) : null);
        if (!pick) continue;
        out.push({ start: t, dur: d, midi: pick.midi, lof: pick.lof });
        last = pick.midi;
      }
    }
    const line = tidy(monoLine(out), total, { sustain });
    lines[v] = line;
    names[v] = guide ? `Begleitstimme ${k + 1}` : `Harmonie ${k + 1}`;
    done.push(line);
  });
  return { lines, names, melShift };
}
