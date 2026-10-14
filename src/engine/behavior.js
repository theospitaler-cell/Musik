// Führung & Stimmendynamik der Orchestrierung.
//
//   Modus „dynamic“ (Standard): Nebenstimmen sind aktiv.
//     - Lücken (Pausen ab einer Viertel, je nach Aktivität auch kürzer) bekommen Einwürfe, Läufe,
//       Gegenmelodien (Call-and-Response über mehrere Stimmen)
//     - lange Haltetöne der Melodie (> 1,5 Schläge) werden von einer Nebenstimme umspielt
//     - Mini-Solo: für 2–4 Takte übernimmt eine Nebenstimme die thematische Führung und gibt zurück
//     - synkopierte Begleitung (Nachschläge, Offbeat-Achtel) statt Liegeklängen
//     - lebendige Basslinie: folgt der Bassdrum (Groove) bzw. einem Funk-Riff statt Grundton-Liegetönen
//   Modus „classic“: strikte Hierarchie. Die Lead-Stimme hat alle Melodielinien, Fills und Läufe;
//     die Begleitung bleibt harmonisch (Akkordtöne, Liegeklänge, Rhythmus-Stützen).
//
// activity 1–5 skaliert, wie viel die Nebenstimmen tun (1 = dezent, 3 = ausgewogen, 5 = virtuos).
import { mod } from '../core/constants.js';
import { inRange, nearestOctave, fitPitch } from './profiles.js';
import { ladder, ladderIndex, makeEvent, endOf, soundingAt, lastBefore, sortEvents } from './util.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const MODES = ['dynamic', 'classic'];
export const ACTIVITY_NAMES = ['Dezent', 'Ruhig', 'Ausgewogen', 'Lebhaft', 'Virtuos'];

export function behaviorFor({ mode = 'dynamic', activity = 3 } = {}) {
  const a = clamp(Math.round(Number(activity) || 3), 1, 5);
  const dynamic = mode !== 'classic';
  return {
    mode: dynamic ? 'dynamic' : 'classic',
    activity: a,
    dynamic,
    // Lücke der Melodie (in Schlägen), ab der eine Nebenstimme einwirft
    gapBeats: [2, 1.5, 1, 1, 0.5][a - 1],
    // länge der Antwort (Takte) in einer Lücke
    answerBars: [1, 1, 2, 2, 3][a - 1],
    // Haltetöne der Melodie (in Schlägen), unter denen eine Nebenstimme sich bewegt (null = aus)
    sustainBeats: [null, 2.5, 1.5, 1.5, 1][a - 1],
    // Mini-Solo: Takte, in denen eine Nebenstimme führt (0 = aus)
    miniSoloBars: [0, 0, 2, 2, 4][a - 1],
    // Begleitung: 0 = Liegeklänge, 1 = Nachschläge, 2 = Nachschläge im Wechsel, 3 = dazu Betonungen auf 1 und 3
    stabs: [0, 1, 2, 2, 3][a - 1],
    // Bass: 0 = wie die Vorlage, 1 = Bassdrum auf 1 und 3, 2 = ganze Bassdrum-Folge/Funk-Muster, 3 = dazu Antizipation
    bassRiff: [0, 1, 2, 2, 3][a - 1],
  };
}

// ---- Hilfen -------------------------------------------------------------------------------------
// Stimmen, die einwerfen dürfen: Gegen- und Mittelstimmen, nach Lage von oben
export function answerPool(score) {
  const center = (v) => (v.profile.sweet[0] + v.profile.sweet[1]) / 2;
  const list = score.voices.filter((v) => v.role === 'counter' || v.role === 'inner');
  return list.sort((a, b) => center(b) - center(a) || a.index - b.index);
}

// Ereignisse der Stimme im Fenster [a, z) ersetzen
function placeWindow(voice, a, z, fill) {
  const keep = [];
  for (const e of voice.events) {
    if (endOf(e) <= a || e.start >= z) keep.push(e);
    else if (e.start < a && endOf(e) > a) {
      e.dur = a - e.start;
      if (e.dur >= 6) keep.push(e);
    }
  }
  voice.events = sortEvents([...keep, ...fill]);
}

const hasAnswer = (voice, a, z) => voice.events.some((e) => e.role === 'answer' && e.start < z && endOf(e) > a);

// Tonleiter-/Akkordtöne im Bereich der Stimme, höchstens `ceil`
function ladderFor(score, voice, t, ceil) {
  const chord = score.chordAt(t);
  const pcs = [...score.scaleAtTick(t)];
  if (chord) for (const x of chord.tones) if (!pcs.includes(x.pc)) pcs.push(x.pc);
  return ladder(pcs, voice.profile.range[0], Math.min(voice.profile.range[1], ceil));
}

const nearestChordTone = (chord, lad, idx) => {
  if (!chord) return idx;
  const tones = new Set(chord.tones.map((x) => x.pc));
  for (let d = 0; d < lad.length; d++) for (const s of [d, -d]) if (lad[idx + s] !== undefined && tones.has(mod(lad[idx + s], 12))) return idx + s;
  return idx;
};

// Gegenmelodie unter einem Haltetón: Achtel, stufenweise, entgegen der Richtung der Melodie, Schluss
// auf einem Akkordton
function figure(score, voice, a, z, leadPitch, dir) {
  const lad = ladderFor(score, voice, a, leadPitch - 3);
  if (lad.length < 4 || z - a < 12) return [];
  let idx = ladderIndex(lad, nearestOctave(leadPitch - 7, leadPitch - 7, voice.profile));
  idx = clamp(idx, 0, lad.length - 1);
  const pattern = [1, 1, -1, 2, -1, -2, 1, 1];
  const out = [];
  let t = a;
  let k = 0;
  while (t < z && k < 8) {
    const d = Math.min(12, z - t);
    if (d < 6) break;
    if (k > 0) idx = clamp(idx + pattern[(k - 1) % pattern.length] * dir, 0, lad.length - 1);
    out.push(makeEvent(t, d, lad[idx], null, { role: 'answer', figure: true }));
    t += d;
    k++;
  }
  if (out.length) {
    const last = out[out.length - 1];
    const j = nearestChordTone(score.chordAt(last.start), lad, ladderIndex(lad, last.pitches[0]));
    last.pitches[0] = lad[j];
  }
  return out;
}

// ---- Haltetöne der Melodie ------------------------------------------------------------------
export function applySustainCounters(score, b) {
  if (!b.dynamic || !b.sustainBeats) return 0;
  const { ctx, report } = score;
  const { beat } = ctx.geo;
  const pool = answerPool(score);
  if (!pool.length) return 0;
  const line = sortEvents([...score.leadLine]);
  let n = 0;
  let rot = 0;
  line.forEach((e, i) => {
    if (e.dur < b.sustainBeats * beat || i === 0) return;
    // erst nach dem Anschlag (ab dem zweiten Schlag) und vor dem Ende des Tons
    const a = Math.ceil((e.start + beat) / 12) * 12;
    const z = endOf(e) - (e.dur >= 3 * beat ? beat / 2 : 0);
    if (z - a < 12) return;
    // eine Stimme, die dort nicht schon antwortet; im Wechsel
    let v = null;
    for (let k = 0; k < pool.length; k++) {
      const c = pool[(rot + k) % pool.length];
      if (!hasAnswer(c, a, z)) {
        v = c;
        rot = (rot + k + 1) % pool.length;
        break;
      }
    }
    if (!v) return;
    const prev = line[i - 1];
    const dir = prev && e.pitches[0] >= prev.pitches[0] ? -1 : 1; // entgegen der Melodiebewegung
    const fig = figure(score, v, a, z, e.pitches[0], dir);
    if (!fig.length) return;
    placeWindow(v, fig[0].start, endOf(fig[fig.length - 1]), fig);
    report.fills.push({ voice: v.index, t0: fig[0].start, t1: endOf(fig[fig.length - 1]), kind: 'sustain' });
    n++;
  });
  return n;
}

// ---- Mini-Solo --------------------------------------------------------------------------------
// sections: [{start, length}] in Takten (aus der Formanalyse). In jedem passenden Formteil gibt die
// Melodie für 2–4 Takte an eine Nebenstimme ab, die sie Ton für Ton spielt (in ihrer Lage), und übernimmt wieder.
export function applyMiniSolos(score, b, sections) {
  if (!b.dynamic || !b.miniSoloBars) return 0;
  const { ctx, report } = score;
  const { mt } = ctx.geo;
  const pool = answerPool(score);
  if (!pool.length) return 0;
  const leadV = score.voices.find((v) => v.role === 'lead');
  let n = 0;
  // Formteile ab 8 Takten; Ausgewogen: im 1., 3., 5. … von ihnen, Lebhaft/Virtuos: in jedem
  const eligible = sections.filter((s) => s.length >= 8);
  sections.forEach((sec, si) => {
    const ei = eligible.indexOf(sec);
    if (ei < 0 || (b.activity === 3 && ei % 2 === 1)) return;
    const bars = Math.min(b.miniSoloBars, Math.floor(sec.length / 2));
    if (bars < 2) return;
    const s = sec.start + Math.floor((sec.length - bars) / 2);
    if (s < 2 || s + bars > ctx.M - 2) return;
    const a = s * mt;
    const z = (s + bars) * mt;
    const inWin = sortEvents(leadV.events.filter((e) => e.start >= a && e.start < z));
    if (inWin.length < 4) return;
    // keine bereits laufende Antwort überlagern
    const free = pool.filter((v) => !hasAnswer(v, a, z));
    if (!free.length) return;
    const v = free[(n + si) % free.length];
    const solo = [];
    for (const e of inWin) {
      // die Melodie Ton für Ton: gleiche Tonklasse, nur in die Lage der Solo-Stimme versetzt
      const m = nearestOctave(e.pitches[0], e.pitches[0], v.profile);
      if (!inRange(m, v.profile)) continue;
      solo.push(makeEvent(e.start, Math.min(e.dur, z - e.start), m, null, { role: 'answer', solo: true, vel: e.vel }));
    }
    if (solo.length < 3) return;
    // Lead pausiert, andere Einwürfe im Fenster entfallen, die Solo-Stimme führt
    leadV.events = leadV.events.filter((e) => !(e.start >= a && e.start < z));
    for (const e of leadV.events) if (e.start < a && endOf(e) > a) e.dur = a - e.start;
    leadV.events = leadV.events.filter((e) => e.dur > 0);
    for (const o of score.voices) {
      if (o === v || o === leadV) continue;
      o.events = o.events.filter((e) => !(e.role === 'answer' && e.start >= a && e.start < z));
      // Oktav-/Unisono-Doppler gehören zur Melodie: sie pausieren, solange die Solo-Stimme führt
      if (o.role === 'double8' || o.role === 'doubleU') placeWindow(o, a, z, []);
    }
    placeWindow(v, a, z, solo);
    // die ersetzten Einwürfe/Gegenfiguren im Fenster stehen nicht mehr im Bericht
    for (let i = report.fills.length - 1; i >= 0; i--) {
      const f = report.fills[i];
      if (f.kind !== 'solo' && f.t0 >= a && f.t0 < z) report.fills.splice(i, 1);
    }
    report.fills.push({ voice: v.index, t0: a, t1: z, kind: 'solo' });
    n++;
  });
  return n;
}

// ---- Bass --------------------------------------------------------------------------------------
// Lebendige Basslinie: folgt der Bassdrum der Vorlage (sonst bei groovigem Material einem Funk-Muster);
// wo die Vorlage selbst einen bewegten Bass hat (> 2 Anschläge je Takt), bleibt er. Nur 4/4.
const FUNK = {
  1: [0, 48],
  2: [0, 18, 36, 60, 72],
  3: [0, 18, 36, 60, 72, 84],
};
const FIGURE = [0, 12, 0, 7, 12, 0];

export function riffBass(ctx, b, chordAt) {
  if (!b.dynamic || !b.bassRiff) return null;
  const { geo, material, bassNotes } = ctx;
  if (geo.compound || geo.nBeats !== 4 || geo.beat !== 24) return null;
  const kicks = (material.drums || []).filter((d) => d.kind === 'kick');
  const hasKicks = kicks.length >= 8;
  // ohne Bassdrum-Daten nur bei Material mit Groove (mindestens jeder fünfte Einsatz der Melodie
  // zwischen den Schlägen): Choräle und Hymnen behalten ihren ruhigen Bass
  const lead = ctx.lead || [];
  const offbeat = lead.length ? lead.filter((n) => n.start % geo.beat !== 0).length / lead.length : 0;
  if (!hasKicks && offbeat < 0.2) return null;
  const kickBars = new Map();
  for (const d of kicks) {
    const bar = Math.floor(d.start / geo.mt);
    if (!kickBars.has(bar)) kickBars.set(bar, new Set());
    kickBars.get(bar).add(Math.round((d.start - bar * geo.mt) / 6) * 6);
  }
  const srcCount = new Array(ctx.M).fill(0);
  for (const n of bassNotes) {
    const bar = Math.floor(n.start / geo.mt);
    if (bar >= 0 && bar < ctx.M) srcCount[bar]++;
  }
  const out = [];
  let changed = 0;
  for (let bar = 0; bar < ctx.M; bar++) {
    const a0 = bar * geo.mt;
    if (srcCount[bar] > 2) {
      for (const n of bassNotes) if (n.start >= a0 && n.start < a0 + geo.mt) out.push({ start: n.start, dur: n.dur, midi: n.midi });
      continue;
    }
    let ons;
    if (hasKicks) {
      const set = kickBars.get(bar);
      if (!set || !set.size) {
        for (const n of bassNotes) if (n.start >= a0 && n.start < a0 + geo.mt) out.push({ start: n.start, dur: n.dur, midi: n.midi });
        continue;
      }
      ons = [...set].filter((t) => t >= 0 && t < geo.mt).sort((x, y) => x - y);
      if (b.bassRiff === 1) ons = ons.filter((t) => t === 0 || t === 48);
      if (b.bassRiff >= 3 && !ons.includes(84) && ons.length < 5) ons.push(84);
    } else ons = [...FUNK[b.bassRiff]];
    if (!ons.includes(0)) ons.unshift(0);
    ons = [...new Set(ons)].sort((x, y) => x - y);
    ons.forEach((t, k) => {
      const chord = chordAt(a0 + t);
      if (!chord) return;
      const root = 36 + (chord.bassPc ?? chord.rootPc);
      const next = ons[k + 1] ?? geo.mt;
      out.push({ start: a0 + t, dur: Math.min(36, next - t), midi: root + FIGURE[k % FIGURE.length] });
    });
    changed++;
  }
  return changed ? out.sort((x, y) => x.start - y.start) : null;
}

// ---- Begleitung --------------------------------------------------------------------------------
// Nachschläge (4/4): Position in Ticks je Takt für die beiden Stimmgruppen A und B
// [Position, Dauer, Art]: 'stab' = kurzer Einwurf, 'pad' = gehaltener Klang
const STAB_PLAN = {
  1: { A: [[12, 12, 'stab'], [60, 12, 'stab']], B: [[0, 36, 'pad'], [48, 36, 'pad']] }, // Nachschlag über gehaltenen Klängen
  2: { A: [[12, 12, 'stab'], [60, 12, 'stab']], B: [[36, 12, 'stab'], [84, 12, 'stab']] }, // abwechselnd 1+/3+ und 2+/4+
  3: { A: [[12, 12, 'stab'], [36, 12, 'stab'], [60, 12, 'stab'], [84, 12, 'stab']], B: [[0, 12, 'stab'], [48, 12, 'stab']] }, // Offbeat-Achtel, dazu kurze Betonung auf 1 und 3
};

export function stabsPlan(geo, b) {
  if (!b.dynamic || !b.stabs || geo.compound || geo.nBeats !== 4 || geo.beat !== 24) return null;
  const p = STAB_PLAN[b.stabs];
  return { kind: 'stabs', A: p.A.map((x) => [...x]), B: p.B.map((x) => [...x]) };
}

// ---- Klassischer Modus: Gegenstimmen als Akkordtöne ------------------------------------------
// Statt einer Gegenmelodie liegt die Stimme auf Akkordtönen unter der Melodie (je halber Takt)
export function harmonicCounter(score, voice, rank = 0) {
  const { ctx, chordAt } = score;
  const { geo } = ctx;
  const half = geo.half || geo.mt / 2;
  const line = score.leadLine;
  const out = [];
  for (let t = 0; t < ctx.total; t += half) {
    const l = soundingAt(line, t) || lastBefore(line, t);
    const chord = chordAt(t);
    if (!l || !chord || t - endOf(l) > geo.mt) continue;
    const top = l.pitches[0] - 3;
    const cands = [];
    for (let p = voice.profile.range[0]; p <= Math.min(voice.profile.range[1], top); p++) if (chord.tones.some((x) => x.pc === mod(p, 12))) cands.push(p);
    if (!cands.length) continue;
    // von oben: die nächsten Akkordtöne unter der Melodie, die Gegenstimme mit höherem Rang tiefer
    const pick = cands.sort((x, y) => y - x).filter((p, i, arr) => i === 0 || mod(arr[i - 1], 12) !== mod(p, 12))[Math.min(rank, 2)] ?? cands[0];
    const prev = out[out.length - 1];
    if (prev && prev.pitches[0] === pick && endOf(prev) === t) prev.dur += Math.min(half, ctx.total - t);
    else out.push(makeEvent(t, Math.min(half, ctx.total - t), pick, null, { role: 'counter' }));
  }
  return out;
}

// ---- Melodieanteil je Stimme --------------------------------------------------------------------
// shares[i] = Anteil (0–100 %) der Takte, in denen Stimme i die Melodie der Lead-Stimme mitspielt (Index 0 =
// Lead, wird ignoriert). Die Lead-Stimme bleibt unverändert; die Takte kommen in Zweierblöcken (Phrasen) und sind
// gleichmäßig über das Stück verteilt, je Stimme etwas versetzt. Hohe Stimmen und Bässe spielen die Melodie in
// ihrer Oktavlage, mittlere und tiefere Stimmen als Terzparallele unter der Melodie (leitereigen).
export function barsForShare(totalBars, percent, rank = 0, blockBars = null) {
  const pct = clamp(Number(percent) || 0, 0, 100);
  if (pct <= 0 || totalBars <= 0) return [];
  if (pct >= 100) return Array.from({ length: totalBars }, (_, i) => i);
  const block = blockBars || (totalBars >= 4 ? 2 : 1);
  const nBlocks = Math.ceil(totalBars / block);
  // der erste Block bleibt der Hauptstimme (das Thema wird zuerst vorgestellt), solange es mehr Blöcke gibt
  const first = nBlocks >= 3 ? 1 : 0;
  const avail = nBlocks - first;
  const want = Math.min(avail, Math.max(1, Math.round(((totalBars * pct) / 100) / block)));
  const picked = new Set();
  const phase = (rank * 0.37) % 1;
  for (let j = 0; j < want; j++) {
    let b = first + Math.floor(((j + phase) * avail) / want);
    // belegten Block durch den nächsten freien ersetzen
    let guard = 0;
    while (picked.has(b) && guard++ < avail) b = first + ((b - first + 1) % avail);
    picked.add(b);
  }
  const bars = [];
  for (const b of [...picked].sort((x, y) => x - y)) for (let k = 0; k < block; k++) if (b * block + k < totalBars) bars.push(b * block + k);
  return bars;
}

export function applyMelodyShare(score, shares) {
  const { ctx, report } = score;
  const { mt } = ctx.geo;
  const leadV = score.voices.find((v) => v.role === 'lead');
  if (!leadV || !Array.isArray(shares)) return 0;
  const centerOf = (v) => (v.profile.sweet[0] + v.profile.sweet[1]) / 2;
  const leadCenter = centerOf(leadV);
  let touched = 0;
  const others = score.voices.filter((v) => v !== leadV);
  others.forEach((v, rank) => {
    const pct = clamp(Number(shares[v.index]) || 0, 0, 100);
    if (pct <= 0) return;
    const bars = barsForShare(ctx.M, pct, rank);
    if (!bars.length) return;
    const bassy = v.role === 'bass' || v.role === 'bass8vb';
    const harmonize = !bassy && centerOf(v) < leadCenter - 2;
    // zusammenhängende Takte zu Fenstern
    const windows = [];
    for (const b of bars) {
      const last = windows[windows.length - 1];
      if (last && last.z === b) last.z = b + 1;
      else windows.push({ a: b, z: b + 1 });
    }
    let n = 0;
    for (const w of windows) {
      const a = w.a * mt;
      const z = w.z * mt;
      const src = sortEvents(leadV.events.filter((e) => e.start < z && endOf(e) > a));
      const fill = [];
      for (const e of src) {
        const start = Math.max(e.start, a);
        const dur = Math.min(endOf(e), z) - start;
        if (dur <= 0) continue;
        const m = e.pitches[0];
        let p = null;
        if (harmonize) {
          // leitereigene Terz unter der Melodie, in die Lage der Stimme gefaltet
          const lad = ladderFor(score, v, start, 127);
          const pcs = [...score.scaleAtTick(start)];
          const full = ladder(pcs, 24, 108);
          const i = ladderIndex(full, m);
          const third = full[Math.max(0, i - 2)];
          p = nearestOctave(third, m - 4, v.profile);
          if (!inRange(p, v.profile) || lad.length === 0) p = null;
        }
        if (p === null) p = nearestOctave(m, bassy ? v.profile.sweet[0] : m, v.profile);
        if (!inRange(p, v.profile)) p = fitPitch(m, v.profile);
        fill.push(makeEvent(start, dur, p, null, { role: 'double', vel: e.vel }));
      }
      if (!fill.length) continue;
      placeWindow(v, a, z, fill);
      n++;
    }
    if (n) {
      touched++;
      report.melodyShare = report.melodyShare || [];
      report.melodyShare.push({ voice: v.index, bars: bars.length, percent: pct });
    }
  });
  if (touched) report.notes.push(`Melodie in Nebenstimmen: ${report.melodyShare.map((x) => `Stimme ${x.voice + 1} ${x.percent} %`).join(', ')}`);
  return touched;
}

// ---- Solo-Übergabe ------------------------------------------------------------------------------
// soloShares[i] = Anteil (0–100 %) der Takte, in denen Stimme i das Solo spielt: sie bekommt die Melodie der
// Lead-Stimme (Ton für Ton, in ihrer Lage), und die Lead-Stimme spielt währenddessen das, was die Stimme sonst
// gespielt hätte (ihre Begleitung). Die Solos stehen in Blöcken von 2–4 Takten und überschneiden sich nicht;
// andere Doppler pausieren, solange ein Solo läuft.
export function applySoloShare(score, soloShares) {
  const { ctx, report } = score;
  const { mt } = ctx.geo;
  const leadV = score.voices.find((v) => v.role === 'lead');
  if (!leadV || !Array.isArray(soloShares)) return 0;
  const block = ctx.M >= 16 ? 4 : 2;
  const taken = new Set();
  // Takte, in denen schon ein Mini-Solo steht
  for (const f of report.fills) {
    if (f.kind !== 'solo') continue;
    for (let b = Math.floor(f.t0 / mt); b * mt < f.t1; b++) taken.add(b);
  }
  let touched = 0;
  const others = score.voices.filter((v) => v !== leadV);
  others.forEach((v, rank) => {
    const pct = clamp(Number(soloShares[v.index]) || 0, 0, 100);
    if (pct <= 0) return;
    const bars = barsForShare(ctx.M, pct, rank, block).filter((b) => !taken.has(b));
    if (!bars.length) return;
    bars.forEach((b) => taken.add(b));
    const windows = [];
    for (const b of bars) {
      const last = windows[windows.length - 1];
      if (last && last.z === b) last.z = b + 1;
      else windows.push({ a: b, z: b + 1 });
    }
    let n = 0;
    for (const w of windows) {
      const a = w.a * mt;
      const z = w.z * mt;
      const melody = sortEvents(leadV.events.filter((e) => e.start < z && endOf(e) > a));
      if (melody.length < 2) continue;
      const solo = [];
      for (const e of melody) {
        const start = Math.max(e.start, a);
        const dur = Math.min(endOf(e), z) - start;
        if (dur <= 0) continue;
        let m = nearestOctave(e.pitches[0], e.pitches[0], v.profile);
        if (!inRange(m, v.profile)) m = fitPitch(e.pitches[0], v.profile);
        solo.push(makeEvent(start, dur, m, null, { role: 'melody', solo: true, vel: e.vel }));
      }
      // was die Stimme sonst gespielt hätte, geht an die Lead-Stimme (in deren Lage, unterhalb der Melodie-Mitte)
      const prev = sortEvents(v.events.filter((e) => e.start < z && endOf(e) > a));
      const accomp = [];
      const lowAnchor = leadV.profile.sweet[0] + 2;
      for (const e of prev) {
        const start = Math.max(e.start, a);
        const dur = Math.min(endOf(e), z) - start;
        if (dur <= 0) continue;
        let m = nearestOctave(e.pitches[0], lowAnchor, leadV.profile);
        if (!inRange(m, leadV.profile)) m = fitPitch(e.pitches[0], leadV.profile);
        accomp.push(makeEvent(start, dur, m, null, { role: e.role && e.role !== 'melody' ? e.role : 'inner', vel: e.vel }));
      }
      // andere Doppler und Einwürfe pausieren, solange das Solo läuft
      for (const o of score.voices) {
        if (o === v || o === leadV) continue;
        o.events = o.events.filter((e) => !((e.role === 'answer' || e.role === 'double') && e.start >= a && e.start < z));
        for (const e of o.events) if ((e.role === 'answer' || e.role === 'double') && e.start < a && endOf(e) > a) e.dur = a - e.start;
      }
      placeWindow(v, a, z, solo);
      placeWindow(leadV, a, z, accomp);
      report.fills.push({ voice: v.index, t0: a, t1: z, kind: 'solo' });
      n++;
    }
    if (n) {
      touched++;
      report.soloShare = report.soloShare || [];
      report.soloShare.push({ voice: v.index, bars: bars.length, percent: pct });
    }
  });
  if (touched) report.notes.push(`Solo-Übergabe: ${report.soloShare.map((x) => `Stimme ${x.voice + 1} ${x.percent} %`).join(', ')} – die Hauptstimme begleitet währenddessen`);
  return touched;
}
