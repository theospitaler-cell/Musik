// Tonalität: Krumhansl-Schmuckler-Profile (gesamtes Stück + gleitende 8-Takt-Fenster),
// Modulationserkennung mit Hysterese und enharmonische Grammatik.
import { mod } from '../core/constants.js';
import { makeKey, keyFromPc } from '../theory/keys.js';
import { lofNear, keyCenter, lofPc } from '../theory/pitch.js';
import { chordAt } from '../model/song.js';

// Krumhansl-Kessler-Gewichte (wie src/theory/keys.js)
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Tonklassen-Histogramm der Noten im Zeitraum [a, b) (Ticks), gewichtet mit der Dauer
export function pcHistogram(notes, a = -Infinity, b = Infinity) {
  const h = new Array(12).fill(0);
  for (const n of notes) {
    const s = Math.max(a, n.start);
    const e = Math.min(b, n.start + n.dur);
    if (e > s) h[mod(n.midi, 12)] += (e - s) * (n.weight ?? 1);
  }
  return h;
}

// Korrelation des Histogramms mit allen 24 Tonartprofilen
export function ksScores(hist) {
  const out = [];
  for (let pc = 0; pc < 12; pc++) {
    for (const mode of ['major', 'minor']) {
      const prof = mode === 'major' ? MAJOR : MINOR;
      const rot = prof.map((_, i) => prof[mod(i - pc, 12)]);
      out.push({ pc, mode, r: correlate(hist, rot) });
    }
  }
  return out.sort((a, b) => b.r - a.r);
}

// Tonart des ganzen Stücks. finalPc: Schlusston (Hinweis), bassFinalPc: Grundton im Bass am Ende
export function estimateKey(notes, { finalPc = null, bassFinalPc = null } = {}) {
  const hist = pcHistogram(notes);
  if (!hist.some((x) => x > 0)) return { key: makeKey(0, 'major'), confidence: 0, scores: [] };
  const scores = ksScores(hist).map((s) => ({ ...s, adj: s.r + (finalPc === s.pc ? 0.06 : 0) + (bassFinalPc === s.pc ? 0.08 : 0) }));
  scores.sort((a, b) => b.adj - a.adj);
  const best = scores[0];
  const second = scores.find((s) => s.pc !== best.pc || s.mode !== best.mode);
  return { key: keyFromPc(best.pc, best.mode), confidence: Math.max(0, best.r - (second ? second.r : 0)), scores };
}

// Vorzeichenzahl einer Tonart (Dur und paralleles Moll teilen sie)
const fifthsOf = (pc, mode) => keyFromPc(pc, mode).fifths;

// Tonartverlauf über gleitende Fenster (windowBars Takte, hop 1) mit Viterbi-Glättung.
// Zustand = Vorzeichenzahl (-6..5); Moll/Dur wird je Abschnitt aus der besseren Korrelation gewählt.
// changePenalty: Kosten eines Tonartwechsels – verhindert Flackern, echte Modulationen halten ihn aus.
// Rückgabe: Abschnitte [{start, end, key, confidence}] in Takten (end exklusiv)
export function keyTrack(notes, { measureTicks, measureCount, windowBars = 8, changePenalty = 0.9, minBars = 4 } = {}) {
  const M = measureCount;
  const states = [];
  for (let f = -6; f <= 5; f++) states.push(f);
  // Emission je Takt: Fenster um den Takt, bester Wert der beiden Modi dieser Vorzeichenzahl
  const emit = [];
  const modeOf = [];
  const half = Math.floor(windowBars / 2);
  for (let b = 0; b < M; b++) {
    const a = Math.max(0, b - half + 1);
    const z = Math.min(M, a + windowBars);
    const a2 = Math.max(0, z - windowBars);
    const hist = pcHistogram(notes, a2 * measureTicks, z * measureTicks);
    const sc = ksScores(hist);
    const row = new Array(states.length).fill(-1);
    const md = new Array(states.length).fill('major');
    for (const s of sc) {
      const idx = fifthsOf(s.pc, s.mode) + 6;
      if (idx >= 0 && idx < states.length && s.r > row[idx]) {
        row[idx] = s.r;
        md[idx] = s.mode;
      }
    }
    emit.push(row);
    modeOf.push(md);
  }
  // Viterbi
  const S = states.length;
  const cost = Array.from({ length: M }, () => new Float64Array(S).fill(-1e9));
  const back = Array.from({ length: M }, () => new Int8Array(S).fill(-1));
  for (let s = 0; s < S; s++) cost[0][s] = emit[0][s];
  for (let b = 1; b < M; b++) {
    for (let s = 0; s < S; s++) {
      let best = -1e9;
      let from = s;
      for (let t = 0; t < S; t++) {
        const v = cost[b - 1][t] - (t === s ? 0 : changePenalty);
        if (v > best) {
          best = v;
          from = t;
        }
      }
      cost[b][s] = best + emit[b][s];
      back[b][s] = from;
    }
  }
  let s = 0;
  for (let k = 1; k < S; k++) if (cost[M - 1][k] > cost[M - 1][s]) s = k;
  const path = new Array(M);
  for (let b = M - 1; b >= 0; b--) {
    path[b] = s;
    s = back[b][s] >= 0 ? back[b][s] : s;
  }
  // Abschnitte bilden, zu kurze an den Nachbarn hängen
  let segs = [];
  for (let b = 0; b < M; b++) {
    const last = segs[segs.length - 1];
    if (last && last.state === path[b]) last.end = b + 1;
    else segs.push({ state: path[b], start: b, end: b + 1 });
  }
  for (let guard = 0; guard < 16 && segs.length > 1; guard++) {
    const k = segs.findIndex((x) => x.end - x.start < minBars);
    if (k < 0) break;
    const into = k === 0 ? 1 : k === segs.length - 1 ? k - 1 : segs[k - 1].end - segs[k - 1].start >= segs[k + 1].end - segs[k + 1].start ? k - 1 : k + 1;
    const a = segs[into];
    const x = segs[k];
    a.start = Math.min(a.start, x.start);
    a.end = Math.max(a.end, x.end);
    segs.splice(k, 1);
    segs = segs.reduce((acc, y) => {
      const l = acc[acc.length - 1];
      if (l && l.state === y.state) l.end = y.end;
      else acc.push(y);
      return acc;
    }, []);
  }
  // Modus je Abschnitt: Summe der Korrelationen über die Takte
  return segs.map((sg) => {
    let major = 0;
    let minor = 0;
    for (let b = sg.start; b < sg.end; b++) {
      const idx = sg.state;
      const hist = pcHistogram(notes, Math.max(0, b - half + 1) * measureTicks, Math.min(M, Math.max(0, b - half + 1) + windowBars) * measureTicks);
      for (const sc of ksScores(hist)) if (fifthsOf(sc.pc, sc.mode) + 6 === idx) (sc.mode === 'major' ? (major = Math.max(major, 0) + sc.r) : (minor = Math.max(minor, 0) + sc.r));
    }
    const mode = minor > major ? 'minor' : 'major';
    const fifths = sg.state - 6;
    const conf = (sg.end - sg.start) ? Math.max(major, minor) / (sg.end - sg.start) : 0;
    return { start: sg.start, end: sg.end, key: makeKey(fifths, mode), confidence: Math.round(conf * 100) / 100 };
  });
}

export function keyAtBarFactory(track) {
  return (bar) => {
    let k = track[0].key;
    for (const s of track) if (s.start <= bar) k = s.key;
    return k;
  };
}

// ---------------------------------------------------------------------------------------------
// Enharmonische Grammatik
//
// Töne der erkannten Skala werden strikt so geschrieben, wie die Skala es verlangt (F-Dur: Bb nie A#,
// D-Moll: Bb, aber als Leitton C# nie Db). Chromatische Töne nehmen die Akkordschreibweise,
// sonst die der Tonartnähe (Quintenreihe).

// LOF-Stufen von Dur und Moll (relativ zum Grundton)
const MAJOR_LOFS = [0, 2, 4, -1, 1, 3, 5];
const MINOR_LOFS = [0, 2, -3, -1, 1, -4, -2];

export function scaleSpelling(key) {
  const base = key.mode === 'minor' ? MINOR_LOFS : MAJOR_LOFS;
  const map = new Map();
  // Doppelvorzeichen (Fisis in gis-Moll) werden nicht geschrieben: der Ton fällt dann auf die
  // enharmonisch einfache Schreibweise (lofNear)
  const add = (lof) => {
    if (lof < -8 || lof > 12) return;
    const pc = mod(lof * 7, 12);
    if (!map.has(pc)) map.set(pc, lof);
  };
  for (const off of base) add(key.tonicLof + off);
  if (key.mode === 'minor') {
    // Leitton (erhöhte 7.) und melodisches Moll (erhöhte 6.) – als Kreuz vom Grundton aus
    add(key.tonicLof + 5);
    add(key.tonicLof + 3);
  }
  return map;
}

// pc -> LOF in der Tonart (chordLof: Schreibweise aus dem Akkord, falls vorhanden)
export function spellPc(pc, key, chordLof = null) {
  const sc = scaleSpelling(key);
  if (sc.has(pc)) return sc.get(pc);
  // Akkordschreibweise nur ohne Doppelvorzeichen und nicht weit außerhalb der Tonart
  if (chordLof !== null && chordLof !== undefined && chordLof >= -8 && chordLof <= 12 && Math.abs(chordLof - keyCenter(key)) <= 7) return chordLof;
  return lofNear(pc, keyCenter(key));
}

// Schreibweise aller Noten (Ticks) – keyAt(bar) liefert die lokale Tonart
export function spellNotes(notes, { keyAt, measureTicks, chords = null }) {
  for (const n of notes) {
    const key = keyAt(Math.max(0, Math.floor(n.start / measureTicks)));
    const pc = mod(n.midi, 12);
    let chordLof = null;
    if (chords) {
      const ch = chordAt(chords, n.start);
      const t = ch && [...ch.tones, ...ch.tens].find((x) => x.pc === pc);
      if (t) chordLof = t.lof;
    }
    n.lof = spellPc(pc, key, chordLof);
  }
  return notes;
}

// Ein Takt, eine Stimme: dieselbe Tonklasse nie in zwei Schreibweisen (A# neben Bb), keine
// Doppelvorzeichen. Die Schreibweise der Skala gewinnt, sonst die häufigere.
export function unifySpelling(events, { keyAt, barOf }) {
  const byBar = new Map();
  for (const e of events) {
    const b = barOf(e.start);
    if (!byBar.has(b)) byBar.set(b, []);
    byBar.get(b).push(e);
  }
  let fixed = 0;
  for (const [bar, list] of byBar) {
    const key = keyAt(bar);
    const sc = scaleSpelling(key);
    const votes = new Map();
    for (const e of list) {
      e.pitches.forEach((p, i) => {
        const pc = mod(p, 12);
        const l = e.lofs[i];
        if (l === null || l === undefined) return;
        if (!votes.has(pc)) votes.set(pc, new Map());
        votes.get(pc).set(l, (votes.get(pc).get(l) || 0) + 1);
      });
    }
    const choice = new Map();
    for (const [pc, m] of votes) {
      let best = sc.get(pc);
      if (best === undefined || !m.has(best)) {
        // keine Skalenschreibweise vorhanden: die häufigste, aber ohne Doppelvorzeichen
        const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]).filter(([l]) => Math.abs(Math.floor((l + 1) / 7)) < 2);
        best = ranked.length ? ranked[0][0] : lofNear(pc, keyCenter(key));
      }
      choice.set(pc, best);
    }
    for (const e of list) {
      e.pitches.forEach((p, i) => {
        const pc = mod(p, 12);
        const l = choice.get(pc);
        if (l !== undefined && e.lofs[i] !== l) {
          e.lofs[i] = l;
          fixed++;
        }
      });
    }
  }
  return fixed;
}

// Prüfung (für Bericht und Tests): Schreibweisen-Verstöße je Stimme
export function spellingIssues(events, { keyAt, barOf }) {
  const issues = [];
  const perBar = new Map();
  for (const e of events) {
    const bar = barOf(e.start);
    const key = keyAt(bar);
    const sc = scaleSpelling(key);
    e.pitches.forEach((p, i) => {
      const l = e.lofs[i];
      if (l === null || l === undefined) return;
      const pc = mod(p, 12);
      const alter = Math.floor((l + 1) / 7);
      if (Math.abs(alter) >= 2) issues.push({ kind: 'double-accidental', bar, midi: p, lof: l });
      if (lofPc(l) !== pc) issues.push({ kind: 'wrong-pitch-class', bar, midi: p, lof: l });
      const want = sc.get(pc);
      if (want !== undefined && want !== l) issues.push({ kind: 'off-scale', bar, midi: p, lof: l, want });
      const k = `${bar}:${pc}`;
      if (!perBar.has(k)) perBar.set(k, new Set());
      perBar.get(k).add(l);
    });
  }
  for (const [k, set] of perBar) if (set.size > 1) issues.push({ kind: 'collision', bar: Number(k.split(':')[0]), lofs: [...set] });
  return issues;
}
