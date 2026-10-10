// Audio-Export: die Vorschau-Wiedergabe offline berechnen – mit denselben Klängen und demselben
// Mischpult wie live (synth.js) – und auf dem Gerät als MP3 kodieren (LAME, vendor/lame.min.js).
// Alles lokal, ohne Server.
import { buildGraph, scheduleNote, loadStretchWorklet, createStretchNode, COMPRESSOR_DELAY } from './synth.js';

const SR = 44100;
const LAME_URL = new URL('../../vendor/lame.min.js', import.meta.url).href;

// Kann dieser Browser die Aufnahme im Übe-Tempo (Tonhöhe bleibt) offline berechnen?
export function canStretchOffline() {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  return !!OAC && typeof AudioWorkletNode !== 'undefined' && 'audioWorklet' in OAC.prototype;
}

// Lautstärke je Stimme im Export. mode 'mix': wie im Mischpult (Stumm/Solo/Lautstärke);
// 'part': nur partKey. withRecording: Original-Aufnahme dazu (sonst ohne).
export function exportGains(player, { mode = 'mix', partKey = null, withRecording = false } = {}) {
  const gains = new Map();
  for (const p of player.parts) {
    let g = 0;
    if (p.audio) g = withRecording ? p.volume || 0.85 : 0;
    else if (mode === 'mix') g = player.audible(p) ? p.volume : 0;
    else if (String(p.key) === String(partKey)) g = p.volume || 0.8;
    gains.set(String(p.key), g);
  }
  return gains;
}

// Offline berechnen. Liefert {channels: [L, R], sampleRate, duration}.
export async function renderMixdown(player, { mode = 'mix', partKey = null, withRecording = false, speed = 1, onProgress = () => {} } = {}) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) throw new Error('Dieser Browser kann keine Audiodateien berechnen');
  const perf = player.perf;
  const gains = exportGains(player, { mode, partKey, withRecording });
  const parts = player.parts.map((p) => ({ key: p.key, inst: p.inst, orig: p.orig, audio: p.audio, drum: p.drum, pan: mode === 'part' ? 0 : p.pan }));
  const byKey = new Map(parts.map((p) => [String(p.key), p]));
  const audioPart = parts.find((p) => p.audio);
  const useRec = !!(audioPart && player.audioUrl && gains.get(String(audioPart.key)) > 0);
  const notes = perf.notes.filter((n) => gains.get(String(n.part)) > 0 && byKey.has(String(n.part)));
  // Aufnahme lesen (wird auf die Export-Abtastrate umgerechnet)
  let rec = null;
  if (useRec) {
    onProgress('Aufnahme wird gelesen', 0.01);
    const bytes = await (await fetch(player.audioUrl)).arrayBuffer();
    rec = await new OAC(2, SR, SR).decodeAudioData(bytes);
  }
  let end = 0;
  for (const n of notes) end = Math.max(end, n.t + n.d);
  if (rec) end = Math.max(end, (perf.audioStart || 0) + rec.duration);
  if (!notes.length && !rec) throw new Error('Keine hörbare Stimme – im Mischpult ist alles stumm');
  const length = Math.ceil((end / speed + 2.5) * SR);
  const ctx = new OAC(2, length, SR);
  const graph = buildGraph(ctx, parts, { master: 0.9 });
  for (const [key, g] of gains) {
    const nd = graph.nodes.get(key);
    if (nd) nd.gain.gain.value = g;
  }
  if (rec) {
    const dest = graph.nodes.get(String(audioPart.key)).gain;
    const start = perf.audioStart || 0;
    if (speed === 1) {
      const src = ctx.createBufferSource();
      src.buffer = rec;
      src.connect(dest);
      src.start(start);
    } else {
      if (!(await loadStretchWorklet(ctx))) throw new Error('Übe-Tempo mit Aufnahme wird von diesem Browser nicht unterstützt');
      const chans = [];
      for (let c = 0; c < Math.min(2, rec.numberOfChannels); c++) chans.push(rec.getChannelData(c));
      // Ausgabe-Sekunde τ = Partiturzeit τ·speed -> Aufnahme-Sekunde τ·speed − audioStart
      createStretchNode(ctx, chans, { at: 0, pos: -start, speed }).connect(dest);
    }
  }
  // Noten abschnittsweise einplanen (spart Speicher, liefert Fortschritt)
  const total = length / SR;
  let idx = 0;
  const planUntil = (t) => {
    while (idx < notes.length && notes[idx].t / speed < t) {
      const n = notes[idx++];
      const p = byKey.get(String(n.part));
      scheduleNote(ctx, p, graph.nodes.get(String(n.part)).gain, n, Math.max(0, n.t / speed), { speed, noise: graph.noise });
    }
  };
  // immer einen Abschnitt im Voraus planen (Unterbrechungen liegen auf 128er-Rastern)
  const CHUNK = 2;
  if (typeof ctx.suspend === 'function') {
    planUntil(2 * CHUNK);
    const step = (k) => {
      const t = k * CHUNK;
      if (t >= total - 0.05) return;
      ctx.suspend(t).then(() => {
        planUntil(t + 2 * CHUNK);
        onProgress('Stimmen werden berechnet', 0.05 + 0.95 * (t / total));
        step(k + 1);
        ctx.resume();
      });
    };
    step(1);
  } else planUntil(Infinity);
  onProgress('Stimmen werden berechnet', 0.05);
  const buf = await ctx.startRendering();
  onProgress('Stimmen werden berechnet', 1);
  // Kompressor-Vorlauf vorne weglassen (Datei liegt exakt auf der Zeitachse des Originals),
  // Stille am Ende kürzen, Pegel angleichen (Spitze −1 dBFS)
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const pre = Math.round(COMPRESSOR_DELAY * SR);
  let last = 0;
  let peak = 0;
  for (let i = pre; i < L.length; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > 1e-4) last = i;
    if (a > peak) peak = a;
  }
  const cut = Math.min(L.length, last + Math.round(0.3 * SR));
  const gain = peak > 0 ? Math.min(8, 0.89 / peak) : 1;
  const out = [L, R].map((ch) => {
    const o = ch.slice(pre, cut);
    for (let i = 0; i < o.length; i++) o[i] *= gain;
    return o;
  });
  return { channels: out, sampleRate: SR, duration: out[0].length / SR };
}

// ---- MP3 ----
// ID3v2.3-Tag (Titel, Software) – damit Player den Namen anzeigen
function id3(tags = {}) {
  const frames = [];
  const text = (id, s) => {
    if (!s) return;
    const str = String(s);
    const body = [1, 0xff, 0xfe]; // UTF-16 mit BOM (Umlaute)
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      body.push(c & 255, c >> 8);
    }
    const size = body.length;
    frames.push(...[...id].map((c) => c.charCodeAt(0)), (size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, 0, 0, ...body);
  };
  text('TIT2', tags.title);
  text('TPE1', tags.artist);
  text('TSSE', 'NoteCode');
  const n = frames.length;
  const head = [0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
  return new Uint8Array([...head, ...frames]);
}

function loadLame() {
  if (window.lamejs) return Promise.resolve(window.lamejs);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LAME_URL;
    s.onload = () => resolve(window.lamejs);
    s.onerror = () => reject(new Error('MP3-Kodierer konnte nicht geladen werden'));
    document.head.appendChild(s);
  });
}

// Rückfall ohne Web-Worker: im Hauptthread, in Häppchen (Oberfläche bleibt bedienbar)
async function encodeHere(channels, sampleRate, kbps, onProgress) {
  const lame = await loadLame();
  const nch = Math.min(2, channels.length);
  const enc = new lame.Mp3Encoder(nch, sampleRate, kbps);
  const len = channels[0].length;
  const BLOCK = 1152 * 32;
  const L = new Int16Array(BLOCK);
  const R = new Int16Array(BLOCK);
  const pcm = (src, from, n, dst) => {
    for (let i = 0; i < n; i++) dst[i] = Math.max(-32768, Math.min(32767, Math.round(src[from + i] * 32767)));
  };
  const chunks = [];
  for (let i = 0; i < len; i += BLOCK) {
    const n = Math.min(BLOCK, len - i);
    pcm(channels[0], i, n, L);
    if (nch > 1) pcm(channels[1], i, n, R);
    chunks.push(nch > 1 ? enc.encodeBuffer(L.subarray(0, n), R.subarray(0, n)) : enc.encodeBuffer(L.subarray(0, n)));
    onProgress(i / len);
    await new Promise((r) => setTimeout(r, 0));
  }
  chunks.push(enc.flush());
  return chunks.map((c) => new Uint8Array(c.buffer, c.byteOffset, c.length));
}

// Kodierung im Web-Worker. Die Daten werden erst übergeben, wenn der Worker samt Kodierer
// bereit ist – scheitert er vorher, bleiben sie für den Rückfall im Hauptthread erhalten.
function encodeInWorker(channels, sampleRate, kbps, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    let sent = false;
    try {
      worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
    } catch (e) {
      reject(Object.assign(e, { retry: true }));
      return;
    }
    const fail = (msg) => {
      worker.terminate();
      const err = new Error(msg || 'MP3-Kodierung fehlgeschlagen');
      err.retry = !sent;
      reject(err);
    };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') {
        sent = true;
        worker.postMessage({ channels, sampleRate, kbps }, channels.map((c) => c.buffer));
      } else if (m.type === 'progress') onProgress(m.frac);
      else if (m.type === 'done') {
        worker.terminate();
        resolve(m.chunks);
      } else if (m.type === 'error') fail(m.message);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      fail(e.message);
    };
  });
}

// LAME verzögert den Klang beim Dekodieren um 576 + 529 Samples (ohne Gapless-Info) – diese
// werden vorne weggelassen, damit die MP3 exakt auf der Zeitachse von Noten & Original liegt
// (z. B. eine Einzelstimme zusammen mit der Aufnahme in einer DAW). Gemessen mit ffmpeg.
const LAME_DELAY = 1105;

// Float-Kanäle -> MP3-Blob (mit Titel-Tag). Die Kanäle werden dabei übergeben (nicht mehr nutzen).
export async function encodeMp3(channels, sampleRate, { kbps = 192, title = '', onProgress = () => {} } = {}) {
  const skip = Math.min(LAME_DELAY, Math.max(0, channels[0].length - 1152));
  channels = channels.map((c) => {
    const v = c.subarray(skip);
    for (let i = 0; i < Math.min(64, v.length); i++) v[i] *= i / 64; // weich einblenden
    return v;
  });
  let chunks;
  try {
    chunks = await encodeInWorker(channels, sampleRate, kbps, onProgress);
  } catch (e) {
    if (!e.retry) throw e;
    console.warn('MP3 im Worker nicht möglich, kodiere direkt:', e);
    chunks = await encodeHere(channels, sampleRate, kbps, onProgress);
  }
  return new Blob([id3({ title }), ...chunks], { type: 'audio/mpeg' });
}
