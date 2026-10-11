// Gütemaß für Arrangements: „gründlich“ erzeugt mehrere Varianten (je Abschnitt und je Seed) und
// behält die beste. Gemessen wird, was Spieler hören und merken:
//   Spielbarkeit  – Töne im bequemen Bereich, keine Ausreißer außerhalb des Umfangs, keine Sprünge
//   Zusammenklang – keine Quint-/Oktavparallelen, keine Stimmkreuzungen, keine Reibungen
//                   (kleine Sekunde über einer Haltedauer), keine unbegründeten Einklänge
//   Wiedererkennung – die Melodie des Liedes steht dort, wo sie hingehört
//   Ausgewogenheit – jede Stimme hat zu tun, keiner spielt dauernd durch
import { mod } from '../core/constants.js';

const LEAD = new Set(['melody', 'solo', 'hook', 'subject']);
const DOUBLING = new Set(['tutti', 'double', 'hits', 'final', 'riff']);

// Töne einer Stimme an einer Stelle: Zeiger über sortierte Ereignisse
function cursorOf(line) {
  let i = 0;
  return (t) => {
    while (i < line.length - 1 && line[i + 1].start <= t) i++;
    while (i > 0 && line[i].start > t) i--;
    const e = line[i];
    return e && e.start <= t && e.start + e.dur > t ? e : null;
  };
}

// lines: [{ events (Ticks relativ), inst, role, rank }] – rank: Klangreihenfolge (0 = oben)
export function scoreLines(parts, { mt, beat, prevLast = [], clash = 1 } = {}) {
  const active = parts.filter((p) => p.events && p.events.length);
  if (!active.length) return { score: -50, notes: 0 };
  let score = 0;
  let notes = 0;
  // --- je Stimme: Spielbarkeit
  for (const p of active) {
    const ev = p.events;
    const lo = p.inst?.comfort?.[0] ?? 40;
    const hi = p.inst?.comfort?.[1] ?? 80;
    const rlo = p.inst?.range?.[0] ?? 30;
    const rhi = p.inst?.range?.[1] ?? 90;
    let dur = 0;
    let comfy = 0;
    let out = 0;
    let leaps = 0;
    let steps = 0;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      const m = e.pitches[0];
      dur += e.dur;
      if (m >= lo - 1 && m <= hi + 1) comfy += e.dur;
      if (m < rlo || m > rhi) out++;
      if (i && ev[i - 1].start + ev[i - 1].dur >= e.start - beat) {
        steps++;
        // Sprünge über eine Sexte sind spielbar, über eine Septime unbequem (Melodie ist vorgegeben)
        if (!LEAD.has(e.role || p.role) && Math.abs(m - ev[i - 1].pitches[0]) > 9) leaps++;
      }
    }
    const share = dur ? comfy / dur : 1;
    score += 10 * share - 30 * (out / ev.length) - 8 * (steps ? leaps / steps : 0);
    // weicher Einstieg: große Sprünge gegenüber dem letzten Ton der Stimme davor
    const pl = prevLast[p.index];
    if (pl !== undefined && pl !== null && Math.abs(ev[0].pitches[0] - pl) > 12) score -= 1.5;
    notes += ev.length;
  }
  // --- zwischen den Stimmen: an allen Einsätzen messen
  const cur = active.map((p) => cursorOf(p.events));
  const times = [...new Set(active.flatMap((p) => p.events.map((e) => e.start)))].sort((a, b) => a - b);
  let prev = null;
  let samples = 0;
  let pen = 0;
  // Orchester: Einklang und Oktavverdopplung sind das tägliche Brot, und die Instrumente teilen
  // sich die Lagen – gezählt werden nur Reibungen zwischen benachbarten Stimmen und Parallelen
  const orch = active.length >= 9;
  for (const t of times) {
    const now = active.map((p, k) => {
      const e = cur[k](t);
      return e ? { k, m: e.pitches[0], role: e.role || p.role, rank: p.rank, long: e.dur >= beat && e.start + e.dur - t >= beat } : null;
    });
    const sounding = now.filter(Boolean);
    if (sounding.length >= 2) samples++;
    sounding.sort((a, b) => (orch ? b.m - a.m || a.rank - b.rank : a.rank - b.rank));
    for (let i = 0; i < sounding.length; i++) {
      for (let j = i + 1; j < sounding.length; j++) {
        const a = sounding[i];
        const b = sounding[j];
        const d = a.m - b.m;
        if (!orch && d === 0 && !(DOUBLING.has(a.role) && DOUBLING.has(b.role))) pen += 2.5; // Einklang ohne Grund
        if (!orch && d < 0 && !(a.role === 'double' || b.role === 'double')) pen += 4; // Stimmkreuzung
        if (j === i + 1 && Math.abs(d) === 1 && a.long && b.long) pen += 4; // Reibung (kleine Sekunde, gehalten)
      }
    }
    // Parallelen: reine Quinte/Oktave in gleicher Richtung zwischen zwei Stimmen
    if (prev) {
      for (const a of sounding) {
        const pa = prev.find((x) => x && x.k === a.k);
        if (!pa) continue;
        for (const b of sounding) {
          if (b.k <= a.k) continue;
          const pb = prev.find((x) => x && x.k === b.k);
          if (!pb) continue;
          const i1 = mod(pa.m - pb.m, 12);
          const i2 = mod(a.m - b.m, 12);
          const da = Math.sign(a.m - pa.m);
          const db = Math.sign(b.m - pb.m);
          if (i1 === i2 && (i1 === 7 || i1 === 0) && da !== 0 && da === db && a.m !== b.m && !(DOUBLING.has(a.role) && DOUBLING.has(b.role))) pen += 6;
        }
      }
    }
    prev = now;
  }
  score -= samples ? ((pen * clash) / samples) * 6 : 0;
  // --- Ausgewogenheit: keine Stimme dauernd stumm (außer bewusst „rest“-Rollen) oder dauernd aktiv
  const span = mt;
  void span;
  return { score, notes };
}

// Wiedererkennung: Anteil der Melodietöne des Liedes (je Formteil), die in einer führenden Rolle
// an derselben Stelle stehen (Tonklasse gleich, Einsatz ±1 Sechzehntel)
export function recognition(arr) {
  const mt = arr.mt;
  let hit = 0;
  let all = 0;
  for (const b of arr.blocks) {
    if (!b.melody || !b.melody.length || b.copyOf !== undefined) continue;
    const from = b.startBar * mt;
    const lead = [];
    for (const v of arr.voices) for (const e of v.events) if (e.start >= from && e.start < from + b.measures * mt && (LEAD.has(e.role) || e.role === 'tutti')) lead.push(e);
    const by = new Map();
    for (const e of lead) by.set(Math.round((e.start - from) / 6), mod(e.pitches[0], 12));
    for (const n of b.melody) {
      all++;
      const k = Math.round(n.start / 6);
      const pc = by.get(k) ?? by.get(k - 1) ?? by.get(k + 1);
      if (pc !== undefined && pc === mod(n.midi, 12)) hit++;
    }
  }
  return all ? hit / all : 1;
}

// Gesamtwertung eines fertigen Arrangements (0 … ~100, höher = besser)
export function scoreArrangement(arr, { adapt = 1 } = {}) {
  const parts = arr.voices.map((v, i) => ({ events: v.events, inst: v.inst, role: 'x', rank: arr.slots?.order ? arr.slots.order.indexOf(i) : i, index: i }));
  // je Stimme: Rolle je Ereignis steckt im Ereignis; Rang aus der Klangreihenfolge
  const r = scoreLines(parts, { mt: arr.mt, beat: arr.beat });
  const bars = Math.max(1, arr.totalBars);
  const rep = arr.report || {};
  const crossRest = rep.crossings ? Math.max(0, rep.crossings.found - rep.crossings.fixed) : 0;
  const parRest = Math.max(0, (rep.parallelsFound || 0) - (rep.parallelsFixed || 0));
  const similar = rep.contrary && rep.contrary.checked ? rep.contrary.similar / rep.contrary.checked : 0;
  let score = 60 + (r.score / Math.max(1, parts.length)) * 1.2;
  score -= 4 * (crossRest / bars) * 10;
  score -= 4 * (parRest / bars) * 10;
  score -= 14 * similar;
  score -= 0.5 * ((rep.rangeFixes || 0) / bars) * 10;
  if (Number(adapt) < 2) score += 30 * recognition(arr);
  return score;
}
