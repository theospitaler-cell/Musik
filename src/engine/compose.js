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
import { behaviorFor, riffBass, stabsPlan, harmonicCounter } from './behavior.js';

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
  const decode = decodeComping(comp, { measureTicks: geo.mt, measureCount: M });
  return { geo, M, total, lead, bassNotes, comp, track, keyAt, globalKey, chords, decode, material };
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
  const evs = notes.map((n) => evFromNote({ ...n, midi: n.midi + sh }, role));
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
  if (rhythmic) {
    // Einwürfe auf 2 und 4 werden zu 2+ und 4+ (Nachschlag); Zählzeit 1 und 3 bleiben, der Rest
    // liegt ohnehin synkopiert
    const place = (t) => {
      const s = snap(t, 6);
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
  const riff = riffBass(ctx, behavior, chordAt);
  const bassSrc = riff || (ctx.bassNotes.length ? ctx.bassNotes : bassFromChords(chords, geo, ctx.total));
  if (riff) report.notes.push('Bass: synkopierte Linie nach der Bassdrum bzw. einem Funk-Muster (wo die Vorlage Liegetöne hatte)');
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
    const sonorityAt = (t) => {
      if (son.has(t)) return son.get(t);
      const chord = chordAt(t) || buildChord(0, 'major');
      const s = buildSonority({ top: leadPitchAt(t), chord, voices: innerProfiles, bass: bassAt(t), prev, style });
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
      for (const at of attacks) {
        const s = sonorityAt(at.t);
        if (!s) continue;
        const top = leadPitchAt(at.t);
        inner.forEach((v, i) => {
          if (i % 2 !== at.grp) return;
          let p = s.pitches[i];
          if (p >= top) {
            if (inRange(p - 12, v.profile)) p -= 12;
            else return;
          }
          const dur = Math.min(at.dur, a0 + geo.mt - at.t);
          if (dur <= 0) return;
          const e = makeEvent(at.t, dur, p, null, { role: at.kind === 'stab' ? 'stabs' : 'pad', template: s.template });
          if (v.profile.staves > 1) {
            // Klavier: der ganze Satz dieses Moments – rechte Hand die Akkordtöne unter der Melodie,
            // linke Hand der Basston (Doppelsystem, Aufteilung beim Notensatz)
            const ps = new Set(s.pitches.filter((x) => x < top && inRange(x, v.profile)));
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
