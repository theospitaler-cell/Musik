// Voicing: Drop-2-/Drop-2/4-Sätze, Gegenstimme in Gegenbewegung, Basslage, Satzregeln
// (verdeckte Quinten/Oktaven, Sekund-Reibungen unter C3).
import { mod } from '../core/constants.js';
import { colorTones, toneByRole } from '../theory/chords.js';
import { fitPitch, inRange } from './profiles.js';
import { endOf, soundingAt } from './util.js';

export const C3 = 48;

// Sekund-Reibung: kleine oder große Sekunde, deren unterer Ton unter C3 liegt
export function isFriction(a, b) {
  const d = Math.abs(a - b);
  return d >= 1 && d <= 2 && Math.min(a, b) < C3;
}

const nearestBelow = (from, pc) => {
  const d = mod(from - pc, 12);
  return from - (d === 0 ? 12 : d);
};

// ---------------------------------------------------------------------------------------------
// Akkord-Vorrat: Terz/Septime (Sext) zuerst, dann Quinte, Spannungen (9/11/13), Grundton zuletzt –
// der Grundton liegt im Bass.
export function chordPool(chord, { tensions = true, style = 'funk' } = {}) {
  if (!chord) return [];
  const t = (r) => toneByRole(chord, r);
  const third = t('third');
  const seventh = t('seventh');
  const fifth = t('fifth');
  const root = t('root');
  const out = [];
  const push = (x, req, role) => x && !out.some((o) => o.pc === x.pc) && out.push({ pc: x.pc, lof: x.lof, role, req });
  push(third, true, 'third');
  push(seventh, true, 'seventh');
  if (!seventh) push(fifth, true, 'fifth');
  else push(fifth, false, 'fifth');
  if (tensions) for (const c of colorTones(chord, style)) push(c, false, 'tension');
  for (const c of chord.tens || []) push(c, false, 'tension');
  push(root, false, 'root');
  return out;
}

function* combinations(arr, m) {
  if (m === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= arr.length - m; i++) for (const rest of combinations(arr.slice(i + 1), m - 1)) yield [arr[i], ...rest];
}

// geschlossener Satz von oben nach unten: erst jeder Ton einmal, danach Oktavverdopplungen
function closedStack(top, firstPcs, dblPcs, k) {
  const res = [top];
  const pass = firstPcs.map((pc) => nearestBelow(top, pc)).sort((a, b) => b - a);
  for (const p of pass) if (res.length < k + 1) res.push(p);
  let guard = 0;
  while (res.length < k + 1 && guard++ < 8) {
    const low = res[res.length - 1];
    const cyc = (dblPcs.length ? dblPcs : firstPcs).map((pc) => nearestBelow(low, pc)).sort((a, b) => b - a);
    for (const p of cyc) if (res.length < k + 1) res.push(p);
  }
  return res;
}

function applyDrop(stack, type) {
  const s = [...stack];
  const idx = type === 'drop2' ? [1] : type === 'drop24' ? [1, 3] : [];
  for (const i of idx) {
    if (i >= s.length) continue;
    let p = s[i] - 12;
    while (s.includes(p)) p -= 12;
    s[i] = p;
  }
  return [s[0], ...s.slice(1).sort((a, b) => b - a)];
}

// voices: Profile der Innenstimmen (oben -> unten); bass: klingender Bass (oder null);
// prev: vorherige Tonhöhen der Innenstimmen (Stimmführung)
export function buildSonority({ top, chord, voices, bass = null, prev = null, tensions = true, style = 'funk' }) {
  const k = voices.length;
  const leadPc = mod(top, 12);
  const pool = chordPool(chord, { tensions: tensions && k >= 4, style });
  if (!pool.length || !k) return null;
  const usable = pool.filter((p) => p.pc !== leadPc);
  const required = usable.filter((p) => p.req);
  const optional = usable.filter((p) => !p.req);
  const m = Math.min(k, usable.length);
  const templates = k >= 4 ? ['drop24', 'drop2'] : k === 3 ? ['drop2'] : ['closed'];
  let best = null;
  const subsets = [];
  if (required.length >= m) subsets.push(required.slice(0, m));
  else for (const extra of combinations(optional, m - required.length)) subsets.push([...required, ...extra]);
  if (!subsets.length) subsets.push(usable.slice(0, Math.max(1, m)));
  for (const sub of subsets) {
    // Verdopplungen: nicht Terz/Septime
    const dbl = sub.filter((p) => p.role !== 'third' && p.role !== 'seventh').map((p) => p.pc);
    if (!dbl.length) {
      const root = pool.find((p) => p.role === 'root');
      if (root) dbl.push(root.pc);
    }
    for (const tpl of templates) {
      const closed = closedStack(top, sub.map((p) => p.pc), dbl, k);
      const open = applyDrop(closed, tpl);
      // je Stimme in ihren Bereich (stufenweise Oktavversetzung)
      const assigned = open.slice(1, k + 1).map((p, i) => fitPitch(p, voices[i]));
      const cost = sonorityCost(top, assigned, voices, bass, prev, sub);
      if (!best || cost < best.cost) best = { cost, pitches: assigned, template: tpl, closed, open, pcs: sub.map((p) => p.pc), roles: sub.map((p) => p.role) };
    }
  }
  return best;
}

function sonorityCost(top, inner, voices, bass, prev, sub) {
  let c = 0;
  const all = [top, ...inner];
  for (let i = 0; i < inner.length; i++) {
    const p = inner[i];
    const v = voices[i];
    if (!inRange(p, v)) c += 1000;
    if (p < v.sweet[0]) c += (v.sweet[0] - p) * 1.0;
    if (p > v.sweet[1]) c += (p - v.sweet[1]) * 1.5;
    if (prev && prev[i] !== undefined) c += 0.35 * Math.abs(p - prev[i]);
    if (bass !== null && bass !== undefined) {
      if (isFriction(p, bass)) c += 120;
      if (p < bass + 3) c += 25;
    }
  }
  for (let i = 1; i < all.length; i++) {
    const d = all[i - 1] - all[i];
    if (d === 0) c += 60;
    else if (d < 0) c += 30; // Stimmenkreuzung
    else if (d === 1) c += 8;
    else if (d === 2) c += Math.min(all[i - 1], all[i]) < C3 ? 120 : 1.5;
    if (d > 12 && i < all.length - 1) c += 3 * (d - 12) / 4;
    if (isFriction(all[i - 1], all[i])) c += 120;
  }
  // Doppelungen von Terz/Septime vermeiden (Leitton!)
  const seen = new Map();
  for (const p of all) seen.set(mod(p, 12), (seen.get(mod(p, 12)) || 0) + 1);
  for (const s of sub) if ((s.role === 'third' || s.role === 'seventh') && (seen.get(s.pc) || 0) > 1) c += 4;
  // Spannungen auf den Innenstimmen sind erwünscht
  for (const s of sub) if (s.role === 'tension') c -= 0.8;
  return c;
}

// ---------------------------------------------------------------------------------------------
// Gegenstimme in Gegenbewegung (bevorzugt Terzen/Sexten), dynamische Programmierung über die Melodie.
// lead: Ereignisse (konzertant, einstimmig); chordAt(t) -> Akkord; scale(t) -> Tonklassen der Skala
// avoid: Tonhöhen einer bereits gesetzten Gegenstimme (je Melodieton) – die neue Linie bleibt darunter
export function counterLine({ lead, chordAt, scalePcs, profile, bassAt = null, avoid = null }) {
  if (!lead.length) return [];
  const [lo, hi] = profile.range;
  const cand = [];
  for (const e of lead) {
    const L = e.pitches[0];
    const chord = chordAt(e.start);
    const chordPcs = chord ? [...chord.tones, ...(chord.tens || [])].map((t) => t.pc) : [];
    const dom = chord && (chord.kind === 'dominant' || chord.kind === 'augmented-seventh');
    const scale = scalePcs(e.start);
    const row = [];
    const ceil = avoid && avoid[cand.length] !== undefined ? Math.min(L - 1, avoid[cand.length] - 3) : L - 1;
    for (let p = Math.max(lo, L - 24); p <= Math.min(hi, ceil); p++) {
      const pc = mod(p, 12);
      const isChord = chordPcs.includes(pc);
      if (!isChord && !scale.includes(pc)) continue;
      const d = L - p;
      let cost = 0;
      const dc = d % 12;
      if (d >= 3 && (dc === 3 || dc === 4 || dc === 8 || dc === 9)) cost += 0;
      else if (dc === 7 || dc === 5) cost += d > 12 ? 0.6 : 1.4;
      else if (dc === 0) cost += d === 0 ? 4 : 2.2;
      else if (dc === 1 || dc === 2 || dc === 10 || dc === 11) cost += e.dur <= 12 ? 1.6 : 3.2;
      else if (dc === 6) cost += dom ? 0.6 : 2.5;
      else cost += 1;
      if (!isChord) cost += 1.2;
      if (p < profile.sweet[0]) cost += (profile.sweet[0] - p) * 0.7;
      if (p > profile.sweet[1]) cost += (p - profile.sweet[1]) * 1.0;
      if (bassAt) {
        const b = bassAt(e.start);
        if (b !== null && b !== undefined) {
          if (isFriction(p, b)) cost += 40;
          if (p <= b) cost += 15;
        }
      }
      row.push({ p, cost });
    }
    if (!row.length) row.push({ p: fitPitch(L - 4, profile), cost: 5 });
    cand.push(row);
  }
  const n = lead.length;
  const best = cand.map((r) => r.map(() => ({ c: Infinity, from: -1 })));
  cand[0].forEach((s, j) => (best[0][j] = { c: s.cost, from: -1 }));
  for (let i = 1; i < n; i++) {
    const dL = lead[i].pitches[0] - lead[i - 1].pitches[0];
    cand[i].forEach((s, j) => {
      let bc = Infinity;
      let bf = -1;
      cand[i - 1].forEach((q, f) => {
        if (best[i - 1][f].c === Infinity) return;
        const dC = s.p - q.p;
        let t = 0;
        if (dL !== 0 && dC !== 0) t += Math.sign(dL) === Math.sign(dC) ? 1.0 : 0; // gleichsinnig vs. Gegenbewegung
        else if (dL !== 0 && dC === 0) t += 0.3;
        else if (dL === 0 && dC !== 0) t += 0.3;
        // Parallelen Quinten/Oktaven
        const dPrev = lead[i - 1].pitches[0] - q.p;
        const dNow = lead[i].pitches[0] - s.p;
        if (mod(dPrev, 12) === mod(dNow, 12) && (mod(dNow, 12) === 7 || mod(dNow, 12) === 0) && dL !== 0 && dC !== 0) t += 8;
        t += 0.15 * Math.abs(dC);
        if (Math.abs(dC) > 7) t += 2;
        const v = best[i - 1][f].c + t;
        if (v < bc) {
          bc = v;
          bf = f;
        }
      });
      best[i][j] = { c: bc + s.cost, from: bf };
    });
  }
  let j = 0;
  for (let k = 1; k < cand[n - 1].length; k++) if (best[n - 1][k].c < best[n - 1][j].c) j = k;
  const path = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    path[i] = cand[i][j].p;
    j = best[i][j].from;
    if (j < 0) j = 0;
  }
  return lead.map((e, i) => ({ start: e.start, dur: e.dur, midi: path[i] }));
}

// ---------------------------------------------------------------------------------------------
// Verdeckte und parallele Quinten/Oktaven zwischen Lead und Bass.
// Prüft gleichzeitige Einsätze; fixes: Bassnote in Oktave/Akkordton ändern (Gegenbewegung).
export function perfectIssues(lead, bass) {
  const out = [];
  const starts = new Set([...lead.map((e) => e.start), ...bass.map((e) => e.start)]);
  const times = [...starts].sort((a, b) => a - b);
  let prev = null;
  for (const t of times) {
    const l = soundingAt(lead, t);
    const b = soundingAt(bass, t);
    if (!l || !b) {
      prev = null;
      continue;
    }
    const cur = { t, l: l.pitches[0], b: b.pitches[0], both: l.start === t && b.start === t };
    if (prev && cur.both) {
      const dl = cur.l - prev.l;
      const db = cur.b - prev.b;
      const ic = mod(cur.l - cur.b, 12);
      if (dl !== 0 && db !== 0 && Math.sign(dl) === Math.sign(db) && (ic === 0 || ic === 7)) out.push({ t, lead: cur.l, bass: cur.b, interval: ic === 7 ? 'quinte' : 'oktave' });
    }
    prev = cur;
  }
  return out;
}

export function fixPerfects(lead, bass, { chordAt, bassProfile, maxLeap = 12, gap = 1 }) {
  let fixed = 0;
  for (let pass = 0; pass < 4; pass++) {
    const issues = perfectIssues(lead, bass);
    if (!issues.length) break;
    for (const is of issues) {
      const idx = bass.findIndex((e) => e.start === is.t);
      if (idx < 0) continue;
      const e = bass[idx];
      const prevB = bass[idx - 1];
      const nextB = bass[idx + 1];
      const chord = chordAt(is.t);
      const pcs = chord ? [...chord.tones.map((t) => t.pc), ...(chord.bassPc !== null && chord.bassPc !== undefined ? [chord.bassPc] : [])] : [mod(e.pitches[0], 12)];
      const orig = e.pitches[0];
      const cands = [];
      for (let p = bassProfile.range[0]; p <= bassProfile.range[1]; p++) {
        if (!pcs.includes(mod(p, 12))) continue;
        if (prevB && e.start - endOf(prevB) < gap && Math.abs(p - prevB.pitches[0]) > maxLeap) continue;
        if (nextB && nextB.start - endOf(e) < gap && Math.abs(nextB.pitches[0] - p) > maxLeap) continue;
        cands.push(p);
      }
      cands.sort((a, b) => Math.abs(a - orig) - Math.abs(b - orig));
      const l = soundingAt(lead, is.t);
      const pl = lastLeadBefore(lead, is.t);
      for (const p of cands) {
        if (p === orig) continue;
        const ic = mod(l.pitches[0] - p, 12);
        const prevBassP = prevB ? prevB.pitches[0] : null;
        const db = prevBassP === null ? 0 : p - prevBassP;
        const dl = pl ? l.pitches[0] - pl : 0;
        const bad = db !== 0 && dl !== 0 && Math.sign(db) === Math.sign(dl) && (ic === 0 || ic === 7);
        if (!bad && ic !== 1 && !(isFriction(p, l.pitches[0]))) {
          e.pitches[0] = p;
          e.lofs[0] = null;
          fixed++;
          break;
        }
      }
    }
  }
  return fixed;
}

function lastLeadBefore(lead, t) {
  let res = null;
  for (const e of lead) {
    if (e.start >= t) break;
    res = e.pitches[0];
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Sekund-Reibungen unter C3 zwischen gleichzeitig klingenden Tönen verschiedener Stimmen.
export function frictions(voiceEvents) {
  const out = [];
  const flat = [];
  voiceEvents.forEach((evs, v) => evs.forEach((e) => flat.push({ v, e })));
  flat.sort((a, b) => a.e.start - b.e.start);
  for (let i = 0; i < flat.length; i++) {
    const a = flat[i];
    for (let j = i + 1; j < flat.length; j++) {
      const b = flat[j];
      if (b.e.start >= endOf(a.e)) break;
      if (a.v === b.v) continue;
      for (const pa of a.e.pitches) for (const pb of b.e.pitches) if (isFriction(pa, pb)) out.push({ t: b.e.start, a: a.v, b: b.v, pa, pb, ea: a.e, eb: b.e });
    }
  }
  return out;
}
