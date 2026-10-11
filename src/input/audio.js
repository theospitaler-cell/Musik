// Audio (MP3/WAV/M4A/OGG/FLAC) -> Leadsheet (Melodie, Akkorde, Tempo, Takt, Tonart).
// Reine Signalverarbeitung in JavaScript (läuft im Web-Worker):
//   1. Spektrum (STFT) mit Whitening
//   2. Onset-Hüllkurve -> Tempo (Autokorrelation) -> Beat-Tracking (dynamische Programmierung)
//   3. Chroma pro Schlag -> Taktart & Taktanfänge (Akkordwechsel), Akkorde & Tonart
//   4. Melodie: harmonische Summation (Salienz) + Viterbi-Glättung -> Noten
// Das Ergebnis ist eine Annäherung – bei klaren Gesangs-/Instrumentalmelodien gut,
// bei sehr dichten Mixen weniger genau.
import { DIV } from '../core/constants.js';
import { finalizeSong } from '../theory/analysis.js';
import { harmonize } from '../theory/analysis.js';
import { detectKey } from '../theory/keys.js';
import { drumNMF, drumHitsFromActivations } from './drums-nmf.js';
import { tempoMarksFromTiming } from './tempo-marks.js';
import { fuseMelody } from './ai-pitch.js';
import { cleanPoly, separateVoices, simplifyLine } from './voices.js';
import { barFeatures, audioSections } from './form.js';

const SR = 22050;
const N = 2048;
const HOP = 441; // 20 ms
const FR = SR / HOP; // 50 Frames/s

// ---------- FFT (radix-2, komplex, in-place) ----------
function makeFFT(n) {
  const levels = Math.log2(n);
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < levels; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };
}

export function resampleMono(channels, sampleRate) {
  const len = channels[0].length;
  const mono = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] / channels.length;
  if (sampleRate === SR) return mono;
  const ratio = sampleRate / SR;
  const outLen = Math.floor(len / ratio);
  const out = new Float32Array(outLen);
  // einfacher Tiefpass (gleitender Mittelwert) gegen Aliasing, dann linear interpolieren
  const k = Math.max(1, Math.round(ratio));
  let acc = 0;
  const smooth = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    acc += mono[i];
    if (i >= k) acc -= mono[i - k];
    smooth[i] = acc / Math.min(k, i + 1);
  }
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const f = x - i0;
    out[i] = smooth[i0] * (1 - f) + (smooth[Math.min(len - 1, i0 + 1)] || 0) * f;
  }
  return out;
}

const binHz = SR / N;
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Pitch-Kandidaten für die Melodie (0,2 Halbtöne)
const P_LO = 48;
const P_HI = 86;
const P_STEP = 0.2;
const CANDS = [];
for (let m = P_LO; m <= P_HI; m += P_STEP) CANDS.push(m);

// Bandgrenzen (Hz): fein im Bass, gröber oben
const SPEC_BANDS = (() => {
  const out = [];
  for (let f = 30; f < 11000; f *= Math.pow(2, 1 / 6)) out.push(f);
  out.push(11025);
  return out;
})();

const SPEC_CENTERS = SPEC_BANDS.slice(0, -1).map((f, b) => Math.sqrt(f * SPEC_BANDS[b + 1]));

function median(arr, n) {
  // kleines Insertion-Sort (n ≤ 17)
  for (let i = 1; i < n; i++) {
    const v = arr[i];
    let j = i - 1;
    while (j >= 0 && arr[j] > v) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = v;
  }
  return arr[n >> 1];
}

// Harmonisch/Perkussiv-Trennung (Median-Filter, Fitzgerald 2010): Liegeklänge (Bass, Gesang,
// Klavier, Gitarre) sind waagrecht im Spektrogramm, Schläge senkrecht. Aus dem perkussiven Anteil
// werden Onsets je Schlagzeug-Band berechnet – Bass & Begleitung stören die Erkennung kaum noch.
function percussiveFlux(spec, nFrames, NB) {
  const KT = 17; // ~340 ms waagrecht
  const KF = 9; // ~1,5 Oktaven senkrecht
  const H = new Float32Array(nFrames * NB);
  const P = new Float32Array(nFrames * NB);
  const tmp = new Float32Array(Math.max(KT, KF));
  for (let b = 0; b < NB; b++)
    for (let t = 0; t < nFrames; t++) {
      let n = 0;
      for (let k = t - (KT >> 1); k <= t + (KT >> 1); k++) tmp[n++] = k >= 0 && k < nFrames ? spec[k * NB + b] : 0;
      H[t * NB + b] = median(tmp, n);
    }
  for (let t = 0; t < nFrames; t++)
    for (let b = 0; b < NB; b++) {
      let n = 0;
      for (let k = b - (KF >> 1); k <= b + (KF >> 1); k++) tmp[n++] = k >= 0 && k < NB ? spec[t * NB + k] : 0;
      P[t * NB + b] = median(tmp, n);
    }
  // weiche Maske
  const Xp = new Float32Array(nFrames * NB);
  const Xh = new Float32Array(nFrames * NB);
  for (let i = 0; i < Xp.length; i++) {
    const p2 = P[i] * P[i];
    const h2 = H[i] * H[i];
    const m = p2 / (p2 + h2 + 1e-12);
    Xp[i] = spec[i] * m;
    Xh[i] = spec[i] * (1 - m);
  }
  const bandIdx = (lo, hi) => {
    const out = [];
    for (let b = 0; b < NB; b++) if (SPEC_BANDS[b] >= lo && SPEC_BANDS[b + 1] <= hi * 1.06) out.push(b);
    return out;
  };
  const kickB = bandIdx(35, 130);
  const snareB = [...bandIdx(150, 320), ...bandIdx(1000, 5000)];
  const hatB = bandIdx(6000, 11025);
  const rideB = bandIdx(3000, 7000);
  const fluxOf = (bands) => {
    const out = new Float32Array(nFrames);
    for (let t = 1; t < nFrames; t++) {
      let f = 0;
      for (const b of bands) {
        const d = Math.log1p(50 * Xp[t * NB + b]) - Math.log1p(50 * Xp[(t - 1) * NB + b]);
        if (d > 0) f += d;
      }
      out[t] = f;
    }
    return out;
  };
  // Nachklang im hohen Band (Ride/Crash klingen lange, geschlossene Hi-Hat nicht)
  const sustainHigh = new Float32Array(nFrames);
  const percHigh = new Float32Array(nFrames);
  for (let t = 0; t < nFrames; t++) {
    let sh = 0;
    let ph = 0;
    for (const b of rideB) {
      sh += Xh[t * NB + b];
      ph += Xp[t * NB + b];
    }
    sustainHigh[t] = sh;
    percHigh[t] = ph;
  }
  return { lowP: fluxOf(kickB), midP: fluxOf(snareB), highP: fluxOf(hatB), sustainHigh, percHigh, Xp, NB };
}

export function analyzeFrames(x, onProgress) {
  const fft = makeFFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const nFrames = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const mag = new Float32Array(N / 2);
  const prevLog = new Float32Array(N / 2);
  const onset = new Float32Array(nFrames);
  const energy = new Float32Array(nFrames);
  // Schlagzeug-Bänder: Bass Drum (tief), Snare (Mitten/Rauschen), Hi-Hat (hoch)
  const lowF = new Float32Array(nFrames);
  const midF = new Float32Array(nFrames);
  const highF = new Float32Array(nFrames);
  // Bandspektrogramm (log-verteilt, 30 Hz – 11 kHz) für die Schlagzeug-Trennung (HPSS)
  const NB = SPEC_BANDS.length - 1;
  const specBand = new Int16Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = k * binHz;
    for (let b = 0; b < NB; b++) if (f >= SPEC_BANDS[b] && f < SPEC_BANDS[b + 1]) specBand[k] = b;
  }
  const spec = new Float32Array(nFrames * NB);
  const bandOf = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = k * binHz;
    if (f >= 30 && f <= 130) bandOf[k] = 0;
    else if (f >= 1500 && f <= 4500) bandOf[k] = 1;
    else if (f >= 6500 && f <= 10500) bandOf[k] = 2;
  }
  const chroma = new Float32Array(nFrames * 12);
  const bass = new Float32Array(nFrames * 12);
  const topP = new Float32Array(nFrames * 4);
  const topS = new Float32Array(nFrames * 4);
  const maxBin = Math.floor(5000 / binHz);
  const env = new Float32Array(N / 2);
  const sal = new Float32Array(CANDS.length);
  // Chroma-Zuordnung je Bin
  const pcOfBin = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = k * binHz;
    if (f < 30 || f > 4200) continue;
    const m = 69 + 12 * Math.log2(f / 440);
    pcOfBin[k] = ((Math.round(m) % 12) + 12) % 12;
  }
  for (let t = 0; t < nFrames; t++) {
    const off = t * HOP;
    let e = 0;
    for (let i = 0; i < N; i++) {
      const v = (x[off + i] || 0) * win[i];
      re[i] = v;
      im[i] = 0;
      e += v * v;
    }
    energy[t] = Math.sqrt(e / N);
    fft(re, im);
    let flux = 0;
    let lf = 0;
    let mf = 0;
    let hf = 0;
    for (let k = 0; k < N / 2; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag[k] = m;
      const lg = Math.log1p(100 * m);
      const d = lg - prevLog[k];
      if (d > 0) {
        if (k < maxBin) flux += d;
        const bd = bandOf[k];
        if (bd === 0) lf += d;
        else if (bd === 1) mf += d;
        else if (bd === 2) hf += d;
      }
      prevLog[k] = lg;
    }
    for (let k = 1; k < N / 2; k++) if (specBand[k] >= 0) spec[t * NB + specBand[k]] += mag[k];
    onset[t] = flux;
    lowF[t] = lf;
    midF[t] = mf;
    highF[t] = hf;
    // Chroma (Obertöne) & Bass-Chroma
    for (let k = 1; k < N / 2; k++) {
      const pc = pcOfBin[k];
      if (pc < 0) continue;
      const f = k * binHz;
      const v = Math.sqrt(mag[k]);
      if (f < 250) bass[t * 12 + pc] += v;
      else chroma[t * 12 + pc] += v;
    }
    // Whitening: durch geglättete Hüllkurve teilen (betont Teiltöne gegenüber Rauschen)
    const R = 8;
    let s = 0;
    for (let k = 0; k < Math.min(N / 2, R); k++) s += mag[k];
    for (let k = 0; k < maxBin + 20 && k < N / 2; k++) {
      if (k + R < N / 2) s += mag[k + R];
      if (k - R - 1 >= 0) s -= mag[k - R - 1];
      env[k] = s / (2 * R + 1);
    }
    // Harmonische Summation
    let best = 0;
    for (let c = 0; c < CANDS.length; c++) {
      const f0 = midiToHz(CANDS[c]);
      let sum = 0;
      let w = 1;
      for (let h = 1; h <= 10; h++) {
        const fh = f0 * h;
        if (fh > 5000) break;
        const b = fh / binHz;
        const b0 = Math.floor(b);
        let m = 0;
        for (let k = b0 - 1; k <= b0 + 1; k++) {
          if (k <= 0 || k >= N / 2) continue;
          const v = mag[k] / (env[k] + 1e-6);
          if (v > m) m = v;
        }
        sum += w * Math.sqrt(m);
        w *= 0.8;
      }
      sal[c] = sum;
      if (sum > best) best = sum;
    }
    // Top-4 lokale Maxima
    const peaks = [];
    for (let c = 1; c < CANDS.length - 1; c++) if (sal[c] >= sal[c - 1] && sal[c] >= sal[c + 1]) peaks.push(c);
    peaks.sort((a, b) => sal[b] - sal[a]);
    for (let q = 0; q < 4; q++) {
      const c = peaks[q];
      topP[t * 4 + q] = c === undefined ? -1 : CANDS[c];
      topS[t * 4 + q] = c === undefined ? 0 : sal[c];
    }
    if (onProgress && t % 200 === 0) onProgress('Spektrum wird analysiert', (t / nFrames) * 0.45);
  }
  if (onProgress) onProgress('Schlagzeug wird vom Rest getrennt', 0.45);
  const perc = percussiveFlux(spec, nFrames, NB);
  return { nFrames, onset, energy, chroma, bass, topP, topS, lowF, midF, highF, ...perc };
}

// ---------- Tempo & Beats ----------
export function trackBeats(onsetRaw) {
  const n = onsetRaw.length;
  // Normalisieren, lokales Mittel abziehen
  const o = new Float32Array(n);
  const W = 25;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += onsetRaw[i];
    if (i >= W) acc -= onsetRaw[i - W];
    const mean = acc / Math.min(W, i + 1);
    o[i] = Math.max(0, onsetRaw[i] - mean);
  }
  let sd = 0;
  for (let i = 0; i < n; i++) sd += o[i] * o[i];
  sd = Math.sqrt(sd / n) || 1;
  for (let i = 0; i < n; i++) o[i] /= sd;
  // geglättete Hüllkurve für die Periodensuche (scharfe Spitzen treffen ganzzahlige Lags sonst
  // nur zufällig – das führte bei 16tel-Hi-Hats zu 2/3-Tempo-Fehlern)
  const os = new Float32Array(n);
  for (let i = 0; i < n; i++) os[i] = 0.4 * o[i] + 0.2 * ((o[i - 1] || 0) + (o[i + 1] || 0)) + 0.1 * ((o[i - 2] || 0) + (o[i + 2] || 0));
  const tempo = tempoCurve(os);
  const Pg = tempo.globalLag;
  // Periode je Frame (Tempowechsel, rit./accel.)
  const Pt = tempo.lagAt;
  // Dynamische Programmierung (Ellis) mit örtlicher Periode
  // Übergangskosten: Abweichung vom vorigen Schlagabstand (stetige Tempoänderung wie rit./accel.
  // bleibt billig) und schwächer vom örtlichen Tempo der Tempokurve.
  // strict: eng am Raster des Grundtempos bleiben (für Stücke mit gleichmäßigem Tempo)
  const tight = 100;
  const jumpCap = 3;
  const tightCurve = 30;
  const run = (strict) => {
    const score = new Float32Array(n);
    const back = new Int32Array(n).fill(-1);
    for (let t = 0; t < n; t++) {
      let best = 0;
      let arg = -1;
      const P = Pt[t];
      const tc = strict && Math.abs(P / Pg - 1) < 0.012 ? 3 * tightCurve : tightCurve;
      for (let tau = t - Math.round(2 * P); tau <= t - Math.round(P / 2); tau++) {
        if (tau < 0) continue;
        const I = back[tau] >= 0 ? tau - back[tau] : P;
        const d = Math.log((t - tau) / I);
        const dc = Math.log((t - tau) / P);
        const v = score[tau] - Math.min(tight * d * d, jumpCap) - tc * dc * dc;
        if (arg < 0 || v > best) {
          best = v;
          arg = tau;
        }
      }
      score[t] = o[t] + (arg >= 0 ? best : 0);
      back[t] = arg;
    }
    // Ende: bestes Score im letzten Periodenfenster
    let t = n - 1;
    let bestEnd = -Infinity;
    for (let i = Math.max(0, n - Math.round(Pt[n - 1] || Pg)); i < n; i++)
      if (score[i] > bestEnd) {
        bestEnd = score[i];
        t = i;
      }
    const bs = [];
    while (t >= 0) {
      bs.push(t);
      t = back[t];
    }
    return bs.reverse();
  };
  let beats = run(false);
  // Gleichmäßiges Tempo? Dann zieht eine Synkopen-Figur (z. B. ein Intro ohne Schlagzeug) den
  // Schlag leicht über ein paar Takte schneller oder langsamer – und schiebt so unbemerkt einen
  // Schlag ein. Echte Änderungen sehen anders aus: sie halten mindestens 8 Takte an
  // (Tempowechsel) oder stehen am Schluss (rit.). Ohne solche Änderungen: zweiter Durchgang
  // eng am Raster.
  {
    const win = [];
    for (let i = 0; i + 8 < beats.length; i += 8) win.push((beats[i + 8] - beats[i]) / 8);
    const sorted = [...win].sort((x, y) => x - y);
    const med8 = sorted[Math.floor(sorted.length / 2)] || Pg;
    const dev = win.map((v) => v / med8 - 1);
    let sustained = false;
    for (let i = 0; i + 4 <= dev.length; i++) {
      const seg = dev.slice(i, i + 4);
      if (seg.every((v) => v > 0.05) || seg.every((v) => v < -0.05)) sustained = true;
    }
    const tail = beats.length >= 10 ? (beats[beats.length - 1] - beats[beats.length - 5]) / 4 / med8 - 1 : 0;
    const lastWin = dev.length ? dev[dev.length - 1] : 0;
    const finalChange = Math.abs(tail) > 0.08 || Math.abs(lastWin) > 0.08;
    if (win.length >= 6 && !sustained && !finalChange) beats = run(true);
  }
  repairBeats(beats);
  const ibis = [];
  for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
  ibis.sort((a, b) => a - b);
  const med = ibis.length ? ibis[Math.floor(ibis.length / 2)] : Pg;
  let bpm = (60 * FR) / med;
  return { beats, bpm, onset: o, lagAt: Pt, barLag: tempo.barLag };
}

// Ausrutscher reparieren: ein starker Anschlag einer Synkope kann einen Schlag „stehlen“ oder
// einen zusätzlichen einschieben – danach lägen alle Taktstriche einen Schlag daneben. Liegt eine
// kurze Folge unregelmäßiger Schlagabstände zwischen zwei ruhigen Stellen und passt in die Lücke
// eine ganze Zahl normaler Schläge, werden die Schläge dort gleichmäßig verteilt. Stetige
// Änderungen (rit., accel., Tempowechsel) bleiben unberührt: sie passen nicht ins alte Raster.
export function repairBeats(beats, depth = 0) {
  const n = beats.length;
  if (n < 12) return beats;
  const ibi = (i) => beats[i + 1] - beats[i];
  const localMed = (i) => {
    const a = [];
    for (let k = Math.max(0, i - 8); k < Math.min(n - 1, i + 9); k++) a.push(ibi(k));
    a.sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  const bad = [];
  for (let i = 0; i < n - 1; i++) bad.push(Math.abs(ibi(i) / localMed(i) - 1) > 0.12);
  let i = 0;
  while (i < n - 1) {
    if (!bad[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n - 1 && (bad[j + 1] || (j + 2 < n - 1 && bad[j + 2]))) j++;
    // Anker: je ein ruhiger Schlag davor und danach
    const a = i;
    const b = j + 1;
    if (a >= 1 && b <= n - 2 && b - a <= 8) {
      const med = (localMed(Math.max(0, a - 1)) + localMed(Math.min(n - 2, b))) / 2;
      const span = beats[b] - beats[a];
      const k = Math.round(span / med);
      if (k >= 1 && Math.abs(span / k / med - 1) < 0.07) {
        const fixed = [];
        for (let q = 1; q < k; q++) fixed.push(Math.round(beats[a] + (q * span) / k));
        beats.splice(a + 1, b - a - 1, ...fixed);
        return depth < 40 ? repairBeats(beats, depth + 1) : beats; // Indizes haben sich verschoben: von vorn
      }
    }
    i = j + 1;
  }
  return beats;
}

function medianIbi(beats) {
  const d = [];
  for (let i = 1; i < beats.length; i++) d.push(beats[i] - beats[i - 1]);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)] || 1;
}

// Harmonik je Schlag aus mehrstimmig gehörten Noten: c = Tonklassen über dem Bass, b = Bass.
// (Das Spektrum löst unter ~250 Hz keine Halbtöne auf – die KI-Noten schon.)
export function noteBeatChroma(ai, beatPos, nBeats) {
  const out = Array.from({ length: nBeats }, () => ({ c: new Float32Array(12), b: new Float32Array(12) }));
  const low = new Map();
  const span = ai.map((n) => ({ a: beatPos(n.start), z: beatPos(n.end), midi: n.midi, amp: n.amp ?? 0.5 }));
  for (const n of span) {
    const k = Math.floor(n.a);
    if (!low.has(k) || n.midi < low.get(k)) low.set(k, n.midi);
  }
  const lows = [...low.values()].sort((a, b) => a - b);
  const bassTop = (lows[Math.floor(lows.length / 2)] ?? 40) + 9;
  for (const n of span) {
    const pc = ((n.midi % 12) + 12) % 12;
    for (let k = Math.max(0, Math.floor(n.a)); k < Math.min(nBeats, Math.ceil(Math.min(n.z, n.a + 4))); k++) {
      const w = (Math.min(n.z, k + 1) - Math.max(n.a, k)) * (0.3 + n.amp);
      if (w <= 0) continue;
      if (n.midi <= bassTop) out[k].b[pc] += w;
      else out[k].c[pc] += w;
    }
  }
  // Gewicht des Basses auf jedem Schlag: tiefe, lange Töne genau auf dem Schlag (die Grundtöne
  // der Harmonie) – sie markieren den Taktanfang, auch ohne Schlagzeug
  const root = new Float32Array(nBeats);
  for (const n of span) {
    if (n.midi > bassTop) continue;
    const k = Math.round(n.a);
    if (k < 0 || k >= nBeats || Math.abs(n.a - k) > 0.2) continue;
    root[k] += (0.3 + n.amp) * Math.min(2, Math.max(0.25, n.z - n.a)) * (1 + Math.max(0, bassTop - n.midi) / 12);
  }
  out.low = Array.from(root);
  for (const x of out) {
    const mc = Math.max(...x.c) || 1;
    const mb = Math.max(...x.b) || 1;
    for (let k = 0; k < 12; k++) {
      x.c[k] /= mc;
      x.b[k] /= mb;
    }
  }
  return out;
}

// Autokorrelation mit Bruchteil-Lags (lineare Interpolation)
function acfOf(x, a, z, maxLag) {
  const acf = new Float32Array(maxLag + 2);
  const len = z - a;
  for (let lag = 1; lag <= maxLag + 1 && lag < len; lag++) {
    let ac = 0;
    for (let i = a + lag; i < z; i++) ac += x[i] * x[i - lag];
    acf[lag] = ac / (len - lag);
  }
  return (lag) => {
    const i = Math.floor(lag);
    if (i < 1 || i + 1 >= acf.length) return 0;
    const f = lag - i;
    return acf[i] * (1 - f) + acf[i + 1] * f;
  };
}

// Tempo-Kandidaten (BPM, logarithmisch, 1 %-Schritte)
const TEMPO_CANDS = [];
for (let b = 40; b <= 220; b *= 1.01) TEMPO_CANDS.push(b);

// Bewertung eines Tempos: Periode, ihre Vielfachen (Takt-Wiederholung) und die Unterteilung
// in Achtel (echte Schläge haben Unterteilungen; das 1,5-fache des Schlags nicht)
function tempoSalience(A, lag) {
  return A(lag) + 0.5 * Math.max(A(2 * lag), A(3 * lag)) + 0.25 * Math.max(A(4 * lag), A(6 * lag)) + 0.3 * Math.max(A(lag / 2), 0.7 * A(lag / 3));
}
const tempoPrior = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 105) / 0.8, 2));

// Takt-Periode: Wiederholt sich das Rhythmus-Muster in einem Abstand von 1,2–4,5 s deutlich
// stärker als in allen anderen (typisch: ein Takt oder zwei), muss der Schlag diese Periode
// ganzzahlig teilen. Das schließt Schein-Tempi aus, die nur aus einer Synkopen-Figur stammen
// (z. B. punktierte Achtel = 4/3 des Tempos – die Figur passt nie in den Takt).
const BAR_DIVS = [2, 3, 4, 6, 8, 12, 16];
export function dominantPeriod(A, n) {
  const lo = Math.round(1.2 * FR);
  const hi = Math.min(Math.round(4.5 * FR), Math.floor(n / 3));
  const peaks = [];
  for (let l = lo; l <= hi; l++) {
    const v = A(l);
    if (v > 0 && v >= A(l - 1) && v >= A(l + 1) && v >= A(l - 2) && v >= A(l + 2)) peaks.push({ l, v });
  }
  if (!peaks.length) return null;
  peaks.sort((a, b) => b.v - a.v);
  const top = peaks[0];
  // Vielfache/Teiler derselben Periode (halber, doppelter Takt) sind keine Konkurrenten
  const related = (l) => [1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3].some((r) => Math.abs(Math.log(l / (top.l * r))) < 0.04);
  const rival = peaks.find((p) => !related(p.l));
  if (rival && top.v < 1.15 * rival.v) return null;
  // Lage der Spitze auf Bruchteile eines Frames genau (Parabel)
  const a = A(top.l - 1);
  const b = top.v;
  const c = A(top.l + 1);
  const d = a - 2 * b + c;
  return top.l + (d < 0 ? (0.5 * (a - c)) / d : 0);
}

// Tempokurve: globales Tempo + örtliches Tempo je Fenster (Viterbi über die Fenster,
// Sprünge kosten, bleiben aber möglich – für Tempowechsel zwischen Formteilen und rit.)
export function tempoCurve(os) {
  const n = os.length;
  const maxLag = Math.ceil((60 / 40) * FR * 6) + 2;
  const Ag = acfOf(os, 0, n, Math.min(maxLag, n - 2));
  let gBest = 105;
  let gScore = -Infinity;
  const gS = TEMPO_CANDS.map((bpm) => tempoSalience(Ag, (60 * FR) / bpm));
  const bar = dominantPeriod(Ag, n);
  const fitsBar = (bpm) => !bar || BAR_DIVS.some((k) => Math.abs(Math.log(bar / k / ((60 * FR) / bpm))) < 0.025);
  TEMPO_CANDS.forEach((bpm, k) => {
    if (!fitsBar(bpm)) return;
    const sc = gS[k] * tempoPrior(bpm);
    if (sc > gScore) {
      gScore = sc;
      gBest = bpm;
    }
  });
  const globalLag = (60 * FR) / gBest;
  const W = 400; // 8 s Fenster
  const H = 50; // 1 s Schritt
  const lagAt = new Float32Array(n).fill(globalLag);
  if (n < 2 * W) return { globalLag, globalBpm: gBest, lagAt, barLag: bar };
  // nur Tempi in der Nähe des globalen (±45 %) – keine Oktavfehler je Fenster
  const cands = TEMPO_CANDS.filter((b) => b >= gBest / 1.45 && b <= gBest * 1.45);
  const wins = [];
  for (let c = W / 2; c + W / 2 <= n; c += H) {
    const A = acfOf(os, c - W / 2, c + W / 2, Math.min(W - 2, Math.ceil((60 * FR * 6) / cands[0]) + 2));
    const s = cands.map((bpm) => tempoSalience(A, (60 * FR) / bpm));
    const mx = Math.max(...s) || 1;
    // leichte Bevorzugung des Grundtempos; typische Fehl-Lagen (3:4, 2:3 – Triolen-Vielfache,
    // z. B. bei Shuffle) kosten etwas, echte Tempowechsel setzen sich trotzdem durch
    // klingt das Grundtempo in diesem Fenster noch deutlich? Dann sind 3:4/2:3-Lagen Fehl-Lagen,
    // sonst ein echter Tempowechsel (alle Anschläge haben das neue Tempo)
    // (nur die direkte Periode zählt – gemeinsame Vielfache wie 3 alte = 4 neue Schläge nicht)
    const direct = cands.map((bpm) => A((60 * FR) / bpm));
    const gDirect = Math.max(A(globalLag * 0.98), A(globalLag), A(globalLag * 1.02));
    const gStill = gDirect >= 0.6 * Math.max(...direct);
    wins.push({
      c,
      s: s.map((v, k) => {
        const r = Math.log2(cands[k] / gBest);
        const metric = [Math.log2(3 / 4), Math.log2(4 / 3), Math.log2(2 / 3), Math.log2(3 / 2)].some((x) => Math.abs(r - x) < 0.06);
        return v / mx + 0.15 * Math.exp(-0.5 * Math.pow(r / 0.08, 2)) - (metric && gStill ? 0.3 : 0);
      }),
    });
  }
  // Viterbi: Emission = normierte Salienz, Übergang = Kosten für Tempoänderung
  const K = cands.length;
  let prev = wins[0].s.map((v, k) => v + 0.3 * Math.exp(-0.5 * Math.pow(Math.log2(cands[k] / gBest) / 0.1, 2)));
  const back = [];
  for (let w = 1; w < wins.length; w++) {
    const cur = new Float32Array(K);
    const bk = new Int16Array(K);
    for (let k = 0; k < K; k++) {
      let best = -Infinity;
      let arg = k;
      for (let j = Math.max(0, k - 40); j < Math.min(K, k + 41); j++) {
        const d = Math.abs(k - j); // 1 % je Schritt
        const v = prev[j] - (d <= 2 ? 0.02 * d : 0.15 + 0.012 * d);
        if (v > best) {
          best = v;
          arg = j;
        }
      }
      cur[k] = best + wins[w].s[k];
      bk[k] = arg;
    }
    back.push(bk);
    prev = cur;
  }
  let k = prev.indexOf(Math.max(...prev));
  const path = new Array(wins.length);
  for (let w = wins.length - 1; w >= 0; w--) {
    path[w] = k;
    if (w > 0) k = back[w - 1][k];
  }
  // Kurze Ausflüge, die wieder beim Grundtempo landen (höchstens ~14 s, weniger als 20 %
  // Abweichung), sind fast immer Fehl-Lagen einer Synkopen-Figur (z. B. ein Intro ohne
  // Schlagzeug) – kein rit./accel. Dort gilt das Grundtempo; echte Änderungen bleiben: sie
  // halten länger an oder enden nicht wieder im alten Tempo (Schluss-rit., Tempowechsel).
  {
    const base = cands.reduce((b, c, i) => (Math.abs(c - gBest) < Math.abs(cands[b] - gBest) ? i : b), 0);
    const off = (w) => Math.abs(cands[path[w]] / gBest - 1) > 0.03;
    let w = 0;
    while (w < path.length) {
      if (!off(w)) {
        w++;
        continue;
      }
      let z = w;
      while (z + 1 < path.length && off(z + 1)) z++;
      const bounded = w > 0 && z < path.length - 1;
      const small = path.slice(w, z + 1).every((k2) => Math.abs(cands[k2] / gBest - 1) < 0.2);
      if (bounded && small && z - w + 1 <= 14) for (let q = w; q <= z; q++) path[q] = base;
      w = z + 1;
    }
  }
  // je Frame interpolieren
  for (let t = 0; t < n; t++) {
    const x = (t - wins[0].c) / H;
    const i = Math.max(0, Math.min(wins.length - 1, Math.floor(x)));
    const j = Math.min(wins.length - 1, i + 1);
    const f = Math.max(0, Math.min(1, x - i));
    const bpm = cands[path[i]] * (1 - f) + cands[path[j]] * f;
    lagAt[t] = (60 * FR) / bpm;
  }
  return { globalLag, globalBpm: gBest, lagAt, barLag: bar };
}

export function beatChroma(beats, feat, nFrames) {
  const out = [];
  for (let i = 0; i < beats.length; i++) {
    const a = beats[i];
    const b = i + 1 < beats.length ? beats[i + 1] : Math.min(nFrames, a + (beats[i] - (beats[i - 1] ?? a - 25)));
    const c = new Float32Array(12);
    const bs = new Float32Array(12);
    for (let t = a; t < b; t++) for (let k = 0; k < 12; k++) {
      c[k] += feat.chroma[t * 12 + k];
      bs[k] += feat.bass[t * 12 + k];
    }
    const mx = Math.max(...c) || 1;
    const mb = Math.max(...bs) || 1;
    for (let k = 0; k < 12; k++) {
      c[k] /= mx;
      bs[k] /= mb;
    }
    out.push({ c, b: bs });
  }
  return out;
}

function cosine(a, b) {
  let s = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < 12; k++) {
    s += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}

// Taktart (3 oder 4) und Lage des ersten Taktanfangs.
// Hinweise je Schlag: Bass-Drum (tief) auf der "1", Snare auf 2/4 (Backbeat),
// Harmoniewechsel (Bass-Chroma & Takt-Chroma) am Taktanfang.
export function findMeter(bc, cues = {}) {
  const n = bc.length;
  const low = cues.low || new Array(n).fill(0);
  const mid = cues.mid || new Array(n).fill(0);
  const onset = cues.onset || new Array(n).fill(0);
  const crash = cues.crash || new Array(n).fill(0); // Becken-Akzent auf dem Schlag
  const fillPre = cues.fillPre || new Array(n).fill(0); // dichte Schläge im Schlag davor (Fill)
  const lowBass = cues.lowBass || new Array(n).fill(0); // tiefe, lange Basstöne auf dem Schlag
  const some = (a) => a.some((v) => v > 0);
  // Basswechsel nur, wo auf beiden Schlägen ein Bass klingt (Pausen sind kein Harmoniewechsel)
  const bassChange = bc.map((x, i) => (i && some(x.b) && some(bc[i - 1].b) ? 1 - cosine(x.b, bc[i - 1].b) : 0));
  const z = (arr) => {
    const m = mean(arr);
    const sd = Math.sqrt(mean(arr.map((v) => (v - m) ** 2))) || 1;
    return arr.map((v) => (v - m) / sd);
  };
  const evalMeter = (m, keys) => {
    const res = [];
    for (let ph = 0; ph < m; ph++) {
      const on = (i) => (((i - ph) % m) + m) % m === 0;
      const back = (i) => m === 4 && (((i - ph) % m) + m) % m % 2 === 1;
      const avgOn = (arr) => mean(arr.filter((_, i) => on(i))) - mean(arr.filter((_, i) => !on(i)));
      // Takt-Chroma: Unterschied zwischen aufeinanderfolgenden Takten (Akkordwechsel an Taktgrenzen)
      const bars = [];
      for (let s0 = ph; s0 + m <= n; s0 += m) {
        const c = new Float32Array(12);
        for (let k = s0; k < s0 + m; k++) for (let q = 0; q < 12; q++) c[q] += bc[k].c[q] + bc[k].b[q];
        bars.push(c);
      }
      let nov = 0;
      for (let k = 1; k < bars.length; k++) nov += 1 - cosine(bars[k], bars[k - 1]);
      nov /= Math.max(1, bars.length - 1);
      // Gegenprobe: dieselbe Novelty, aber um einen halben Takt versetzt
      res.push({
        ph,
        kick: avgOn(low),
        snare: m === 4 ? mean(mid.filter((_, i) => back(i))) - mean(mid.filter((_, i) => !back(i))) : 0,
        bass: avgOn(bassChange),
        onset: avgOn(onset),
        crash: avgOn(crash),
        fill: avgOn(fillPre),
        root: avgOn(lowBass),
        nov,
      });
    }
    // je Merkmal über die Phasen normieren und gewichten
    const tot = new Array(m).fill(0);
    for (const [k, w] of Object.entries(keys)) {
      const vals = res.map((r) => r[k]);
      const spread = Math.max(...vals) - Math.min(...vals);
      if (spread < 1e-6) continue;
      z(vals).forEach((v, i) => (tot[i] += w * v));
    }
    let best = 0;
    for (let i = 1; i < m; i++) if (tot[i] > tot[best]) best = i;
    res.all = tot;
    if (cues.debug) cues.debug({ m, keys, res: res.map((r) => ({ ...r })), tot });
    // Stärke: Abstand der besten Phase zum Mittel
    const raw = res[best];
    return { phase: best, score: raw.kick + raw.bass + raw.nov * 2 + raw.onset * 0.1, all: tot };
  };
  const base = { kick: 1.2, snare: 0.8, bass: 1, onset: 0.3, nov: 1.2 };
  // Snare-Muster (4/4): normaler Backbeat (2 & 4) oder Half-Time (nur 3)? Daraus folgt die "1".
  const snarePhase = () => {
    const cls = [0, 0, 0, 0];
    const cnt = [0, 0, 0, 0];
    mid.forEach((v, i) => {
      cls[i % 4] += v;
      cnt[i % 4]++;
    });
    const mean = cls.map((v, k) => v / Math.max(1, cnt[k]));
    const order = [0, 1, 2, 3].sort((a, b) => mean[b] - mean[a]);
    const [hi, second] = order;
    const lowest = mean[order[3]];
    if (mean[hi] - lowest < 0.15) return null; // kein klares Muster
    if (mean[second] >= 0.6 * mean[hi] && (second - hi + 4) % 4 === 2) return { type: 'backbeat', phases: [(hi + 3) % 4, (hi + 1) % 4] };
    if (mean[second] < 0.6 * mean[hi]) return { type: 'halftime', phases: [(hi + 2) % 4] };
    return null;
  };
  // Taktart aus den Grundmerkmalen; die Lage der "1" zusätzlich mit Crash & Fills
  // (nur wenn diese deutlich und mehrfach vorkommen – sonst sind sie Rauschen)
  // Crash & Fill nur als schwacher Zusatz-Hinweis (in dichten Mixen sind sie unzuverlässig)
  const withAcc = { ...base, crash: 0.4, fill: 0.3, root: 1 };
  const m4 = evalMeter(4, base);
  const m3 = evalMeter(3, base);
  let beatsPer = m3.score > m4.score * 1.35 && m3.score > 0.05 ? 3 : 4;
  // Wiederholt sich das Rhythmus-Muster deutlich alle 4 (2, 8) bzw. 3 (6) Schläge, entscheidet das
  if (cues.barBeats) {
    const near = (k) => Math.abs(Math.log(cues.barBeats / k)) < 0.06;
    if ([2, 4, 8, 16].some(near)) beatsPer = 4;
    else if ([3, 6].some(near)) beatsPer = 3;
  }
  if (beatsPer === 4) {
    const sp = snarePhase();
    if (cues.debug) cues.debug({ snare: sp, barBeats: cues.barBeats });
    if (sp && sp.phases.length === 1) return { beats: 4, phase: sp.phases[0], snare: sp.type };
    if (sp) {
      // Backbeat: nur zwei Lagen möglich – davon die mit mehr Bass-Drum/Harmoniewechsel auf der "1"
      const keys = { kick: 1.2, bass: 1, nov: 1.2, crash: 0.4, fill: 0.3, root: 1.5 };
      const all = evalMeter(4, keys);
      const scores = all.all;
      const best = sp.phases.reduce((a, b) => (scores[b] > scores[a] ? b : a));
      return { beats: 4, phase: best, snare: sp.type };
    }
  }
  return { beats: beatsPer, phase: evalMeter(beatsPer, withAcc).phase };
}

// ---------- Melodie ----------
export function trackMelody(feat, onProgress) {
  const { nFrames, topP, topS, energy } = feat;
  // Schwellen
  const tops = [];
  for (let t = 0; t < nFrames; t++) tops.push(topS[t * 4]);
  const sorted = [...tops].sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))] || 0;
  const thr = Math.min(q(0.35), 0.8 * (q(0.97) || 1));
  const sMax = q(0.97) || 1;
  const eSorted = [...energy].sort((a, b) => a - b);
  const eThr = Math.min(eSorted[Math.floor(0.1 * (eSorted.length - 1))] * 1.3, eSorted[Math.floor(0.5 * (eSorted.length - 1))] * 0.35);
  const K = 5; // 4 Kandidaten + stimmlos
  const score = new Float32Array(nFrames * K);
  const back = new Int8Array(nFrames * K);
  const pitchOf = (t, k) => (k < 4 ? topP[t * 4 + k] : -1);
  const emit = (t, k) => {
    if (k === 4) return thr / sMax;
    const p = topP[t * 4 + k];
    if (p < 0 || energy[t] < eThr) return -5;
    // leichte Bevorzugung höherer Kandidaten gegenüber Begleitstimmen/Bass
    return topS[t * 4 + k] / sMax + (p - 60) * 0.004;
  };
  for (let k = 0; k < K; k++) score[k] = emit(0, k);
  for (let t = 1; t < nFrames; t++) {
    for (let k = 0; k < K; k++) {
      const pk = pitchOf(t, k);
      let best = -Infinity;
      let arg = 0;
      for (let j = 0; j < K; j++) {
        const pj = pitchOf(t - 1, j);
        let tr;
        if (k === 4 && j === 4) tr = 0;
        else if (k === 4 || j === 4) tr = -0.35;
        else {
          const d = Math.abs(pk - pj);
          tr = -0.06 * d - (d > 7 ? 0.6 : 0);
        }
        const v = score[(t - 1) * K + j] + tr;
        if (v > best) {
          best = v;
          arg = j;
        }
      }
      score[t * K + k] = best + emit(t, k);
      back[t * K + k] = arg;
    }
    if (onProgress && t % 500 === 0) onProgress('Melodie wird erkannt', 0.55 + (t / nFrames) * 0.2);
  }
  let k = 0;
  let bestEnd = -Infinity;
  for (let j = 0; j < K; j++)
    if (score[(nFrames - 1) * K + j] > bestEnd) {
      bestEnd = score[(nFrames - 1) * K + j];
      k = j;
    }
  const path = new Float32Array(nFrames);
  const sal = new Float32Array(nFrames); // Salienz des gewählten Tons (für Neuanschläge)
  for (let t = nFrames - 1; t >= 0; t--) {
    path[t] = pitchOf(t, k);
    sal[t] = k < 4 ? topS[t * 4 + k] : 0;
    k = back[t * K + k];
  }
  path.sal = sal;
  return path; // MIDI (Bruchteile) oder -1
}

export function segmentNotes(path, sal = path.sal) {
  const notes = [];
  let cur = null;
  // Neuanschlag desselben Tons: Salienz bricht kurz ein und steigt wieder
  const reattack = (t) => {
    if (!sal || t < 3 || t + 2 >= sal.length) return false;
    let mx = 0;
    for (let k = t - 6; k < t; k++) if (k >= 0) mx = Math.max(mx, sal[k]);
    return sal[t] < 0.6 * mx && sal[t + 2] > sal[t] * 1.3 && sal[t] <= sal[t - 1] && sal[t] <= sal[t + 1];
  };
  const flush = () => {
    if (!cur) return;
    const vals = cur.vals.slice().sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    let sm = 0;
    if (sal) for (let k = cur.start; k < cur.end; k++) sm += sal[k];
    if (cur.end - cur.start >= 3) notes.push({ start: cur.start, end: cur.end, midi: Math.round(med), sal: sal ? sm / (cur.end - cur.start) : 1 });
    cur = null;
  };
  for (let t = 0; t < path.length; t++) {
    const p = path[t];
    if (p < 0) {
      flush();
      continue;
    }
    if (cur) {
      const ref = cur.vals.slice(-6).reduce((s, x) => s + x, 0) / Math.min(6, cur.vals.length);
      if (Math.abs(p - ref) > 0.7 || (t - cur.start >= 4 && reattack(t))) {
        flush();
        cur = { start: t, end: t + 1, vals: [p] };
      } else {
        cur.vals.push(p);
        cur.end = t + 1;
      }
    } else cur = { start: t, end: t + 1, vals: [p] };
  }
  flush();
  // gleiche Tonhöhen mit Mini-Lücke verbinden
  const merged = [];
  for (const n of notes) {
    const p = merged[merged.length - 1];
    if (p && p.midi === n.midi && n.start - p.end <= 1) p.end = n.end;
    else merged.push({ ...n });
  }
  return merged;
}

// Übergangs-Schnipsel und Fremdtöne entfernen: zu kurze Töne (weicher Einsatz, Vibrato,
// Gleiten zwischen zwei Tönen), unsichere kurze Töne, Bass-/Begleittöne weit unter der
// Melodielage; Oktavfehler zur Melodielage hin korrigieren.
export function cleanMelodyNotes(notes) {
  if (!notes.length) return notes;
  const len = (n) => n.end - n.start;
  const sals = notes.map((n) => n.sal).sort((a, b) => a - b);
  const medSal = sals[Math.floor(sals.length / 2)] || 1;
  // Melodielage: längengewichteter Median
  const weighted = [];
  for (const n of notes) for (let k = 0; k < Math.min(50, len(n)); k++) weighted.push(n.midi);
  weighted.sort((a, b) => a - b);
  const medP = weighted[Math.floor(weighted.length / 2)];
  const out = [];
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    const next = notes[i + 1];
    const L = len(n);
    // schnelle Läufe (mehrere kurze, eng aufeinanderfolgende Töne in Stufen) bleiben
    const inRun = prev && next && n.start - prev.end <= 2 && next.start - n.end <= 2 && len(prev) < 10 && len(next) < 10 && Math.abs(n.midi - prev.midi) <= 2 && Math.abs(next.midi - n.midi) <= 2;
    if (L < 5 && !inRun) return;
    if (L < 9 && n.sal < 0.8 * medSal && !inRun) return;
    // kurzer Ton direkt vor einem längeren, nur Übergang dorthin
    if (L < 7 && next && next.start - n.end <= 1 && len(next) >= 2 * L && Math.abs(next.midi - n.midi) <= 7 && !inRun) return;
    let m = n.midi;
    if (m < medP - 14 && L < 15) return; // Bass/Begleitung
    while (m > medP + 14) m -= 12;
    while (m < medP - 14) m += 12;
    out.push({ ...n, midi: m });
  });
  // gleiche Tonhöhe mit Mini-Lücke (nach dem Entfernen) zusammenführen
  const merged = [];
  for (const n of out) {
    const p = merged[merged.length - 1];
    if (p && p.midi === n.midi && n.start - p.end <= 1) p.end = n.end;
    else merged.push({ ...n });
  }
  return merged;
}

// ---------- Schlagzeug ----------
// Onset-Stärke je Band normalisieren (lokales Mittel abziehen, auf 97. Perzentil skalieren)
function bandNorm(arr) {
  const n = arr.length;
  const o = new Float32Array(n);
  const W = 15;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += arr[i];
    if (i >= W) acc -= arr[i - W];
    o[i] = Math.max(0, arr[i] - acc / Math.min(W, i + 1));
  }
  const sorted = Array.from(o).sort((a, b) => a - b);
  const p = sorted[Math.floor(0.97 * (n - 1))] || 1;
  for (let i = 0; i < n; i++) o[i] = Math.min(3, o[i] / p);
  return o;
}

// Bruchteil-Schlagindex -> Frame (zwischen den Beats interpoliert, an den Rändern extrapoliert)
export function beatFrame(beats, idx) {
  const n = beats.length;
  if (n < 2) return beats[0] || 0;
  if (idx <= 0) return beats[0] + idx * (beats[1] - beats[0]);
  if (idx >= n - 1) return beats[n - 1] + (idx - (n - 1)) * (beats[n - 1] - beats[n - 2]);
  const i = Math.floor(idx);
  return beats[i] + (idx - i) * (beats[i + 1] - beats[i]);
}

const SUB = 12; // Positionen je Schlag: 16tel (0,3,6,9) und Triolen (4,8)
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// Groove eines Formteils aus den gemittelten Band-Profilen
function groovePattern(avg, meterBeats) {
  const [low, mid, high] = avg;
  const steps = meterBeats * SUB;
  const at = (arr, r) => mean(Array.from({ length: meterBeats }, (_, b) => arr[b * SUB + r]));
  // Swing: Offbeat auf der Triolen-Position statt auf der Achtel
  const swing = at(high, 8) > 1.4 * at(high, 6) && at(high, 8) > 0.15;
  const grid = [];
  for (let s = 0; s < steps; s += 3) grid.push(s);
  const hits = [];
  // Hi-Hat: Viertel, Achtel oder 16tel
  const q = at(high, 0);
  const e = swing ? at(high, 8) : at(high, 6);
  const x = (at(high, 3) + at(high, 9)) / 2;
  let hatStep = 12;
  if (!swing && x > 0.55 * Math.max(q, e) && x > 0.12) hatStep = 3;
  else if (e > 0.4 * q) hatStep = 6;
  if (Math.max(q, e) > 0.08) for (let s = 0; s < steps; s += hatStep) hits.push({ s, midi: 42, vel: 80 });
  // Bass Drum: viel Tiefe, wenig Mitten (Snare-Rauschen reicht auch in die Tiefe)
  const kick = (s) => low[s] - 0.5 * mid[s];
  const kG = grid.map(kick);
  const kMax = Math.max(...kG);
  const ks = [];
  if (kMax > 0.1) {
    ks.push(...grid.filter((s) => kick(s) >= 0.6 * kMax).sort((a, b) => kick(b) - kick(a)).slice(0, 2 * meterBeats - 2));
    if (kick(0) >= 0.3 * kMax && !ks.includes(0)) ks.push(0);
    for (const s of ks) hits.push({ s, midi: 36, vel: 100 });
  }
  // Snare: Mitten deutlich über dem, was die Hi-Hat dort hinterlässt
  const snare = (s) => mid[s] - 0.7 * high[s];
  const sG = grid.map(snare).sort((a, b) => a - b);
  const med = Math.max(0.02, sG[Math.floor(sG.length / 2)]);
  const sMax = sG[sG.length - 1];
  if (sMax > 0.15 && sMax > 1.4 * med) {
    const thr = med + 0.5 * (sMax - med);
    const ss = grid.filter((s) => snare(s) >= thr && !(ks.includes(s) && kick(s) > snare(s) * 2)).sort((a, b) => snare(b) - snare(a)).slice(0, meterBeats);
    for (const s of ss) hits.push({ s, midi: 38, vel: 100 });
  }
  // Raster -> Ticks (Swing wird als gerade Achtel notiert, gespielt wird mit Swing)
  const toTick = (s) => {
    const b = Math.floor(s / SUB);
    const r = s % SUB;
    return b * DIV + (swing && r === 8 ? DIV / 2 : Math.round((r * DIV) / SUB));
  };
  return { hits: hits.map((h) => ({ pos: toTick(h.s), s: h.s, midi: h.midi, vel: h.vel })), swing, toTick };
}

// Schlagzeug je Formteil: Groove aus der Aufnahme, Takte ohne Schlagzeug bleiben leer
// Shuffle-Erkennung: Anschläge auf dem 1. und 3. Triolen-Achtel deutlich stärker als auf der
// geraden Achtel, und auch das mittlere Triolen-Achtel ist besetzt (Ghost-Notes, Hi-Hat)
export function detectShuffle(feat, beats) {
  const a = feat.midP || feat.midF;
  const h = feat.highP || feat.highF;
  if (!a || beats.length < 16) return false;
  const at = (arr, f) => Math.max(arr[Math.round(f) - 1] || 0, arr[Math.round(f)] || 0, arr[Math.round(f) + 1] || 0);
  // je Schlag abstimmen (Songs können zwischendurch gerade werden, z. B. ein Samba-Teil)
  let shuf = 0;
  let straight = 0;
  for (let i = 2; i < beats.length - 2; i++) {
    const d = beats[i + 1] - beats[i];
    const t1 = at(a, beats[i] + d / 3) + at(h, beats[i] + d / 3);
    const half = at(a, beats[i] + d / 2) + at(h, beats[i] + d / 2);
    const t2 = at(a, beats[i] + (2 * d) / 3) + at(h, beats[i] + (2 * d) / 3);
    if (t2 > 1.5 * half && t1 > 1.1 * half) shuf++;
    else if (half > 1.2 * t2) straight++;
  }
  return shuf >= 0.3 * (beats.length - 4) && shuf > 1.4 * straight;
}

// Groove im 12/8 (Triolen-Raster): Hi-Hat auf den besetzten Triolen-Achteln, Bass Drum,
// Snare-Backbeat und Ghost-Notes (leise Snare auf dem mittleren Triolen-Achtel)
function groovePatternCompound(avg, meterBeats) {
  const [low, mid, high] = avg;
  const steps = meterBeats * SUB;
  const grid = [];
  for (let s = 0; s < steps; s += 4) grid.push(s);
  const at = (arr, r) => mean(Array.from({ length: meterBeats }, (_, b) => arr[b * SUB + r]));
  const hits = [];
  const parts = [0, 4, 8].map((r) => at(high, r));
  const pm = Math.max(...parts);
  if (pm > 0.08) for (let b = 0; b < meterBeats; b++) [0, 4, 8].forEach((r, k) => parts[k] >= 0.35 * pm && hits.push({ s: b * SUB + r, midi: 42, vel: 80 }));
  const kick = (s) => low[s] - 0.5 * mid[s];
  const kMax = Math.max(...grid.map(kick));
  const ks = [];
  if (kMax > 0.1) {
    ks.push(...grid.filter((s) => kick(s) >= 0.55 * kMax).sort((a, b) => kick(b) - kick(a)).slice(0, 2 * meterBeats));
    for (const s of ks) hits.push({ s, midi: 36, vel: 100 });
  }
  const snare = (s) => mid[s] - 0.7 * high[s];
  const sG = grid.map(snare).sort((a, b) => a - b);
  const med = Math.max(0.02, sG[Math.floor(sG.length / 2)]);
  const sMax = sG[sG.length - 1];
  if (sMax > 0.15) {
    const main = grid.filter((s) => snare(s) >= med + 0.5 * (sMax - med)).sort((a, b) => snare(b) - snare(a)).slice(0, meterBeats);
    for (const s of main) hits.push({ s, midi: 38, vel: 100 });
    // Ghost-Notes: deutlich, aber leiser – typisch auf dem mittleren Triolen-Achtel
    for (const s of grid) if (!main.includes(s) && s % 12 === 4 && snare(s) >= med + 0.15 * (sMax - med)) hits.push({ s, midi: 38, vel: 40 });
  }
  const toTick = (s) => Math.floor(s / SUB) * 36 + (s % SUB) * 3;
  return { hits: hits.map((h) => ({ pos: toTick(h.s), s: h.s, midi: h.midi, vel: h.vel })), swing: false, toTick };
}

// Schlagzeug Takt für Takt wie in der Aufnahme: Grundgroove je Formteil als Referenz,
// dann je Takt nur die Schläge, die dort wirklich zu hören sind – plus Variationen
// (zusätzliche Bass-Drum/Snare), Fills (dichte Schläge am Taktende -> Snare/Toms),
// Crash nach Fills bzw. am Formteil-Anfang, Takte ohne Hi-Hat bzw. ganz ohne Schlagzeug.
// Wie bandNorm, aber mit kurzem Fenster: schnelle Folgen (Fills, Doppelschläge) bleiben sichtbar
function bandNormFast(arr) {
  const n = arr.length;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let base = Infinity;
    for (let k = Math.max(0, i - 4); k < i; k++) base = Math.min(base, arr[k]);
    o[i] = Math.max(0, arr[i] - (base === Infinity ? 0 : base));
  }
  const sorted = Array.from(o).sort((a, b) => a - b);
  const p = sorted[Math.floor(0.97 * (n - 1))] || 1;
  for (let i = 0; i < n; i++) o[i] = Math.min(3, o[i] / p);
  return o;
}

export function estimateDrums(feat, beats, firstDown, meterBeats, measureCount, sections, { compound = false } = {}) {
  const BT = compound ? 36 : DIV;
  const bands = feat.lowP ? [bandNormFast(feat.lowP), bandNormFast(feat.midP), bandNormFast(feat.highP)] : [bandNormFast(feat.lowF), bandNormFast(feat.midF), bandNormFast(feat.highF)];
  const valAt = (band, f) => {
    const i = Math.round(f);
    let m = 0;
    for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < band.length && band[k] > m) m = band[k];
    return m;
  };
  const steps = meterBeats * SUB;
  const bars = [];
  for (let m = 0; m < measureCount; m++) {
    const prof = [new Float32Array(steps), new Float32Array(steps), new Float32Array(steps)];
    let act = 0;
    for (let s = 0; s < steps; s++) {
      const f = beatFrame(beats, firstDown + m * meterBeats + s / SUB);
      for (let b = 0; b < 3; b++) prof[b][s] = valAt(bands[b], f);
      if (s % 3 === 0) act += prof[0][s] + prof[2][s];
    }
    bars.push({ prof, act });
  }
  const acts = bars.map((b) => b.act).sort((a, b) => a - b);
  const medAct = acts[Math.floor(acts.length / 2)] || 0;
  for (const b of bars) b.on = medAct > 0 && b.act > 0.35 * medAct;
  const kickV = (P, s) => P[0][s] - 0.5 * P[1][s];
  const snareV = (P, s) => P[1][s] - 0.7 * P[2][s];
  const hatV = (P, s) => P[2][s];
  const valFor = (midi, P, s) => (midi === 36 ? kickV(P, s) : midi === 38 ? snareV(P, s) : hatV(P, s));
  const notes = [];
  let swingVotes = 0;
  let votes = 0;
  let prevFill = false;
  for (const sec of sections) {
    const idx = [];
    for (let m = sec.start; m < sec.start + sec.length; m++) if (bars[m] && bars[m].on) idx.push(m);
    if (!idx.length) continue;
    const avg = [0, 1, 2].map((b) => {
      const a = new Float32Array(steps);
      for (const m of idx) for (let s = 0; s < steps; s++) a[s] += bars[m].prof[b][s] / idx.length;
      return a;
    });
    const g = compound ? groovePatternCompound(avg, meterBeats) : groovePattern(avg, meterBeats);
    if (!g.hits.length) continue;
    votes += idx.length;
    if (g.swing) swingVotes += idx.length;
    // typische Stärke der Groove-Schläge in diesem Formteil
    const typ = {};
    for (const midi of [36, 38, 42]) {
      const hs = g.hits.filter((h) => h.midi === midi);
      let sum = 0;
      let c = 0;
      for (const m of idx) for (const h of hs) {
        sum += valFor(midi, bars[m].prof, h.s);
        c++;
      }
      typ[midi] = c ? sum / c : 0;
    }
    const has = (midi, s) => g.hits.some((h) => h.midi === midi && h.s === s);
    // Übersprechen der Hi-Hat in die Mitten (Snare-Band) an reinen Hi-Hat-Positionen
    const hatOnly = g.hits.filter((h) => h.midi === 42 && !has(38, h.s) && !has(36, h.s)).map((h) => h.s);
    let leak = 0;
    let midTyp = 0;
    for (const m of idx) for (const st of hatOnly) leak += snareV(bars[m].prof, st) / (idx.length * Math.max(1, hatOnly.length));
    for (const m of idx) for (const h of g.hits.filter((x) => x.midi === 38)) midTyp += bars[m].prof[1][h.s] / (idx.length * Math.max(1, g.hits.filter((x) => x.midi === 38).length));
    // Aktivität (Mitten + Höhen) an Hi-Hat-Positionen als Maß für "normale" Dichte
    let actHat = 0;
    for (const m of idx) for (const st of hatOnly) actHat += (bars[m].prof[1][st] + bars[m].prof[2][st]) / (idx.length * Math.max(1, hatOnly.length));
    const grid = [];
    for (let st = 0; st < steps; st += compound ? 4 : 3) grid.push(st);
    const gstep = compound ? 4 : 3;
    for (const m of idx) {
      const P = bars[m].prof;
      const hits = [];
      // Hi-Hat nur, wenn in diesem Takt überhaupt Becken zu hören sind
      const hatSteps = g.hits.filter((h) => h.midi === 42);
      const hatLevel = hatSteps.length ? hatSteps.reduce((a, h) => a + hatV(P, h.s), 0) / hatSteps.length : 0;
      for (const h of g.hits) {
        if (h.midi === 42 && (hatLevel < 0.3 * typ[42] || hatV(P, h.s) < 0.3 * typ[42])) continue;
        if (h.midi !== 42 && typ[h.midi] > 0.05 && valFor(h.midi, P, h.s) < 0.3 * typ[h.midi]) continue; // im Takt nicht gespielt
        hits.push({ s: h.s, midi: h.midi, vel: h.vel });
      }
      // Variationen: zusätzliche Schläge, die deutlich zu hören sind
      const extraSn = [];
      const peakAt = (fn, st) => fn(P, st) >= (st >= gstep ? fn(P, st - gstep) : 0) && fn(P, st) >= (st + gstep < steps ? fn(P, st + gstep) : 0);
      const midPeak = (st) => P[1][st] >= (st >= gstep ? P[1][st - gstep] : 0) && P[1][st] >= (st + gstep < steps ? P[1][st + gstep] : 0);
      for (const st of grid) {
        if (!has(36, st) && typ[36] > 0.05 && kickV(P, st) >= Math.max(0.12 * typ[36], 0.2) && P[0][st] >= 0.25 && peakAt(kickV, st)) hits.push({ s: st, midi: 36, vel: 95 });
        if (has(38, st) || typ[38] <= 0.05) continue;
        // an Hi-Hat-Positionen nur, was deutlich über dem Übersprechen liegt; sonst jeder klare Mitten-Anschlag
        const onHat = has(42, st);
        if (onHat ? snareV(P, st) >= leak + 0.6 * Math.max(0.1, typ[38] - leak) : P[1][st] >= Math.max(0.35 * midTyp, 0.2) && midPeak(st)) extraSn.push(st);
      }
      // Fill: dichte Anschläge (Mitten + Höhen) im letzten Schlag, wo der Groove keine hat
      const dense = (from) => {
        let c = 0;
        for (let st = from; st < steps; st += gstep) {
          const a = P[1][st] + P[2][st];
          const groovePos = g.hits.some((h) => h.s === st);
          if (groovePos ? a >= 1.3 * actHat && P[1][st] >= 0.5 * midTyp : a >= Math.max(0.35 * actHat, 0.3)) c++;
        }
        return c;
      };
      const fillFrom = dense(steps - SUB) >= 3 ? steps - SUB : null;
      if (fillFrom !== null) for (let st = fillFrom; st < steps; st += gstep) if (!extraSn.includes(st) && P[1][st] + P[2][st] >= Math.max(0.35 * actHat, 0.3)) extraSn.push(st);
      if (fillFrom !== null) {
        const fillSteps = [...new Set([...extraSn.filter((st) => st >= fillFrom), ...hits.filter((h) => h.midi === 38 && h.s >= fillFrom).map((h) => h.s)])].sort((a, b) => a - b);
        for (let k = hits.length - 1; k >= 0; k--) if (hits[k].s >= fillFrom && (hits[k].midi === 38 || hits[k].midi === 42)) hits.splice(k, 1);
        const seq = [38, 38, 48, 48, 45, 45, 41, 41];
        fillSteps.forEach((st, k) => hits.push({ s: st, midi: seq[Math.min(seq.length - 1, Math.floor((k * seq.length) / fillSteps.length))], vel: 100 }));
        for (const st of extraSn.filter((x) => x < fillFrom)) hits.push({ s: st, midi: 38, vel: 85 });
      } else for (const st of extraSn) hits.push({ s: st, midi: 38, vel: 85 });
      // Crash: nach einem Fill bzw. am Formteil-Anfang – starkes Becken auf der "1" oder ein
      // nachklingendes Becken, das die folgenden Hi-Hat-Schläge überdeckt
      const firstHalfHats = hatOnly.filter((st) => st > 0 && st < steps / 2);
      const masked = firstHalfHats.length && firstHalfHats.reduce((a, st) => a + hatV(P, st), 0) / firstHalfHats.length < 0.5 * typ[42];
      if ((prevFill || (m === sec.start && m > 0)) && (hatV(P, 0) >= 1.2 * Math.max(0.2, typ[42]) || masked)) {
        for (let k = hits.length - 1; k >= 0; k--) if (hits[k].s === 0 && hits[k].midi === 42) hits.splice(k, 1);
        hits.push({ s: 0, midi: 49, vel: 105 });
        // unter dem Becken spielt der Groove weiter (Hi-Hat wird nur überdeckt)
        for (const h of g.hits) if (h.midi === 42 && h.s > 0 && !hits.some((x) => x.s === h.s && x.midi === 42)) hits.push({ s: h.s, midi: 42, vel: h.vel });
      }
      prevFill = fillFrom !== null;
      for (const h of hits) notes.push({ start: m * meterBeats * BT + g.toTick(h.s), dur: 6, midi: h.midi, vel: h.vel });
    }
  }
  return { notes: notes.sort((a, b) => a.start - b.start), swing: votes > 0 && swingVotes > votes / 2, activeBars: bars.map((b) => b.on) };
}

function linFit(y, a, z, i) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, c = 0;
  for (let k = a; k <= z; k++) {
    sx += k;
    sy += y[k];
    sxx += k * k;
    sxy += k * y[k];
    c++;
  }
  const slope = (c * sxy - sx * sy) / (c * sxx - sx * sx || 1);
  return (sy - slope * sx) / c + slope * i;
}

// Kleinste-Quadrate-Parabel durch y[a..z] (x = Index, um i zentriert), Wert an i
function localQuadFit(y, a, z, i) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let k = a; k <= z; k++) {
    const x = k - i;
    const x2 = x * x;
    s0 += 1;
    s1 += x;
    s2 += x2;
    s3 += x2 * x;
    s4 += x2 * x2;
    t0 += y[k];
    t1 += x * y[k];
    t2 += x2 * y[k];
  }
  if (s0 < 4) {
    // zu wenige Punkte: Gerade
    const den = s0 * s2 - s1 * s1 || 1;
    const slope = (s0 * t1 - s1 * t0) / den;
    return (t0 - slope * s1) / s0;
  }
  // Normalgleichungen 3x3 (Cramer), gesucht: Achsenabschnitt c0
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-9) return y[i];
  return (t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - s3 * t2) + s2 * (t1 * s3 - s2 * t2)) / det;
}


// ---------- Feine Beat-Lage ----------
// Jeder Beat wird auf die nächste Onset-Spitze (±2 Frames, mit Parabel-Interpolation auf
// Bruchteile eines Frames) gezogen; danach werden die Abstände geglättet, damit die Noten
// gleichmäßig auf dem Raster liegen und nicht mit einzelnen Ausreißern "wackeln".
export function refineBeats(beats, env) {
  const n = beats.length;
  if (n < 4) return beats.slice();
  const peak = beats.map((b) => {
    let best = b;
    for (let k = b - 2; k <= b + 2; k++) if (k > 0 && k < env.length - 1 && env[k] > env[best]) best = k;
    const y0 = env[best - 1] || 0;
    const y1 = env[best] || 0;
    const y2 = env[best + 1] || 0;
    const den = y0 - 2 * y1 + y2;
    const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    // nur wenn dort wirklich ein Anschlag ist, sonst ursprüngliche Lage
    return y1 > 0.4 ? best + frac : b;
  });
  // lokale Ausgleichsparabel über ±3 Beats (robust gegen einzelne Ausreißer, folgt aber
  // stetigen Tempoänderungen wie rit./accel.)
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    // am Rand das Fenster verschieben (immer 7 Punkte), statt mit 4 Punkten zu extrapolieren
    const a = Math.max(0, Math.min(i - 3, n - 7));
    const z = Math.min(n - 1, Math.max(i + 3, 6));
    const fit = i < 3 || i > n - 4 ? linFit(peak, a, z, i) : localQuadFit(peak, a, z, i);
    // Mischung: Anschlag selbst (Feeling) und Ausgleich (Stabilität)
    out[i] = Math.abs(peak[i] - fit) > 2 ? fit : 0.5 * peak[i] + 0.5 * fit;
  }
  for (let i = 1; i < n; i++) if (out[i] <= out[i - 1]) out[i] = out[i - 1] + 0.5;
  return out;
}

// ---------- Gesamtablauf ----------
// Frame-Index -> Sekunde in der Datei (Onset-Spitze liegt kurz nach Fensteranfang)
export const FRAME_LAG = 0.75 * N;
export const frameToSec = (f) => (f * HOP + FRAME_LAG) / SR;

// Schlagzeug-Noten über die NMF-Aktivierungen (Ergebnis wird je Analyse zwischengespeichert)
export function transcribeDrums(feat, beatFrames, firstDown, meterBeats, measureCount, sections, { compound = false } = {}) {
  if (!feat.Xp) return estimateDrums(feat, beatFrames.map(Math.round), firstDown, meterBeats, measureCount, sections, { compound });
  if (!feat.drumAct) feat.drumAct = drumNMF(feat.Xp, feat.nFrames, feat.NB, SPEC_CENTERS).act;
  const bf = beatFrames;
  const frameToBeat = (f) => {
    const n = bf.length;
    if (f <= bf[0]) return (f - bf[0]) / (bf[1] - bf[0]);
    if (f >= bf[n - 1]) return n - 1 + (f - bf[n - 1]) / (bf[n - 1] - bf[n - 2]);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bf[mid] <= f) lo = mid;
      else hi = mid;
    }
    return lo + (f - bf[lo]) / (bf[lo + 1] - bf[lo]);
  };
  return drumHitsFromActivations(feat.drumAct, bf, firstDown, meterBeats, measureCount, sections, { compound, frameToBeat, wash: feat.sustainHigh, perc: feat.percHigh });
}

// Wird erhöht, wenn die Analyse deutlich bessere Ergebnisse liefert (Hinweis „neu analysieren“)
export const ANALYSIS_VERSION = 2;

// mono: Float32Array (22050 Hz, siehe resampleMono)
export function transcribe(mono, { title = 'Audio-Import', onProgress = () => {}, ai = null, debug = null } = {}) {
  onProgress('Spektrum wird analysiert', 0);
  const feat = analyzeFrames(mono, onProgress);
  onProgress('Tempo & Beats werden erkannt', 0.46);
  // Onset-Hüllkurve: Spektralfluss + Tiefband (Bass Drum hat nur wenige Bins)
  const lowNorm = bandNorm(feat.lowF);
  const fluxNorm = bandNorm(feat.onset);
  const comb = new Float32Array(feat.nFrames);
  for (let i = 0; i < comb.length; i++) comb[i] = fluxNorm[i] + 0.7 * lowNorm[i];
  let { beats, bpm, onset, barLag } = trackBeats(comb);
  // Halbes Tempo erkannt? Dann liegt die Snare (Backbeat) zwischen den Schlägen -> verdoppeln
  {
    const midN = bandNorm(feat.midF);
    const highN = bandNorm(feat.highF);
    const sn = (f) => {
      let m = 0;
      for (let k = Math.round(f) - 1; k <= Math.round(f) + 1; k++) if (k >= 0 && k < midN.length) m = Math.max(m, midN[k] - 0.7 * highN[k]);
      return Math.max(0, m);
    };
    const on = [];
    const off = [];
    for (let i = 0; i + 1 < beats.length; i++) {
      on.push(sn(beats[i]));
      off.push(sn((beats[i] + beats[i + 1]) / 2));
    }
    // Gleich starke Anschläge auf und zwischen den Schlägen (Bass Drum/Snare, z. B. schneller
    // Walzer): der Puls ist doppelt so schnell
    const kN = bandNorm(feat.lowP || feat.lowF);
    const sN = feat.midP ? bandNorm(feat.midP) : midN;
    const kickSnare = kN.map((v, i) => v + sN[i]);
    const ks = (f) => Math.max(kickSnare[Math.round(f) - 1] || 0, kickSnare[Math.round(f)] || 0, kickSnare[Math.round(f) + 1] || 0);
    const kOn = mean(beats.slice(0, -1).map(ks));
    const kOff = mean(beats.slice(0, -1).map((b, i) => ks((b + beats[i + 1]) / 2)));
    // … aber nur, wenn das Rhythmus-Muster dann einen Dreiertakt ergibt (oder keine Takt-Periode
    // erkennbar ist): im geraden Takt sind starke Achtel-Zwischenschläge normales Synkopen-Spiel
    const bb = barLag ? barLag / medianIbi(beats) : null;
    const tripleIfDoubled = bb === null || [3, 6, 12].some((k) => Math.abs(Math.log((2 * bb) / k)) < 0.06);
    const evenPulse = bpm < 100 && kOn > 0.2 && kOff >= 0.8 * kOn && tripleIfDoubled;
    if ((bpm < 110 && mean(off) > 1.5 * mean(on) && mean(off) > 0.1) || evenPulse) {
      const dbl = [];
      for (let i = 0; i < beats.length; i++) {
        dbl.push(beats[i]);
        if (i + 1 < beats.length) dbl.push(Math.round((beats[i] + beats[i + 1]) / 2));
      }
      beats = dbl;
      bpm *= 2;
    }
  }
  // Schnelle, durchsynkopierte Stücke (fast die Hälfte aller Einsätze auf Sechzehntel-Zwischen-
  // zeiten bei Tempo 92–112): in gedruckten Noten stehen sie im doppelten Tempo mit Achteln
  // (Alla-breve-Gefühl) – viel leichter zu lesen als Ketten übergebundener Sechzehntel
  if (ai && ai.length >= 32 && bpm >= 92 && bpm < 112 && beats.length >= 8) {
    const bs = beats.map(frameToSec);
    let odd = 0;
    let all = 0;
    let i = 0;
    for (const n of [...ai].sort((a, b) => a.start - b.start)) {
      while (i < bs.length - 2 && n.start >= bs[i + 1]) i++;
      if (n.start < bs[i] || n.start >= bs[i + 1]) continue;
      const q = ((n.start - bs[i]) / (bs[i + 1] - bs[i])) * 4;
      const slot = Math.round(q) % 4;
      if (Math.abs(q - Math.round(q)) > 0.3) continue;
      all++;
      if (slot === 1 || slot === 3) odd++;
    }
    if (all >= 32 && odd / all >= 0.44) {
      const dbl = [];
      for (let k = 0; k < beats.length; k++) {
        dbl.push(beats[k]);
        if (k + 1 < beats.length) dbl.push(Math.round((beats[k] + beats[k + 1]) / 2));
      }
      beats = dbl;
      bpm *= 2;
    }
  }
  if (beats.length < 8) throw new Error('Im Audio wurde kein durchgehender Rhythmus erkannt (zu kurz oder zu leise).');
  // Sekunde -> Schlagposition (lineare Interpolation zwischen den Beats)
  const beatSec = refineBeats(beats, comb).map(frameToSec);
  const beatPos = (sec) => {
    const b = beatSec;
    if (sec <= b[0]) return (sec - b[0]) / (b[1] - b[0]);
    for (let i = 0; i < b.length - 1; i++) if (sec < b[i + 1]) return i + (sec - b[i]) / (b[i + 1] - b[i]);
    const last = b.length - 1;
    return last + (sec - b[last]) / (b[last] - b[last - 1]);
  };
  // Harmonik je Schlag: mit lokaler KI aus den gehörten Noten (genaue Tonhöhen), sonst Chroma
  const hasAi = !!(ai && ai.length >= 16);
  const bc = hasAi ? noteBeatChroma(ai, beatPos, beats.length) : beatChroma(beats, feat, feat.nFrames);
  const lowN = bandNorm(feat.lowP || feat.lowF);
  const midN = bandNorm(feat.midP || feat.midF);
  const peak = (arr, f) => Math.max(arr[f - 1] || 0, arr[f] || 0, arr[f + 1] || 0);
  const highN = bandNorm(feat.highF);
  // Becken-Akzent: hohes Band deutlich stärker als sonst (Crash), Fill: viele Snare-Anschläge
  // zwischen dem vorigen und diesem Schlag
  const hiAt = beats.map((b) => peak(highN, b));
  const hiMed = [...hiAt].sort((a, b) => a - b)[Math.floor(hiAt.length / 2)] || 0;
  const meterInfo = findMeter(bc, {
    low: beats.map((b) => peak(lowN, b)),
    mid: beats.map((b) => peak(midN, b)),
    onset: beats.map((b) => onset[b] || 0),
    crash: hiAt.map((v) => Math.max(0, v - 1.4 * hiMed)),
    fillPre: beats.map((b, i) => {
      if (!i) return 0;
      const a = beats[i - 1];
      let c = 0;
      for (let f = a + 2; f < b - 1; f++) if (midN[f] > 0.6 && midN[f] >= midN[f - 1] && midN[f] >= midN[f + 1]) c++;
      return c >= 2 ? c : 0;
    }),
    // Takt-Periode des Rhythmus-Musters in Schlägen (4 oder 8 -> gerader Takt, 3 oder 6 -> Dreiertakt)
    barBeats: barLag ? barLag / medianIbi(beats) : null,
    lowBass: bc.low || null,
    debug,
  });
  const m = meterInfo.beats;
  const firstDown = meterInfo.phase;
  // Shuffle mit Schlägen auf allen Triolen-Achteln (z. B. Half-Time-Shuffle) -> 12/8-Notation
  const shuffle12 = detectShuffle(feat, beats) && m === 4;
  const BT = shuffle12 ? 36 : DIV; // Ticks je Grundschlag
  const mt = m * BT;
  const measureCount = Math.max(1, Math.floor((beats.length - firstDown) / m));
  // Tonhöhen-Frames: Salienz setzt erst ein, wenn der Ton das Fenster füllt
  const melStartSec = (f) => (f * HOP) / SR + 0.034;
  const melEndSec = (f) => (f * HOP) / SR - 0.1;

  // Akkorde: Chroma pro Schlag als gewichtete "Noten" an den Harmonisierer
  onProgress('Akkorde & Tonart werden erkannt', 0.5);
  const pseudo = [];
  bc.forEach((x, i) => {
    const start = (i - firstDown) * BT;
    if (start < 0) return;
    for (let k = 0; k < 12; k++) {
      if (x.c[k] > 0.35) pseudo.push({ start, dur: Math.round(DIV * x.c[k]), midi: 60 + k });
      if (x.b[k] > 0.6) pseudo.push({ start, dur: Math.round(DIV * 0.9 * x.b[k]), midi: 36 + k });
    }
  });

  onProgress('Melodie wird erkannt', 0.55);
  const path = trackMelody(feat, onProgress);
  const notesF = cleanMelodyNotes(segmentNotes(path));

  // Schlagzeug (vorläufige Formteile = 8-Takt-Gruppen, danach mit der echten Form)
  onProgress('Schlagzeug wird erkannt', 0.78);
  const roughSections = [];
  for (let s0 = 0; s0 < measureCount; s0 += 8) roughSections.push({ start: s0, length: Math.min(8, measureCount - s0) });
  const drumsRough = transcribeDrums(feat, refineBeats(beats, comb), firstDown, m, measureCount, roughSections, { compound: shuffle12 });
  const swing = !shuffle12 && drumsRough.swing;

  onProgress('Noten werden ins Taktraster gesetzt', 0.82);
  // 16tel-Raster (ab Tempo 150 Achtel – schneller spielt und liest niemand); bei Swing liegen
  // Offbeats auf der Triole -> als gerade Achtel notiert
  const GRID = bpm >= 150 ? DIV / 2 : 6;
  const toTick = (sec) => {
    const bp = beatPos(sec) - firstDown;
    const b = Math.floor(bp);
    const f = bp - b;
    if (shuffle12) return b * BT + Math.round(f * 6) * 6; // 12/8: Achtel = 12, 16tel = 6 Ticks
    if (swing) {
      const opts = [0, 2 / 3, 1];
      const ticks = [0, DIV / 2, DIV];
      let best = 0;
      for (let i = 1; i < 3; i++) if (Math.abs(f - opts[i]) < Math.abs(f - opts[best])) best = i;
      return b * DIV + ticks[best];
    }
    return b * DIV + Math.round((f * DIV) / GRID) * GRID;
  };
  // Melodie in Sekunden; mit lokaler KI (Basic Pitch) kombiniert, falls vorhanden
  let melSec = notesF.map((n) => ({ s: melStartSec(n.start), e: melEndSec(n.end), midi: n.midi }));
  let aiInfo = null;
  if (ai && ai.length) {
    // echter Neuanschlag: kurz vorher deutlich weniger Energie auf dieser Tonhöhe (sonst war es
    // nur ein Schlagzeug-Transient mitten im gehaltenen Ton)
    const salAt = (fr, midi) => {
      let v = 0;
      for (let q = 0; q < 4; q++) if (Math.abs(feat.topP[fr * 4 + q] - midi) < 0.6) v = Math.max(v, feat.topS[fr * 4 + q]);
      return v;
    };
    const reattack = (sec, midi) => {
      const fr = Math.round(((sec - 0.034) * SR) / HOP);
      const before = Math.min(salAt(fr - 1, midi), salAt(fr - 2, midi), salAt(fr, midi));
      const around = [];
      for (let k = fr - 12; k <= fr + 12; k++) if (k >= 0 && k < feat.nFrames) around.push(salAt(k, midi));
      around.sort((a, b) => a - b);
      const typ = around[Math.floor(around.length * 0.75)] || 0;
      return typ > 0 && before < 0.6 * typ;
    };
    const f = fuseMelody(melSec, ai, { reattack });
    melSec = f.melody;
    aiInfo = { changed: f.changed, added: f.added, notes: ai.length };
  }
  let melody = melSec.map((n) => {
    const s = toTick(n.s);
    const e = Math.max(s + (swing ? DIV / 2 : 6), toTick(n.e));
    return { start: s, dur: e - s, midi: n.midi };
  });
  melody = melody.filter((n) => n.start >= -mt + BT);
  // gleiche Startzeit nach dem Runden: längere Note behalten
  melody = melody.filter((n, i) => !melody.some((o, j) => j !== i && o.start === n.start && (o.dur > n.dur || (o.dur === n.dur && j < i))));
  // Notenenden lesbar machen: Mini-Lücken schließen (Ausklingen wird oft zu früh erkannt),
  // sonst auf Achtel runden – Einsätze bleiben exakt
  const unit = swing ? DIV / 2 : GRID;
  const tidyEnds = (line) => {
    line.sort((a, b) => a.start - b.start);
    line.forEach((n, i) => {
      const next = line[i + 1];
      const end = n.start + n.dur;
      if (next && next.start - end <= DIV / 4 + 1) n.dur = next.start - n.start;
      else {
        let e = Math.round(end / (DIV / 2)) * (DIV / 2);
        if (next) e = Math.min(e, next.start);
        n.dur = Math.max(unit, e - n.start);
      }
    });
    return line;
  };
  tidyEnds(melody);

  const meter = shuffle12 ? { beats: 3 * m, beatType: 8 } : { beats: m, beatType: 4 };
  // KI: Stimmen aus den mehrstimmig gehörten Noten – Melodie (Oberstimme), Bass und bis zu zwei
  // Mittelstimmen. Die Gesangslinie der Signalanalyse dient dabei als Hinweis.
  const aiTracks = [];
  let polyNotes = null;
  if (hasAi) {
    const poly = cleanPoly(
      ai
        .map((n) => {
          const s0 = toTick(n.start);
          return { start: s0, dur: Math.max(unit, toTick(n.end) - s0), midi: n.midi, amp: n.amp ?? 0.5 };
        })
        .filter((n) => n.start >= -mt + BT && n.start < measureCount * mt),
      { step: unit },
    );
    polyNotes = poly;
    if (debug) debug({ hint: melody.map((n) => [n.start, n.dur, n.midi]), poly, beat: BT, mt });
    const vs = separateVoices(poly, { beat: BT, mt, step: unit, hint: melody });
    // Lesbarkeit: im mittleren Tempo stehen die Stimmen im Achtel-Raster (nur echte Synkopen
    // bleiben als Sechzehntel). Langsame Stücke und Shuffle/Swing behalten ihr Raster.
    if (GRID === 6 && !swing && !shuffle12 && bpm >= 72) {
      vs.melody = simplifyLine(vs.melody, { beat: BT, allowPush: true });
      vs.bass = simplifyLine(vs.bass, { beat: BT });
      vs.inner = vs.inner.map((l) => simplifyLine(l, { beat: BT, mergeRepeats: true }));
    }
    const vel = (n) => Math.round(40 + 80 * Math.min(1, n.amp || 0.5));
    const asTrack = (line) => line.filter((n) => n.start >= 0).map((n) => ({ start: n.start, dur: n.dur, midi: n.midi, vel: vel(n) }));
    if (vs.melody.length >= 8) {
      aiInfo.fromVoices = true;
      melody = tidyEnds(vs.melody.map((n) => ({ start: n.start, dur: n.dur, midi: n.midi })));
    }
    const bn = asTrack(vs.bass);
    if (bn.length >= 8) aiTracks.push({ id: 'ai-bass', name: 'Bass (KI)', program: 33, mel: false, role: 'bass', notes: bn });
    vs.inner.forEach((line, k) => {
      const notes = asTrack(line);
      if (notes.length >= 8) aiTracks.push({ id: `ai-inner${k + 1}`, name: `Mittelstimme ${k + 1} (KI)`, program: 0, mel: false, role: 'inner', notes });
    });
    // Harmonik & Tonart aus den gehörten Noten (der Bass zählt doppelt)
    pseudo.length = 0;
    for (const n of poly) if (n.start >= 0) pseudo.push({ start: n.start, dur: Math.min(n.dur, DIV * 2), midi: n.midi });
    for (const n of vs.bass) if (n.start >= 0) pseudo.push({ start: n.start, dur: Math.min(n.dur, DIV * 2), midi: n.midi });
  }
  const key = detectKey([...pseudo, ...melody.filter((n) => n.start >= 0).map((n) => ({ midi: n.midi, dur: n.dur * 0.5 }))]);
  const chords = harmonize(pseudo, { meter, key, measureCount, melodyOnly: false });
  const pickupNotes = melody.filter((n) => n.start < 0);
  const song = {
    title,
    composer: null,
    key,
    keyDetected: true,
    meter,
    tempo: Math.round(shuffle12 ? bpm * 1.5 : bpm), // immer in Vierteln (12/8: punktierte Viertel × 1,5)
    swing,
    pickup: pickupNotes.length ? -Math.min(...pickupNotes.map((n) => n.start)) : 0,
    measureCount,
    melody: melody.filter((n) => n.start < measureCount * mt),
    chords,
    sections: [],
    warnings: ['Aus Audio erkannt: Melodie, Akkorde, Tempo und Schlagzeug sind eine Annäherung – bitte mit dem Original anhören.'],
    source: 'audio',
    chordsDetected: true,
  };
  onProgress('Form wird bestimmt', 0.92);
  const fin = finalizeSong(song);
  fin.chordsDetected = true;
  // Formteile aus Takt-Merkmalen (Harmonik, Melodie, Lautstärke, Dichte, Schlagzeug) – jede
  // Wiederholung bekommt denselben Buchstaben, jeder Teil seine relative Lautstärke
  if (measureCount >= 12) {
    const energy = [];
    for (let b = 0; b < measureCount; b++) {
      const a = Math.round(beats[firstDown + b * m] ?? 0);
      const z = Math.round(beats[firstDown + (b + 1) * m] ?? feat.nFrames);
      let e = 0;
      for (let t = a; t < z; t++) e += feat.energy[t] || 0;
      energy.push(20 * Math.log10(1e-5 + e / Math.max(1, z - a)));
    }
    const secs = audioSections(barFeatures({ mt, measureCount, melody: fin.melody, notes: polyNotes || pseudo, drumNotes: drumsRough.notes || [], energy }));
    if (secs && secs.length >= 2) {
      fin.sections = secs;
      fin.sectionsDetected = true;
    }
  }
  // Schlagzeug: NMF-Zerlegung in Bass Drum, Snare, Hi-Hat, Becken, Toms; Anschläge ins Raster
  onProgress('Schlagzeug wird Instrument für Instrument getrennt', 0.93);
  fin.drumNotes = transcribeDrums(feat, refineBeats(beats, comb), firstDown, m, measureCount, fin.sections, { compound: shuffle12 }).notes;
  // Zeitbezug zur Datei: Schlag i liegt bei beatSec[i] Sekunden; Takt 1 beginnt bei Schlag firstDown
  fin.timing = { beatSec, firstBeat: firstDown, beatTicks: BT };
  if (aiTracks.length) fin.tracks = [{ id: 'ai-melody', name: 'Gesang / Melodie (KI)', program: 52, mel: true, notes: fin.melody.map((n) => ({ ...n, vel: 90 })) }, ...aiTracks];
  if (aiInfo) fin.warnings.push(`Lokale KI (Basic Pitch): ${aiInfo.notes} Noten gehört – Melodie, Bass${aiTracks.length > 1 ? ' und Mittelstimmen' : ''} als eigene Spuren.`);
  // Tempowechsel, rit./accel. aus den echten Schlagzeiten
  const tm = tempoMarksFromTiming(fin.timing, m, measureCount);
  fin.tempoMarks = tm.marks.map((x) => ({ ...x, bpm: Math.round(shuffle12 ? x.bpm * 1.5 : x.bpm) }));
  // Tempoangabe am Anfang = Anfangstempo (wie in gedruckten Noten), nicht der Durchschnitt
  if (tm.marks.length > 1 && fin.tempoMarks[0]) fin.tempo = fin.tempoMarks[0].bpm;
  if (tm.marks.length > 1) fin.warnings.push(`Tempo ändert sich im Stück (${tm.marks.filter((x) => x.kind !== 'tempo' || x.bar > 0).map((x) => `Takt ${x.bar + 1}: ${x.kind === 'rit' ? 'rit.' : x.kind === 'accel' ? 'accel.' : x.kind === 'atempo' ? 'a tempo' : (shuffle12 ? '♩. = ' + Math.round(x.bpm / 1.5) : '♩ = ' + x.bpm)}`).join(', ')}).`);
  if (shuffle12) fin.warnings.push('Shuffle erkannt – notiert im 12/8-Takt (Triolen-Feeling).');
  fin.duration = mono.length / SR;
  // Stand der Analyse: ältere, gespeicherte Analysen lassen sich in der App neu berechnen
  fin.analysisVersion = ANALYSIS_VERSION;
  fin.aiUsed = hasAi;
  onProgress('Fertig', 1);
  return fin;
}
