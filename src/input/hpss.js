// Harmonisch/Perkussiv-Trennung im Zeitbereich (Fitzgerald 2010) für die „gründliche“ Analyse.
// Töne mit Tonhöhe liegen im Spektrogramm waagrecht (lange Linien), Schläge senkrecht. Zwei
// Median-Filter (längs der Zeit bzw. der Frequenz) trennen sie; mit weichen Masken wird daraus
// ein Signal ohne Schlagzeug-Transienten. Die lokale KI hört darin Noten deutlich sicherer –
// vor allem Gesang und Bass werden nicht mehr von Snare und Hi-Hat „geschnitten“.
import { makeFFT } from './audio.js';

const median17 = (buf, n) => {
  // Einfügesortierung (n ≤ 17)
  for (let i = 1; i < n; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = v;
  }
  return buf[n >> 1];
};

// x: Float32Array (mono). Ergebnis: Float32Array gleicher Länge (nur der harmonische Anteil)
export function harmonicPart(x, { n = 2048, hop = 512, kT = 17, kF = 17, onProgress = null } = {}) {
  const half = n / 2 + 1;
  const fft = makeFFT(n);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); // periodisches Hann
  const out = new Float32Array(x.length);
  const pad = n; // Rahmen beginnen vor dem Signal, damit auch die ersten Samples voll gewichtet sind
  const nFrames = Math.ceil((x.length + pad) / hop) + 1;
  const CH = 192; // Rahmen je Block
  const ctxT = kT >> 1;
  const ctxF = kF >> 1;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const bufT = new Float32Array(kT);
  const bufF = new Float32Array(kF);
  const HS = 1.5; // Summe der Fensterquadrate bei 75 % Überlappung (Analyse × Synthese)
  for (let f0 = 0; f0 < nFrames; f0 += CH) {
    const f1 = Math.min(nFrames, f0 + CH);
    const a = Math.max(0, f0 - ctxT);
    const b = Math.min(nFrames, f1 + ctxT);
    const m = b - a;
    const R = new Float32Array(m * half);
    const I = new Float32Array(m * half);
    const M = new Float32Array(m * half);
    for (let t = 0; t < m; t++) {
      const start = (a + t) * hop - pad;
      for (let i = 0; i < n; i++) {
        const p = start + i;
        re[i] = p >= 0 && p < x.length ? x[p] * win[i] : 0;
        im[i] = 0;
      }
      fft(re, im);
      const o = t * half;
      for (let k = 0; k < half; k++) {
        R[o + k] = re[k];
        I[o + k] = im[k];
        M[o + k] = Math.hypot(re[k], im[k]);
      }
    }
    for (let t = f0 - a; t < f1 - a; t++) {
      const o = t * half;
      // Harmonisch: Median längs der Zeit; Perkussiv: Median längs der Frequenz
      for (let k = 0; k < half; k++) {
        let c = 0;
        for (let d = -ctxT; d <= ctxT; d++) {
          const tt = Math.min(m - 1, Math.max(0, t + d));
          bufT[c++] = M[tt * half + k];
        }
        const h = median17(bufT, c);
        c = 0;
        for (let d = -ctxF; d <= ctxF; d++) {
          const kk = Math.min(half - 1, Math.max(0, k + d));
          bufF[c++] = M[o + kk];
        }
        const p = median17(bufF, c);
        const h2 = h * h;
        const g = h2 / (h2 + p * p + 1e-12);
        re[k] = R[o + k] * g;
        im[k] = I[o + k] * g;
      }
      // Spiegelhälfte (reelles Signal): konjugiert-symmetrisch ergänzen
      for (let k = half; k < n; k++) {
        re[k] = re[n - k];
        im[k] = -im[n - k];
      }
      // inverse FFT über Konjugation: ifft(X) = conj(fft(conj(X))) / n
      for (let k = 0; k < n; k++) im[k] = -im[k];
      fft(re, im);
      const start = (a + t) * hop - pad;
      for (let i = 0; i < n; i++) {
        const p = start + i;
        if (p < 0 || p >= out.length) continue;
        out[p] += (re[i] / n) * win[i];
      }
    }
    if (onProgress) onProgress(f1 / nFrames);
  }
  for (let i = 0; i < out.length; i++) out[i] /= HS;
  return out;
}
