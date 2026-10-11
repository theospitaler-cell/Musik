// Lokale KI für Noten aus Audio: Spotify „Basic Pitch“ (neuronales Netz, Apache-2.0), läuft komplett
// im Gerät mit TensorFlow.js – keine Server, keine Kosten. Liefert mehrstimmige Noten (Melodie,
// Begleitung, Bass) mit Anschlagsstärke; daraus werden Melodie, Basslinie und Harmonik gebildet.
import { outputToNotesPoly, noteFramesToTime } from '../../vendor/basic-pitch/notes.js';

const SR = 22050;
const FFT_HOP = 256;
const AUDIO_N_SAMPLES = SR * 2 - FFT_HOP;
const N_OVERLAP = 30;
const OVERLAP_HALF = N_OVERLAP / 2;
const OVERLAP_SAMPLES = N_OVERLAP * FFT_HOP;
const HOP = AUDIO_N_SAMPLES - OVERLAP_SAMPLES;
const FPS = Math.floor(SR / FFT_HOP);

let tfP = null;
let modelP = null;

async function getTf() {
  if (!tfP)
    tfP = (async () => {
      // Node (Tests): TensorFlow.js erwartet dort require()
      if (typeof process !== 'undefined' && process.versions?.node && typeof window === 'undefined' && typeof globalThis.require === 'undefined') {
        const { createRequire } = await import('module');
        globalThis.require = createRequire(import.meta.url);
      }
      return import('../../vendor/tfjs/tf.fesm.min.js');
    })();
  return tfP;
}

// Modell laden: im Browser per URL, in Node/Tests aus Dateien
async function getModel() {
  if (modelP) return modelP;
  modelP = (async () => {
    const tf = await getTf();
    const url = new URL('../../vendor/basic-pitch/model.json', import.meta.url);
    if (url.protocol === 'file:') {
      const { readFile } = await import('fs/promises');
      const json = JSON.parse(await readFile(url, 'utf8'));
      const bin = await readFile(new URL('../../vendor/basic-pitch/group1-shard1of1.bin', import.meta.url));
      const weights = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
      return tf.loadGraphModel(tf.io.fromMemory({ modelTopology: json.modelTopology, weightSpecs: json.weightsManifest[0].weights, weightData: weights, format: json.format, generatedBy: json.generatedBy, convertedBy: json.convertedBy }));
    }
    return tf.loadGraphModel(url.href);
  })();
  return modelP;
}

// audio: Float32Array mono 22050 Hz -> {frames, onsets, contours} (je Frame 88 bzw. 264 Werte)
export async function runBasicPitch(audio, onProgress = () => {}) {
  const tf = await getTf();
  const model = await getModel();
  const padded = new Float32Array(OVERLAP_SAMPLES / 2 + audio.length);
  padded.set(audio, OVERLAP_SAMPLES / 2);
  const nWin = Math.max(1, Math.ceil((padded.length - AUDIO_N_SAMPLES) / HOP) + 1);
  const nOut = Math.floor(audio.length * (FPS / SR));
  const frames = [];
  const onsets = [];
  const contours = [];
  const win = new Float32Array(AUDIO_N_SAMPLES);
  for (let w = 0; w < nWin; w++) {
    win.fill(0);
    win.set(padded.subarray(w * HOP, Math.min(padded.length, w * HOP + AUDIO_N_SAMPLES)));
    const out = tf.tidy(() => {
      const x = tf.tensor3d(win, [1, AUDIO_N_SAMPLES, 1]);
      const [fr, on, co] = model.execute(x, ['Identity_1', 'Identity_2', 'Identity']);
      const cut = (t) => t.slice([0, OVERLAP_HALF, 0], [-1, t.shape[1] - 2 * OVERLAP_HALF, -1]).squeeze([0]);
      return [cut(fr), cut(on), cut(co)];
    });
    const [fa, oa, ca] = await Promise.all(out.map((t) => t.array()));
    out.forEach((t) => t.dispose());
    for (let i = 0; i < fa.length && frames.length < nOut; i++) {
      frames.push(fa[i]);
      onsets.push(oa[i]);
      contours.push(ca[i]);
    }
    onProgress((w + 1) / nWin, w + 1, nWin);
    // dem Browser Luft lassen (Fortschrittsanzeige) – ohne setTimeout, das in verdeckten Fenstern
    // auf eine Sekunde gedrosselt wird
    if (w % 2 === 1) await yieldNow();
  }
  return { frames, onsets, contours };
}

function yieldNow() {
  return new Promise((r) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(r, 0);
      return;
    }
    const c = new MessageChannel();
    c.port1.onmessage = () => {
      c.port1.close();
      r();
    };
    c.port2.postMessage(0);
  });
}

// Noten (Sekunden) aus der KI-Ausgabe
export function aiNotes(out, { onsetThresh = 0.5, frameThresh = 0.3, minNoteLen = 5 } = {}) {
  const raw = outputToNotesPoly(out.frames, out.onsets, onsetThresh, frameThresh, minNoteLen, true, null, null, true);
  return noteFramesToTime(raw).map((n) => ({ start: n.startTimeSeconds, end: n.startTimeSeconds + n.durationSeconds, midi: n.pitchMidi, amp: n.amplitude }));
}

// KI vorab laden (Modell & Rechen-Backend), damit der erste Analyseschritt sichtbar wird.
// backend: 'cpu' erzwingt das Rechnen auf dem Prozessor. Ergebnis: Name des aktiven Backends.
export async function loadAi(backend = null) {
  const tf = await getTf();
  if (backend && tf.getBackend() !== backend) await tf.setBackend(backend);
  await tf.ready();
  await getModel();
  return tf.getBackend();
}

// Ist die KI verfügbar (TensorFlow.js lädt)?
export async function aiAvailable() {
  try {
    await getModel();
    return true;
  } catch {
    return false;
  }
}

// ---------- KI + Signalanalyse kombinieren ----------
// mel: [{s, e, midi}] (Sekunden) aus der Salienz-Analyse; ai: KI-Noten [{start, end, midi, amp}]
// Ergebnis: Melodie mit
//  - KI-Tonhöhe, wo die Analyse eine Oktave/Halbton daneben liegt (KI hört Obertöne sicherer)
//  - KI-Einsatz (auf ±40 ms genauer)
//  - ergänzten Tönen in Lücken, wo die KI eine laute, zur Linie passende Note hört
export function fuseMelody(mel, ai, { reattack = null } = {}) {
  if (!ai || !ai.length) return { melody: mel, changed: 0, added: 0 };
  const lead = ai.filter((n) => n.midi >= 50);
  // typische Lautstärke der Melodie = KI-Noten, die mit der Analyse übereinstimmen
  const matchAmp = [];
  for (const m of mel) {
    const a = lead.find((x) => Math.abs(x.start - m.s) < 0.07 && x.midi % 12 === m.midi % 12);
    if (a) matchAmp.push(a.amp);
  }
  matchAmp.sort((a, b) => a - b);
  const typ = matchAmp.length >= 4 ? matchAmp[Math.floor(matchAmp.length / 2)] : null;
  if (!typ) return { melody: mel, changed: 0, added: 0 };
  const thr = 0.7 * typ;
  let changed = 0;
  const out = mel.map((m) => {
    const cands = lead.filter((x) => Math.abs(x.start - m.s) < 0.06 && x.amp >= thr && Math.abs(x.midi - m.midi) <= 12);
    if (!cands.length) return m;
    const best = cands.sort((a, b) => Math.abs(a.midi - m.midi) - Math.abs(b.midi - m.midi) || b.amp - a.amp)[0];
    const d = best.midi - m.midi;
    const r = { ...m, s: best.start };
    // Oktav-/Halbtonfehler der Analyse korrigieren, wenn die KI sicher ist
    if ((Math.abs(d) === 12 || Math.abs(d) === 1) && best.amp >= typ) {
      r.midi = best.midi;
      changed++;
    }
    return r;
  });
  // Tonwiederholungen: die KI hört einen neuen Anschlag desselben Tons mitten in einem langen Ton
  const split = [];
  for (const m of out) {
    const re = lead
      .filter((x) => x.midi === m.midi && x.start > m.s + 0.1 && x.start < m.e - 0.08 && x.amp >= Math.max(thr, 0.85 * typ) && (!reattack || reattack(x.start, x.midi)))
      .sort((a, b) => a.start - b.start);
    let cur = { ...m };
    for (const x of re) {
      split.push({ ...cur, e: x.start - 0.01 });
      cur = { ...m, s: x.start };
      changed++;
    }
    split.push(cur);
  }
  // Lücken füllen
  const sorted = split.sort((a, b) => a.s - b.s);
  const covered = (t0, t1) => sorted.some((m) => m.s < t1 - 0.03 && m.e > t0 + 0.03);
  let added = 0;
  const loud = lead.filter((x) => x.amp >= Math.max(thr, 0.85 * typ)).sort((a, b) => a.start - b.start);
  for (const x of loud) {
    if (covered(x.start, x.end)) continue;
    // passt zur Linie: höchstens eine None/Dezime von den Nachbartönen entfernt
    const prev = [...sorted].reverse().find((m) => m.s < x.start);
    const next = sorted.find((m) => m.s > x.start);
    const ref = [prev, next].filter(Boolean).filter((m) => Math.abs(m.s - x.start) < 4);
    if (!ref.length || ref.some((m) => Math.abs(m.midi - x.midi) > 14)) continue;
    // in derselben Lücke nur der lauteste/höchste Ton
    const rival = loud.find((y) => y !== x && Math.abs(y.start - x.start) < 0.05 && (y.amp > x.amp || (y.amp === x.amp && y.midi > x.midi)));
    if (rival) continue;
    const n = { s: x.start, e: x.end, midi: x.midi, ai: true };
    sorted.push(n);
    sorted.sort((a, b) => a.s - b.s);
    added++;
  }
  return { melody: sorted, changed, added };
}

// Basslinie (tiefste Töne, einstimmig) und Begleitung (alles außer Melodie & Bass) aus den KI-Noten
export function aiBassAndHarmony(ai, melody) {
  const bass = [];
  const low = ai.filter((n) => n.midi < 52).sort((a, b) => a.start - b.start || a.midi - b.midi);
  for (const n of low) {
    const prev = bass[bass.length - 1];
    if (prev && Math.abs(prev.start - n.start) < 0.04) continue; // gleichzeitiger Ton: tiefster zählt
    if (prev && prev.end > n.start) prev.end = n.start;
    bass.push({ ...n });
  }
  const isMel = (n) => melody.some((m) => Math.abs(m.s - n.start) < 0.05 && m.midi === n.midi);
  const harmony = ai.filter((n) => n.midi >= 48 && !isMel(n));
  return { bass: bass.filter((n) => n.end - n.start > 0.05), harmony };
}

// ---------- Gründliche Analyse: mehrere Durchgänge, Ergebnis gemittelt ----------
// Ein Durchgang = das Modell einmal über das ganze Lied. Jeder weitere Durchgang
//  - verschiebt das Fensterraster (Fenstergrenzen sind die Schwachstelle des Modells) und
//  - hört auf einer anderen Ansicht des Signals (Mitte/Original, „harmonischer“ Anteil ohne
//    Schlagzeug-Transienten).
// Gemittelt werden die Aktivierungen (Frames, Onsets) – ein Ton, den nur ein Durchgang „sieht“,
// fällt unter die Schwelle; Töne, die alle hören, werden sicherer (Einsatz & Dauer genauer).
const SHIFTS = [0, 70 * 256 + 128, 35 * 256 + 64, 105 * 256 + 192, 52 * 256 + 32, 17 * 256 + 160];

// Aktivierungen (Frames, Onsets) für ein Signal; shift: Samples, um die das Raster versetzt ist
async function inferActivations(audio, shift, onProgress, { tf, model }) {
  const shiftFrames = Math.floor(shift / FFT_HOP);
  const sub = shift - shiftFrames * FFT_HOP;
  const lead = OVERLAP_SAMPLES / 2 + shiftFrames * FFT_HOP + sub;
  const padded = new Float32Array(lead + audio.length);
  padded.set(audio, lead);
  const nWin = Math.max(1, Math.ceil((padded.length - AUDIO_N_SAMPLES) / HOP) + 1);
  const nOut = Math.floor(audio.length * (FPS / SR));
  const total = nOut + shiftFrames;
  const frames = new Float32Array(nOut * 88);
  const onsets = new Float32Array(nOut * 88);
  let fi = 0; // geschriebene Frames dieses Durchgangs (inkl. Vorlauf)
  const win = new Float32Array(AUDIO_N_SAMPLES);
  for (let w = 0; w < nWin && fi < total; w++) {
    win.fill(0);
    win.set(padded.subarray(w * HOP, Math.min(padded.length, w * HOP + AUDIO_N_SAMPLES)));
    const res = tf.tidy(() => {
      const x = tf.tensor3d(win, [1, AUDIO_N_SAMPLES, 1]);
      const [fr, on] = model.execute(x, ['Identity_1', 'Identity_2']);
      const cut = (t) => t.slice([0, OVERLAP_HALF, 0], [-1, t.shape[1] - 2 * OVERLAP_HALF, -1]).squeeze([0]);
      return [cut(fr), cut(on)];
    });
    const [fa, oa] = await Promise.all(res.map((t) => t.data()));
    res.forEach((t) => t.dispose());
    const rows = fa.length / 88;
    for (let r = 0; r < rows && fi < total; r++, fi++) {
      const o = fi - shiftFrames; // Ausgabe-Frame (Vorlauf verwerfen)
      if (o < 0) continue;
      frames.set(fa.subarray(r * 88, r * 88 + 88), o * 88);
      onsets.set(oa.subarray(r * 88, r * 88 + 88), o * 88);
    }
    if (onProgress) onProgress((w + 1) / nWin);
    if (w % 2 === 1) await yieldNow();
  }
  return { frames, onsets, nOut };
}

// Ansicht mit verschobener Tonhöhe: das Signal wird um `semis` Halbtöne „hochgespielt“ (schneller
// abgespielt, kürzer), das Modell hört es in anderen Tonhöhen-Bins – seine Fehler sind dort anders
// verteilt. Die Aktivierungen werden zurück auf Zeit und Tonhöhe des Originals abgebildet.
async function inferPitchShifted(audio, semis, onProgress, handles) {
  const r = 2 ** (semis / 12);
  const n = Math.floor(audio.length / r);
  const sh = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * r;
    const i0 = Math.floor(x);
    const fr = x - i0;
    sh[i] = audio[i0] * (1 - fr) + (audio[i0 + 1] || 0) * fr;
  }
  const pass = await inferActivations(sh, 0, onProgress, handles);
  const nOut = Math.floor(audio.length * (FPS / SR));
  const frames = new Float32Array(nOut * 88);
  const onsets = new Float32Array(nOut * 88);
  for (let i = 0; i < nOut; i++) {
    const x = i / r;
    const i0 = Math.floor(x);
    if (i0 + 1 >= pass.nOut) break;
    const fr = x - i0;
    for (let k = 0; k < 88; k++) {
      const bs = k + semis;
      if (bs < 0 || bs > 87) continue;
      frames[i * 88 + k] = pass.frames[i0 * 88 + bs] * (1 - fr) + pass.frames[(i0 + 1) * 88 + bs] * fr;
      onsets[i * 88 + k] = pass.onsets[i0 * 88 + bs] * (1 - fr) + pass.onsets[(i0 + 1) * 88 + bs] * fr;
    }
  }
  return { frames, onsets, nOut };
}

const PITCH_VIEWS = [1, -1, 2, -2];

// sources: [{ audio: Float32Array (22050 Hz mono), name }] – die erste ist die Hauptansicht
// passes: Durchgänge insgesamt (höchstens); pitchViews: davon mit verschobener Tonhöhe
// Ergebnis: { notes: [{start, end, midi, amp}], passes, ms }
export async function runEnsemble(sources, { budgetMs = 300000, maxPasses = 6, passes = null, pitchViews = 0, minPasses = 1, onProgress = () => {}, onsetThresh = null, frameThresh = null } = {}) {
  const total = Math.max(1, passes ?? maxPasses);
  const tf = await getTf();
  const model = await getModel();
  const handles = { tf, model };
  const t0 = Date.now();
  // Plan: erst Fensterraster-Verschiebungen aller Ansichten (wichtigste zuerst), dann Tonhöhen-Ansichten
  const nPitch = Math.min(pitchViews, Math.max(0, total - sources.length));
  const plan = [];
  for (let p = 0; p < total - nPitch; p++) plan.push({ src: sources[p % sources.length], shift: SHIFTS[Math.floor(p / sources.length) % SHIFTS.length], semis: 0 });
  for (let i = 0; i < nPitch; i++) plan.push({ src: sources[i % sources.length], shift: 0, semis: PITCH_VIEWS[i % PITCH_VIEWS.length] });
  let sum = null;
  let weight = 0;
  let nOut = 0;
  let planned = plan.length;
  for (let p = 0; p < planned; p++) {
    const step = plan[p];
    const prog = (fr) => onProgress((p + fr) / planned, p + 1, planned);
    const pass = step.semis ? await inferPitchShifted(step.src.audio, step.semis, prog, handles) : await inferActivations(step.src.audio, step.shift, prog, handles);
    if (!sum) {
      sum = { frames: new Float32Array(pass.frames.length), onsets: new Float32Array(pass.onsets.length) };
      nOut = pass.nOut;
    }
    for (let i = 0; i < sum.frames.length; i++) {
      sum.frames[i] += pass.frames[i];
      sum.onsets[i] += pass.onsets[i];
    }
    weight++;
    if (p === 0 && budgetMs > 0) {
      // Zeitplan nach dem ersten Durchgang: so viele, wie ins Budget passen
      const per = Math.max(1, Date.now() - t0);
      planned = Math.max(minPasses, Math.min(plan.length, Math.floor(budgetMs / per)));
    }
    onProgress(weight / planned, weight, planned);
  }
  const rowsF = [];
  const rowsO = [];
  for (let i = 0; i < nOut; i++) {
    const fr = new Array(88);
    const on = new Array(88);
    for (let k = 0; k < 88; k++) {
      fr[k] = sum.frames[i * 88 + k] / weight;
      on[k] = sum.onsets[i * 88 + k] / weight;
    }
    rowsF.push(fr);
    rowsO.push(on);
  }
  const multi = weight > 1;
  const notes = aiNotes({ frames: rowsF, onsets: rowsO }, { onsetThresh: onsetThresh ?? (multi ? 0.45 : 0.5), frameThresh: frameThresh ?? (multi ? 0.28 : 0.3) });
  return { notes, passes: weight, ms: Date.now() - t0 };
}

// Markiert Noten der Hauptansicht, die auch im „Seiten“-Signal ((L−R)/2) vorkommen: Die Mitte
// (Gesang, Bass, Schlagzeug) hebt sich dort auf, seitlich verteilte Gitarren & Streicher bleiben.
// Solche Töne gehören sehr wahrscheinlich zur Begleitung, nicht zur Gesangsmelodie.
export function flagSideNotes(notes, sideNotes) {
  if (!sideNotes || !sideNotes.length) return notes;
  const by = new Map();
  for (const s of sideNotes) {
    if (!by.has(s.midi)) by.set(s.midi, []);
    by.get(s.midi).push(s);
  }
  for (const n of notes) {
    const c = by.get(n.midi);
    if (!c) continue;
    if (c.some((s) => Math.abs(s.start - n.start) < 0.06 && s.amp >= 0.5 * n.amp)) n.side = true;
  }
  return notes;
}
