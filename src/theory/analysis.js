// Musikalische Analyse: Tonart, Harmonik (falls keine Akkordsymbole vorhanden),
// Formanalyse (Abschnitte A/B/C ...).
import { DIV, mod } from '../core/constants.js';
import { buildChord, sameChord } from './chords.js';
import { detectKey, scalePcs, makeKey } from './keys.js';
import { lofNear, keyCenter } from './pitch.js';
import { measureTicks, normalizeChords, monophonize, ensureSpelling, sortEvents } from '../model/song.js';

const TEMPLATE_KINDS = [
  ['major', 0],
  ['minor', 0],
  ['dominant', 0.15],
  ['minor-seventh', 0.2],
  ['major-seventh', 0.3],
  ['diminished', 0.35],
  ['half-diminished', 0.4],
];

function beatStrengthWeight(t, mt, beatTicks) {
  const p = mod(t, mt);
  if (p === 0) return 2.0;
  if (p % (mt / 2) === 0 && mt % 2 === 0) return 1.5;
  if (p % beatTicks === 0) return 1.2;
  return 0.8;
}

// Gewichte der Tonhöhenklassen in [a, b)
function pcWeights(notes, a, b, mt, beatTicks, melodyOnly) {
  const w = new Array(12).fill(0);
  let bassPc = null;
  let bassMidi = Infinity;
  for (const n of notes) {
    const s = Math.max(a, n.start);
    const e = Math.min(b, n.start + n.dur);
    if (e <= s) continue;
    const strength = n.start >= a ? beatStrengthWeight(n.start, mt, beatTicks) : 1.0;
    w[mod(n.midi, 12)] += ((e - s) / DIV) * strength;
    if (!melodyOnly && n.start <= a + beatTicks / 2 && n.midi < bassMidi) {
      bassMidi = n.midi;
      bassPc = mod(n.midi, 12);
    }
  }
  return { w, bassPc };
}

function scoreChord(rootPc, kind, penalty, weights, key, scale, prevChord, bassPc) {
  const c = buildChord(lofNear(rootPc, keyCenter(key)), kind);
  const pcs = c.tones.map((t) => t.pc);
  let score = 0;
  let total = 0;
  for (let pc = 0; pc < 12; pc++) {
    const x = weights[pc];
    if (!x) continue;
    total += x;
    if (pcs.includes(pc)) score += x * (pc === rootPc ? 1.15 : 1);
    else score -= x * 0.75;
  }
  if (total === 0) return { c, score: -Infinity };
  score /= total;
  // fehlende Akkordtöne leicht bestrafen (Septime fehlt -> Dreiklang bevorzugen)
  for (const t of c.tones) if (!weights[t.pc]) score -= t.role === 'seventh' ? 0.18 : t.role === 'third' ? 0.05 : 0.02;
  // Diatonik-Prior
  const nonDia = pcs.filter((p) => !scale.includes(p)).length;
  score -= nonDia * 0.12;
  // Funktions-Prior: I, IV, V, vi, ii
  const deg = mod(rootPc - key.tonicPc, 12);
  const fn = key.mode === 'minor' ? { 0: 0.12, 5: 0.06, 7: 0.1, 8: 0.04, 3: 0.04, 10: 0.03 } : { 0: 0.12, 5: 0.07, 7: 0.1, 9: 0.05, 2: 0.04 };
  score += fn[deg] || 0;
  // Dominantseptakkord auf V ist natürlich
  if (deg === 7 && kind === 'dominant') score += 0.12;
  if (key.mode === 'minor' && deg === 7 && (kind === 'major' || kind === 'dominant')) score += 0.06;
  score -= penalty;
  if (bassPc !== null && bassPc === rootPc) score += 0.15;
  if (prevChord && prevChord.rootPc === rootPc && prevChord.kind === kind) score += 0.06;
  return { c, score };
}

function bestChord(weights, key, prev, bassPc) {
  const scale = scalePcs(key);
  if (key.mode === 'minor') scale.push(mod(key.tonicPc + 11, 12)); // Leitton
  let best = null;
  for (let r = 0; r < 12; r++) {
    for (const [kind, pen] of TEMPLATE_KINDS) {
      const s = scoreChord(r, kind, pen, weights, key, scale, prev, bassPc);
      if (!best || s.score > best.score) best = s;
    }
  }
  return best;
}

// Harmonisierung: pro Takt, ggf. pro Halbtakt (bei 4/4) oder pro Schlag (3/4 Walzer nicht)
export function harmonize(notes, { meter, key, measureCount, melodyOnly = false }) {
  const mt = measureTicks(meter);
  const beatTicks = (DIV * 4) / meter.beatType * (meter.beatType === 8 && meter.beats % 3 === 0 ? 3 : 1);
  const chords = [];
  let prev = null;
  for (let m = 0; m < measureCount; m++) {
    const a = m * mt;
    const b = a + mt;
    const whole = pcWeights(notes, a, b, mt, beatTicks, melodyOnly);
    const full = bestChord(whole.w, key, prev, whole.bassPc);
    let used = [{ start: a, dur: mt, best: full }];
    // Halbtakt-Test
    if (mt >= DIV * 4 && mt % 2 === 0) {
      const h = mt / 2;
      const w1 = pcWeights(notes, a, a + h, mt, beatTicks, melodyOnly);
      const w2 = pcWeights(notes, a + h, b, mt, beatTicks, melodyOnly);
      const b1 = bestChord(w1.w, key, prev, w1.bassPc);
      const b2 = bestChord(w2.w, key, b1?.c, w2.bassPc);
      if (b1 && b2 && Number.isFinite(b1.score) && Number.isFinite(b2.score) && !sameChord(b1.c, b2.c)) {
        const gain = (b1.score + b2.score) / 2 - full.score;
        if (gain > (melodyOnly ? 0.28 : 0.18)) used = [
          { start: a, dur: h, best: b1 },
          { start: a + h, dur: h, best: b2 },
        ];
      }
    }
    for (const u of used) {
      if (!u.best || !Number.isFinite(u.best.score)) {
        if (prev) chords.push({ start: u.start, dur: u.dur, chord: prev });
        continue;
      }
      chords.push({ start: u.start, dur: u.dur, chord: u.best.c });
      prev = u.best.c;
    }
  }
  // Schlussakkord: Tonika bevorzugen
  if (chords.length) {
    const last = chords[chords.length - 1];
    const tonic = buildChord(key.tonicLof, key.mode === 'minor' ? 'minor' : 'major');
    const lastNotes = pcWeights(notes, last.start, last.start + last.dur, mt, beatTicks, melodyOnly);
    const tPcs = tonic.tones.map((t) => t.pc);
    const ok = lastNotes.w.every((x, pc) => !x || tPcs.includes(pc));
    if (ok) last.chord = tonic;
  }
  if (!chords.length) chords.push({ start: 0, dur: mt * Math.max(1, measureCount), chord: buildChord(key.tonicLof, key.mode === 'minor' ? 'minor' : 'major') });
  return normalizeChords(chords, measureCount * mt);
}

// --- Formanalyse -------------------------------------------------------

function phraseSignature(melody, a, b) {
  return melody.filter((n) => n.start >= a && n.start < b).map((n) => [n.start - a, n.midi]);
}

function similarity(sa, sb) {
  if (!sa.length && !sb.length) return 1;
  if (!sa.length || !sb.length) return 0;
  // Transpositionsinvariant über Intervalle zum ersten Ton + Rhythmus
  const keyA = new Set(sa.map(([t, m]) => `${t}:${m - sa[0][1]}`));
  const keyB = new Set(sb.map(([t, m]) => `${t}:${m - sb[0][1]}`));
  const rA = new Set(sa.map(([t]) => t));
  const rB = new Set(sb.map(([t]) => t));
  let inter = 0;
  for (const k of keyA) if (keyB.has(k)) inter++;
  let rInter = 0;
  for (const k of rA) if (rB.has(k)) rInter++;
  const pitchSim = inter / Math.max(keyA.size, keyB.size);
  const rhythmSim = rInter / Math.max(rA.size, rB.size);
  // gleiche absolute Tonhöhe am Anfang zählt extra
  const same = sa[0][1] === sb[0][1] ? 0.1 : 0;
  return Math.min(1, pitchSim * 0.7 + rhythmSim * 0.3 + same);
}

export function autoSections(song) {
  const mt = measureTicks(song.meter);
  const M = song.measureCount;
  let len = M >= 24 ? 8 : M >= 8 ? 4 : M;
  if (M % len !== 0 && M % 4 === 0 && len === 8) len = 4;
  const raw = [];
  for (let s = 0; s < M; s += len) raw.push({ start: s, length: Math.min(len, M - s) });
  // kurzen Rest an vorherigen Abschnitt hängen
  if (raw.length > 1 && raw[raw.length - 1].length < Math.min(4, len)) {
    const r = raw.pop();
    raw[raw.length - 1].length += r.length;
  }
  const labels = [];
  const sigs = raw.map((r) => phraseSignature(song.melody, r.start * mt, (r.start + r.length) * mt));
  let nextLetter = 0;
  const reps = [];
  for (let i = 0; i < raw.length; i++) {
    let found = null;
    for (const rep of reps) {
      if (similarity(sigs[i], sigs[rep.idx]) >= 0.62) {
        found = rep;
        break;
      }
    }
    if (found) labels.push(found.label);
    else {
      const label = String.fromCharCode(65 + nextLetter++);
      reps.push({ idx: i, label });
      labels.push(label);
    }
  }
  // Große Formen (> 6 Abschnitte) zu Paaren zusammenfassen (z. B. Strophe = 2×8)
  let secs = raw.map((r, i) => ({ label: labels[i], start: r.start, length: r.length }));
  if (secs.length > 6) {
    const merged = [];
    for (let i = 0; i < secs.length; i++) {
      const cur = secs[i];
      const nxt = secs[i + 1];
      if (nxt && nxt.label === cur.label) {
        merged.push({ label: cur.label, start: cur.start, length: cur.length + nxt.length });
        i++;
      } else merged.push({ ...cur });
    }
    secs = merged;
  }
  return secs;
}

export function sanitizeSections(sections, M) {
  const s = sections.filter((x) => x.start < M).sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const end = i + 1 < s.length ? s[i + 1].start : M;
    if (end > s[i].start) out.push({ label: s[i].label || String.fromCharCode(65 + i), start: s[i].start, length: end - s[i].start });
  }
  if (!out.length || out[0].start > 0) out.unshift({ label: 'A', start: 0, length: out.length ? out[0].start : M });
  return out;
}

// Gemeinsame Nachbearbeitung aller Importer
export function finalizeSong(song, { allNotes = null } = {}) {
  song.warnings = song.warnings || [];
  song.melody = monophonize(sortEvents(song.melody));
  const mt = measureTicks(song.meter);
  const lastEnd = Math.max(0, ...song.melody.map((n) => n.start + n.dur));
  if (!song.measureCount) song.measureCount = Math.max(1, Math.ceil(lastEnd / mt));
  song.measureCount = Math.max(1, song.measureCount);
  const total = song.measureCount * mt;
  // Noten über das Ende hinaus kappen
  song.melody = song.melody.filter((n) => n.start < total).map((n) => ({ ...n, dur: Math.min(n.dur, total - n.start) }));

  if (!song.key) {
    const pool = (allNotes && allNotes.length ? allNotes : song.melody).map((n) => ({ midi: n.midi, dur: n.dur }));
    const lastMel = song.melody[song.melody.length - 1];
    song.key = pool.length ? detectKey(pool, { finalPc: lastMel ? mod(lastMel.midi, 12) : null }) : makeKey(0, 'major');
    song.keyDetected = true;
  }
  if (!song.chords || !song.chords.length) {
    const src = allNotes && allNotes.length ? allNotes : song.melody;
    song.chords = harmonize(src.filter((n) => n.start >= 0), {
      meter: song.meter,
      key: song.key,
      measureCount: song.measureCount,
      melodyOnly: !(allNotes && allNotes.length),
    });
    song.chordsDetected = true;
  } else {
    song.chords = normalizeChords(song.chords, total);
  }
  ensureSpelling(song.melody, song.key, song.chords);
  if (!song.sections || !song.sections.length) {
    song.sections = autoSections(song);
    song.sectionsDetected = true;
  } else song.sections = sanitizeSections(song.sections, song.measureCount);
  if (!song.tempo) song.tempo = 100;
  song.title = song.title || 'Ohne Titel';
  return song;
}
