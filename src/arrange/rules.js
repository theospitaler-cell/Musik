// Profi-Regeln aus dem Vergleich gedruckter Arrangements mit den Original-Aufnahmen:
//  - Lead immer oben: keine Begleitstimme klingt über der Melodie, keine Kreuzung mit dem Bass
//  - Guide-Tones: Terz (und Septime) des Akkords sind in den Mittelstimmen abgedeckt
//  - Pre-Chorus: Vorhalte (4–3, 9–8) in den Liegeklängen
//  - Gesangslinien lesbar: Silbenwiederholungen zusammenfassen statt „Maschinengewehr-Achteln“
import { mod } from '../core/constants.js';
import { chordAt } from '../model/song.js';
import { lofForChordPc } from './context.js';

const LEAD = new Set(['melody', 'solo', 'hook', 'subject']);
const HARMONY = new Set(['comp', 'pad', 'stabs', 'background', 'counter', 'fill']);

const sounding = (events, t) => events.find((e) => e.start <= t && e.start + e.dur > t) || null;
const top = (e) => Math.max(...e.pitches);

function leadVoiceAt(arr, t) {
  for (const v of arr.voices) {
    const e = sounding(v.events, t);
    if (e && LEAD.has(e.role)) return { v, e };
  }
  return null;
}

// Tonhöhe m auf einen Akkordton unterhalb von limit legen (nächstgelegen, im Instrumentenumfang)
function chordToneBelow(chord, m, limit, lo) {
  const pcs = chord.tones.map((x) => x.pc);
  for (let x = Math.min(m, limit - 1); x >= lo; x--) if (pcs.includes(mod(x, 12))) return x;
  return null;
}

// 1) Lead oben & Bass unten: Begleitstimmen, die über der Melodie (oder unter dem Bass) klingen,
//    eine Oktave versetzen bzw. auf den nächsten Akkordton darunter legen
export function keepLeadOnTop(arr, report) {
  report.crossings = report.crossings || { found: 0, fixed: 0 };
  const bv = arr.bassVoice;
  const allowed = arr._crossAllowed || (arr._crossAllowed = new Set());
  arr.voices.forEach((line, vi) => {
    for (const e of line.events) {
      if (LEAD.has(e.role) || e.role === 'double' || e.role === 'final' || e.role === 'tutti') continue;
      const lead = leadVoiceAt(arr, e.start);
      if (!lead || lead.v === line) continue;
      const lm = lead.e.pitches[0];
      if (top(e) <= lm) continue;
      // erlaubte, klanglich motivierte Überschneidungen: Fill/Gegenstimme über einem gehaltenen
      // Melodieton (Antwort in der Lücke) und kurze Durchgangstöne
      // – aber nur gelegentlich: höchstens eine pro Stimme alle 4 Takte
      const answersHeldNote = (e.role === 'fill' || e.role === 'counter') && lead.e.dur >= 2 * arr.beat && e.start > lead.e.start;
      const win = Math.floor(e.start / (4 * arr.mt));
      if ((answersHeldNote || e.dur <= 6) && !allowed.has(`${vi}:${win}`)) {
        allowed.add(`${vi}:${win}`);
        continue;
      }
      report.crossings.found++;
      const inst = line.inst;
      const chord = chordAt(arr.chordTrack, e.start);
      const bass = bv !== undefined && bv !== null && bv !== vi ? sounding(arr.voices[bv].events, e.start) : null;
      const floor = Math.max(inst.range[0], bass ? bass.pitches[0] + 1 : inst.range[0]);
      // Bass: nur Oktavversetzung (Grundton bleibt Grundton)
      if (e.role === 'bass') {
        if (e.pitches.every((p) => p - 12 >= inst.range[0])) {
          e.pitches = e.pitches.map((p) => p - 12);
          report.crossings.fixed++;
        }
        continue;
      }
      // Kandidaten unter der Melodie; bevorzugt in Gegen- oder Seitenbewegung zum Bass
      const idx = line.events.indexOf(e);
      const prevE = idx > 0 ? line.events[idx - 1] : null;
      const bassPrev = bass ? sounding(arr.voices[bv].events, e.start - 1) : null;
      const bassDir = bass && bassPrev && bass !== bassPrev ? Math.sign(bass.pitches[0] - bassPrev.pitches[0]) : 0;
      const pcs = chord.tones.map((x) => x.pc);
      const np = e.pitches.map((p) => {
        if (p <= lm) return p;
        const cands = [];
        if (p - 12 >= floor && p - 12 < lm) cands.push(p - 12);
        for (let x = lm - 1; x >= Math.max(floor, lm - 9); x--) if (pcs.includes(mod(x, 12))) cands.push(x);
        if (!cands.length) return chordToneBelow(chord, p, lm, floor) ?? p;
        const cost = (x) => {
          let c = Math.abs(x - p) * 0.2 + (x === p - 12 ? 0 : 0.5);
          if (prevE && bassDir) {
            const d = Math.sign(x - prevE.pitches[0]);
            if (d && d === bassDir) c += 3; // Parallelbewegung mit dem Bass vermeiden
          }
          return c;
        };
        return cands.sort((a, b) => cost(a) - cost(b))[0];
      });
      if (np.every((p) => p < lm || (p === lm && e.pitches.length === 1))) {
        e.pitches = [...new Set(np)].sort((a, b) => b - a);
        e.lofs = e.pitches.map((p) => lofForChordPc(chord, mod(p, 12), arr.keyAt(e.start)));
        report.crossings.fixed++;
      }
    }
  });
}

// 2) Guide-Tones: an jedem Akkordwechsel müssen Terz (und bei Septakkorden die Septime) in
//    Melodie + Mittelstimmen vorkommen. Fehlt einer, wird eine Mittelstimme, die Grundton oder
//    Quinte verdoppelt, auf den nächstgelegenen Guide-Tone gelegt.
export function ensureGuideTones(arr, report) {
  report.guideTones = report.guideTones || { checked: 0, fixed: 0 };
  const bv = arr.bassVoice;
  for (const c of arr.chordTrack) {
    const t = c.start;
    const chord = c.chord;
    const third = chord.tones.find((x) => x.role === 'third');
    const seventh = chord.tones.find((x) => x.role === 'seventh');
    if (!third) continue;
    const mids = [];
    let leadPc = null;
    arr.voices.forEach((line, vi) => {
      if (vi === bv) return;
      const e = line.events.find((x) => x.start === t) || sounding(line.events, t);
      if (!e) return;
      if (LEAD.has(e.role) || e.role === 'tutti') leadPc = leadPc ?? mod(e.pitches[0], 12);
      else if (HARMONY.has(e.role) && e.start === t && e.dur >= arr.beat / 2) mids.push({ e, line });
    });
    if (mids.length < 2) continue; // nur bei mindestens zwei harmonischen Mittelstimmen (Satz)
    report.guideTones.checked++;
    const have = new Set([...mids.flatMap((m) => m.e.pitches.map((p) => mod(p, 12))), ...(leadPc !== null ? [leadPc] : [])]);
    const need = [third, ...(seventh ? [seventh] : [])].filter((g) => !have.has(g.pc));
    if (!need.length) continue;
    const lead = leadVoiceAt(arr, t);
    for (const g of need) {
      // verdoppelte Grundton/Quinte zuerst ersetzen
      const counts = {};
      for (const m of mids) for (const p of m.e.pitches) counts[mod(p, 12)] = (counts[mod(p, 12)] || 0) + 1;
      const cand = mids
        .filter((m) => m.e.pitches.length === 1)
        .map((m) => {
          const pc = mod(m.e.pitches[0], 12);
          const role = chord.tones.find((x) => x.pc === pc)?.role;
          const expendable = role === 'root' || role === 'fifth' || counts[pc] > 1 || pc === leadPc;
          let best = null;
          for (let x = m.e.pitches[0] - 6; x <= m.e.pitches[0] + 6; x++) {
            if (mod(x, 12) !== g.pc || x < m.line.inst.range[0] || x > m.line.inst.range[1]) continue;
            if (lead && x >= lead.e.pitches[0]) continue;
            if (!best || Math.abs(x - m.e.pitches[0]) < Math.abs(best - m.e.pitches[0])) best = x;
          }
          return { m, best, expendable, dist: best === null ? 99 : Math.abs(best - m.e.pitches[0]) };
        })
        .filter((x) => x.best !== null && x.expendable)
        .sort((a, b) => a.dist - b.dist);
      if (!cand.length) continue;
      const { m, best } = cand[0];
      m.e.pitches = [best];
      m.e.lofs = [g.lof];
      report.guideTones.fixed++;
    }
  }
}

// 3) Vorhalte im Aufbau-Teil (Pre-Chorus): Liegeklang hält den Ton über den Akkordwechsel, wenn er
//    eine Stufe über einem Akkordton des neuen Akkords liegt, und löst dann abwärts auf.
export function addSuspensions(arr, report) {
  report.suspensions = report.suspensions || 0;
  const mt = arr.mt;
  for (const b of arr.blocks) {
    for (const seg of b.segments || []) {
      if (!seg.susp) continue;
      const a0 = (b.startBar + seg.startBar) * mt;
      const a1 = a0 + seg.bars * mt;
      arr.voices.forEach((line) => {
        const evs = line.events;
        for (let i = 1; i < evs.length; i++) {
          const e = evs[i];
          const p = evs[i - 1];
          if (e.role !== 'pad' || p.role !== 'pad' || e.start < a0 || e.start >= a1) continue;
          if (p.start + p.dur !== e.start || e.dur < arr.beat * 2 || e.start % mt !== 0) continue;
          const chord = chordAt(arr.chordTrack, e.start);
          const prevChord = chordAt(arr.chordTrack, p.start);
          if (chord === prevChord) continue;
          const held = p.pitches[0];
          const pcs = chord.tones.map((x) => x.pc);
          if (pcs.includes(mod(held, 12))) continue;
          // Auflösung: Akkordton 1–2 Halbtöne darunter
          const res = [held - 1, held - 2].find((x) => pcs.includes(mod(x, 12)));
          if (res === undefined || res < line.inst.range[0]) continue;
          const lead = leadVoiceAt(arr, e.start);
          if (lead && held >= lead.e.pitches[0]) continue;
          // Vorhalt: erster Schlag gehalten (Haltebogen), dann Auflösung
          const hold = { ...e, pitches: [held], lofs: [p.lofs?.[0] ?? null], dur: arr.beat, tieFromPrev: true, art: [], fx: [] };
          const resolve = { ...e, start: e.start + arr.beat, dur: e.dur - arr.beat, pitches: [res], lofs: [lofForChordPc(chord, mod(res, 12), arr.keyAt(e.start))] };
          p.tieToNext = true;
          evs.splice(i, 1, hold, resolve);
          report.suspensions++;
          i++;
        }
      });
    }
  }
}

// 4) Gesangslinie lesbar machen: Silbenwiederholungen (≥ 3 gleiche kurze Töne hintereinander)
//    paarweise zu längeren Tönen mit Tenuto zusammenfassen. Einsätze auf schweren Zeiten bleiben.
//    lv: Schwierigkeit (Profi behält Achtel-Wiederholungen, fasst nur 16tel zusammen)
export function reduceSyllableRepeats(events, lv, beat) {
  const maxShort = lv && lv >= 5 ? 6 : 12; // Profi: nur 16tel, sonst bis Achtel
  const out = [];
  const src = [...events].sort((a, b) => a.start - b.start);
  let i = 0;
  let merged = 0;
  while (i < src.length) {
    const e = src[i];
    let j = i;
    while (
      j + 1 < src.length &&
      src[j + 1].pitches.length === 1 &&
      e.pitches.length === 1 &&
      src[j + 1].pitches[0] === e.pitches[0] &&
      src[j + 1].start === src[j].start + src[j].dur &&
      src[j].dur <= maxShort &&
      src[j + 1].dur <= maxShort
    )
      j++;
    const run = src.slice(i, j + 1);
    if (run.length >= 3) {
      // Paare (auf geraden Positionen) zusammenfassen, letzten Ton (Phrasenende) behalten
      for (let k = 0; k < run.length; k++) {
        const a = run[k];
        const b = run[k + 1];
        const onBeatHalf = a.start % (beat / 2) === 0;
        if (b && k + 1 < run.length - 1 && onBeatHalf && a.dur === b.dur) {
          const x = { ...a, dur: a.dur + b.dur, art: [...new Set([...(a.art || []).filter((r) => r !== 'staccato'), 'tenuto'])] };
          out.push(x);
          merged++;
          k++;
        } else out.push(a);
      }
    } else out.push(...run);
    i = j + 1;
  }
  return { events: out, merged };
}
