// Textur der Vorlage übernehmen: Wie wird die Melodie im Original gespielt?
//
//   solo        eine Stimme trägt die Melodie, der Rest begleitet (Liegeklänge, Rhythmus, Pausen)
//   doubled     die Melodie liegt im Original mehrfach (Unisono/Oktave, z. B. Bläser- oder Streicher-Tutti)
//   harmonized  die Melodie ist mehrstimmig gesetzt (Satz im Rhythmus der Melodie, z. B. Bläsersatz, Chor)
//   tutti       beides
//
// Erkannt wird das an den Begleitnoten der Vorlage, die zusammen mit den Melodietönen einsetzen. Die
// Orchestrierung verteilt dann die Melodie bzw. den Satz der Vorlage auf mehrere Instrumente, statt alles in
// eine Stimme zu zwingen und den Rest neu zu erfinden – und lässt in Solo-Stellen die anderen begleiten.
import { mod } from '../core/constants.js';
import { inRange, nearestOctave, fitPitch } from './profiles.js';
import { makeEvent, endOf, sortEvents } from './util.js';

const KINDS = ['solo', 'doubled', 'harmonized', 'tutti'];

// lead: [{start, dur, midi}] (einstimmig), comp: [{start, dur, midi}], geo: Zeitraster, M: Takte
// -> { bars: [{ bar, kind, n, doubled, harmonized }], at: Map(start -> { pcs: [..], midis: [..], doubled }) }
// refrainBars: Takte des Refrains – dort trägt ab 5 Stimmen eine zweite Stimme die Melodie mit (wie in
// gedruckten Arrangements: Strophe solo, Refrain verdoppelt), auch wenn das Original sie nicht verdoppelt
export function sourceTexture({ lead, comp, geo, M, cluster = 3, refrainBars = null, voices = 0 }) {
  const byStart = [...(comp || [])].filter((n) => n.dur > 0).sort((a, b) => a.start - b.start);
  const at = new Map();
  const per = Array.from({ length: M }, (_, b) => ({ bar: b, n: 0, doubled: 0, harmonized: 0 }));
  let j = 0;
  for (const m of lead) {
    while (j < byStart.length && byStart[j].start < m.start - cluster) j++;
    const same = [];
    for (let k = j; k < byStart.length && byStart[k].start <= m.start + cluster; k++) same.push(byStart[k]);
    const doubled = same.some((n) => mod(n.midi, 12) === mod(m.midi, 12));
    const under = same.filter((n) => n.midi < m.midi - 1 && mod(n.midi, 12) !== mod(m.midi, 12));
    const pcsUnder = [...new Set(under.map((n) => mod(n.midi, 12)))];
    const b = Math.floor(m.start / geo.mt);
    if (b < 0 || b >= M) continue;
    per[b].n++;
    if (doubled) per[b].doubled++;
    // „mehrstimmig gesetzt“: mindestens zwei weitere Töne gleichzeitig, oder einer bei sehr kurzen Werten
    if (pcsUnder.length >= 2 || (pcsUnder.length === 1 && m.dur <= geo.beat)) per[b].harmonized++;
    at.set(m.start, { pcs: pcsUnder, midis: under.map((n) => n.midi).sort((x, y) => y - x), doubled });
  }
  // Takt-Art, dann über Phrasen (je 2 Takte Nachbarschaft) glätten – einzelne Ausreißer kippen nichts
  const raw = per.map((p) => {
    if (p.n < 2) return null;
    const d = p.doubled / p.n >= 0.5;
    const h = p.harmonized / p.n >= 0.5;
    return d && h ? 'tutti' : h ? 'harmonized' : d ? 'doubled' : 'solo';
  });
  const bars = per.map((p, b) => {
    const votes = new Map();
    for (let k = b - 2; k <= b + 2; k++) {
      const v = raw[k];
      if (!v) continue;
      votes.set(v, (votes.get(v) || 0) + (k === b ? 2 : 1));
    }
    let kind = 'solo';
    let best = 0;
    for (const kd of KINDS) if ((votes.get(kd) || 0) > best) [kind, best] = [kd, votes.get(kd)];
    // ohne eigene Melodietöne bleibt der Takt „solo“ (nichts zu verdoppeln)
    if (!p.n) kind = 'solo';
    let refrain = false;
    if (kind === 'solo' && p.n && refrainBars && refrainBars.has(b) && voices >= 5) {
      kind = 'doubled';
      refrain = true;
    }
    return { ...p, kind, refrain };
  });
  return { bars, at };
}

// Anzahl Stimmen, die eine verdoppelte Melodie mittragen (ohne Lead): mit der Größe der Besetzung
export const doublersFor = (N) => (N <= 3 ? 1 : N <= 6 ? 1 : N <= 9 ? 2 : 3);

const center = (v) => (v.profile.sweet[0] + v.profile.sweet[1]) / 2;

// Verdopplung: Unisono, wenn die Lage passt, sonst Oktave darunter (Tenor-Instrumente), sonst nächste Oktave
function doublePitch(m, v) {
  if (inRange(m, v.profile) && Math.abs(center(v) - m) <= 9) return m;
  if (inRange(m - 12, v.profile)) return m - 12;
  if (inRange(m + 12, v.profile) && center(v) > m + 4) return m + 12;
  return inRange(m, v.profile) ? m : nearestOctave(m, center(v), v.profile);
}

// Satz unter der Melodie aus den Tönen der Vorlage: von oben nach unten je Stimme der nächste tiefere Ton
// der Vorlage (Tonklassen), in die Lage der Stimme gelegt; fehlen Töne, kommen Akkordtöne dazu
function soliPitches(m, pcs, chordPcs, voices) {
  const pool = pcs.length ? pcs : chordPcs.filter((p) => p !== mod(m, 12));
  const out = [];
  let ceil = m;
  const used = new Set();
  for (const v of voices) {
    let pick = null;
    for (let p = ceil - 1; p >= ceil - 12; p--) {
      const pc = mod(p, 12);
      if (!pool.includes(pc)) continue;
      if (used.has(pc) && used.size < pool.length) continue;
      pick = p;
      break;
    }
    if (pick === null) {
      out.push(null);
      continue;
    }
    if (!inRange(pick, v.profile)) {
      const alt = nearestOctave(pick, Math.min(ceil - 1, center(v)), v.profile);
      pick = inRange(alt, v.profile) ? alt : null;
    }
    out.push(pick);
    if (pick !== null) {
      used.add(mod(pick, 12));
      ceil = Math.min(ceil, pick);
    }
  }
  return out;
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

// score: aus compose(); texture: sourceTexture(); opts.doubling/opts.soli (false = aus)
// Rückgabe: { doubled: Takte, soli: Takte }
export function applySourceTexture(score, texture, { doubling = true, soli = true } = {}) {
  const { ctx, report } = score;
  const { mt } = ctx.geo;
  const leadV = score.voices.find((v) => v.role === 'lead');
  if (!leadV || !texture) return { doubled: 0, soli: 0 };
  const isBass = (v) => v.role === 'bass' || v.role === 'bass8vb';
  const others = score.voices.filter((v) => v !== leadV && !isBass(v)).sort((a, b) => center(b) - center(a));
  if (!others.length) return { doubled: 0, soli: 0 };
  const N = score.voices.length;
  const nDouble = Math.min(others.length, doublersFor(N));
  // Doppler: Stimmen, deren Lage am nächsten an der Melodie liegt (Unisono), dann die Tenorlage (Oktave)
  const leadCenter = center(leadV);
  const byFit = [...others].sort((a, b) => Math.abs(center(a) - leadCenter) - Math.abs(center(b) - leadCenter));
  const doublers = [];
  if (nDouble >= 1) doublers.push(byFit[0]);
  // die zweite Verdopplung eine Oktave tiefer: die Stimme, die am nächsten an Melodie − 12 liegt
  const lowFit = [...others].filter((v) => !doublers.includes(v)).sort((a, b) => Math.abs(center(a) - (leadCenter - 12)) - Math.abs(center(b) - (leadCenter - 12)));
  for (const v of lowFit) if (doublers.length < nDouble) doublers.push(v);
  const out = { doubled: 0, soli: 0 };
  // Fenster gleicher Art zusammenfassen
  const runs = [];
  for (const b of texture.bars) {
    const last = runs[runs.length - 1];
    if (last && last.kind === b.kind && last.z === b.bar) last.z = b.bar + 1;
    else runs.push({ kind: b.kind, a: b.bar, z: b.bar + 1 });
  }
  for (const r of runs) {
    if (r.kind === 'solo') continue;
    const a = r.a * mt;
    const z = r.z * mt;
    const melody = sortEvents(leadV.events.filter((e) => e.start >= a && e.start < z && e.pitches && e.pitches.length));
    if (melody.length < 2) continue;
    const wantDouble = doubling && (r.kind === 'doubled' || r.kind === 'tutti');
    const wantSoli = soli && (r.kind === 'harmonized' || r.kind === 'tutti');
    const dbl = wantDouble ? (r.kind === 'tutti' ? doublers.slice(0, Math.max(1, nDouble - 1)) : doublers) : [];
    const soliVoices = wantSoli ? others.filter((v) => !dbl.includes(v)) : [];
    for (const v of dbl) {
      const fill = melody.map((e) => makeEvent(e.start, Math.min(e.dur, z - e.start), doublePitch(e.pitches[0], v), null, { role: 'double', vel: e.vel }));
      placeWindow(v, a, z, fill.filter((e) => e.dur > 0));
    }
    if (dbl.length) out.doubled += r.z - r.a;
    if (soliVoices.length) {
      const fills = soliVoices.map(() => []);
      for (const e of melody) {
        const src = texture.at.get(e.start) || texture.at.get(e.start - 1) || texture.at.get(e.start + 1);
        const chord = score.chordAt(e.start);
        const chordPcs = chord ? chord.tones.map((t) => t.pc) : [];
        const ps = soliPitches(e.pitches[0], src ? src.pcs : [], chordPcs, soliVoices);
        ps.forEach((p, i) => {
          if (p === null || p === undefined) return;
          fills[i].push(makeEvent(e.start, Math.min(e.dur, z - e.start), fitPitch(p, soliVoices[i].profile), null, { role: 'soli', vel: e.vel }));
        });
      }
      soliVoices.forEach((v, i) => placeWindow(v, a, z, fills[i].filter((e) => e.dur > 0)));
      out.soli += r.z - r.a;
    }
  }
  if (out.doubled || out.soli) {
    const parts = [];
    if (out.doubled) parts.push(`Melodie wie im Original verdoppelt in ${out.doubled} Takten`);
    if (out.soli) parts.push(`mehrstimmiger Satz der Vorlage in ${out.soli} Takten`);
    report.notes.push(`Textur der Vorlage: ${parts.join(', ')}`);
  }
  report.texture = out;
  return out;
}
