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
    onProgress((w + 1) / nWin);
    // dem Browser Luft lassen
    if (w % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  return { frames, onsets, contours };
}

// Noten (Sekunden) aus der KI-Ausgabe
export function aiNotes(out, { onsetThresh = 0.5, frameThresh = 0.3, minNoteLen = 5 } = {}) {
  const raw = outputToNotesPoly(out.frames, out.onsets, onsetThresh, frameThresh, minNoteLen, true, null, null, true);
  return noteFramesToTime(raw).map((n) => ({ start: n.startTimeSeconds, end: n.startTimeSeconds + n.durationSeconds, midi: n.pitchMidi, amp: n.amplitude }));
}

// KI vorab laden (Modell & Rechen-Backend), damit der erste Analyseschritt sichtbar wird
export async function loadAi() {
  const tf = await getTf();
  await tf.ready();
  await getModel();
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
