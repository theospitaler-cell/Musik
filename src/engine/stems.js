// Stem-Routing, Groove-Extraktion und rhythmische Synthese.
//
//   vocals.wav  Lead-Melodie (Basic Pitch)
//   bass.wav    Monophones Fundament, 30–250 Hz, Transienten-Kompensation gegen Sub-Bass-Lag
//   other.wav   Polyphon: Tonalität, Akkorde, Begleit-Rhythmus (Comping)
//   drums.wav   KEINE Notenerkennung – nur Transienten zur Kalibrierung des Takt-/Backbeat-Rasters
//
// Die Funktionen arbeiten auf Noten bzw. Einsätzen in Sekunden (so liefern Basic Pitch und der
// Einsatz-Detektor sie) und erzeugen daraus ein `Material` in Ticks (DIV = 24 je Viertel), das die
// Orchestrierung weiterverarbeitet.
import { DIV, clamp, mod } from '../core/constants.js';
import { makeFFT } from '../input/audio.js';
import { estimateTempo, plausibleTempo, mergeOnsets } from './tempo.js';

const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);

// ---- Bass-Band --------------------------------------------------------------------------------
export const BASS_BAND_HZ = [30, 250];
export const BASS_MIDI_BAND = [Math.ceil(hzToMidi(BASS_BAND_HZ[0])), Math.floor(hzToMidi(BASS_BAND_HZ[1]))]; // [23, 59]

// RBJ-Biquad (Butterworth-Güte), zweistufig = 24 dB/Oktave
function biquad(type, f0, sr, Q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * f0) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0;
  let b1;
  let b2;
  if (type === 'low') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function runBiquad(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = v;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
  }
  return y;
}

// Bandpass lo–hi Hz (Hochpass + Tiefpass, je zweimal)
export function bandpass(x, sr, lo = BASS_BAND_HZ[0], hi = BASS_BAND_HZ[1]) {
  let y = x;
  for (let k = 0; k < 2; k++) y = runBiquad(y, biquad('high', lo, sr));
  for (let k = 0; k < 2; k++) y = runBiquad(y, biquad('low', hi, sr));
  return y;
}

// Obertöne, die die KI als eigene Noten meldet: ein Ton, der +12/+19/+24/+28/+31 Halbtöne (Oktave,
// Duodezime, Doppeloktave, große Terz und Quinte darüber) über einem gleichzeitigen, nicht
// leiseren Ton liegt, ist dessen Teilton. Die Oktave (+12) gilt nur bei einstimmigen Stems, in
// Akkorden (other) ist sie oft echt.
export function suppressOvertones(notes, { octave = true, ratio = 0.9 } = {}) {
  const OFF = octave ? [12, 19, 24, 28, 31, 34, 36] : [19, 24, 28, 31, 34, 36];
  const sorted = [...notes].sort((x, y) => x.start - y.start);
  return sorted.filter((n) => {
    for (const m of sorted) {
      if (m.start > n.start + 0.03) break;
      if (m === n || m.end < n.start + 0.02) continue; // m klingt beim Einsatz von n
      if (OFF.includes(n.midi - m.midi) && (n.amp ?? 0.5) <= ratio * (m.amp ?? 0.5) + 1e-9) return false;
    }
    return true;
  });
}

// Bass-Noten: nur das Band 30–250 Hz, einstimmig. Gleichzeitige Töne: der tiefste, solange er nicht
// viel leiser ist als der lauteste (Oberton-Oktaven werden gern stärker gemeldet als der Grundton)
export function filterBassNotes(notes) {
  const [lo, hi] = BASS_MIDI_BAND;
  const kept = suppressOvertones(notes.filter((n) => n.midi >= lo && n.midi <= hi).map((n) => ({ ...n })));
  kept.sort((x, y) => x.start - y.start || x.midi - y.midi);
  const out = [];
  for (let i = 0; i < kept.length; ) {
    let j = i;
    while (j + 1 < kept.length && kept[j + 1].start - kept[i].start < 0.03) j++;
    const group = kept.slice(i, j + 1);
    const max = Math.max(...group.map((g) => g.amp ?? 0.5));
    const pick = group.find((g) => (g.amp ?? 0.5) >= 0.35 * max) || group[0];
    const prev = out[out.length - 1];
    if (prev && pick.start < prev.end - 0.005) prev.end = pick.start; // der frühere endet mit dem Einsatz des späteren
    out.push(pick);
    i = j + 1;
  }
  return out.filter((n) => n.end > n.start);
}

// Lag der Bass-Einsätze gegenüber den Bassdrum-Transienten (Sekunden, ≥ 0)
export function bassLag(bassNotes, kickTimes, { window = [-0.03, 0.12] } = {}) {
  const diffs = [];
  for (const k of kickTimes) {
    let best = null;
    for (const n of bassNotes) {
      const d = n.start - k;
      if (d < window[0]) continue;
      if (d > window[1]) break;
      if (best === null || Math.abs(d) < Math.abs(best)) best = d;
    }
    if (best !== null) diffs.push(best);
  }
  if (diffs.length < 3) return { lag: 0, pairs: diffs.length };
  diffs.sort((a, b) => a - b);
  const med = diffs[Math.floor(diffs.length / 2)];
  // nur ein gleichmäßiger Versatz ist ein Lag (kein „mal vor, mal nach“)
  const mad = diffs.map((d) => Math.abs(d - med)).sort((a, b) => a - b)[Math.floor(diffs.length / 2)];
  if (mad > 0.025) return { lag: 0, pairs: diffs.length };
  return { lag: clamp(med, 0, 0.08), pairs: diffs.length };
}

export function compensateBassLag(bassNotes, lag) {
  if (!lag) return bassNotes.map((n) => ({ ...n }));
  return bassNotes.map((n) => ({ ...n, start: Math.max(0, n.start - lag), end: Math.max(0, n.end - lag) }));
}

// ---- Schlagzeug: Transienten -> Raster -------------------------------------------------------
// Band-Einsätze aus Audio: {t, low, mid, high, flux}
export function detectDrumOnsets(x, sr, { frame = 1024, hop = 256 } = {}) {
  const N = frame;
  const fft = makeFFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binHz = sr / N;
  const band = (hz) => Math.min(N / 2 - 1, Math.max(1, Math.round(hz / binHz)));
  const edges = [band(40), band(180), band(2500), band(Math.min(10000, sr / 2 - 1))];
  const nFrames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
  const E = [new Float32Array(nFrames), new Float32Array(nFrames), new Float32Array(nFrames)];
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let f = 0; f < nFrames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = x[o + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < 3; b++) {
      let s = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) s += re[k] * re[k] + im[k] * im[k];
      E[b][f] = s;
    }
  }
  // Fluss: positive Änderung der log-komprimierten Bandenergie
  const flux = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) {
    let s = 0;
    for (let b = 0; b < 3; b++) s += Math.max(0, Math.log1p(40 * E[b][f]) - Math.log1p(40 * E[b][f - 1]));
    flux[f] = s;
  }
  const out = [];
  const W = Math.round(0.12 / (hop / sr));
  // untere Schranke: mindestens 12 % des 95-Prozent-Flusses (kein Anspringen auf Restrauschen/Klicks)
  const sortedFlux = Float32Array.from(flux).sort();
  const floor = 0.12 * (sortedFlux[Math.floor(0.95 * (nFrames - 1))] || 0);
  for (let f = 2; f < nFrames - 2; f++) {
    if (flux[f] < flux[f - 1] || flux[f] <= flux[f + 1] || flux[f] < floor) continue;
    let mean = 0;
    let c = 0;
    for (let k = Math.max(1, f - W); k <= Math.min(nFrames - 1, f + W); k++) {
      mean += flux[k];
      c++;
    }
    mean /= c;
    if (flux[f] < 0.5 + 1.8 * mean) continue;
    const t = (f * hop + N / 2) / sr;
    if (out.length && t - out[out.length - 1].t < 0.04) {
      if (flux[f] > out[out.length - 1].flux) out.pop();
      else continue;
    }
    // Nachschwingen (Ausklang, Klick am Ende einer Hülle): deutlich schwächer als ein Einsatz < 0,2 s davor
    const before = out.length ? out[out.length - 1] : null;
    if (before && t - before.t < 0.2 && flux[f] < 0.3 * before.flux) continue;
    let lo = 0;
    let mi = 0;
    let hi = 0;
    for (let k = f; k <= Math.min(nFrames - 1, f + 2); k++) {
      lo = Math.max(lo, E[0][k]);
      mi = Math.max(mi, E[1][k]);
      hi = Math.max(hi, E[2][k]);
    }
    out.push({ t, low: lo, mid: mi, high: hi, flux: flux[f] });
  }
  return out;
}

// kick | snare | hat | other – aus den Energiedichten der drei Bänder (Energie je Hz), damit weißes
// Rauschen (Snare) nicht allein wegen der breiteren oberen Bänder wie eine Hi-Hat aussieht.
//   Bassdrum: Tiefen dominieren; Hi-Hat: Höhen ≥ 2,5× die Mitten; Snare: Mitten und Höhen etwa gleich
const BAND_HZ = { low: 140, mid: 2320, high: 7500 }; // 40–180, 180–2500, 2500–10000 Hz
export function classifyDrumHit(h) {
  if (h.kind) return h.kind;
  const dl = (h.low || 0) / BAND_HZ.low;
  const dm = (h.mid || 0) / BAND_HZ.mid;
  const dh = (h.high || 0) / BAND_HZ.high;
  if (!dl && !dm && !dh) return 'other';
  if (dl > 3 * Math.max(dm, dh)) return 'kick';
  if (dh > 2.5 * dm) return 'hat';
  if (dm >= 0.4 * dh && dm > 0.2 * dl) return 'snare';
  return 'other';
}

const KIND_WEIGHT = { kick: 1, snare: 1, hat: 0.35, other: 0.5 };

// Raster aus den Schlagzeug-Transienten: Tempo, Phase und Takt-Eins über den Backbeat
// hits: [{t, kind?|low,mid,high, w?}] (Sekunden). Rückgabe: Raster mit beats[] (Sekunden)
export function calibrateGrid(hitsIn, { bpm = null, beatsPerBar = 4, extraOnsets = [], duration = null } = {}) {
  const hits = hitsIn.map((h) => ({ t: h.t, kind: classifyDrumHit(h), w: (h.w ?? 1) * 1 })).sort((a, b) => a.t - b.t);
  hits.forEach((h) => (h.w *= KIND_WEIGHT[h.kind] ?? 0.5));
  if (hits.length < 4) return null;
  const all = [...hits.map((h) => ({ t: h.t, w: h.w })), ...extraOnsets.map((t) => ({ t, w: 0.3 }))];
  let detected = bpm;
  if (!detected) detected = estimateTempo(all).bpm;
  if (!detected) return null;
  const pt = plausibleTempo(detected, [...hits.map((h) => h.t), ...extraOnsets]);
  const tempo = pt.bpm;
  let P = 60 / tempo;
  // Phase: Summe gaußförmig bewerteter Abstände zur Gitterlinie
  const sigma = 0.035;
  let bestPhase = 0;
  let bestScore = -1;
  for (let ph = 0; ph < P; ph += 0.005) {
    let s = 0;
    for (const h of hits) {
      const d = mod(h.t - ph + P / 2, P) - P / 2;
      s += h.w * Math.exp(-((d / sigma) ** 2));
    }
    if (s > bestScore) {
      bestScore = s;
      bestPhase = ph;
    }
  }
  // Schläge nachführen (kleine Temposchwankungen)
  const end = duration ?? hits[hits.length - 1].t + 2 * P;
  const strong = hits.filter((h) => h.kind !== 'hat');
  let pos = bestPhase;
  // einen Schlag vor dem ersten Einsatz beginnen
  while (pos - P >= 0 && pos > hits[0].t - 0.5 * P) pos -= P;
  const beats = [];
  while (pos < end + P) {
    beats.push(pos);
    let num = 0;
    let den = 0;
    for (const h of strong) {
      const d = h.t - pos;
      if (Math.abs(d) <= 0.2 * P) {
        num += h.w * d;
        den += h.w;
      }
    }
    const err = den ? num / den : 0;
    pos += P + 0.4 * err;
    if (den) P = clamp(P + 0.05 * err, (60 / tempo) * 0.93, (60 / tempo) * 1.07);
  }
  // Takt-Eins: Bassdrum auf 1 (und 3), Snare auf 2 und 4 (Backbeat)
  const beatOf = (t) => {
    let lo = 0;
    let hi = beats.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] <= t) lo = mid;
      else hi = mid;
    }
    return Math.abs(t - beats[lo]) <= Math.abs(beats[Math.min(hi, beats.length - 1)] - t) ? lo : hi;
  };
  const scores = new Array(beatsPerBar).fill(0);
  const matched = [];
  for (const h of strong) {
    const bi = beatOf(h.t);
    if (Math.abs(h.t - beats[bi]) > 0.2 * (60 / tempo)) continue;
    matched.push({ kind: h.kind, bi, w: h.w });
  }
  for (let r = 0; r < beatsPerBar; r++) {
    for (const m of matched) {
      const p = mod(m.bi - r, beatsPerBar);
      if (m.kind === 'kick') scores[r] += m.w * (p === 0 ? 1 : p === beatsPerBar / 2 ? 0.55 : -0.3);
      else if (m.kind === 'snare') scores[r] += m.w * (p % 2 === 1 ? 1 : -0.5);
    }
  }
  let down = 0;
  for (let r = 1; r < beatsPerBar; r++) if (scores[r] > scores[down] + 1e-9) down = r;
  // Backbeat-Kontrolle
  let snareBack = 0;
  let snareAll = 0;
  let kickDown = 0;
  let kickAll = 0;
  for (const m of matched) {
    const p = mod(m.bi - down, beatsPerBar);
    if (m.kind === 'snare') {
      snareAll++;
      if (p % 2 === 1) snareBack++;
    } else if (m.kind === 'kick') {
      kickAll++;
      if (p % (beatsPerBar / 2) === 0) kickDown++;
    }
  }
  return {
    bpm: tempo,
    detectedBpm: detected,
    doubled: pt.doubled,
    doubledReason: pt.reason,
    period: 60 / tempo,
    beats,
    beatsPerBar,
    downbeatIndex: down,
    backbeat: { snareOnBackbeat: snareAll ? snareBack / snareAll : null, kickOnStrong: kickAll ? kickDown / kickAll : null },
    confidence: scores[down] > 0 ? clamp(scores[down] / Math.max(1, matched.length), 0, 1) : 0,
  };
}

// Sekunden -> Ticks (Takt 1, Zählzeit 1 = Tick 0; davor negativ = Auftakt)
export function gridTicker(grid) {
  const { beats, downbeatIndex } = grid;
  return (t) => {
    let lo = 0;
    let hi = beats.length - 1;
    if (t <= beats[0]) return (-(downbeatIndex) - (beats[0] - t) / (beats[1] - beats[0])) * DIV;
    if (t >= beats[hi]) return (hi - downbeatIndex + (t - beats[hi]) / (beats[hi] - beats[hi - 1])) * DIV;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] <= t) lo = mid;
      else hi = mid;
    }
    return (lo - downbeatIndex + (t - beats[lo]) / (beats[lo + 1] - beats[lo])) * DIV;
  };
}

// ---- Tonwiederholungen erhalten ------------------------------------------------------------
// Gleiche Tonhöhe, Einsatzabstand ≥ 60 ms: zwei Noten (kein Verschmelzen). Nur Splitter (< 60 ms)
// oder – mit Anschlag-Detektor (Teilton-Hüllkurve, src/input/fast.js) – Einsätze ohne neuen
// Anschlag werden zusammengefasst.
export function consolidateNotes(notes, { minSpacing = 0.06, attack = null } = {}) {
  const sorted = notes.map((n) => ({ ...n })).sort((a, b) => a.start - b.start || a.midi - b.midi);
  const lastOf = new Map();
  const out = [];
  for (const n of sorted) {
    const prev = lastOf.get(n.midi);
    if (prev && n.start - prev.start < minSpacing + 1e-9 && n.start - prev.start < minSpacing) {
      prev.end = Math.max(prev.end, n.end);
      prev.amp = Math.max(prev.amp ?? 0, n.amp ?? 0);
      continue;
    }
    if (prev && attack && n.start - prev.end <= 0.04 && n.start - prev.start >= minSpacing) {
      const r = attack(prev.start, n.start, n.midi);
      if (r && r.ok === false) {
        prev.end = Math.max(prev.end, n.end);
        continue;
      }
    }
    out.push(n);
    lastOf.set(n.midi, n);
  }
  return out;
}

// ---- Quantisierung ---------------------------------------------------------------------------
// Je Schlag wird zwischen binärem 16tel-Raster (6 Ticks) und Achteltriolen (8 Ticks) gewählt.
function chooseBeatGrids(ticks, nBeats) {
  const g = new Array(nBeats).fill(6);
  const err = (x, step) => Math.abs(x - Math.round(x / step) * step);
  const per = Array.from({ length: nBeats }, () => []);
  for (const x of ticks) {
    const b = Math.floor(x / DIV);
    if (b >= 0 && b < nBeats) per[b].push(mod(x, DIV));
  }
  for (let b = 0; b < nBeats; b++) {
    if (per[b].length < 2) continue;
    const e16 = per[b].reduce((s, x) => s + err(x, 6), 0);
    const e3 = per[b].reduce((s, x) => s + err(x, 8), 0);
    if (e3 + 3 < e16 * 0.7) g[b] = 8;
  }
  return g;
}

// notes (Sekunden) -> Ticks im Raster; Wiederholungen bleiben getrennt
export function quantizeNotes(notes, ticker, { beatGrids = null } = {}) {
  const raw = notes
    .map((n) => ({ ...n, s: ticker(n.start), e: ticker(n.end) }))
    .sort((a, b) => a.s - b.s || a.midi - b.midi);
  const maxTick = raw.length ? Math.max(...raw.map((n) => n.e)) : 0;
  const nBeats = Math.max(1, Math.ceil(maxTick / DIV) + 1);
  const offset = raw.length ? Math.min(0, ...raw.map((n) => n.s)) : 0;
  const shift = Math.ceil(-offset / DIV) * DIV;
  const grids = beatGrids || chooseBeatGrids(raw.map((n) => n.s + shift), nBeats + Math.ceil(shift / DIV));
  const snap = (x) => {
    const xs = x + shift;
    const b = clamp(Math.floor(xs / DIV), 0, grids.length - 1);
    const step = grids[b];
    const within = xs - b * DIV;
    return Math.round(within / step) * step + b * DIV - shift;
  };
  const out = [];
  const lastOf = new Map(); // je Tonhöhe der zuletzt gesetzte Ton
  for (const n of raw) {
    let st = snap(n.s);
    // Wiederholung auf demselben Rasterpunkt: auf das feinere Raster (32tel) schieben – die gespielten
    // Einsätze lagen ≥ 60 ms auseinander (kürzere sind schon vorher zusammengefasst)
    const prev = lastOf.get(n.midi);
    if (prev && st <= prev.start) st = prev.start + 3;
    let en = snap(n.e);
    if (en <= st) en = st + 6;
    if (prev && prev.start + prev.dur > st) prev.dur = st - prev.start;
    const note = { start: st, dur: en - st, midi: n.midi, vel: n.vel ?? n.amp ?? null, stem: n.stem };
    out.push(note);
    lastOf.set(n.midi, note);
  }
  return out.filter((n) => n.dur > 0);
}

// ---- Begleitung (Comping) -------------------------------------------------------------------
// Gleichzeitige Einsätze zu „Schlägen“ bündeln und je Takt die Dichte bestimmen.
//   Dichte > 2 je Takt:  'rhythmic'  -> synkopierte Staccato-/Marcato-Einwürfe
//   Dichte <= 1:         'sustained' -> gehaltene Klänge mit rhythmischer Phrasierung
//   Dichte == 2:         'moderate'  -> wie sustained, mit Neuanschlag in der Taktmitte
export function decodeComping(notes, { measureTicks, measureCount, cluster = 4 } = {}) {
  const sorted = [...notes].filter((n) => n.start >= 0).sort((a, b) => a.start - b.start);
  const hits = [];
  for (const n of sorted) {
    const h = hits[hits.length - 1];
    if (h && n.start - h.t0 <= cluster) {
      h.midis.push(n.midi);
      h.vel = Math.max(h.vel, n.vel ?? 0);
      h.dur = Math.max(h.dur, n.dur);
    } else hits.push({ t: n.start, t0: n.start, midis: [n.midi], vel: n.vel ?? 0, dur: n.dur });
  }
  const bars = [];
  for (let b = 0; b < measureCount; b++) {
    const a = b * measureTicks;
    const z = a + measureTicks;
    const bh = hits.filter((h) => h.t >= a && h.t < z).map((h) => ({ t: h.t - a, pcs: [...new Set(h.midis.map((m) => mod(m, 12)))], midis: h.midis, vel: h.vel, dur: h.dur }));
    const density = bh.length;
    bars.push({ bar: b, hits: bh, density, mode: density > 2 ? 'rhythmic' : density === 2 ? 'moderate' : 'sustained' });
  }
  return { bars, hits };
}

// ---- Gesamtweg: Stems -> Material -----------------------------------------------------------
// stems: { vocals, bass, other: [{start,end,midi,amp}], drums: { hits:[{t,low,mid,high}|{t,kind}] } }
// opts: { title, beatsPerBar, bpm (erzwingen), attack: {vocals|other: detektor} }
export function routeStems(stems, opts = {}) {
  const notes = [];
  const report = { notes: [], bassLag: 0, pairs: 0 };
  const drums = (stems.drums && stems.drums.hits) || [];
  const kick = drums.filter((h) => classifyDrumHit(h) === 'kick').map((h) => h.t);

  // 1) Bass: Band 30–250 Hz, einstimmig, Lag kompensiert
  let bass = filterBassNotes(stems.bass || []);
  const lag = bassLag(bass, kick);
  if (lag.lag > 0) {
    bass = compensateBassLag(bass, lag.lag);
    report.notes.push(`Bass: Sub-Bass-Lag ${Math.round(lag.lag * 1000)} ms ausgeglichen`);
  }
  report.bassLag = lag.lag;
  report.pairs = lag.pairs;

  // 2) Lead (vocals) und Begleitung (other); Tonwiederholungen ab 60 ms bleiben
  const att = opts.attack || {};
  const vocals = suppressOvertones(consolidateNotes(stems.vocals || [], { attack: att.vocals || null })).map((n) => ({ ...n, stem: 'vocals' }));
  let other = suppressOvertones(consolidateNotes(stems.other || [], { attack: att.other || null }), { octave: false }).map((n) => ({ ...n, stem: 'other' }));
  // Durchsprechen: dieselbe Tonhöhe fast gleichzeitig in vocals und other gehört dem Gesang
  other = other.filter((n) => !vocals.some((v) => v.midi === n.midi && Math.abs(v.start - n.start) < 0.05));
  other = other.filter((n) => !bass.some((b) => b.midi === n.midi && Math.abs(b.start - n.start) < 0.05));

  // 3) Raster aus dem Schlagzeug (nie Noten daraus)
  const extra = mergeOnsets([...other.map((n) => n.start), ...vocals.map((n) => n.start)]);
  const grid = drums.length >= 4 ? calibrateGrid(drums, { bpm: opts.bpm || null, beatsPerBar: opts.beatsPerBar || 4, extraOnsets: extra }) : null;
  if (!grid) throw new Error('Aus dem Schlagzeug-Stem lässt sich kein Raster bestimmen (zu wenige Transienten)');
  if (grid.doubled) report.notes.push(`Tempo ${grid.detectedBpm} → ${grid.bpm} BPM (${grid.doubledReason})`);
  const ticker = gridTicker(grid);

  // 4) Quantisieren – ein gemeinsames Raster für alle Stems
  const lead = quantizeNotes(vocals, ticker);
  const comp = quantizeNotes(other, ticker);
  const bassT = quantizeNotes(bass, ticker);
  const mt = grid.beatsPerBar * DIV;
  // Auftakt: ein vorangestellter Takt, damit alle Einsätze ≥ 0 liegen
  const minStart = Math.min(0, ...lead.map((n) => n.start), ...comp.map((n) => n.start), ...bassT.map((n) => n.start));
  const pickupBars = minStart < 0 ? Math.ceil(-minStart / mt) : 0;
  const sh = pickupBars * mt;
  const shift = (list) => list.map((n) => ({ ...n, start: n.start + sh }));
  const drumTicks = drums.map((h) => ({ start: Math.round(ticker(h.t) / 3) * 3 + sh, kind: classifyDrumHit(h), vel: h.w ?? 1 })).filter((d) => d.start >= 0);
  let total = Math.max(0, ...lead.map((n) => n.start + n.dur + sh), ...comp.map((n) => n.start + n.dur + sh), ...bassT.map((n) => n.start + n.dur + sh));
  // Ausklang der KI-Noten über den letzten Takt hinaus ist kein neuer Takt: überragt die Musik den
  // letzten vollen Takt um höchstens eine Zählzeit und beginnt dort kein Ton, wird gekürzt
  const lastFull = Math.floor(total / mt) * mt;
  const overhang = total - lastFull;
  if (overhang > 0 && overhang <= DIV && lastFull > 0) {
    const starts = [...lead, ...comp, ...bassT].some((n) => n.start + sh >= lastFull);
    if (!starts) {
      total = lastFull;
      for (const list of [lead, comp, bassT]) for (const n of list) if (n.start + sh + n.dur > total) n.dur = Math.max(3, total - sh - n.start);
    }
  }
  return {
    title: opts.title || 'Audio-Import',
    tempo: grid.bpm,
    meter: { beats: grid.beatsPerBar, beatType: 4 },
    measureCount: Math.max(1, Math.ceil(total / mt)),
    pickupBars,
    lead: shift(lead),
    bass: shift(bassT),
    comp: shift(comp),
    drums: drumTicks,
    grid,
    report,
  };
}

// Rohaudio -> Noten/Einsätze. pitch(samples, sampleRate) -> [{start,end,midi,amp}] (Basic Pitch,
// im Test ersetzbar). Der Schlagzeug-Stem liefert ausschließlich Transienten.
export async function analyzeStemAudio(stems, { pitch } = {}) {
  if (typeof pitch !== 'function') throw new Error('analyzeStemAudio: pitch(samples, sampleRate) fehlt');
  const out = {};
  if (stems.vocals) out.vocals = await pitch(stems.vocals.samples, stems.vocals.sampleRate);
  if (stems.other) out.other = await pitch(stems.other.samples, stems.other.sampleRate);
  if (stems.bass) {
    const y = bandpass(stems.bass.samples, stems.bass.sampleRate);
    out.bass = await pitch(y, stems.bass.sampleRate);
  }
  if (stems.drums) out.drums = { hits: detectDrumOnsets(stems.drums.samples, stems.drums.sampleRate) };
  return out;
}
