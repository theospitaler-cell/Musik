// Synthetische Stems mit bekannter Wahrheit (4/4, F-Dur, 16 Takte) für die Orchestrierungs-Tests.
// vocals: Lead-Melodie (mit Tonwiederholung, 16tel-Lauf, Pause von zwei Schlägen)
// bass:   Fundament, um 40 ms verspätet (Sub-Bass-Lag)
// other:  Begleitung – Takte 1–4 Liegeklänge, 5–8 synkopierte Einwürfe, danach gemischt
// drums:  Bassdrum 1+3, Snare 2+4, Hi-Hat auf Achteln; Takt 1 beginnt bei t0 (nicht bei 0)

// [bar (1-basiert), beat (0-basiert, Schläge ab Taktanfang), dauer in Schlägen, midi]
const MELODY = [
  [1, 0, 1, 69], [1, 1, 1, 72], [1, 2, 1, 69], [1, 3, 1, 65],
  [2, 0, 1, 74], [2, 1, 1, 72], [2, 2, 2, 69],
  [3, 0, 1, 74], [3, 1, 0.5, 72], [3, 1.5, 0.5, 70], [3, 2, 1, 69], [3, 3, 1, 70],
  [4, 0, 1, 72], [4, 1, 1, 70], [4, 2, 1, 69], [4, 3, 1, 67],
  [5, 0, 1, 69], [5, 1, 1, 72], [5, 2, 2, 77],
  [6, 0, 1, 77], [6, 1, 1, 75], [6, 2, 1, 74], [6, 3, 1, 72],
  [7, 0, 0.5, 74], [7, 0.5, 0.5, 72], [7, 1, 1, 70], [7, 2, 2, 74],
  [8, 0, 1, 72], [8, 1, 1, 70], // Pause: Schläge 3–4 (Lücke von zwei Schlägen)
  [9, 0, 1, 72], [9, 1, 1, 77], [9, 2, 1, 72], [9, 3, 1, 69],
  [10, 0, 1, 76], [10, 1, 1, 72], [10, 2, 2, 69],
  [11, 0, 1, 74], [11, 1, 0.25, 74], [11, 1.25, 0.25, 74], [11, 1.5, 0.25, 74], [11, 1.75, 0.25, 74], [11, 2, 1, 72], [11, 3, 1, 70],
  [12, 0, 0.25, 70], [12, 0.25, 0.25, 72], [12, 0.5, 0.25, 74], [12, 0.75, 0.25, 75], [12, 1, 1, 74], [12, 2, 1, 72], [12, 3, 1, 70],
  [13, 0, 1, 76], [13, 1, 1, 72], [13, 2, 1, 70], [13, 3, 1, 67],
  [14, 0, 1, 69], [14, 1, 1, 72], [14, 2, 2, 75],
  [15, 0, 1, 74], [15, 1, 1, 70], [15, 2, 2, 74],
  [16, 0, 2, 72], [16, 2, 2, 65],
];

// Akkorde je Takt (Grundton MIDI Bass, Begleitklang)
const BARS = [
  { root: 41, comp: [57, 60, 65] }, // F
  { root: 38, comp: [57, 62, 65] }, // Dm
  { root: 46, comp: [58, 62, 65] }, // Bb
  { root: 43, comp: [58, 60, 64, 67] }, // C7
  { root: 41, comp: [57, 60, 65] }, // F
  { root: 41, comp: [57, 63, 65] }, // F7 (Eb)
  { root: 46, comp: [58, 62, 65] }, // Bb
  { root: 43, comp: [58, 60, 64, 67] }, // C7
  { root: 41, comp: [57, 60, 65] }, // F
  { root: 45, comp: [57, 60, 64] }, // Am
  { root: 46, comp: [58, 62, 65] }, // Bb
  { root: 43, comp: [58, 62, 67] }, // Gm
  { root: 43, comp: [58, 60, 64, 67] }, // C7
  { root: 41, comp: [57, 63, 65] }, // F7
  { root: 46, comp: [58, 62, 65] }, // Bb
  { root: 41, comp: [57, 60, 65] }, // F
];

const jitter = (i) => ((((i * 2654435761) >>> 0) % 21) - 10) / 1000; // ±10 ms, deterministisch

export function makeStemFixture({ bpm = 120, t0 = 0.37, bassLag = 0.04, bars = 16 } = {}) {
  const beat = 60 / bpm;
  const at = (bar, b) => t0 + ((bar - 1) * 4 + b) * beat;
  const vocals = [];
  let k = 0;
  for (const [bar, b, d, midi] of MELODY) {
    if (bar > bars) continue;
    const vel = bar <= 8 ? 64 : 100;
    vocals.push({ start: at(bar, b) + jitter(k++), end: at(bar, b + d) - 0.02, midi, amp: vel / 127 });
  }
  const bass = [];
  for (let bar = 1; bar <= bars; bar++) {
    const r = BARS[bar - 1].root;
    const lag = bassLag;
    bass.push({ start: at(bar, 0) + lag, end: at(bar, 2) - 0.03 + lag, midi: r, amp: 0.8 });
    bass.push({ start: at(bar, 2) + lag, end: at(bar, 3.5) - 0.03 + lag, midi: r + 7 > 52 ? r - 5 : r + 7, amp: 0.7 });
    if (bar % 2 === 0) bass.push({ start: at(bar, 3.5) + jitter(bar), end: at(bar, 4) - 0.03, midi: r, amp: 0.6 });
  }
  const other = [];
  for (let bar = 1; bar <= bars; bar++) {
    const chord = BARS[bar - 1].comp;
    const rhythmic = (bar >= 5 && bar <= 8) || (bar >= 9 && bar % 2 === 1);
    const hits = rhythmic ? [[0, 0.5], [1.5, 0.5], [2.5, 0.5], [3.5, 0.5]] : [[0, 4]];
    for (const [b, d] of hits) for (const m of chord) other.push({ start: at(bar, b) + 0.004 * (m % 3), end: at(bar, b + d) - 0.03, midi: m, amp: 0.6 });
  }
  const hits = [];
  let h = 0;
  for (let bar = 1; bar <= bars; bar++) {
    for (let b = 0; b < 4; b++) {
      const t = at(bar, b);
      if (b % 2 === 0) hits.push({ t: t + jitter(h++), kind: 'kick', w: 1 });
      else hits.push({ t: t + jitter(h++), kind: 'snare', w: 1 });
      hits.push({ t: t + jitter(h++), kind: 'hat', w: 0.5 });
      hits.push({ t: t + beat / 2 + jitter(h++), kind: 'hat', w: 0.4 });
    }
  }
  return {
    stems: { vocals, bass, other, drums: { hits } },
    truth: { bpm, t0, beat, bars, melody: MELODY.filter((n) => n[0] <= bars), chords: BARS },
  };
}

// Kurzer Auftakt-Fall: Musik beginnt eine Zählzeit vor dem ersten Schlag (Auftakt)
export function withPickup(fx, beats = 1) {
  const { stems, truth } = fx;
  const early = (list) => list.map((n) => ({ ...n }));
  const vocals = early(stems.vocals);
  vocals.unshift({ start: truth.t0 - beats * truth.beat, end: truth.t0 - 0.03, midi: 65, amp: 0.5 });
  return { stems: { ...stems, vocals }, truth };
}

// Zufälliges Material (deterministisch je seed): beliebige Taktart, Lage, Pausen, Begleitdichte.
// Prüft, dass die Satzregeln nicht nur an den handgebauten Liedern halten.
export function randomMaterial(seed, Rng) {
  const rng = new Rng(seed);
  const meters = [[4, 4], [4, 4], [4, 4], [3, 4], [2, 4], [6, 8], [5, 4], [12, 8]];
  const [beats, beatType] = rng.pick(meters);
  const mt = (beats * 96) / beatType;
  const bars = rng.int(6, 20);
  const unit = beatType === 8 ? 12 : 24;
  const lead = [];
  let t = 0;
  let p = rng.int(55, 80);
  while (t < bars * mt - unit) {
    const dur = rng.pick([6, 12, 12, 24, 24, 36, 48, 72]);
    if (rng.chance(0.12)) {
      t += rng.pick([12, 24, 48, 72]);
      continue;
    }
    p = Math.max(40, Math.min(96, p + rng.pick([-5, -3, -2, -1, 0, 1, 2, 3, 5, 7, -12])));
    lead.push({ start: t, dur, midi: p, vel: rng.int(40, 120) });
    t += dur;
  }
  const root = rng.int(30, 45);
  const bass = [];
  for (let b = 0; b < bars; b++) {
    const r = root + rng.pick([0, 0, 2, 5, 7, -2, 3]);
    if (rng.chance(0.9)) bass.push({ start: b * mt, dur: mt / 2, midi: r }, { start: b * mt + mt / 2, dur: mt / 2, midi: r + rng.pick([0, 7, 12]) });
  }
  const comp = [];
  for (let b = 0; b < bars; b++) {
    const hits = rng.pick([0, 1, 1, 2, 4, 5]);
    for (let h = 0; h < hits; h++) {
      const st = b * mt + Math.round(rng.int(0, mt - 6) / 6) * 6;
      for (const m of [root + 24 + rng.int(0, 5), root + 28 + rng.int(0, 4), root + 31]) comp.push({ start: st, dur: rng.pick([12, 24, 48]), midi: m });
    }
  }
  return { title: `Zufall ${seed}`, tempo: rng.int(60, 180), meter: { beats, beatType }, measureCount: bars, lead, bass, comp, drums: [] };
}
