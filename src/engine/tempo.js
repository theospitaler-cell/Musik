// Tempo: Schätzung aus Einsatzzeiten und Plausibilitätsprüfung (Halbtempo-Fehler).
//
// Die Autokorrelation der Einsatzfolge findet gern den halben Wert (Viertel statt Achtel) – bei
// schnellen Stücken ab ~150 BPM landet sie bei 60–85. Die Plausibilitätsprüfung verdoppelt dann,
// wenn die übrigen Spuren (other/drums) dafür sprechen. „Dafür sprechen“ ist hier messbar:
//
//   - Anteil der Abstände zwischen Einsätzen um ein Sechzehntel/Zweiunddreißigstel des
//     erkannten Schlags (bei echtem Tempo wären das Achtel/Sechzehntel) ≥ 25 %, oder
//   - Abstände um ein Achtel dominieren (≥ 50 %) und es gibt im Schnitt ≥ 3 Einsätze je Schlag.
//
// Reine Achtel-Dichte genügt NICHT: eine Ballade bei 79 BPM mit durchlaufenden Achteln würde sonst
// auf 158 „korrigiert“ (so an Kravitz/Duett-Aufnahmen gemessen).

const EPS = 1e-9;

// Einsätze (Sekunden) zusammenfassen, die weniger als gap auseinander liegen
export function mergeOnsets(times, gap = 0.03) {
  const t = [...times].sort((a, b) => a - b);
  const out = [];
  for (const x of t) {
    if (out.length && x - out[out.length - 1] < gap) continue;
    out.push(x);
  }
  return out;
}

// onsets: [{t, w}] oder Zahlen (Sekunden). Rückgabe: { bpm, candidates: [{bpm, score}] }
export function estimateTempo(onsets, { minBpm = 60, maxBpm = 200, center = 110 } = {}) {
  const ev = onsets.map((o) => (typeof o === 'number' ? { t: o, w: 1 } : { t: o.t, w: o.w ?? 1 })).sort((a, b) => a.t - b.t);
  if (ev.length < 4) return { bpm: null, candidates: [] };
  const RES = 0.01; // 10 ms
  const dur = ev[ev.length - 1].t;
  const n = Math.ceil(dur / RES) + 2;
  const a = new Float32Array(n);
  for (const e of ev) a[Math.round(e.t / RES)] += e.w;
  const maxLag = Math.round(60 / minBpm / RES) * 2 + 2;
  const ac = new Float32Array(maxLag + 1);
  // sparse Einsätze: Autokorrelation nur über die Ereignisliste
  for (let i = 0; i < ev.length; i++) {
    for (let j = i + 1; j < ev.length; j++) {
      const lag = Math.round((ev[j].t - ev[i].t) / RES);
      if (lag > maxLag) break;
      // ±1 Raster Toleranz
      for (const d of [-1, 0, 1]) if (lag + d >= 0 && lag + d <= maxLag) ac[lag + d] += ev[i].w * ev[j].w * (d === 0 ? 1 : 0.5);
    }
  }
  const cands = [];
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const lag = (60 / bpm) / RES;
    const at = (l) => {
      const k = Math.round(l);
      return k >= 1 && k <= maxLag ? ac[k] : 0;
    };
    // Vielfache stützen den Schlag (2·, 4·), ganze Takte (4 Schläge) besonders
    let s = at(lag) + 0.6 * at(lag * 2) + 0.5 * at(lag * 4) + 0.25 * at(lag * 3);
    // Prior: logarithmisch um das übliche Tempo
    const prior = Math.exp(-0.5 * (Math.log2(bpm / center) / 0.6) ** 2);
    s *= 0.6 + 0.4 * prior;
    cands.push({ bpm, score: s });
  }
  // lokale Spitzen
  const peaks = cands.filter((c, i) => i > 0 && i < cands.length - 1 && c.score >= cands[i - 1].score && c.score >= cands[i + 1].score && c.score > EPS).sort((x, y) => y.score - x.score);
  if (!peaks.length) return { bpm: null, candidates: [] };
  return { bpm: Math.round(peaks[0].bpm * 2) / 2, candidates: peaks.slice(0, 6).map((p) => ({ bpm: p.bpm, score: p.score })) };
}

// Statistik der Abstände zwischen Einsätzen relativ zum Schlag T = 60/bpm
export function onsetStats(onsets, bpm) {
  const t = mergeOnsets(onsets.map((o) => (typeof o === 'number' ? o : o.t)));
  const T = 60 / bpm;
  let total = 0;
  let q = 0;
  let e = 0;
  let s = 0;
  let h = 0;
  const near = (d, target) => Math.abs(d - target) <= 0.2 * target;
  for (let i = 1; i < t.length; i++) {
    const d = t[i] - t[i - 1];
    if (d > 1.3 * T) continue;
    total++;
    if (near(d, T)) q++;
    else if (near(d, T / 2)) e++;
    else if (near(d, T / 4)) s++;
    else if (near(d, T / 8)) h++;
  }
  const span = t.length > 1 ? t[t.length - 1] - t[0] : 0;
  const perBeat = span > 0 ? t.length / (span / T) : 0;
  return {
    total,
    quarter: total ? q / total : 0,
    eighth: total ? e / total : 0,
    sixteenth: total ? s / total : 0,
    thirtysecond: total ? h / total : 0,
    onsetsPerBeat: perBeat,
  };
}

// bpm: erkannter Wert; onsets: Einsätze aus other + drums (Sekunden)
// Rückgabe: { bpm, doubled, reason, stats }
export function plausibleTempo(bpm, onsets) {
  const stats = onsetStats(onsets, bpm);
  if (bpm >= 60 && bpm <= 85 && stats.total >= 8) {
    const fine = stats.sixteenth + stats.thirtysecond;
    if (fine >= 0.25) return { bpm: bpm * 2, doubled: true, reason: `${Math.round(fine * 100)} % der Einsatzabstände liegen bei Sechzehnteln – erkannter Schlag ist ein halber`, stats };
    if (stats.eighth >= 0.5 && stats.onsetsPerBeat >= 3) return { bpm: bpm * 2, doubled: true, reason: `Achtel-Dichte ${stats.onsetsPerBeat.toFixed(1)} Einsätze je Schlag`, stats };
  }
  return { bpm, doubled: false, reason: null, stats };
}
