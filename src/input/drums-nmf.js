// Schlagzeug-Transkription per NMF (nicht-negative Matrixfaktorisierung, Standardverfahren der
// Forschung zur automatischen Drum-Transkription): Das perkussive Spektrogramm wird in
// Klangprofile (Bass Drum, Snare, Hi-Hat, Becken, Toms + freie Komponenten für andere
// Anschläge wie Gitarre/Klavier) und deren Aktivierung über die Zeit zerlegt. Die Profile
// starten mit typischen Schlagzeug-Spektren und passen sich an das jeweilige Lied an –
// deshalb funktioniert die Erkennung für beliebige Aufnahmen, nicht nur für ein Lied.
// Rein lokal, deterministisch, ohne Server.

export const DRUM_COMPONENTS = ['kick', 'snare', 'hat', 'cym', 'tomHi', 'tomLo', 'other1', 'other2'];
const DRUM_K = 6; // die ersten 6 sind Schlagzeug, der Rest fängt anderes ab

const g = (f, fc, oct) => Math.exp(-0.5 * Math.pow(Math.log2(f / fc) / oct, 2));
const ramp = (f, lo, hi) => (f <= lo ? 0 : f >= hi ? 1 : Math.log2(f / lo) / Math.log2(hi / lo));

function templates(centers) {
  const T = {
    kick: (f) => g(f, 60, 0.7) + 0.06 * g(f, 3000, 1),
    snare: (f) => 0.8 * g(f, 210, 0.45) + 0.45 * g(f, 2500, 1.4) + 0.2 * g(f, 7000, 0.8),
    hat: (f) => g(f, 9000, 0.45) + 0.15 * g(f, 5000, 0.5),
    cym: (f) => 0.5 * g(f, 4500, 0.7) + 0.6 * g(f, 8000, 0.8),
    tomHi: (f) => g(f, 230, 0.3) + 0.05 * g(f, 2000, 1),
    tomLo: (f) => g(f, 110, 0.3) + 0.05 * g(f, 1500, 1),
    other1: (f) => g(f, 900, 1.0),
    other2: (f) => 0.3 + 0.7 * ramp(f, 300, 3000) * g(f, 2000, 1.5),
  };
  return DRUM_COMPONENTS.map((name) => {
    const w = new Float32Array(centers.length);
    let s = 0;
    centers.forEach((f, b) => {
      w[b] = T[name](f) + 1e-4;
      s += w[b];
    });
    for (let b = 0; b < w.length; b++) w[b] /= s;
    return w;
  });
}

// Xp: perkussives Bandspektrogramm (nFrames × NB, zeilenweise je Frame), centers: Bandmitten (Hz)
// -> {act: [K][nFrames] Aktivierungen, W}
export function drumNMF(Xp, nFrames, NB, centers, { iters = 36, sparsity = 0.1 } = {}) {
  const K = DRUM_COMPONENTS.length;
  const W0 = templates(centers);
  const W = W0.map((w) => Float32Array.from(w));
  // Startwerte H: Projektion
  const H = Array.from({ length: K }, () => new Float32Array(nFrames));
  for (let t = 0; t < nFrames; t++) {
    let e = 0;
    for (let b = 0; b < NB; b++) e += Xp[t * NB + b];
    for (let k = 0; k < K; k++) H[k][t] = e / K + 1e-6;
  }
  const R = new Float32Array(NB); // V / (WH) je Frame
  const numH = new Float32Array(K);
  const numW = Array.from({ length: K }, () => new Float64Array(NB));
  const sumH = new Float64Array(K);
  const colSum = W.map((w) => w.reduce((a, b) => a + b, 0));
  // Sparsity: Toms und freie Komponenten nur, wenn das Spektrum sie klar verlangt
  // (Toms spielen fast nur in Fills; Bass Drum/Snare sollen nicht als Tom erklärt werden)
  const lam = DRUM_COMPONENTS.map((n) => (n === 'tomHi' || n === 'tomLo' ? sparsity : n.startsWith('other') ? 0.1 : 0));
  for (let it = 0; it < iters; it++) {
    const updW = it >= 6 && it < iters - 8;
    if (updW) for (let k = 0; k < K; k++) {
      numW[k].fill(0);
      sumH[k] = 0;
    }
    for (let t = 0; t < nFrames; t++) {
      const off = t * NB;
      for (let b = 0; b < NB; b++) {
        let wh = 1e-9;
        for (let k = 0; k < K; k++) wh += W[k][b] * H[k][t];
        R[b] = Xp[off + b] / wh;
      }
      for (let k = 0; k < K; k++) {
        let s = 0;
        const w = W[k];
        for (let b = 0; b < NB; b++) s += w[b] * R[b];
        numH[k] = s;
      }
      if (updW)
        for (let k = 0; k < K; k++) {
          const h = H[k][t];
          if (h < 1e-9) continue;
          const nw = numW[k];
          for (let b = 0; b < NB; b++) nw[b] += R[b] * h;
          sumH[k] += h;
        }
      for (let k = 0; k < K; k++) H[k][t] *= numH[k] / (colSum[k] + lam[k]);
    }
    if (updW) {
      for (let k = 0; k < K; k++) {
        if (sumH[k] < 1e-9) continue;
        const w = W[k];
        let s = 0;
        for (let b = 0; b < NB; b++) {
          w[b] *= numW[k][b] / sumH[k];
          s += w[b];
        }
        // Profil bleibt in der Nähe der Vorlage (sonst tauschen Komponenten ihre Rolle)
        const keep = k < DRUM_K ? 0.35 : 0.05;
        let s2 = 0;
        for (let b = 0; b < NB; b++) {
          w[b] = (1 - keep) * (w[b] / (s || 1)) + keep * W0[k][b];
          s2 += w[b];
        }
        for (let b = 0; b < NB; b++) w[b] /= s2;
        colSum[k] = 1;
      }
    }
  }
  const act = {};
  DRUM_COMPONENTS.forEach((name, k) => (act[name] = H[k]));
  return { act, W };
}

// Anschlagsstärke je Frame (Anstieg der Aktivierung gegenüber den letzten Frames)
export function attackCurve(h) {
  const n = h.length;
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let base = Infinity;
    for (let k = Math.max(0, t - 3); k < t; k++) base = Math.min(base, h[k]);
    out[t] = Math.max(0, h[t] - (base === Infinity ? 0 : base));
  }
  return out;
}

// Spitzen (lokale Maxima über ±2 Frames) -> [{f (Frame, mit Bruchteil), v}]
export function pickPeaks(a, minRel = 0.06) {
  const n = a.length;
  const vals = [];
  for (let t = 2; t < n - 2; t++) if (a[t] > 0 && a[t] >= a[t - 1] && a[t] > a[t + 1] && a[t] >= a[t - 2] && a[t] >= a[t + 2]) vals.push(a[t]);
  vals.sort((x, y) => x - y);
  const ref = vals.length ? vals[Math.floor(0.95 * (vals.length - 1))] : 0;
  const out = [];
  if (!ref) return { peaks: out, ref };
  for (let t = 2; t < n - 2; t++) {
    const v = a[t];
    if (v < minRel * ref || !(v >= a[t - 1] && v > a[t + 1] && v >= a[t - 2] && v >= a[t + 2])) continue;
    const den = a[t - 1] - 2 * v + a[t + 1];
    const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a[t - 1] - a[t + 1])) / den)) : 0;
    out.push({ f: t + frac, v: v / ref, abs: v });
  }
  return { peaks: out, ref };
}

// ---------- Anschläge -> Noten im Taktraster ----------
const SUB = 12; // Positionen je Schlag (16tel = 3, Triolen-Achtel = 4)
const GM = { kick: 36, snare: 38, hat: 42, tomHi: 48, tomLo: 43 };
// Grundschwellen (relativ zur typischen Anschlagsstärke der Komponente)
const BASE = { kick: 0.28, snare: 0.28, metal: 0.22, tomHi: 0.35, tomLo: 0.35 };

// act: Aktivierungen (drumNMF), beats: Beat-Frames, firstDown: Index des ersten Taktanfangs
// opts: {compound (12/8), beatFrame, frameToBeat}
export function drumHitsFromActivations(act, beats, firstDown, meterBeats, measureCount, sections, { compound = false, frameToBeat, wash = null, perc = null } = {}) {
  const BT = compound ? 36 : 24;
  const cand = []; // {m, pos (Schlag-Bruchteil im Takt), comp, v, abs, f}
  // Becken-Familie (Hi-Hat, Ride, Crash) klingt spektral ähnlich -> gemeinsame Anschläge,
  // Unterscheidung danach über das Nachklingen
  const metal = new Float32Array(act.hat.length);
  for (let t = 0; t < metal.length; t++) metal[t] = act.hat[t] + act.cym[t];
  const src = { kick: act.kick, snare: act.snare, metal, tomHi: act.tomHi, tomLo: act.tomLo };
  const peaksOf = {};
  for (const c of Object.keys(src)) {
    // Lage: steilster Anstieg (wie beim Beat-Tracking), Stärke: Anstieg über 3 Frames
    const rise = attackCurve(src[c]);
    const step = new Float32Array(rise.length);
    for (let t = 1; t < step.length; t++) step[t] = Math.max(0, src[c][t] - src[c][t - 1]);
    peaksOf[c] = pickPeaks(step).peaks.map((p) => {
      const i = Math.round(p.f);
      return { f: p.f, abs: Math.max(rise[i] || 0, rise[i + 1] || 0, rise[i + 2] || 0) };
    });
  }
  // Übersprechen in die Becken: Snare-Rauschen (und Bass-Drum-Klick) landen teilweise im
  // Becken-Kanal. Anteil je Lied messen (untere Quantile: Schläge ohne echtes Becken) und abziehen.
  const near = (arr, f) => arr.find((p) => Math.abs(p.f - f) <= 1.5);
  for (const c of ['snare', 'kick', 'tomHi', 'tomLo']) {
    const ratios = [];
    for (const p of peaksOf[c]) {
      const mp = near(peaksOf.metal, p.f);
      ratios.push(mp ? mp.abs / p.abs : 0);
    }
    if (ratios.length < 4) continue;
    ratios.sort((a, b) => a - b);
    const leak = ratios[Math.floor(0.05 * (ratios.length - 1))];
    for (const p of peaksOf[c]) {
      const mp = near(peaksOf.metal, p.f);
      if (mp) {
        mp.abs = Math.max(0, mp.abs - leak * p.abs);
        mp.coincide = true;
      }
    }
  }
  // Bezugsstärke je Komponente: typische Anschläge (90 %-Quantil), bei Becken ohne die
  // Schläge, die mit Snare/Bass Drum zusammenfallen
  const refs = {};
  for (const c of Object.keys(src)) {
    const vals = peaksOf[c].filter((p) => c !== 'metal' || !p.coincide).map((p) => p.abs).sort((a, b) => a - b);
    const all = peaksOf[c].map((p) => p.abs).sort((a, b) => a - b);
    const use = vals.length >= 8 ? vals : all;
    refs[c] = use.length ? use[Math.floor(0.9 * (use.length - 1))] : 0;
  }
  // Toms spielen selten (nur in Fills): ihre Stärke an Bass Drum & Snare messen, nicht an sich selbst
  const drumRef = Math.max(refs.kick || 0, refs.snare || 0);
  for (const c of Object.keys(src)) {
    const tom = c === 'tomHi' || c === 'tomLo';
    for (const p of peaksOf[c]) {
      const v = p.abs / Math.max(1e-9, tom ? 0.8 * drumRef : refs[c]);
      if (!(v > 0.02)) continue;
      const bp = frameToBeat(p.f) - firstDown;
      const m = Math.floor(bp / meterBeats);
      if (m < 0 || m >= measureCount) continue;
      cand.push({ m, pos: bp - m * meterBeats, comp: c, v, abs: p.abs, f: p.f });
    }
  }
  // Swing (gerade Taktart): Anschläge auf dem 3. Triolen-Achtel statt auf der Achtel
  let half = 0;
  let trip = 0;
  if (!compound)
    for (const h of cand) {
      if (h.v < 0.3 || !['metal', 'snare', 'kick'].includes(h.comp)) continue;
      const fr = h.pos - Math.floor(h.pos);
      if (Math.abs(fr - 0.5) < 0.07) half++;
      else if (Math.abs(fr - 2 / 3) < 0.07) trip++;
    }
  const swing = !compound && trip >= 8 && trip > 1.5 * half;
  const grid = compound || swing ? [0, 4, 8] : [0, 3, 6, 9];
  const snap = (pos) => {
    const b = Math.floor(pos);
    const r = (pos - b) * SUB;
    let best = grid[0];
    for (const gq of [...grid, SUB]) if (Math.abs(r - gq) < Math.abs(r - best)) best = gq;
    return best === SUB ? (b + 1) * SUB : b * SUB + best;
  };
  const steps = meterBeats * SUB;
  // je Takt & Raster-Position die stärkste Kandidatin je Komponente
  const cell = new Map();
  for (const h of cand) {
    let s = snap(h.pos);
    let m = h.m;
    if (s >= steps) {
      s -= steps;
      m++;
      if (m >= measureCount) continue;
    }
    const key = `${m}:${s}:${h.comp}`;
    const o = cell.get(key);
    if (!o || o.v < h.v) cell.set(key, { m, s, comp: h.comp, v: h.v, abs: h.abs, f: h.f });
  }
  const hits = [...cell.values()];
  const byBar = Array.from({ length: measureCount }, () => []);
  for (const h of hits) byBar[h.m].push(h);
  const at = (m, s, c) => byBar[m].find((h) => h.s === s && h.comp === c);
  // Übersprechen: Snare/Hi-Tom und Bass Drum/Floor-Tom teilen sich Frequenzen
  for (const bar of byBar) {
    // Bass Drum/Snare gleichzeitig mit einer Tom: Tom nur, wenn sie klar stärker ist
    for (const t of bar.filter((x) => (x.comp === 'tomHi' || x.comp === 'tomLo') && !x.drop)) {
      const o = bar.filter((x) => x.s === t.s && (x.comp === 'kick' || x.comp === 'snare'));
      if (o.some((x) => t.abs < 1.0 * x.abs)) t.drop = true;
    }
    for (const t of bar.filter((x) => x.comp === 'tomHi' && !x.drop)) {
      const o = bar.find((x) => x.s === t.s && x.comp === 'tomLo' && !x.drop);
      if (!o) continue;
      const weak = t.abs < o.abs ? t : o;
      if (weak.abs < 0.75 * Math.max(t.abs, o.abs)) weak.drop = true;
    }
  }
  // Formteile: wie oft kommt ein Schlag an dieser Position vor? (Groove als Erwartung)
  const out = [];
  const secs = sections && sections.length ? sections : [{ start: 0, length: measureCount }];
  let prevFillEnd = false;
  for (const sec of secs) {
    const ms = [];
    for (let m = sec.start; m < sec.start + sec.length && m < measureCount; m++) if (byBar[m].some((h) => !h.drop && h.v >= 0.3)) ms.push(m);
    if (!ms.length) continue;
    const freq = new Map();
    for (const m of ms) for (const h of byBar[m]) if (!h.drop && h.v >= BASE[h.comp]) freq.set(`${h.s}:${h.comp}`, (freq.get(`${h.s}:${h.comp}`) || 0) + 1 / ms.length);
    const fr = (s, c) => freq.get(`${s}:${c}`) || 0;
    // Becken im Formteil: Ride (durchgehender Klangteppich zwischen den Schlägen) oder Hi-Hat
    // (trocken, kein Nachklang); Crash = Akzent mit plötzlich lautem, lange klingendem Becken
    const metalHits = ms.flatMap((m) => byBar[m].filter((h) => h.comp === 'metal' && !h.drop && h.v >= BASE.metal));
    const percPeak = (i) => (perc ? Math.max(perc[i] || 0, perc[i + 1] || 0, perc[i + 2] || 0) : 0);
    const washRatio = (() => {
      if (!wash || !perc || metalHits.length < 4) return 0;
      const r = metalHits.map((h) => {
        const i = Math.round(h.f);
        const between = Math.min(wash[i + 6] || 0, wash[i + 9] || 0);
        return percPeak(i) > 0 ? between / percPeak(i) : 0;
      }).sort((x, y) => x - y);
      return r[Math.floor(r.length / 2)];
    })();
    const ridePattern = metalHits.length / ms.length >= 2.5 && washRatio >= 0.25;
    const crashAt = (h) => {
      if (!wash || !perc) return false;
      const i = Math.round(h.f);
      const pre = Math.min(wash[i - 2] || 0, wash[i - 3] || 0);
      const after = Math.min(wash[i + 8] || 0, wash[i + 14] || 0);
      return after >= 0.3 * percPeak(i) && after >= 2.5 * pre + 1e-6 && h.v >= 0.4;
    };
    for (const m of ms) {
      let lastBeatBusy = 0;
      for (const h of byBar[m]) {
        if (h.drop) continue;
        const f = fr(h.s, h.comp);
        const thr = BASE[h.comp] * (f >= 0.5 ? 0.55 : f >= 0.25 ? 0.8 : 1);
        let midi;
        let vel = Math.round(62 + 45 * Math.min(1, h.v));
        if (h.comp === 'snare') {
          if (h.v < thr) {
            // Ghost-Note: leiser Snare-Anschlag zwischen den Hauptschlägen
            if (h.v >= 0.12 && h.s % SUB !== 0 && !at(m, h.s, 'kick')) {
              out.push({ m, s: h.s, midi: 38, vel: 40 });
            }
            continue;
          }
          midi = 38;
        } else if (h.v < thr) continue;
        else if (h.comp === 'metal') {
          if (crashAt(h) && (h.s % SUB === 0 || prevFillEnd)) {
            midi = 49;
            vel = 105;
          } else if (ridePattern) midi = 51;
          else {
            // offene Hi-Hat: klingt kurz nach (100–200 ms), aber nicht so lange wie ein Becken
            const i = Math.round(h.f);
            const open = wash && perc && Math.min(wash[i + 4] || 0, wash[i + 6] || 0) >= 0.25 * percPeak(i);
            midi = open ? 46 : 42;
          }
        } else midi = GM[h.comp];
        if (h.comp === 'tomHi' || h.comp === 'tomLo' || h.comp === 'snare') if (h.s >= steps - SUB) lastBeatBusy++;
        out.push({ m, s: h.s, midi, vel });
      }
      prevFillEnd = lastBeatBusy >= 3;
    }
  }
  const toTick = (s) => {
    const b = Math.floor(s / SUB);
    const r = s % SUB;
    if (compound) return b * BT + r * 3;
    if (swing) return b * BT + (r === 8 ? 12 : r === 4 ? 6 : 0);
    return b * BT + r * 2;
  };
  // doppelte Noten (gleiche Zeit & Instrument) entfernen
  const seen = new Set();
  const notes = [];
  for (const h of out) {
    const start = h.m * meterBeats * BT + toTick(h.s);
    const key = `${start}:${h.midi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push({ start, dur: 6, midi: h.midi, vel: h.vel });
  }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  return { notes, swing };
}
