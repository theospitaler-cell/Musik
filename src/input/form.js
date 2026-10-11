// Formanalyse für Aufnahmen: Formteile (Intro, Strophe, Refrain …) aus Takt-Merkmalen.
// Aus einer Aufnahme lässt sich die Melodie nie notengleich wiedererkennen – verglichen werden
// deshalb je Takt: Harmonik (Tonklassen), Melodie (Tonklassen & Lage), Lautstärke, Dichte der
// Begleitung und des Schlagzeugs. Grenzen liegen dort, wo sich diese Merkmale ändern; gleiche
// Formteile bekommen denselben Buchstaben. Jeder Formteil trägt seine relative Lautstärke
// (energy 0..1) – damit folgt das Arrangement der Dramaturgie des Originals.

const cosine = (a, b) => {
  let s = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < a.length; k++) {
    s += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const letter = (n) => (n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(65 + (n % 26)) + (Math.floor(n / 26) + 1));

// bars: [{chroma: [12], mel: [12], energy, register, density, drums, sung}] – eine Zeile je Takt
export function barFeatures({ mt, measureCount, melody = [], notes = [], drumNotes = [], energy = null }) {
  const bars = Array.from({ length: measureCount }, () => ({ chroma: new Array(12).fill(0), mel: new Array(12).fill(0), energy: 0, register: 0, density: 0, drums: 0, sung: 0 }));
  const barOf = (t) => Math.floor(t / mt);
  for (const n of notes) {
    if (n.start < 0) continue;
    const pc = ((n.midi % 12) + 12) % 12;
    for (let b = barOf(n.start); b <= barOf(n.start + n.dur - 1) && b < measureCount; b++) {
      const w = Math.min((b + 1) * mt, n.start + n.dur) - Math.max(b * mt, n.start);
      if (w > 0) bars[b].chroma[pc] += w;
    }
    const b0 = barOf(n.start);
    if (b0 < measureCount) bars[b0].density++;
  }
  const reg = bars.map(() => []);
  for (const n of melody) {
    if (n.start < 0) continue;
    const b = barOf(n.start);
    if (b >= measureCount) continue;
    bars[b].mel[((n.midi % 12) + 12) % 12] += n.dur;
    bars[b].sung += n.dur;
    reg[b].push(n.midi);
  }
  bars.forEach((x, b) => {
    x.sung = Math.min(1, x.sung / mt);
    x.register = reg[b].length ? mean(reg[b]) : 0;
  });
  for (const d of drumNotes) {
    const b = barOf(d.start);
    if (b >= 0 && b < measureCount) bars[b].drums++;
  }
  if (energy) energy.forEach((e, b) => b < measureCount && (bars[b].energy = e));
  return bars;
}

// Skalare Merkmale auf 0..1 (robust: 10.–90. Perzentil)
function normalize(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const lo = s[Math.floor(0.1 * (s.length - 1))];
  const hi = s[Math.floor(0.9 * (s.length - 1))];
  if (hi - lo < 1e-9) return vals.map(() => 0.5);
  return vals.map((v) => Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
}

export function audioSections(bars) {
  const M = bars.length;
  if (M < 12) return null;
  const en = normalize(bars.map((b) => b.energy));
  const dn = normalize(bars.map((b) => b.density));
  const dr = normalize(bars.map((b) => b.drums));
  const regs = bars.map((b) => b.register).filter((x) => x > 0);
  const regMid = regs.length ? mean(regs) : 60;
  const rg = bars.map((b) => (b.register ? Math.max(0, Math.min(1, 0.5 + (b.register - regMid) / 14)) : 0.5));
  const sc = bars.map((b, i) => [en[i], dn[i], dr[i], rg[i], b.sung]);
  const W = [1.2, 0.6, 0.8, 0.7, 0.9];
  const sim = (i, j) => {
    let d = 0;
    for (let k = 0; k < W.length; k++) d += W[k] * (sc[i][k] - sc[j][k]) ** 2;
    return 0.35 * cosine(bars[i].chroma, bars[j].chroma) + 0.2 * cosine(bars[i].mel, bars[j].mel) + 0.45 * Math.exp(-2.5 * d);
  };
  const S = Array.from({ length: M }, (_, i) => Array.from({ length: M }, (_, j) => (i === j ? 1 : sim(i, j))));
  // Neuheit: Vergleich der K Takte vor und nach jeder Taktgrenze (Schachbrett-Kern)
  const K = 4;
  const nov = new Array(M + 1).fill(0);
  for (let t = 2; t <= M - 2; t++) {
    let within = 0;
    let across = 0;
    let nw = 0;
    let na = 0;
    for (let a = Math.max(0, t - K); a < t; a++)
      for (let b = t; b < Math.min(M, t + K); b++) {
        across += S[a][b];
        na++;
      }
    for (let a = Math.max(0, t - K); a < t; a++)
      for (let b = a + 1; b < t; b++) {
        within += S[a][b];
        nw++;
      }
    for (let a = t; a < Math.min(M, t + K); a++)
      for (let b = a + 1; b < Math.min(M, t + K); b++) {
        within += S[a][b];
        nw++;
      }
    nov[t] = (nw ? within / nw : 0) - (na ? across / na : 0);
  }
  const vals = nov.slice(2, M - 1);
  const mu = mean(vals);
  const sd = Math.sqrt(mean(vals.map((v) => (v - mu) ** 2))) || 1e-6;
  // Grenzen: deutliche Spitzen, mindestens 4 Takte Abstand – die stärksten zuerst
  const peaks = [];
  for (let t = 2; t <= M - 2; t++) if (nov[t] > mu + 0.6 * sd && nov[t] >= nov[t - 1] && nov[t] >= nov[t + 1]) peaks.push(t);
  peaks.sort((a, b) => nov[b] - nov[a]);
  let bounds = [0, M];
  for (const p of peaks) if (bounds.every((b) => Math.abs(b - p) >= 4 || b === 0 || b === M) && p >= 2 && M - p >= 4 && bounds.every((b) => Math.abs(b - p) >= 2)) bounds.push(p);
  bounds = [...new Set(bounds)].sort((a, b) => a - b);
  // lange Abschnitte in 8-Takt-Phrasen teilen (Formteile sind selten länger als 16 Takte)
  const split = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    split.push(a);
    if (b - a > 16) for (let t = a + 8; b - t >= 4; t += 8) split.push(t);
  }
  split.push(M);
  bounds = split;
  // Phrasenlängen glätten: Grenzen auf Vielfache von 4 Takten ab der vorigen Grenze ziehen,
  // wenn sie nur einen Takt daneben liegen (Beat-Tracking-/Analyse-Unschärfe)
  for (let i = 1; i < bounds.length - 1; i++) {
    const len = bounds[i] - bounds[i - 1];
    const r = len % 4;
    if (r === 1 && bounds[i] - 1 - bounds[i - 1] >= 4) bounds[i] -= 1;
    else if (r === 3 && bounds[i + 1] - (bounds[i] + 1) >= 3) bounds[i] += 1;
  }
  bounds = [...new Set(bounds)].sort((a, b) => a - b);
  const secs = [];
  for (let i = 0; i < bounds.length - 1; i++) secs.push({ start: bounds[i], length: bounds[i + 1] - bounds[i] });
  // Ähnlichkeit zweier Formteile: Takte der Reihe nach verglichen
  const secSim = (a, b) => {
    const n = Math.min(a.length, b.length);
    if (Math.max(a.length, b.length) > 2 * n) return 0;
    let s = 0;
    for (let k = 0; k < n; k++) s += S[a.start + k][b.start + k];
    return s / n;
  };
  const pairs = [];
  for (let i = 0; i < secs.length; i++) for (let j = i + 1; j < secs.length; j++) pairs.push(secSim(secs[i], secs[j]));
  const pm = mean(pairs);
  const ps = Math.sqrt(mean(pairs.map((v) => (v - pm) ** 2))) || 1e-6;
  const thr = Math.max(0.72, pm + 0.25 * ps);
  let next = 0;
  const reps = [];
  for (const sec of secs) {
    let best = null;
    for (const r of reps) {
      const v = secSim(sec, r.sec);
      if (v >= thr && (!best || v > best.v)) best = { v, r };
    }
    if (best) sec.label = best.r.label;
    else {
      sec.label = letter(next++);
      reps.push({ sec, label: sec.label });
    }
  }
  // Lautstärke je Formteil (für die Dramaturgie) und Anteil gesungener Takte
  for (const sec of secs) {
    const idx = Array.from({ length: sec.length }, (_, k) => sec.start + k);
    sec.energy = Math.round(mean(idx.map((i) => 0.6 * en[i] + 0.2 * dn[i] + 0.2 * dr[i])) * 100) / 100;
    sec.sung = Math.round(mean(idx.map((i) => bars[i].sung)) * 100) / 100;
  }
  return secs;
}
