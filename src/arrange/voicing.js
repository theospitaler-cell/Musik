// Stimmführung gegen den Bass: Gegenbewegung (motus contrarius) der Mittelstimmen.
// Fällt der Bass, steigen die Mittelstimmen – und umgekehrt; Seitenbewegung (liegender
// gemeinsamer Ton) ist erlaubt, Parallelbewegung mit dem Bass wird korrigiert.
import { mod } from '../core/constants.js';
import { chordAt } from '../model/song.js';
import { lofForChordPc } from './context.js';

export const MIDDLE_ROLES = new Set(['counter', 'fill', 'comp', 'pad', 'background', 'stabs']);

const sounding = (events, t) => {
  for (const e of events) if (e.start <= t && e.start + e.dur > t) return e;
  return null;
};

function blockRoles(arr) {
  // pro Takt: Rollen der Stimmen (aus den Segmenten)
  const out = [];
  for (const b of arr.blocks) {
    for (const seg of b.segments) {
      for (let k = 0; k < seg.bars * (seg.repeatTimes || 1); k++) out[b.startBar + seg.startBar + k] = seg.roles;
    }
  }
  return out;
}

// Bewegungen des Basses: [{t, prevT, dir}] (Anschlag mit Tonhöhenwechsel)
function bassMoves(events) {
  const out = [];
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1];
    const b = events[i];
    const d = b.pitches[0] - a.pitches[0];
    if (d !== 0 && b.start - (a.start + a.dur) <= 12) out.push({ t: b.start, prevT: a.start, dir: Math.sign(d) });
  }
  return out;
}

// Statistik: wie bewegen sich Mittelstimmen, wenn der Bass sich bewegt?
export function motionStats(arr) {
  const roles = blockRoles(arr);
  const mt = arr.mt;
  const st = { contrary: 0, oblique: 0, similar: 0 };
  const bassIdx = (bar) => (roles[bar] || []).indexOf('bass');
  arr.voices.forEach((v, vi) => {
    for (const mv of collectMoves(arr, roles, bassIdx)) {
      const r = (roles[Math.floor(mv.t / mt)] || [])[vi];
      if (!MIDDLE_ROLES.has(r)) continue;
      const before = sounding(v.events, mv.t - 1);
      const now = v.events.find((e) => e.start >= mv.t && e.start < mv.t + arr.beat / 2) || sounding(v.events, mv.t);
      if (!before || !now || now === before) continue;
      const d = now.pitches[0] - before.pitches[0];
      if (d === 0) st.oblique++;
      else if (Math.sign(d) === mv.dir) st.similar++;
      else st.contrary++;
    }
  });
  return st;
}

function collectMoves(arr, roles, bassIdx) {
  const mt = arr.mt;
  const out = [];
  arr.voices.forEach((v, vi) => {
    const evs = v.events.filter((e) => bassIdx(Math.floor(e.start / mt)) === vi);
    for (const m of bassMoves(evs)) if (bassIdx(Math.floor(m.prevT / mt)) === vi) out.push(m);
  });
  return out.sort((a, b) => a.t - b.t);
}

// Korrektur: Mittelstimmen, die mit dem Bass in dieselbe Richtung gehen, auf einen
// Akkordton in Gegenrichtung (oder liegenbleibenden gemeinsamen Ton) umlegen.
export function enforceContraryMotion(arr, report) {
  const roles = blockRoles(arr);
  const mt = arr.mt;
  const beat = arr.beat;
  const bassIdx = (bar) => (roles[Math.floor(bar)] || []).indexOf('bass');
  const moves = collectMoves(arr, roles, bassIdx);
  const leadIdx = (bar) => (roles[bar] || []).findIndex((r) => r === 'melody' || r === 'solo' || r === 'hook');
  report.contrary = report.contrary || { checked: 0, similar: 0, fixed: 0 };
  for (const mv of moves) {
    const bar = Math.floor(mv.t / mt);
    const rs = roles[bar] || [];
    const bi = rs.indexOf('bass');
    const bassNow = sounding(arr.voices[bi].events, mv.t);
    const bassPrev = sounding(arr.voices[bi].events, mv.t - 1);
    const li = leadIdx(bar);
    const melNow = li >= 0 ? sounding(arr.voices[li].events, mv.t) : null;
    arr.voices.forEach((v, vi) => {
      if (!MIDDLE_ROLES.has(rs[vi])) return;
      const evs = v.events;
      const idx = evs.findIndex((e) => e.start >= mv.t && e.start < mv.t + beat / 2);
      if (idx <= 0) return;
      const e = evs[idx];
      const p = evs[idx - 1];
      if (p.start + p.dur < mv.t - beat) return; // nach einer Pause: neuer Einsatz, keine Fortschreitung
      // schnelle Figuren (Läufe) werden beim Erzeugen gegen den Bass gerichtet
      if (e.dur < beat / 2 && p.dur < beat / 2) return;
      report.contrary.checked++;
      const d = e.pitches[0] - p.pitches[0];
      if (d === 0 || Math.sign(d) !== mv.dir) return;
      report.contrary.similar++;
      const chord = chordAt(arr.chordTrack, e.start);
      const pcs = chord.tones.map((t) => t.pc);
      const inst = v.inst;
      const lo = Math.max(inst.range[0], bassNow ? bassNow.pitches[0] + 3 : inst.range[0]);
      let hi = inst.range[1];
      if (melNow) hi = Math.min(hi, melNow.pitches[0] - 1); // nie über die Melodie (Lead immer oben)
      const others = arr.voices.filter((_, k) => k !== vi && k !== bi).map((o) => sounding(o.events, e.start)).filter(Boolean).map((o) => o.pitches[0]);
      const cands = [];
      for (let m = p.pitches[0] - 7; m <= p.pitches[0] + 7; m++) {
        if (m < lo || m > hi || !pcs.includes(mod(m, 12))) continue;
        const dm = m - p.pitches[0];
        const contrary = dm !== 0 && Math.sign(dm) === -mv.dir;
        const oblique = dm === 0;
        if (!contrary && !oblique) continue;
        if (melNow && (Math.abs(m - melNow.pitches[0]) % 12 === 1 || Math.abs(m - melNow.pitches[0]) % 12 === 11 || m === melNow.pitches[0])) continue;
        if (others.includes(m)) continue;
        // keine Quint-/Oktavparallelen zum Bass
        if (bassNow && bassPrev) {
          const i1 = mod(p.pitches[0] - bassPrev.pitches[0], 12);
          const i2 = mod(m - bassNow.pitches[0], 12);
          if ((i2 === 0 || i2 === 7) && i1 === i2) continue;
        }
        const cost = Math.abs(dm) + (oblique ? 2.5 : 0) + (Math.abs(m - e.pitches[0]) > 9 ? 3 : 0);
        cands.push({ m, cost });
      }
      if (!cands.length) return;
      cands.sort((a, b) => a.cost - b.cost);
      const m = cands[0].m;
      e.pitches = [m, ...e.pitches.slice(1).filter((x) => x !== m)];
      e.lofs = [lofForChordPc(chord, mod(m, 12), arr.keyAt(e.start)), ...(e.lofs || []).slice(1)];
      // gebundene Fortsetzung (gleiche Tonhöhe, Haltebogen) mitziehen
      for (let k = idx + 1; k < evs.length && evs[k].tieFromPrev && evs[k].start === evs[k - 1].start + evs[k - 1].dur; k++) {
        evs[k].pitches = [m];
        evs[k].lofs = [e.lofs[0]];
      }
      report.contrary.fixed++;
    });
  }
}

// Hilfe für die Generatoren: Richtung des Basses zwischen zwei Zeitpunkten (-1/0/1)
export function bassDirection(bassLine, t0, t1) {
  if (!bassLine || !bassLine.length) return 0;
  const a = sounding(bassLine, t0);
  const b = sounding(bassLine, t1) || bassLine.find((e) => e.start >= t1 && e.start < t1 + 12);
  if (!a || !b) return 0;
  return Math.sign(b.pitches[0] - a.pitches[0]);
}
