// Interpretation der Zeitleiste für Wiedergabe & MIDI:
// Tempoverlauf (rit.), Swing-Achtel, Dynamik/Hairpins, Artikulationen und Effekte.
import { DIV, dynVelocity, clamp } from '../core/constants.js';

// Ticks -> Sekunden entlang der Tempo-Map
export function makeClock(tempoMap, defaultBpm) {
  const map = (tempoMap && tempoMap.length ? tempoMap : [{ t: 0, bpm: defaultBpm }]).slice().sort((a, b) => a.t - b.t);
  const segs = [];
  let sec = 0;
  for (let i = 0; i < map.length; i++) {
    const cur = map[i];
    segs.push({ t: cur.t, sec, spt: 60 / cur.bpm / DIV });
    const next = map[i + 1];
    if (next) sec += (next.t - cur.t) * (60 / cur.bpm / DIV);
  }
  return {
    toSec(t) {
      let s = segs[0];
      for (const x of segs) if (x.t <= t) s = x;
      return s.sec + (t - s.t) * s.spt;
    },
    toTick(sec) {
      let s = segs[0];
      for (const x of segs) if (x.sec <= sec) s = x;
      return s.t + (sec - s.sec) / s.spt;
    },
  };
}

// Swing: Offbeat-Achtel auf die Triolen-Position (2:1) verschieben
function swingTick(t, on) {
  if (!on) return t;
  const r = t % DIV;
  const b = t - r;
  if (r === 12) return b + 16;
  if (r > 0 && r < 12) return b + (r * 16) / 12;
  if (r > 12) return b + 16 + ((r - 12) * 8) / 12;
  return t;
}

function dynamicAt(dirs) {
  const list = dirs.filter((d) => d.kind === 'dyn' || d.kind === 'wedge').sort((a, b) => a.t - b.t);
  return (t) => {
    let level = 'mf';
    let wedge = null;
    for (const d of list) {
      if (d.t > t) break;
      if (d.kind === 'dyn') {
        level = d.value;
        wedge = null;
      } else if (d.type === 'crescendo' || d.type === 'diminuendo') wedge = { type: d.type, t: d.t };
      else if (d.type === 'stop') wedge = null;
    }
    let vel = dynVelocity(level);
    if (wedge) vel += (wedge.type === 'crescendo' ? 1 : -1) * Math.min(20, ((t - wedge.t) / (DIV * 4)) * 8);
    return vel;
  };
}

// Ergebnis: [{part, t(sec), d(sec), midi, vel, fx: {...}}], Dauer gesamt
export function performArrangement(arr, { swing = arr.meta?.swing } = {}) {
  const clock = makeClock(arr.tempoMap, arr.tempo);
  const notes = [];
  const sw = (t) => swingTick(t, swing);
  arr.voices.forEach((v, vi) => {
    const dynAt = dynamicAt(v.dirs);
    const evs = v.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      const next = evs[i + 1];
      const start = sw(e.start);
      let playDur = e.playDur ?? e.dur;
      const legato = e.slurStart || (next && next.start === e.start + e.dur && (e.fx.includes('glissStart') || e.tieFromPrev));
      if (e.art.includes('staccato')) playDur = Math.min(playDur * 0.55, 10);
      else if (e.art.includes('tenuto') || legato) playDur = playDur * 0.98;
      else playDur = Math.max(3, playDur * 0.9);
      if (e.fermata) playDur *= 1.8;
      const end = sw(e.start + playDur);
      const t0 = clock.toSec(start);
      const t1 = clock.toSec(Math.max(start + 2, end));
      let vel = dynAt(e.start);
      if (e.art.includes('accent')) vel += 14;
      if (e.art.includes('marcato')) vel += 20;
      if (e.role && ['comp', 'pad', 'fill', 'background', 'stabs'].includes(e.role)) vel -= 6;
      vel = clamp(Math.round(vel), 20, 127);
      const fx = {};
      if (e.fx.includes('falloff')) fx.fall = -5;
      if (e.fx.includes('doit')) fx.fall = 4;
      if (e.fx.includes('scoop')) fx.scoop = -3;
      if (e.fx.includes('glissStart') && next) fx.glideTo = next.pitches[next.pitches.length - 1];
      if (e.orn?.includes('shake')) fx.shake = 3;
      if (e.orn?.includes('trill')) fx.shake = 2;
      if (e.grace) {
        const gd = Math.min(0.08, (t1 - t0) / 3);
        notes.push({ part: vi, t: t0 - gd, d: gd, midi: e.grace.midi, vel: vel - 10, fx: e.grace.gliss ? { glideTo: e.pitches[e.pitches.length - 1] } : {} });
      }
      for (const m of e.pitches) notes.push({ part: vi, t: t0, d: t1 - t0, midi: m, vel, fx });
    }
  });
  if (arr.drums) {
    for (const e of arr.drums.events) {
      const t0 = clock.toSec(sw(e.start));
      let vel = e.ghost ? 45 : e.art.includes('accent') ? 112 : 88;
      notes.push({ part: 'drums', t: t0, d: 0.12, midi: e.pitches[0], vel, fx: {} });
    }
  }
  notes.sort((a, b) => a.t - b.t);
  const total = clock.toSec(arr.totalBars * arr.mt) + 1.5;
  return { notes, total, clock, barToSec: (bar) => clock.toSec(bar * arr.mt), secToBar: (s) => Math.floor(clock.toTick(s) / arr.mt) };
}
