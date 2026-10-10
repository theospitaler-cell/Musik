// Synthetische Testaufnahmen mit bekannter Wahrheit: Band (Melodie, Bass, Akkorde) +
// Schlagzeug in verschiedenen Grooves, Taktarten und Tempoverläufen. Damit wird die
// Audio-Erkennung an vielen unterschiedlichen Songs gemessen – nicht an einem einzelnen Lied.
export const SR = 22050;

function rng(seed) {
  let r = seed >>> 0 || 1;
  return () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}

// Grooves: je Takt Liste [Position in Schlägen, Instrument, Lautstärke]
// Instrumente: kick, snare, ghost, hat, ohat, ride, crash, tom1, tom2, tom3
export const GROOVES = {
  rock8: { beats: 4, bar: () => [[0, 'kick'], [2, 'kick'], [1, 'snare'], [3, 'snare'], ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((p) => [p, 'hat'])] },
  rock16: { beats: 4, bar: (b) => [[0, 'kick'], [1.5, 'kick'], [2, 'kick'], ...(b % 2 ? [[2.75, 'kick']] : []), [1, 'snare'], [3, 'snare'], ...Array.from({ length: 16 }, (_, i) => [i / 4, 'hat', i % 2 ? 0.6 : 1])] },
  halftime: { beats: 4, bar: () => [[0, 'kick'], [2.5, 'kick'], [2, 'snare'], ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((p) => [p, 'hat'])] },
  ride8: { beats: 4, bar: () => [[0, 'kick'], [2, 'kick'], [1, 'snare'], [3, 'snare'], ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((p) => [p, 'ride'])] },
  // Shuffle (Triolen): Hi-Hat 1. und 3. Triolen-Achtel, Ghost-Notes auf dem mittleren
  shuffle: {
    beats: 4,
    swing: true,
    bar: (b) => [[0, 'kick'], [2, 'kick'], ...(b % 2 ? [[2 + 2 / 3, 'kick']] : []), [1, 'snare'], [3, 'snare'], [1 / 3, 'ghost'], [2 + 1 / 3, 'ghost'], ...[0, 1, 2, 3].flatMap((q) => [[q, 'hat'], [q + 2 / 3, 'hat', 0.7]])],
  },
  waltz: { beats: 3, bar: () => [[0, 'kick'], [1, 'snare', 0.7], [2, 'snare', 0.7], ...[0, 1, 2].map((p) => [p, 'hat'])] },
  funk: { beats: 4, bar: (b) => [[0, 'kick'], [0.75, 'kick'], [2.5, 'kick'], ...(b % 2 ? [[3.5, 'kick']] : []), [1, 'snare'], [3, 'snare'], [1.75, 'ghost'], [2.25, 'ghost'], [3.75, 'ghost'], ...Array.from({ length: 8 }, (_, i) => [i / 2, 'hat'])] },
};

// Tempoverläufe: bpm(beatIndex, totalBeats)
export const TEMPOS = {
  steady: (bpm) => () => bpm,
  rit: (bpm, bars = 2, beats = 4, to = 0.7) => (i, n) => {
    const r0 = n - bars * beats;
    return i < r0 ? bpm : bpm * (1 - (1 - to) * ((i - r0) / (bars * beats)));
  },
  change: (bpm, bpm2, atBeat) => (i) => (i < atBeat ? bpm : bpm2),
  drift: (bpm, amt = 0.04) => (i) => bpm * (1 + amt * Math.sin(i / 9)),
};

const SCALE = [0, 2, 4, 5, 7, 9, 11];
const PROG = [0, 5, 3, 4]; // I vi IV V (Stufen)

// opts: {groove, bars, bpm | tempo(i,n), lead, seed, band, fills, crashEvery, melody}
export function synthSong({ groove = 'rock8', bars = 16, bpm = 100, tempo = null, lead = 0.4, seed = 3, band = true, fills = true, crashEvery = 4, keyPc = 0, level = 1 } = {}) {
  const G = GROOVES[groove];
  const B = G.beats;
  const nBeats = bars * B;
  const tf = tempo || TEMPOS.steady(bpm);
  // Schlagzeiten
  const beatSec = [lead];
  for (let i = 0; i < nBeats + 2; i++) beatSec.push(beatSec[i] + 60 / tf(i, nBeats));
  const posSec = (barIdx, p) => {
    const gi = barIdx * B + p;
    const i = Math.floor(gi);
    return beatSec[i] + (gi - i) * (beatSec[i + 1] - beatSec[i]);
  };
  const total = beatSec[nBeats + 1] + 1;
  const x = new Float32Array(Math.ceil(total * SR));
  const rnd = rng(seed);
  const add = (t0, len, fn) => {
    const a = Math.floor(t0 * SR);
    for (let i = 0; i < len * SR && a + i < x.length; i++) if (a + i >= 0) x[a + i] += fn(i / SR);
  };
  // --- Schlagzeug-Klänge
  let prev = 0;
  const noise = () => {
    const n = rnd();
    const v = n - prev;
    prev = n;
    return v;
  };
  const metal = (s, fs) => fs.reduce((a, f) => a + Math.sign(Math.sin(2 * Math.PI * f * s)), 0) / fs.length;
  const KIT = {
    kick: (t, v) => add(t, 0.25, (s) => v * 0.6 * Math.exp(-s / 0.06) * Math.sin(2 * Math.PI * (48 + 80 * Math.exp(-s / 0.03)) * s)),
    snare: (t, v) => add(t, 0.2, (s) => v * Math.exp(-s / 0.05) * (0.35 * rnd() + 0.2 * Math.sin(2 * Math.PI * 190 * s))),
    ghost: (t, v) => add(t, 0.1, (s) => v * 0.3 * Math.exp(-s / 0.03) * (0.35 * rnd() + 0.2 * Math.sin(2 * Math.PI * 190 * s))),
    hat: (t, v) => add(t, 0.08, (s) => v * 0.13 * Math.exp(-s / 0.025) * noise()),
    ohat: (t, v) => add(t, 0.4, (s) => v * 0.13 * Math.exp(-s / 0.15) * noise()),
    ride: (t, v) => add(t, 1.2, (s) => v * (0.05 * Math.exp(-s / 0.4) * metal(s, [3150, 4280, 5370, 6810]) + 0.04 * Math.exp(-s / 0.02) * noise())),
    crash: (t, v) => add(t, 1.5, (s) => v * (0.3 * Math.exp(-s / 0.45) * noise() + 0.04 * Math.exp(-s / 0.5) * metal(s, [2870, 4120, 5900]))),
    tom1: (t, v) => add(t, 0.3, (s) => v * 0.45 * Math.exp(-s / 0.12) * Math.sin(2 * Math.PI * (220 + 40 * Math.exp(-s / 0.02)) * s)),
    tom2: (t, v) => add(t, 0.3, (s) => v * 0.45 * Math.exp(-s / 0.14) * Math.sin(2 * Math.PI * (160 + 30 * Math.exp(-s / 0.02)) * s)),
    tom3: (t, v) => add(t, 0.35, (s) => v * 0.5 * Math.exp(-s / 0.16) * Math.sin(2 * Math.PI * (105 + 25 * Math.exp(-s / 0.02)) * s)),
  };
  const truth = [];
  const hit = (sec, inst, v = 1) => {
    KIT[inst](sec, v * level);
    truth.push({ sec, inst });
  };
  for (let b = 0; b < bars; b++) {
    const isFill = fills && b % 4 === 3 && b < bars - 1;
    const isCrash = crashEvery && b % crashEvery === 0 && b > 0;
    for (const [p, inst, v = 1] of G.bar(b)) {
      if (isFill && p >= B - 1) continue; // letzter Schlag: Fill
      if (isCrash && p === 0 && (inst === 'hat' || inst === 'ride')) continue;
      hit(posSec(b, p), inst, v);
    }
    if (isCrash) hit(posSec(b, 0), 'crash');
    if (isFill) {
      const seq = G.swing ? ['snare', 'snare', 'tom1', 'tom2', 'tom3', 'tom3'] : ['snare', 'snare', 'tom1', 'tom2'];
      const step = 1 / seq.length;
      seq.forEach((inst, k) => hit(posSec(b, B - 1 + k * step), inst, 0.9));
    }
  }
  // --- Band: Bass auf den Schwerpunkten, Akkorde, Melodie aus Akkord- und Tonleitertönen
  const melody = [];
  if (band) {
    const r2 = rng(seed + 11);
    for (let b = 0; b < bars; b++) {
      const deg = PROG[b % PROG.length];
      const rootPc = (keyPc + SCALE[deg]) % 12;
      const triad = [0, 2, 4].map((k) => (keyPc + SCALE[(deg + k) % 7]) % 12);
      for (let p = 0; p < B; p += B === 3 ? 3 : 2) {
        const f = 440 * Math.pow(2, (36 + rootPc - 69) / 12);
        const t0 = posSec(b, p);
        const d = posSec(b, Math.min(B, p + (B === 3 ? 3 : 2))) - t0;
        add(t0, d * 0.9, (s) => 0.25 * Math.min(1, s / 0.01, (d * 0.9 - s) / 0.08) * Math.exp(-s / 0.6) * (Math.sin(2 * Math.PI * f * s) + 0.4 * Math.sin(4 * Math.PI * f * s)));
      }
      const t0 = posSec(b, 0);
      const d = posSec(b + 1, 0) - t0;
      for (const pc of triad) {
        const f = 440 * Math.pow(2, (60 + pc - 69) / 12);
        add(t0, d * 0.95, (s) => 0.03 * Math.min(1, s / 0.05, (d * 0.95 - s) / 0.05) * Math.sin(2 * Math.PI * f * s));
      }
      // Melodie: Viertel/Halbe, Tonhöhen um c''
      let p = 0;
      while (p < B) {
        const len = p + 2 <= B && r2() > 0.3 ? (r2() > 0.5 ? 1 : 2) : 1;
        const useChord = p === 0 || r2() > 0.5;
        const pc = useChord ? triad[Math.floor(((r2() + 1) / 2) * 3) % 3] : (keyPc + SCALE[Math.floor(((r2() + 1) / 2) * 7) % 7]) % 12;
        const midi = 67 + ((pc - 7 + 12) % 12);
        const ts = posSec(b, p);
        const dur = posSec(b, p + len) - ts;
        const f = 440 * Math.pow(2, (midi - 69) / 12);
        add(ts, dur * 0.92, (s) => {
          const env = Math.min(1, s / 0.02) * Math.min(1, (dur * 0.92 - s) / 0.03);
          let v = 0;
          for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * s) / h;
          return 0.17 * env * v;
        });
        melody.push({ sec: ts, midi, bar: b, pos: p, len });
        p += len;
      }
    }
  }
  const barSec = Array.from({ length: bars + 1 }, (_, b) => beatSec[b * B]);
  return { audio: x, truth, beatSec: beatSec.slice(0, nBeats + 1), barSec, melody, beats: B, swing: !!G.swing };
}

// Sekunde eines Ticks der Transkription (über song.timing)
export function tickToSec(song, tick) {
  const { beatSec, firstBeat, beatTicks } = song.timing;
  const idx = firstBeat + tick / (beatTicks || 24);
  const n = beatSec.length;
  if (idx <= 0) return beatSec[0] + idx * (beatSec[1] - beatSec[0]);
  if (idx >= n - 1) return beatSec[n - 1] + (idx - n + 1) * (beatSec[n - 1] - beatSec[n - 2]);
  const i = Math.floor(idx);
  return beatSec[i] + (idx - i) * (beatSec[i + 1] - beatSec[i]);
}

const CLASS = { kick: 'kick', snare: 'snare', ghost: 'snare', hat: 'hat', ohat: 'hat', ride: 'ride', crash: 'crash', tom1: 'tom', tom2: 'tom', tom3: 'tom' };
const GM_CLASS = (m) => (m === 35 || m === 36 ? 'kick' : m === 38 || m === 40 || m === 37 ? 'snare' : m === 42 || m === 44 || m === 46 ? 'hat' : m === 51 || m === 53 || m === 59 ? 'ride' : m === 49 || m === 57 || m === 52 || m === 55 ? 'crash' : [41, 43, 45, 47, 48, 50].includes(m) ? 'tom' : 'other');

// Treffergenauigkeit je Klasse (F1) mit Zeittoleranz tol (s)
export function drumScore(song, truth, { tol = 0.04, merge = { ride: 'hat' } } = {}) {
  const cls = (c) => merge[c] || c;
  const est = song.drumNotes.map((d) => ({ sec: tickToSec(song, d.start), c: cls(GM_CLASS(d.midi)) }));
  const ref = truth.map((h) => ({ sec: h.sec, c: cls(CLASS[h.inst]) }));
  const out = {};
  for (const c of new Set([...ref.map((r) => r.c), ...est.map((e) => e.c)])) {
    const R = ref.filter((r) => r.c === c).map((r) => r.sec);
    const E = est.filter((e) => e.c === c).map((e) => e.sec);
    const used = new Set();
    let tp = 0;
    for (const r of R) {
      let best = -1;
      let bd = tol;
      E.forEach((e, i) => {
        const d = Math.abs(e - r);
        if (!used.has(i) && d <= bd) {
          bd = d;
          best = i;
        }
      });
      if (best >= 0) {
        used.add(best);
        tp++;
      }
    }
    const p = E.length ? tp / E.length : R.length ? 0 : 1;
    const r = R.length ? tp / R.length : 1;
    out[c] = { f1: p + r ? (2 * p * r) / (p + r) : 0, p, r, ref: R.length, est: E.length };
  }
  return out;
}

// Beat-Genauigkeit: Anteil der echten Schläge mit geschätztem Schlag in ±tol
export function beatScore(song, beatSec, tol = 0.05) {
  const bs = song.timing.beatSec;
  let ok = 0;
  for (const b of beatSec) if (bs.some((x) => Math.abs(x - b) <= tol)) ok++;
  return ok / beatSec.length;
}

// Taktanfänge: Anteil der echten Taktanfänge, die als Takt-"1" erkannt wurden
export function downbeatScore(song, barSec, tol = 0.05) {
  const mt = song.timing.beatTicks * song.meter.beats * (song.meter.beatType === 8 ? 1 / 3 : 1);
  const est = [];
  for (let b = 0; b < song.measureCount + 1; b++) est.push(tickToSec(song, b * mt));
  let ok = 0;
  for (const t of barSec) if (est.some((x) => Math.abs(x - t) <= tol)) ok++;
  return ok / barSec.length;
}
