// Orchestrierung: aus Material (Lead, Bass, Begleitung, Akkorde) eine Partitur für N = 1..15 Stimmen.
//
//   N = 1       Lead Sheet (Melodie + Harmoniesymbole)
//   N = 2–3     Duo/Trio: Lead, Bass, ab 3 kontrapunktische Gegenstimme in Gegenbewegung
//   N = 4       Quartett: Lead, zwei rhythmisch eigenständige Mittelstimmen, Bass
//   N = 5–8     Drop-2-/Drop-2/4-Sätze mit Spannungen auf den Innenstimmen
//   N = 9–15    vier Register-Schichten (Sopran/Melodie, Alt/Tenor, Bariton, Bass)
import { mod } from '../core/constants.js';
import { harmonize } from '../theory/analysis.js';
import { normalizeChords, chordAt as chordAtList, monophonize } from '../model/song.js';
import { scalePcs } from '../theory/keys.js';
import { capLeaps } from '../arrange/voicing.js';
import { bassOctave } from '../arrange/original.js';
import { fitMelodyOctave } from '../arrange/instruments.js';
import { buildChord } from '../theory/chords.js';
import { keyTrack, keyAtBarFactory, estimateKey } from './tonality.js';
import { decodeComping } from './stems.js';
import { ensembleFor, profileInstrument, getProfile, fitPitch, inRange } from './profiles.js';
import { buildSonority, counterLine, fixPerfects, frictions, isFriction } from './voicing.js';
import { makeEvent, meterGeometry, monoClean, soundingAt, lastBefore, endOf, sortEvents } from './util.js';
import { behaviorFor, riffBass, sourceBass, stabsPlan, harmonicCounter } from './behavior.js';

const snap = (x, step = 6) => Math.round(x / step) * step;

// ---- Vorbereitung -------------------------------------------------------------------------------
// Einstimmige Linie bereinigen; Lücken bis zu einem Sechzehntel (Artikulation der Aufnahme, Atem-
// geräusch) werden geschlossen – sie wären im Notenbild nur Sechzehntelpausen
function cleanNotes(list, { closeGap = 6, low = false } = {}) {
  let src = (list || []).filter((n) => n.dur > 0 && n.start >= 0).map((n) => ({ start: n.start, dur: n.dur, midi: n.midi, vel: n.vel ?? null }));
  if (low) {
    // Bass: bei gleichem Einsatz gewinnt der tiefste Ton (monophonize würde den höchsten nehmen)
    const byStart = new Map();
    for (const n of src) if (!byStart.has(n.start) || n.midi < byStart.get(n.start).midi) byStart.set(n.start, n);
    src = [...byStart.values()];
  }
  const mono = monophonize(src);
  for (let i = 0; i + 1 < mono.length; i++) {
    const gap = mono[i + 1].start - (mono[i].start + mono[i].dur);
    if (gap > 0 && gap <= closeGap) mono[i].dur += gap;
  }
  return mono;
}

export function prepare(material, opts = {}) {
  const geo = meterGeometry(material.meter);
  const M = material.measureCount;
  let lead = cleanNotes(material.lead);
  const comp = (material.comp || []).filter((n) => n.dur > 0 && n.start >= 0);
  if (!lead.length && comp.length) {
    // Skyline der Begleitung als Notbehelf
    const byStart = new Map();
    for (const n of comp) if (!byStart.has(n.start) || n.midi > byStart.get(n.start).midi) byStart.set(n.start, n);
    lead = monophonize([...byStart.values()].map((n) => ({ start: n.start, dur: n.dur, midi: n.midi })));
  }
  if (!lead.length) throw new Error('Keine Melodie im Material – Orchestrierung braucht mindestens eine Lead-Linie');
  const bassNotes = cleanNotes(material.bass, { low: true });
  const all = [...lead, ...bassNotes, ...comp];
  const track = keyTrack(all, { measureTicks: geo.mt, measureCount: M });
  const keyAt = keyAtBarFactory(track);
  const finalPc = lead.length ? mod(lead[lead.length - 1].midi, 12) : null;
  const bassFinal = bassNotes.length ? mod(bassNotes[bassNotes.length - 1].midi, 12) : null;
  const globalKey = material.key || estimateKey(all, { finalPc, bassFinalPc: bassFinal }).key;
  const total = M * geo.mt;
  let chords;
  if (material.chords && material.chords.length) chords = normalizeChords(material.chords, total);
  else {
    chords = [];
    for (const seg of track) {
      const a = seg.start * geo.mt;
      const z = seg.end * geo.mt;
      const notes = all.filter((n) => n.start >= a && n.start < z).map((n) => ({ start: n.start - a, dur: Math.min(n.dur, z - n.start), midi: n.midi }));
      const cs = harmonize(notes, { meter: material.meter, key: seg.key, measureCount: seg.end - seg.start });
      for (const c of cs) chords.push({ start: c.start + a, dur: c.dur, chord: c.chord });
    }
    chords = normalizeChords(chords, total);
  }
  // Begleitrhythmus: bevorzugt die echten Akkordanschläge der Vorlage (Audio-Analyse), sonst die Begleitstimmen
  const compRhythm = (material.compRhythm || []).filter((n) => n.dur > 0 && n.start >= 0);
  const decode = decodeComping(compRhythm.length >= 16 ? compRhythm : comp, { measureTicks: geo.mt, measureCount: M });
  decode.fromChords = compRhythm.length >= 16;
  // nur aus echten Akkordanschlägen (Aufnahmen); Begleitstimmen allein sind kein Begleitrhythmus
  if (decode.fromChords) markOstinato(decode.bars, geo.mt);
  // Nachschlag-Begleitung (Two-Beat/Swing: Horn und Posaune auf den „und“, Bass auf den Schlägen – „Puttin'
  // on the Ritz“): ohne festes Muster, aber deutlich mehr Akkordanschläge zwischen den Schlägen als auf ihnen.
  // Gemessen: Ritz 1,41; Lieder mit Anschlägen auf dem Schlag (Rocky, Bond) 0,55–0,69, Viva außerhalb des
  // Ostinatos 1,14
  decode.offbeat = decode.fromChords && !geo.compound && geo.beat % 2 === 0 ? offbeatComp(decode.bars, geo) : false;
  // Intro/Zwischenspiel ohne Gesang: läuft die „Melodie“ dort im Rhythmus des Begleitmusters, ist sie nur
  // dessen Oberstimme (die Tonerkennung nimmt mangels Gesang den obersten Begleitton). Gedruckte Sätze lassen
  // dort das Muster allein spielen – im Intro von „Viva la Vida“ pausieren Trompeten und Melodiestimmen
  const accompLead = decode.fromChords ? accompanimentLeadBars(lead, decode.bars, material.vocal, geo, M) : [];
  const lowLead = decode.fromChords ? lowLeadBars(lead, geo, M).filter((b) => !accompLead.includes(b)) : [];
  if (accompLead.length || lowLead.length) {
    const set = new Set([...accompLead, ...lowLead]);
    const kept = lead.filter((n) => !set.has(Math.floor(n.start / geo.mt)));
    if (kept.length >= 8) lead = kept;
    else {
      accompLead.length = 0;
      lowLead.length = 0;
    }
  }
  return { geo, M, total, lead, bassNotes, comp, compRhythm, track, keyAt, globalKey, chords, decode, material, accompLead, lowLead };
}

// „Melodie“ weit unter ihrer Lage: liegen alle Töne eines Takts mindestens eine Oktave unter der Mitte der
// Melodie des Stücks (nach Dauer gewichtet), ist es die Basslinie oder eine Begleitfigur, die die Erkennung
// mangels Melodie genommen hat (die Tuba allein im Intro von „Puttin' on the Ritz“, eine Oktave höher gehört).
// Nur Strecken ab zwei Takten.
function lowLeadBars(lead, geo, M) {
  if (lead.length < 32) return [];
  const w = lead.map((n) => [n.midi, n.dur]).sort((a, b) => a[0] - b[0]);
  const tot = w.reduce((a, x) => a + x[1], 0);
  let acc = 0;
  let mid = w[0][0];
  for (const [p, d] of w) {
    acc += d;
    if (acc >= tot / 2) {
      mid = p;
      break;
    }
  }
  const maxIn = new Array(M).fill(null);
  for (const n of lead) {
    const b = Math.floor(n.start / geo.mt);
    if (b >= 0 && b < M) maxIn[b] = Math.max(maxIn[b] ?? -Infinity, n.midi);
  }
  const low = maxIn.map((m) => m !== null && m < mid - 12);
  const out = [];
  for (let b = 0; b < M; ) {
    if (!low[b]) {
      b++;
      continue;
    }
    let z = b;
    // Takte ohne Melodie dazwischen gehören zur Strecke
    while (z < M && (low[z] || (maxIn[z] === null && z + 1 < M && low[z + 1]))) z++;
    if (low.slice(b, z).filter(Boolean).length >= 2) for (let k = b; k < z; k++) if (low[k]) out.push(k);
    b = z;
  }
  return out;
}

function offbeatComp(bars, geo) {
  const free = bars.filter((b) => b.hits.length && !b.ostinato);
  if (free.length < 16) return false;
  const rate = (t) => free.filter((b) => b.hits.some((h) => Math.abs(h.t - t) <= 3)).length / free.length;
  const ks = Array.from({ length: geo.nBeats }, (_, k) => k * geo.beat);
  const on = ks.reduce((a, t) => a + rate(t), 0) / ks.length;
  const and = ks.reduce((a, t) => a + rate(t + geo.beat / 2), 0) / ks.length;
  return and >= 0.3 && and >= 1.3 * Math.max(0.05, on);
}

// Takte ohne Gesang, deren „Melodie“ im Begleitmuster mitläuft (≥ 60 % der Einsätze auf den Plätzen des
// Musters). Nur zusammenhängende Strecken mit mindestens zwei solchen Takten; Takte ohne Melodie oder mit
// halber Übereinstimmung dazwischen gehören zur Strecke.
function accompanimentLeadBars(lead, bars, vocal, geo, M) {
  if (!Array.isArray(vocal)) return [];
  const mt = geo.mt;
  const state = new Array(M).fill(0); // 0 = nein, 1 = verträglich, 2 = eindeutig
  for (let b = 0; b < M; b++) {
    const info = bars[b];
    if (!info || !info.ostinato || !info.pattern || (vocal[b] ?? 0) >= 0.1) continue;
    const a0 = b * mt;
    const ns = lead.filter((n) => n.start >= a0 && n.start < a0 + mt);
    if (!ns.length) {
      state[b] = 1;
      continue;
    }
    const on = ns.filter((n) => info.pattern.some((p) => Math.abs(n.start - a0 - p) <= 6)).length / ns.length;
    state[b] = ns.length >= 2 && on >= 0.6 ? 2 : on >= 0.5 ? 1 : 0;
  }
  const out = [];
  for (let b = 0; b < M; ) {
    if (!state[b]) {
      b++;
      continue;
    }
    let z = b;
    while (z < M && state[z]) z++;
    const sure = state.slice(b, z).filter((s) => s === 2).length;
    if (sure >= 2) for (let k = b; k < z; k++) out.push(k);
    b = z;
  }
  return out;
}

// Wiederkehrender Begleitrhythmus (Ostinato): Einzelne Takte einer Aufnahme sind verrauscht – über das ganze
// Stück übereinandergelegt tritt das Muster hervor. Gezählt wird, in wie vielen Takten ein Anschlag auf jedem
// Sechzehntel-Platz liegt; Plätze mit hoher Quote bilden das Muster. Es gilt nur, wenn es sich klar abhebt
// (häufigster Platz in ≥ 50 % der Takte, Quote der Muster-Plätze ≥ 1,8 × der übrigen, höchstens 10 von 16
// Plätzen). Ostinato-Takte sind die, deren eigene Anschläge überwiegend auf dem Muster liegen; kurze Lücken
// dazwischen (bis zwei Takte) laufen mit, damit der Rhythmus nicht abreißt.
// Viele Begleitmuster laufen über zwei Takte (Viva la Vida: „𝄾♪𝄾♪♩♩ | ♩♩♩♪♪“) – übereinandergelegt ergäben
// beide Takte zusammen ein falsches, zu dichtes Muster. Darum wird das Muster zusätzlich getrennt für gerade und
// ungerade Takte bestimmt; sind beide klar und verschieden, gilt das Zwei-Takt-Muster. Welcher Takt welche
// Hälfte spielt, entscheidet ein Viterbi-Lauf (Wechsel A/B bevorzugt, Phasensprung an Formgrenzen möglich).
function patternOf(list, slots, slotOf, minBars = 8) {
  if (list.length < minBars) return null;
  const cnt = new Array(slots).fill(0);
  for (const b of list) for (const k of new Set(b.hits.map(slotOf))) cnt[k]++;
  const rate = cnt.map((c) => c / list.length);
  const top = Math.max(...rate);
  if (top < 0.5) return null;
  const inPat = rate.map((x) => x >= Math.max(0.3, 0.55 * top));
  const nIn = inPat.filter(Boolean).length;
  if (nIn < 3 || nIn > Math.round(slots * 0.625)) return null;
  const mean = (pick) => {
    const v = rate.filter((_, k) => inPat[k] === pick);
    return v.length ? v.reduce((p, c) => p + c, 0) / v.length : 0;
  };
  const contrast = mean(true) / Math.max(0.01, mean(false));
  if (contrast < 1.8) return null;
  const pattern = [];
  inPat.forEach((on, k) => on && pattern.push(k * 6));
  return { inPat, pattern, contrast };
}

const jaccardSets = (a, b) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 1;
};

export function markOstinato(bars, mt = 96) {
  const slots = Math.max(1, Math.round(mt / 6));
  for (const b of bars) {
    b.ostinato = false;
    b.pattern = null;
  }
  const slotOf = (h) => Math.min(slots - 1, Math.round(h.t / 6));
  const active = bars.filter((b) => b.hits.length);
  if (active.length < 8) return null;
  const one = patternOf(active, slots, slotOf);
  const p0 = patternOf(bars.filter((b, i) => b.hits.length && i % 2 === 0), slots, slotOf, 6);
  const p1 = patternOf(bars.filter((b, i) => b.hits.length && i % 2 === 1), slots, slotOf, 6);
  let two = null;
  if (p0 && p1) {
    const s0 = new Set(p0.pattern);
    const s1 = new Set(p1.pattern);
    if (jaccardSets(s0, s1) <= 0.6 && Math.min(p0.contrast, p1.contrast) > (one ? one.contrast : 0)) two = [p0, p1];
  }
  if (!one && !two) return null;
  const cands = two || [one];
  const inAny = (k) => cands.some((p) => p.inPat[k]);
  const fits = bars.map((b) => {
    if (!b.hits.length) return false;
    const ks = [...new Set(b.hits.map(slotOf))];
    // passt, wenn die Anschläge überwiegend auf einem der Muster liegen
    return cands.some((p) => {
      const on = ks.filter((k) => p.inPat[k]).length;
      return on >= 2 && on / ks.length >= 0.5;
    }) || (two && ks.filter(inAny).length / ks.length >= 0.7);
  });
  let pattern = one ? one.pattern : two[0].pattern;
  const which = new Array(bars.length).fill(0);
  if (two) {
    // Viterbi über die Takte: Zustand = Hälfte A/B; Wechsel kostet nichts, Wiederholung 0,8
    const sets = two.map((p) => new Set(p.pattern.map((t) => t / 6)));
    const emit = (b, s) => (b.hits.length ? 1 - jaccardSets(new Set(b.hits.map(slotOf)), sets[s]) : 0);
    let cost = [emit(bars[0], 0), emit(bars[0], 1)];
    const back = [];
    for (let i = 1; i < bars.length; i++) {
      const nc = [0, 0];
      const bk = [0, 0];
      for (let s = 0; s < 2; s++) {
        const fromAlt = cost[1 - s];
        const fromSame = cost[s] + 0.8;
        bk[s] = fromAlt <= fromSame ? 1 - s : s;
        nc[s] = Math.min(fromAlt, fromSame) + emit(bars[i], s);
      }
      back.push(bk);
      cost = nc;
    }
    let s = cost[0] <= cost[1] ? 0 : 1;
    for (let i = bars.length - 1; i >= 0; i--) {
      which[i] = s;
      if (i > 0) s = back[i - 1][s];
    }
  }
  // Lücken bis zwei Takte zwischen passenden Takten schließen
  for (let i = 0; i < bars.length; i++) {
    if (fits[i]) continue;
    let a = i - 1;
    let z = i + 1;
    while (z < bars.length && !fits[z] && z - i < 2) z++;
    if (a >= 0 && fits[a] && z < bars.length && fits[z]) for (let k = i; k < z; k++) fits[k] = 'gap';
  }
  bars.forEach((b, i) => {
    if (!fits[i]) return;
    b.ostinato = true;
    b.pattern = two ? two[which[i]].pattern : pattern;
    if (two) b.patternHalf = which[i];
  });
  return two ? two.map((p) => p.pattern) : pattern;
}

// ---- Linien einpassen ---------------------------------------------------------------------------
const evFromNote = (n, role, extra = {}) => makeEvent(n.start, n.dur, n.midi, null, { role, vel: n.vel ?? null, ...extra });

function stepFold(events, profile) {
  for (const e of events) e.pitches = e.pitches.map((p) => fitPitch(p, profile));
}

// Melodie: Originaloktave, ganze Linie nur bei > 1/3 Ausreißern verschoben; Reste stufenweise
function fitMelody(notes, profile, role = 'melody', { transposeOct = 0 } = {}) {
  const inst = profileInstrument(profile.key);
  const shifted = notes.map((n) => ({ ...n, midi: n.midi + transposeOct }));
  const sh = fitMelodyOctave(shifted.map((n) => ({ midi: n.midi, dur: n.dur })), inst);
  const evs = shifted.map((n) => evFromNote({ ...n, midi: n.midi + sh }, role));
  stepFold(evs, profile);
  return evs;
}

function fitBass(notes, profile, role = 'bass') {
  const inst = profileInstrument(profile.key);
  const sh = bassOctave(notes.map((n) => ({ midi: n.midi, dur: n.dur })), inst);
  const evs = notes.map((n) => evFromNote({ ...n, midi: n.midi + sh }, role, { ...(n.ostinato ? { ostinato: true } : {}), ...(n.srcBass ? { srcBass: true } : {}) }));
  stepFold(evs, profile);
  return evs;
}

// Bass aus Akkorden (Grundton auf 1 und 3, Quinte auf 3 bei Wechsel) – wenn kein Bass-Stem da ist
function bassFromChords(chords, geo, total) {
  const out = [];
  for (const c of chords) {
    const root = 36 + mod(c.chord.rootPc - 36, 12); // E2..D#3
    const fifth = root + 7 <= 52 ? root + 7 : root - 5;
    const len = c.dur;
    let t = c.start;
    let k = 0;
    while (t < c.start + len && t < total) {
      const d = Math.min(geo.beat * 2, c.start + len - t);
      out.push({ start: t, dur: d, midi: k % 2 === 0 ? root : fifth });
      t += d;
      k++;
    }
  }
  return monophonize(out);
}

// ---- Begleit-Muster ----------------------------------------------------------------------------
function padPattern(geo) {
  const { mt, beat, nBeats, compound } = geo;
  if (mt === 96 && beat === 24) return { A: [[0, 48], [48, 48]], B: [[0, 36], [36, 36], [72, 24]] };
  if (nBeats === 3 && beat === 24) return { A: [[0, 48], [48, 24]], B: [[0, 36], [36, 36]] };
  if (nBeats === 2 && beat === 24) return { A: [[0, 24], [24, 24]], B: [[0, 36], [36, 12]] };
  if (compound) return { A: [[0, 36], [36, 36]], B: [[0, 24], [24, mt - 24]] };
  const h = snap(mt / 2, 3);
  const q = snap(mt * 0.375, 3);
  return { A: [[0, h], [h, mt - h]], B: [[0, q], [q, mt - q]] };
}

// Schläge je Takt für die beiden Stimmgruppen (A/B)
function attackPlan(bar, ctx, hasLead, behavior) {
  const { geo } = ctx;
  const info = ctx.decode.bars[bar];
  const rhythmic = info && info.mode === 'rhythmic';
  // (auch in überbrückten Lücken des Musters ohne eigene Anschläge – das Muster läuft durch)
  if (info && info.ostinato && info.pattern) {
    // Wiederkehrendes Begleitmuster der Vorlage (Ostinato, z. B. die Streicher-Akkorde in „Viva la Vida“):
    // genau so übernehmen – alle Begleitstimmen gemeinsam. Das Muster trägt den Wiedererkennungswert;
    // verschoben oder auf zwei Gruppen verteilt wäre es ein anderes Lied. Längen: bis zum nächsten Anschlag,
    // höchstens eine Zählzeit.
    const ts = info.pattern.filter((t) => t < geo.mt);
    const list = ts.map((t, i) => {
      // höchstens bis zum nächsten Anschlag und nie über die Zählzeit hinaus (keine Überbindungen im Muster)
      const toBeat = geo.beat - (t % geo.beat);
      const d = Math.max(6, Math.min(geo.beat, toBeat, (ts[i + 1] ?? geo.mt) - t));
      return [t, d, d <= geo.beat / 2 ? 'stab' : 'pad'];
    });
    return { kind: 'ostinato', A: list, B: list };
  }
  // Nachschlag-Begleitung der Vorlage: kurze Klänge auf jedem „und“, alle Begleitstimmen gemeinsam
  if (ctx.decode.fromChords && ctx.decode.offbeat && info && (hasLead || info.density > 0)) {
    const list = Array.from({ length: geo.nBeats }, (_, k) => [k * geo.beat + geo.beat / 2, geo.beat / 2, 'stab']);
    return { kind: 'stabs', together: true, offbeat: true, A: list, B: list };
  }
  // Aufnahme ohne klares, wiederkehrendes Begleitmuster: die einzelnen Anschläge eines Takts sind zu unsicher,
  // um sie als Rhythmus auszuschreiben – die Begleitstimmen halten lange Töne (ruhig, gut spielbar; die
  // Bewegung kommt von Melodie und Bass). So stehen auch gedruckte Sätze, wenn eine Stimme die Melodie führt.
  if (ctx.decode.fromChords && info && (hasLead || info.density > 0)) {
    const p = padPattern(geo);
    return { kind: 'pad', together: true, A: p.A.map(([t, d]) => [t, d, 'pad']), B: p.A.map(([t, d]) => [t, d, 'pad']) };
  }
  if (rhythmic) {
    // Einsätze der Vorlage (echte Akkordanschläge) bleiben, wo sie sind. Ohne Akkordanschläge (nur
    // Begleitstimmen bekannt) werden Einwürfe auf 2 und 4 zu 2+ und 4+ (Nachschlag)
    const place = (t) => {
      const s = snap(t, 6);
      if (ctx.decode.fromChords) return s;
      return !geo.compound && s !== 0 && s % geo.beat === 0 && (s / geo.beat) % 2 === 1 ? s + geo.beat / 2 : s;
    };
    const ts = [...new Set(info.hits.map((h) => Math.min(geo.mt - 6, place(h.t))))].sort((a, b) => a - b);
    if (ts.length >= 3) {
      const down = ts[0] === 0;
      const rest = down ? ts.slice(1) : ts;
      const A = [];
      const B = [];
      rest.forEach((t, i) => (i % 2 === 0 ? A : B).push(t));
      if (down) {
        A.unshift(0);
        B.unshift(0);
      }
      const mk = (list, kind) => list.map((t, i) => [t, Math.max(6, Math.min(12, (list[i + 1] ?? geo.mt) - t)), kind]);
      return { kind: 'stabs', A: mk(A, 'stab'), B: mk(B, 'stab') };
    }
  }
  if (!hasLead && (!info || info.density === 0)) return null;
  // Dynamisch: Nachschläge/Offbeat-Achtel statt Liegeklänge (klassisch und „Dezent“: Liegeklänge).
  // Wo die Vorlage selbst Klänge hält (Fanfaren, Chöre, Flächen), bleiben die Klänge stehen – mit einem
  // Nachschlag darüber (Stufe 1); die Offbeat-Achtel gehören den rhythmischen Takten der Vorlage.
  const held = info && info.mode === 'sustained';
  // Hält die Vorlage ihre Klänge (Akkordanschläge bekannt, höchstens einer je Takt), bleiben die Begleitstimmen
  // lange Töne – wie in gedruckten Arrangements, wenn eine Stimme die Melodie allein trägt
  if (held && ctx.decode.fromChords) {
    const p = padPattern(geo);
    return { kind: 'pad', together: true, A: p.A.map(([t, d]) => [t, d, 'pad']), B: p.A.map(([t, d]) => [t, d, 'pad']) };
  }
  const sp = stabsPlan(geo, held ? { ...behavior, stabs: Math.min(behavior.stabs, 1) } : behavior);
  if (sp) return sp;
  const p = padPattern(geo);
  return { kind: 'pad', A: p.A.map(([t, d]) => [t, d, 'pad']), B: p.B.map(([t, d]) => [t, d, 'pad']) };
}

// Melodie für die Gegenstimme ausdünnen: Einsätze auf dem Schlag oder ab einer Viertel Länge;
// dazwischen hält die Gegenstimme (längere Werte gegen die bewegte Melodie)
function thinLead(line, geo) {
  const keep = line.filter((e) => e.start % geo.beat === 0 || e.dur >= geo.beat);
  return keep.map((e, i) => {
    const next = keep[i + 1];
    const contiguous = next && next.start - endOf(e) < geo.beat;
    const dur = contiguous ? next.start - e.start : Math.max(e.dur, Math.min(geo.beat, e.dur));
    return { ...e, dur };
  });
}

// ---- Hauptfunktion ------------------------------------------------------------------------------
export function compose(material, N, opts = {}) {
  const ctx = prepare(material, opts);
  const { geo, M, chords } = ctx;
  const layout = ensembleFor(N, opts.instruments || null);
  const voices = layout.map((v, i) => ({
    index: i,
    profile: getProfile(v.profile),
    inst: profileInstrument(v.profile),
    role: v.role,
    group: v.group,
    events: [],
    dirs: [],
    label: `Stimme ${i + 1}`,
  }));
  // Melodieanteil gesteuert (opts.melodyShare): Oktav-/Unisono-Doppler spielen Begleitung wie die Innenstimmen;
  // die Melodie kommt nur in dem gewählten Anteil dazu (applyMelodyShare)
  if (Array.isArray(opts.melodyShare) || Array.isArray(opts.soloShare) || opts.textureAuto) for (const v of voices) if (v.role === 'double8' || v.role === 'doubleU') v.role = 'inner';
  // Aufnahme mit durchgehendem Begleitmuster: die Bariton-Schicht spielt das Muster mit (wie Tenorsax, Bariton
  // und Euphonium in gedruckten Sätzen) statt einer erfundenen Gegenmelodie, die es im Original nicht gibt
  if (opts.textureAuto && N >= 9 && ctx.decode.bars.filter((b) => b.ostinato).length >= 0.4 * M) for (const v of voices) if (v.role === 'counter') v.role = 'inner';
  const chordAt = (t) => chordAtList(chords, t);
  const scaleAtTick = (t) => {
    const k = ctx.keyAt(Math.max(0, Math.floor(t / geo.mt)));
    const s = scalePcs(k);
    if (k.mode === 'minor') s.push(mod(k.tonicPc + 11, 12));
    return s;
  };
  const style = opts.style || 'funk';
  // Führung & Stimmendynamik: dynamisch/polyphon oder klassischer Solo-Lead (Aktivität 1–5)
  const behavior = opts.behavior || behaviorFor({ mode: opts.mode, activity: opts.activity });
  const report = { notes: [], voicings: [], fills: [], breaths: [], repairs: { friction: 0, perfects: 0, leaps: 0 } };
  const barRuns = (list) => {
    const runs = [];
    for (const b of list) {
      const r = runs[runs.length - 1];
      if (r && r[1] === b - 1) r[1] = b;
      else runs.push([b, b]);
    }
    return runs.map(([a, z]) => (a === z ? `Takt ${a + 1}` : `Takte ${a + 1}–${z + 1}`)).join(', ');
  };
  if (ctx.accompLead && ctx.accompLead.length) report.notes.push(`Ohne Gesang (${barRuns(ctx.accompLead)}): die Oberstimme der Begleitung ist keine Melodie – dort spielt das Begleitmuster allein`);
  if (ctx.lowLead && ctx.lowLead.length) report.notes.push(`Keine Melodie in der Vorlage (${barRuns(ctx.lowLead)}): die gehörten Töne liegen eine Oktave und mehr unter der Melodie – Bass oder Begleitung, keine Melodiestimme`);

  // ---- Lead & Doppelungen
  const leadV = voices.find((v) => v.role === 'lead');
  const leadLine = monoClean(fitMelody(ctx.lead, leadV.profile, 'melody'));
  leadV.events = leadLine;
  for (const v of voices) {
    if (v.role === 'double8' || v.role === 'doubleU') {
      const up = v.role === 'double8' ? 12 : 0;
      const evs = leadLine.map((e) => {
        const m = e.pitches[0] + up;
        const p = inRange(m, v.profile) ? m : fitPitch(e.pitches[0], v.profile);
        return makeEvent(e.start, e.dur, p, null, { role: 'double', vel: e.vel });
      });
      v.events = monoClean(evs);
    }
  }

  // ---- Bass
  // lebendige Basslinie (dynamisch): folgt der Bassdrum bzw. einem Funk-Muster, wo die Vorlage nur hält
  // Aufnahmen: Bass als klares Muster mit den Tönen der Bass-Spur (Begleitmuster / Bassdrum / ruhig)
  const srcBass = opts.textureAuto ? sourceBass(ctx, chordAt) : null;
  const riff = srcBass ? null : riffBass(ctx, behavior, chordAt);
  const bassSrc = srcBass ? srcBass.notes : riff || (ctx.bassNotes.length ? ctx.bassNotes : bassFromChords(chords, geo, ctx.total));
  if (srcBass) {
    const k = srcBass.kinds;
    const parts = [];
    if (k.ostinato) parts.push(`im Begleitmuster der Vorlage (${k.ostinato} Takte)`);
    if (k.kick) parts.push(`nach dem Muster der Bassdrum (${k.kick} Takte)`);
    if (k.walk) parts.push(`in Vierteln wie die Bass-Spur (${k.walk} Takte)`);
    if (k.oom) parts.push(`als Wechselbass auf jedem Schlag (${k.oom} Takte)`);
    if (k.held) parts.push(`ruhig in Halben (${k.held} Takte)`);
    report.notes.push(`Bass mit den Tönen der Bass-Spur: ${parts.join(', ')}`);
    if (ctx.decode.offbeat) report.notes.push('Begleitung auf den Nachschlägen (wie in der Vorlage: Akkorde zwischen den Schlägen, Bass auf ihnen)');
  } else if (riff) report.notes.push('Bass: synkopierte Linie nach der Bassdrum bzw. einem Funk-Muster (wo die Vorlage Liegetöne hatte)');
  else if (!ctx.bassNotes.length) report.notes.push('Kein Bass-Stem: Basslinie aus den Akkorden abgeleitet');
  const bassVoices = voices.filter((v) => v.role === 'bass' || v.role === 'bass8vb');
  let foundation = null;
  for (const v of bassVoices) {
    if (v.role === 'bass') {
      v.events = monoClean(fitBass(bassSrc, v.profile, 'bass'));
      if (!foundation) foundation = v;
    }
  }
  if (!foundation && bassVoices.length) {
    foundation = bassVoices[0];
    foundation.events = monoClean(fitBass(bassSrc, foundation.profile, 'bass'));
  }
  for (const v of bassVoices) {
    if (v.role !== 'bass8vb') continue;
    const base = foundation && foundation !== v ? foundation.events : monoClean(fitBass(bassSrc, v.profile, 'bass'));
    v.events = monoClean(
      base.map((e) => {
        const p = e.pitches[0] - 12;
        return makeEvent(e.start, e.dur, inRange(p, v.profile) ? p : fitPitch(e.pitches[0], v.profile), null, { role: 'bass', vel: e.vel });
      })
    );
  }
  const bassRef = foundation ? foundation.events : [];
  const bassAt = (t) => {
    const e = soundingAt(bassRef, t) || lastBefore(bassRef, t);
    return e ? e.pitches[0] : null;
  };

  // ---- Gegenstimmen: Trio (eine, mit der Melodie) und Bariton-Schicht ab 9 Stimmen (rhythmisch
  // ausgedünnt: auf den Schlägen und unter langen Melodietönen, damit sie eigenständig laufen)
  const counterVoices = voices.filter((v) => v.role === 'counter').sort((x, y) => (y.profile.sweet[0] + y.profile.sweet[1]) / 2 - (x.profile.sweet[0] + x.profile.sweet[1]) / 2);
  if (N === 3 || N >= 9) {
    const src = N === 3 ? leadLine : thinLead(leadLine, geo);
    let avoid = null;
    if (!behavior.dynamic) {
      // klassisch: keine Gegenmelodie, die Stimme liegt auf Akkordtönen unter der Melodie
      counterVoices.forEach((cv, k) => {
        cv.events = harmonicCounter({ ctx, chordAt, leadLine }, cv, k);
      });
    } else
    for (const cv of counterVoices) {
      const line = counterLine({ lead: src, chordAt, scalePcs: scaleAtTick, profile: cv.profile, bassAt, avoid });
      const evs = [];
      for (const c of line) {
        const prev = evs[evs.length - 1];
        if (prev && prev.pitches[0] === c.midi && endOf(prev) === c.start) prev.dur += c.dur;
        else evs.push(makeEvent(c.start, c.dur, c.midi, null, { role: 'counter' }));
      }
      cv.events = evs;
      avoid = line.map((x) => x.midi);
    }
  }

  // ---- Innenstimmen (N >= 4): Sonoritäten mit Drop-2 / Drop-2/4
  // Innenstimmen nach Lage (Mitte des Sweet Spots) – die Partitur steht in Familienordnung
  const center = (v) => (v.profile.sweet[0] + v.profile.sweet[1]) / 2;
  const inner = N >= 4 ? voices.filter((v) => v.role === 'inner' || (v.role === 'counter' && N < 9)).sort((a, b) => center(b) - center(a) || a.index - b.index) : [];
  if (inner.length) {
    const innerProfiles = inner.map((v) => v.profile);
    const son = new Map();
    let prev = null;
    const leadPitchAt = (t) => {
      const e = soundingAt(leadLine, t);
      if (e) return e.pitches[0];
      const b = lastBefore(leadLine, t);
      const nx = leadLine.find((x) => x.start >= t);
      if (b && t - endOf(b) <= 2 * geo.mt) return b.pitches[0];
      return nx ? nx.pitches[0] : b ? b.pitches[0] : 67;
    };
    const sonorityAt = (t, key = t, topOverride = null) => {
      if (son.has(key)) return son.get(key);
      const chord = chordAt(t) || buildChord(0, 'major');
      const s = buildSonority({ top: topOverride ?? leadPitchAt(t), chord, voices: innerProfiles, bass: bassAt(t), prev, style });
      if (s) {
        prev = s.pitches;
        report.voicings.push({ t, template: s.template, closed: s.closed, open: s.open, chord: chord.symbol, pitches: s.pitches, roles: s.roles });
      }
      son.set(t, s);
      return s;
    };
    for (let b = 0; b < M; b++) {
      const a0 = b * geo.mt;
      const hasLead = leadLine.some((e) => e.start < a0 + geo.mt && endOf(e) > a0);
      const plan = attackPlan(b, ctx, hasLead, behavior);
      if (!plan) continue;
      const attacks = [];
      plan.A.forEach(([t, d, kind]) => attacks.push({ t: a0 + t, dur: d, kind, grp: 0 }));
      plan.B.forEach(([t, d, kind]) => attacks.push({ t: a0 + t, dur: d, kind, grp: 1 }));
      attacks.sort((x, y) => x.t - y.t);
      // Begleitmuster: ein Klang je Abschnitt (Takthälfte bzw. Akkord), unter der Melodie dieses Abschnitts
      // (nach Dauer gewichteter Median – ein kurzer Ausflug nach unten zieht nicht den ganzen Klang mit) –
      // jede Stimme wiederholt ihren Ton, statt im Muster zwischen Lagen zu springen
      const half = geo.nBeats === 4 && !geo.compound ? geo.mt / 2 : geo.mt;
      const segOf = (t) => {
        const h0 = a0 + (t - a0 >= half ? half : 0);
        const c = chords.find((x) => x.start <= t && t < x.start + x.dur);
        const s0 = Math.max(h0, c ? c.start : h0);
        const s1 = Math.min(h0 + half, c ? c.start + c.dur : h0 + half);
        const w = [];
        for (const e of leadLine) {
          if (e.start >= s1) break;
          if (endOf(e) <= s0) continue;
          w.push([e.pitches[0], Math.min(endOf(e), s1) - Math.max(e.start, s0)]);
        }
        let mid = null;
        if (w.length) {
          w.sort((x, y) => x[0] - y[0]);
          const tot = w.reduce((a, x) => a + x[1], 0);
          let acc = 0;
          for (const [p, d] of w) {
            acc += d;
            if (acc >= tot / 2) {
              mid = p;
              break;
            }
          }
        }
        return { key: `o${s0}`, t: s0, top: mid ?? leadPitchAt(s0) };
      };
      for (const at of attacks) {
        const seg = plan.kind === 'ostinato' ? segOf(at.t) : null;
        const s = seg ? sonorityAt(seg.t, seg.key, seg.top) : sonorityAt(at.t);
        if (!s) continue;
        const top = seg ? seg.top : leadPitchAt(at.t);
        inner.forEach((v, i) => {
          if (i % 2 !== at.grp) return;
          let p = s.pitches[i];
          if (p === null || p === undefined) return; // kein Platz in der Lage dieser Stimme: sie pausiert
          if (p >= top) {
            if (inRange(p - 12, v.profile)) p -= 12;
            else return;
          }
          const dur = Math.min(at.dur, a0 + geo.mt - at.t);
          if (dur <= 0) return;
          const e = makeEvent(at.t, dur, p, null, { role: at.kind === 'stab' ? 'stabs' : 'pad', template: s.template, ...(plan.kind === 'ostinato' ? { ostinato: true } : {}), ...(plan.together ? { shared: true } : {}) });
          if (v.profile.staves > 1) {
            // Klavier: der ganze Satz dieses Moments – rechte Hand die Akkordtöne unter der Melodie,
            // linke Hand der Basston (Doppelsystem, Aufteilung beim Notensatz)
            const ps = new Set(s.pitches.filter((x) => x !== null && x < top && inRange(x, v.profile)));
            const b = bassAt(at.t);
            if (b !== null && inRange(b, v.profile)) ps.add(b);
            if (ps.size) {
              e.pitches = [...ps].sort((x, y) => x - y);
              e.lofs = e.pitches.map(() => null);
            }
          }
          v.events.push(e);
        });
      }
    }
    // gleichzeitige Gruppe: Töne mit Überlappung kürzen
    for (const v of inner) v.events = monoClean(v.events);
  }
  // leadLine: immer die aktuellen Ereignisse der Lead-Stimme (Atem und Satzregeln ersetzen die Liste)
  return {
    ctx,
    voices,
    get leadLine() {
      return leadV.events;
    },
    bassRef,
    chordAt,
    scaleAtTick,
    report,
    N,
    style,
    behavior,
    foundation,
    inner,
  };
}

// ---- Nachbearbeitung der Satzregeln -----------------------------------------------------------
function hasLeaps(v, mt) {
  const evs = sortEvents([...v.events]);
  for (let i = 1; i < evs.length; i++) {
    if (evs[i].start - endOf(evs[i - 1]) >= mt) continue;
    if (Math.abs(evs[i].pitches[0] - evs[i - 1].pitches[evs[i - 1].pitches.length - 1]) > 12) return true;
  }
  return false;
}

export function applySatzRegeln(score) {
  const { voices, ctx, report, chordAt } = score;
  const { geo } = ctx;
  for (let pass = 0; pass < 3; pass++) {
    // 1. spielbare Sprünge (höchstens Oktave; gezielte Oktavsprünge im Bass bleiben)
    for (const v of voices) {
      if (v.events.length < 2) continue;
      report.repairs.leaps += capLeaps(v.events, v.inst, { max: 12, restGap: geo.mt });
      v.events = sortEvents(v.events);
    }
    // 2. verdeckte Quinten/Oktaven zwischen Lead und Bass
    if (score.foundation) {
      report.repairs.perfects += fixPerfects(score.leadLine, score.foundation.events, { chordAt, bassProfile: score.foundation.profile, gap: geo.mt });
      // 8vb folgt der geänderten Basslinie
      for (const v of voices) {
        if (v.role !== 'bass8vb') continue;
        v.events = monoClean(
          score.foundation.events.map((e) => {
            const p = e.pitches[0] - 12;
            return makeEvent(e.start, e.dur, inRange(p, v.profile) ? p : fitPitch(e.pitches[0], v.profile), null, { role: 'bass', vel: e.vel });
          })
        );
      }
    }
    // 3. Sekund-Reibungen unter C3
    report.repairs.friction += repairFrictions(voices, score);
    // 4. verbliebene Sprünge gemeinsam mit den Reibungen lösen
    let again = false;
    for (const v of voices) {
      if (hasLeaps(v, geo.mt)) {
        refineVoice(v, voices, score);
        again = true;
      }
    }
    if (!again) break;
  }
  return score;
}

const PRIORITY = { lead: 5, double8: 4, doubleU: 4, bass: 3, bass8vb: 3, counter: 2, inner: 1 };

// Oktavlage einer Stimme: dynamische Programmierung über {0, ±12, ±24} je Ton. Kosten: Sekund-
// Reibung mit gleichzeitig klingenden Tönen anderer Stimmen, Sprünge > Oktave, Stimme über der
// Melodie, Lage außerhalb des Sweet Spots, jede Versetzung. Löst Reibungen und Sprünge gemeinsam.
export function refineVoice(v, voices, score) {
  const evs = sortEvents(v.events.filter((e) => e.pitches.length === 1));
  if (!evs.length) return 0;
  const OFFS = [0, 12, -12, 24, -24];
  const { mt } = score.ctx.geo;
  const others = voices.filter((o) => o !== v).flatMap((o) => o.events.map((e) => ({ e, role: o.role })));
  others.sort((a, b) => a.e.start - b.e.start);
  const isInner = v.role === 'inner' || v.role === 'counter';
  const INF = 1e9;
  const cost = evs.map(() => new Float64Array(OFFS.length).fill(INF));
  const back = evs.map(() => new Int8Array(OFFS.length).fill(-1));
  const base = evs.map((e) => {
    const clash = others.filter((o) => o.e.start < endOf(e) && endOf(o.e) > e.start);
    const lead = score.leadLine && soundingAt(score.leadLine, e.start);
    return { clash, lead };
  });
  const own = (i, k) => {
    const e = evs[i];
    const p = e.pitches[0] + OFFS[k];
    if (!inRange(p, v.profile)) return INF;
    let c = k === 0 ? 0 : 1.5;
    if (p < v.profile.sweet[0]) c += (v.profile.sweet[0] - p) * 0.15;
    if (p > v.profile.sweet[1]) c += (p - v.profile.sweet[1]) * 0.25;
    for (const o of base[i].clash) for (const q of o.e.pitches) if (isFriction(p, q)) c += 120;
    if (isInner && base[i].lead && p >= base[i].lead.pitches[0]) c += 60;
    return c;
  };
  for (let k = 0; k < OFFS.length; k++) cost[0][k] = own(0, k);
  for (let i = 1; i < evs.length; i++) {
    const free = evs[i].start - endOf(evs[i - 1]) >= mt;
    for (let k = 0; k < OFFS.length; k++) {
      const oc = own(i, k);
      if (oc >= INF) continue;
      const p = evs[i].pitches[0] + OFFS[k];
      for (let j = 0; j < OFFS.length; j++) {
        if (cost[i - 1][j] >= INF) continue;
        const pp = evs[i - 1].pitches[0] + OFFS[j];
        let t = cost[i - 1][j] + oc;
        if (!free) {
          const leap = Math.abs(p - pp);
          // Sprung > Oktave ist teurer als eine Reibung: Reibungen lassen sich notfalls durch Kürzen lösen
          if (leap > 12) t += 200 + 4 * (leap - 12);
          else if (leap > 9) t += 1;
        }
        if (t < cost[i][k]) {
          cost[i][k] = t;
          back[i][k] = j;
        }
      }
    }
  }
  const n = evs.length;
  let s = 0;
  for (let k = 1; k < OFFS.length; k++) if (cost[n - 1][k] < cost[n - 1][s]) s = k;
  if (cost[n - 1][s] >= INF) return 0;
  let moved = 0;
  for (let i = n - 1; i >= 0; i--) {
    const o = OFFS[s];
    if (o) {
      evs[i].pitches = evs[i].pitches.map((p) => p + o);
      moved++;
    }
    s = back[i][s];
    if (s < 0) break;
  }
  return moved;
}

export function repairFrictions(voices, score) {
  let fixed = 0;
  // zuerst gemeinsam je Stimme (schwächste Stimmen zuerst), danach Einzelfälle
  const movable = voices.filter((v) => v.role !== 'lead' && v.role !== 'bass').sort((a, b) => (PRIORITY[a.role] ?? 0) - (PRIORITY[b.role] ?? 0));
  for (let round = 0; round < 3; round++) {
    if (!frictions(voices.map((v) => v.events)).length) break;
    for (const v of movable) fixed += refineVoice(v, voices, score);
  }
  // Einzelfälle: Oktavversetzung gegen ALLE gleichzeitig klingenden Töne prüfen (nicht nur gegen den
  // einen, der die Reibung ausgelöst hat – sonst wechselt der Ton zwischen zwei Oktaven hin und her);
  // bleibt nur eine Reibung mit einem späteren Ton, wird der Ton davor beendet
  for (let pass = 0; pass < 6; pass++) {
    const list = frictions(voices.map((v) => v.events));
    if (!list.length) break;
    let any = false;
    const all = voices.flatMap((v, i) => v.events.map((e) => ({ v: i, e })));
    for (const f of list) {
      const va = voices[f.a];
      const vb = voices[f.b];
      const pa = PRIORITY[va.role] ?? 0;
      const pb = PRIORITY[vb.role] ?? 0;
      // die weniger wichtige Stimme weicht
      const [mv, me, mi] = pa <= pb ? [va, f.ea, f.a] : [vb, f.eb, f.b];
      if (!me.pitches.length || me.dur <= 0) continue;
      const mine = sortEvents(mv.events);
      const at = mine.indexOf(me);
      const nbrs = [mine[at - 1], mine[at + 1]].filter((x) => x && Math.abs(x.start - me.start) < 2 * score.ctx.geo.mt);
      const overlapping = all.filter((o) => o.v !== mi && o.e.start < endOf(me) && endOf(o.e) > me.start);
      let best = null;
      for (const d of [0, 12, -12, 24, -24]) {
        const np = me.pitches.map((p) => p + d);
        if (!np.every((p) => inRange(p, mv.profile))) continue;
        if (nbrs.some((x) => Math.abs(x.pitches[0] - np[0]) > 12)) continue;
        if (mv.role === 'inner' || mv.role === 'counter') {
          const l = score.leadLine && soundingAt(score.leadLine, me.start);
          if (l && Math.max(...np) >= l.pitches[0]) continue;
        }
        // frühester Einsatz eines Tons, der mit np reibt
        let firstClash = Infinity;
        for (const o of overlapping) if (o.e.pitches.some((q) => np.some((p) => isFriction(p, q)))) firstClash = Math.min(firstClash, Math.max(o.e.start, me.start));
        const keep = firstClash === Infinity ? me.dur : firstClash - me.start;
        if (keep < 6) continue;
        const score2 = keep * 10 - Math.abs(d);
        if (!best || score2 > best.score2) best = { np, keep, score2 };
      }
      if (best) {
        me.pitches = best.np;
        me.dur = Math.min(me.dur, best.keep);
      } else me.dur = 0;
      fixed++;
      any = true;
    }
    for (const v of voices) v.events = v.events.filter((e) => e.dur > 0);
    if (!any) break;
  }
  return fixed;
}
