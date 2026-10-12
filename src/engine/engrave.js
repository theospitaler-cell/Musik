// Notensatz-Vorbereitung: Formteile & Probenbuchstaben, Artikulation, Dynamik, Schreibweise,
// Zusammenbau des Arrangements (`arr`) für den MusicXML-4.0-Export.
import { DYN_LEVELS, dynShift, dynIndex, mod } from '../core/constants.js';
import { keyName, keyNameDe } from '../theory/keys.js';
import { tempoHeading } from '../arrange/post.js';
import { barFeatures, audioSections } from '../input/form.js';
import { exportMusicXML } from '../output/musicxml.js';
import { spellPc, unifySpelling } from './tonality.js';
import { chordAt as chordAtList } from '../model/song.js';
import { endOf, sortEvents, median } from './util.js';

const ENSEMBLE_NAMES = { 1: 'Lead Sheet', 2: 'Duo', 3: 'Trio', 4: 'Quartett', 5: 'Quintett', 6: 'Sextett', 7: 'Septett', 8: 'Oktett', 9: 'Nonett', 10: 'Dezett', 11: 'Kleines Orchester', 12: 'Kleines Orchester', 13: 'Blasorchester', 14: 'Blasorchester', 15: 'Blasorchester' };
export const ensembleName = (n) => ENSEMBLE_NAMES[n] || `${n} Stimmen`;

const LETTER = (n) => (n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(65 + (n % 26)) + (Math.floor(n / 26) + 1));

// ---- Formteile ----------------------------------------------------------------------------------
const cosine = (a, b) => {
  let s = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
};

function chunkSections(ctx) {
  const { M, geo } = ctx;
  const len = M >= 32 ? 8 : 4;
  const raw = [];
  for (let s = 0; s < M; s += len) raw.push({ start: s, length: Math.min(len, M - s) });
  if (raw.length > 1 && raw[raw.length - 1].length < 3) {
    const r = raw.pop();
    raw[raw.length - 1].length += r.length;
  }
  const sig = raw.map((r) => {
    const h = new Array(12).fill(0);
    for (const n of ctx.lead) if (n.start >= r.start * geo.mt && n.start < (r.start + r.length) * geo.mt) h[mod(n.midi, 12)] += n.dur;
    return h;
  });
  const reps = [];
  raw.forEach((r, i) => {
    const hit = reps.find((x) => cosine(sig[i], sig[x.i]) >= 0.93);
    if (hit) r.label = hit.label;
    else {
      r.label = LETTER(reps.length);
      reps.push({ i, label: r.label });
    }
  });
  return raw;
}

export function detectSections(ctx) {
  const { M, geo, material } = ctx;
  if (material.sections && material.sections.length) return material.sections.map((s) => ({ label: s.label, start: s.start, length: s.length, energy: s.energy }));
  let secs = null;
  if (M >= 12) {
    const notes = [...ctx.comp, ...ctx.bassNotes].map((n) => ({ start: n.start, dur: n.dur, midi: n.midi }));
    const energy = new Array(M).fill(0);
    const cnt = new Array(M).fill(0);
    for (const n of ctx.lead) {
      const b = Math.floor(n.start / geo.mt);
      if (b < M && n.vel !== null && n.vel !== undefined) {
        energy[b] += n.vel > 1 ? n.vel / 127 : n.vel;
        cnt[b]++;
      }
    }
    const en = energy.map((e, i) => (cnt[i] ? e / cnt[i] : 0));
    const bars = barFeatures({ mt: geo.mt, measureCount: M, melody: ctx.lead, notes, drumNotes: material.drums || [], energy: cnt.some(Boolean) ? en : null });
    secs = audioSections(bars);
  }
  if (!secs || (secs.length < 2 && M >= 8)) secs = chunkSections(ctx);
  return secs.map((s) => ({ ...s }));
}

// Namen: Intro, Strophe, Refrain, Bridge, Schluss
export function nameSections(secs) {
  const n = secs.length;
  const byLabel = new Map();
  secs.forEach((s) => {
    if (!byLabel.has(s.label)) byLabel.set(s.label, []);
    byLabel.get(s.label).push(s);
  });
  const out = secs.map((s) => ({ ...s, name: null }));
  const countOf = (l) => byLabel.get(l).length;
  if (n >= 3 && secs[0].length <= 4 && countOf(secs[0].label) === 1) out[0].name = 'Intro';
  // Refrain: wiederkehrender Formteil mit der höchsten mittleren Lautstärke (sonst der längste)
  const repeated = [...byLabel.entries()].filter(([, l]) => l.length >= 2);
  let refrain = null;
  if (repeated.length) {
    refrain = repeated
      .map(([label, l]) => ({ label, score: median(l.map((x) => x.energy ?? 0)) + 0.01 * l.reduce((a, x) => a + x.length, 0) }))
      .sort((a, b) => b.score - a.score)[0].label;
    if (repeated.length === 1 && n <= 3) refrain = null;
  }
  const verses = new Set(repeated.map(([l]) => l).filter((l) => l !== refrain));
  out.forEach((s, i) => {
    if (s.name) return;
    if (s.label === refrain) s.name = 'Refrain';
    else if (verses.has(s.label)) s.name = 'Strophe';
    else if (i === n - 1 && n >= 3 && s.length <= 4) s.name = 'Schluss';
    else if (i > 0 && i < n - 1 && countOf(s.label) === 1 && out.slice(0, i).some((x) => x.label === refrain || verses.has(x.label))) s.name = 'Bridge';
    else s.name = n === 1 ? 'Thema' : `Teil ${s.label}`;
  });
  // fortlaufend nummerieren, wenn derselbe Name mehrfach vorkommt
  const seen = new Map();
  const total = new Map();
  out.forEach((s) => total.set(s.name, (total.get(s.name) || 0) + 1));
  out.forEach((s) => {
    if (total.get(s.name) > 1) {
      seen.set(s.name, (seen.get(s.name) || 0) + 1);
      s.display = `${s.name} ${seen.get(s.name)}`;
    } else s.display = s.name;
  });
  return out;
}

// ---- Artikulation -------------------------------------------------------------------------------
export function articulate(score) {
  const { voices, ctx } = score;
  const { mt, beat } = ctx.geo;
  const dynamic = !!(score.behavior && score.behavior.dynamic);
  for (const v of voices) {
    const evs = sortEvents(v.events);
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      const prev = evs[i - 1];
      const rel = e.start - Math.floor(e.start / mt) * mt;
      const onBeat = rel % beat === 0;
      const beatStart = e.start - (rel % beat);
      const nextBeat = beatStart + beat;
      const short = e.dur <= 12;
      const crosses = endOf(e) > nextBeat;
      const beatEmpty = !prev || endOf(prev) <= beatStart; // auf dem Schlag selbst pausiert die Stimme
      const sync = !onBeat && (crosses || beatEmpty) && e.dur >= 6;
      if (short && !onBeat && !e.art.includes('staccato')) e.art.push('staccato');
      if (e.role === 'stabs' && short && !e.art.includes('staccato')) e.art.push('staccato');
      if (sync && !e.art.includes('accent')) e.art.push('accent');
      if (dynamic && (e.role === 'melody' || e.role === 'answer' || e.role === 'double')) {
        // Fanfaren-Auftakte: Einsatz nach einer Pause wird betont, lange Phrasenschlüsse bekommen Tenuto
        const afterRest = !!prev && e.start - endOf(prev) >= beat;
        const next = evs[i + 1];
        const phraseEnd = !next || next.start - endOf(e) >= beat / 2;
        if (afterRest && e.dur >= 6 && !e.art.includes('accent')) e.art.push('accent');
        if (e.dur >= 2 * beat && phraseEnd && !e.art.includes('staccato') && !e.art.includes('tenuto')) e.art.push('tenuto');
      }
    }
  }
}

// ---- Dynamik ------------------------------------------------------------------------------------
// MIDI-Velocity -> p..ff (mit Clustern über die Formteile, damit ähnlich laute Teile gleich notiert werden)
export function dynForVelocity(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'mf';
  const x = v <= 1 ? v * 127 : v;
  return x < 48 ? 'p' : x < 70 ? 'mp' : x < 92 ? 'mf' : x < 110 ? 'f' : 'ff';
}

function kmeans1d(vals, k) {
  if (!vals.length) return [];
  const sorted = [...vals].sort((a, b) => a - b);
  k = Math.max(1, Math.min(k, new Set(sorted).size));
  let centers = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) / k) * (sorted.length - 1))]);
  for (let it = 0; it < 20; it++) {
    const sums = centers.map(() => ({ s: 0, n: 0 }));
    for (const v of vals) {
      let bi = 0;
      for (let c = 1; c < centers.length; c++) if (Math.abs(v - centers[c]) < Math.abs(v - centers[bi])) bi = c;
      sums[bi].s += v;
      sums[bi].n++;
    }
    const nc = sums.map((s, i) => (s.n ? s.s / s.n : centers[i]));
    if (nc.every((c, i) => Math.abs(c - centers[i]) < 1e-6)) break;
    centers = nc;
  }
  return centers;
}

const LEADISH = new Set(['melody', 'double']);

export function assignDynamics(score, blocks) {
  const { voices, ctx } = score;
  const lead = ctx.lead;
  const { mt } = ctx.geo;
  // Velocity je Block
  const medians = blocks.map((b) => {
    const vs = lead.filter((n) => n.start >= b.startBar * mt && n.start < (b.startBar + b.measures) * mt && n.vel !== null && n.vel !== undefined).map((n) => n.vel);
    return vs.length ? median(vs) : null;
  });
  const known = medians.filter((x) => x !== null);
  const centers = kmeans1d(known, 3);
  blocks.forEach((b, i) => {
    let m = medians[i];
    if (m === null) {
      b.dyn = 'mf';
      return;
    }
    // zum Cluster-Zentrum: ähnliche Formteile bekommen dieselbe Stufe
    let c = centers[0];
    for (const x of centers) if (Math.abs(x - m) < Math.abs(c - m)) c = x;
    b.dyn = dynForVelocity(c);
  });
  // Lead nie leiser als mp, damit die Begleitung eine Stufe tiefer noch in der Reihe p..ff bleibt
  blocks.forEach((b) => {
    if (DYN_LEVELS.indexOf(b.dyn) < 1) b.dyn = 'p';
  });
  const blockAt = (t) => {
    const bar = Math.floor(t / mt);
    let r = blocks[0];
    for (const b of blocks) if (b.startBar <= bar) r = b;
    return r;
  };
  // Einwürfe, Gegenmelodien und Mini-Solos („answer“) treten hervor (mindestens mf); die Begleitung
  // tritt währenddessen auf p zurück (zwei Stufen unter dem Einwurf)
  const answers = [];
  for (const v of voices) for (const e of v.events) if (e.role === 'answer') answers.push([e.start, endOf(e)]);
  const answerAt = (t0, t1) => answers.some(([a, z]) => a < t1 && z > t0);
  const MF = dynIndex('mf');
  for (const v of voices) {
    v.dirs = v.dirs.filter((d) => d.kind !== 'dyn');
    let cur = null;
    for (const e of sortEvents(v.events)) {
      const d = blockAt(e.start).dyn;
      const level = dynIndex(d) < MF ? 'mf' : d;
      let want;
      if (e.role === 'answer') want = level;
      else if (LEADISH.has(e.role)) want = d;
      else if (answerAt(e.start, endOf(e))) want = e.role === 'bass' ? dynShift(d, -1) : dynShift(level, -2);
      else want = e.role === 'bass' ? d : dynShift(d, -1);
      if (want !== cur) {
        v.dirs.push({ t: e.start, kind: 'dyn', value: want });
        cur = want;
      }
    }
  }
}

// ---- Schreibweise -------------------------------------------------------------------------------
export function spellVoices(score) {
  const { voices, ctx, chordAt } = score;
  const { mt } = ctx.geo;
  const barOf = (t) => Math.max(0, Math.floor(t / mt));
  for (const v of voices) {
    for (const e of v.events) {
      const key = ctx.keyAt(barOf(e.start));
      const chord = chordAt(e.start);
      e.lofs = e.pitches.map((p) => {
        const pc = mod(p, 12);
        const t = chord && [...chord.tones, ...(chord.tens || [])].find((x) => x.pc === pc);
        return spellPc(pc, key, t ? t.lof : null);
      });
    }
    unifySpelling(v.events, { keyAt: ctx.keyAt, barOf });
  }
}

// ---- Blöcke (Formteile) ----------------------------------------------------------------------
function roleName(events) {
  if (!events.length) return 'rest';
  const count = new Map();
  for (const e of events) count.set(e.role, (count.get(e.role) || 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (top === 'melody' || top === 'double' || top === 'answer') return top === 'answer' ? 'counter' : 'melody';
  if (top === 'stabs') return 'stabs';
  if (top === 'pad') return 'pad';
  if (top === 'counter') return 'counter';
  if (top === 'bass') return 'bass';
  return 'comp';
}

export function buildBlocks(score, sections) {
  const { voices, ctx } = score;
  const { mt } = ctx.geo;
  const M = ctx.M;
  const named = nameSections(sections);
  const blocks = [];
  let letterNo = 0;
  named.forEach((s) => {
    const end = Math.min(M, s.start + s.length);
    // an Tonartwechseln teilen
    const cuts = [s.start, ...ctx.track.map((t) => t.start).filter((b) => b > s.start && b < end), end];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i];
      const z = cuts[i + 1];
      const first = i === 0;
      const roles = voices.map((v) => roleName(v.events.filter((e) => e.start >= a * mt && e.start < z * mt)));
      blocks.push({
        startBar: a,
        measures: z - a,
        key: ctx.keyAt(a),
        name: first ? s.display : `${s.display} (${keyNameDe(ctx.keyAt(a))})`,
        type: first ? 'section' : 'modulation',
        section: s.display,
        label: s.label,
        rehearsal: first ? LETTER(letterNo) : null,
        showChords: true,
        dyn: 'mf',
        segments: [{ startBar: 0, bars: z - a, roles, intensity: 1 }],
      });
      if (first) letterNo++;
    }
  });
  if (!blocks.length) blocks.push({ startBar: 0, measures: M, key: ctx.keyAt(0), name: 'Thema', rehearsal: 'A', showChords: true, dyn: 'mf', segments: [{ startBar: 0, bars: M, roles: voices.map(() => 'melody'), intensity: 1 }] });
  return blocks;
}

// ---- Arrangement zusammensetzen ----------------------------------------------------------------
export function buildArrangement(score, { title, composer = '', N, sections = null } = {}) {
  const { voices, ctx } = score;
  const { geo, material } = ctx;
  const secs = sections || detectSections(ctx);
  const blocks = buildBlocks(score, secs);
  assignDynamics(score, blocks);
  // Dynamik pro Block für Anzeige
  const style = { id: 'engine', name: 'Orchestrierung', feel: 'straight8', heading: null };
  const tempo = Math.round(material.tempo || 100);
  const th = tempoHeading(style, tempo);
  const keyChanges = [];
  let last = null;
  for (const b of blocks) {
    if (!last || last.fifths !== b.key.fifths || last.mode !== b.key.mode) keyChanges.push({ bar: b.startBar, key: b.key });
    last = b.key;
  }
  const chordTrack = score.ctx.chords.map((c) => ({ start: c.start, dur: c.dur, chord: c.chord }));
  const arr = {
    meta: {
      title: title || material.title || 'Ohne Titel',
      composer,
      arranger: 'Arr.: NoteCode',
      subtitle: `Orchestrierung – ${ensembleName(N)}`,
      keyName: keyName(blocks[0].key),
      keyNameDe: keyNameDe(blocks[0].key),
      tempo,
      tempoText: th.text,
      styleHint: th.hint,
      swing: false,
    },
    song: {
      title: title || material.title,
      key: ctx.globalKey,
      meter: material.meter,
      tempo,
      melody: ctx.lead,
      chords: ctx.chords,
      sections: secs,
      measureCount: ctx.M,
      source: 'engine',
    },
    style,
    key: blocks[0].key,
    globalKey: ctx.globalKey,
    meter: material.meter,
    mt: geo.mt,
    beat: geo.beat,
    tempo,
    tempoMap: null,
    totalBars: ctx.M,
    voices: voices.map((v) => ({ inst: v.inst, events: sortEvents(v.events), dirs: v.dirs, label: v.label, role: v.role, group: v.group, profile: v.profile.key })),
    drums: null,
    blocks,
    chordTrack,
    keyAt: (tick) => ctx.keyAt(Math.max(0, Math.floor(tick / geo.mt))),
    keyChanges,
    form: { repeats: [], skip: null, segnoBar: null, toCodaBar: null, dsBar: null, codaBar: null },
    report: { notes: [...(material.report?.notes || []), ...score.report.notes] },
    options: { voices: N },
    engine: { report: score.report, track: ctx.track, behavior: score.behavior || null },
  };
  void chordAtList;
  return arr;
}

// MusicXML 4.0: <transpose> in der Form der Vorgabe (diatonic/chromatic, ohne octave-change)
export function exportScore(arr, opts = {}) {
  const n = arr.voices.length;
  return exportMusicXML(arr, { mode: 'score', concert: false, paper: 'A4', chords: n === 1 ? 'all' : 'solo', transposeForm: 'compound', ...opts });
}
