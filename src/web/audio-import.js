// Audio-Datei -> Song: Dekodieren (Browser) + Analyse im Web-Worker, mit Fortschritt je Aufgabe.
import { effortOf } from '../core/effort.js';

export async function decodeAudio(bytes) {
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new AC(1, 2, 44100);
  // decodeAudioData übernimmt den Puffer -> Kopie übergeben
  const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const channels = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).slice());
  return { channels, sampleRate: buf.sampleRate, duration: buf.duration };
}

// Aufwand (Stufe 1–5, siehe core/effort.js): Gesang/Begleitung werden getrennt (harmonischer
// Anteil ohne Schlagzeug), die lokale KI hört das Lied mehrfach (verschobene Fenster, verschiedene
// Ansichten, dazu das Seitensignal) und die Aktivierungen werden gemittelt. Je höher die Stufe,
// desto mehr Durchgänge – Stufe 1 ist ein einzelner Durchgang (schnell, aber ungenauer).
//
// Die KI läuft zuerst dort, wo sie schnell ist:
//   1. im Hauptfenster mit Grafikbeschleunigung (WebGL): wenige Sekunden je Durchgang.
//      (Im Web-Worker bleibt WebGL in manchen Umgebungen hängen – daher nicht dort.)
//   2. sonst im Web-Worker auf dem Prozessor: langsamer, dafür weniger Durchgänge.
// Nur wenn beides scheitert, wird ohne KI analysiert (mit Hinweis).
const AI_STALL_MS = 60000; // Worker: so lange darf ein Schritt ohne Meldung dauern

function spawn() {
  try {
    return new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    throw new Error('Audio-Analyse wird von diesem Browser nicht unterstützt: ' + e.message);
  }
}

// task-Nachricht an einen frischen Worker; onStage(stage, frac, text); Ergebnis der Nachricht
const aborted = () => Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });

function callWorker(msg, { onStage, transfer = [], stall = AI_STALL_MS, watchAi = false, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    if (signal?.aborted) return reject(aborted());
    try {
      worker = spawn();
    } catch (e) {
      reject(e);
      return;
    }
    let last = Date.now();
    const onAbort = () => {
      clearInterval(timer);
      worker.terminate();
      reject(aborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setInterval(() => {
      // hängt die KI im Worker ohne Meldung, wird abgebrochen (dann läuft die Analyse ohne KI weiter)
      if (watchAi && Date.now() - last > stall) {
        clearInterval(timer);
        worker.terminate();
        reject(Object.assign(new Error('KI hängt'), { aiStall: true }));
      }
    }, 1000);
    const end = () => {
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        last = Date.now();
        onStage?.(m.stage, m.frac, m.text);
      } else if (m.type === 'done' || m.type === 'prepared') {
        end();
        resolve(m);
      } else if (m.type === 'error') {
        end();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      end();
      reject(new Error(e.message || 'Audio-Analyse fehlgeschlagen'));
    };
    worker.postMessage(msg, transfer);
  });
}

// KI im Hauptfenster (Grafikkarte): Ansichten mid + harm (+ Seite)
async function aiOnMainThread(prepared, cfg, onStage, signal) {
  const ai = await import('../input/ai-pitch.js');
  onStage('ai', 0, 'Lokale KI wird geladen');
  const backend = await ai.loadAi();
  if (backend !== 'webgl') throw new Error('keine Grafikbeschleunigung');
  const sources = [{ audio: prepared.mid, name: 'mid' }];
  if (prepared.harm) sources.push({ audio: prepared.harm, name: 'harm' });
  // nur Aktivierungen: die Umrechnung in Noten ist langsam und läuft im Worker
  const out = await ai.runEnsembleActivations(sources, {
    budgetMs: cfg.budgetMs,
    passes: cfg.passes,
    pitchViews: cfg.shifts || 0,
    signal,
    onProgress: (f, k, n) => onStage('ai', f, n > 1 ? `Durchgang ${k} von ${n}` : 'Lokale KI hört die Noten'),
  });
  onStage('ai', 1, '');
  let sideActs = null;
  if (cfg.side && prepared.side) {
    onStage('side', 0, 'Seitensignal wird gehört');
    sideActs = await ai.runEnsembleActivations([{ audio: prepared.side }], {
      maxPasses: 1,
      budgetMs: 0,
      signal,
      onProgress: (f) => onStage('side', f, 'Seitensignal wird gehört'),
    });
    onStage('side', 1, '');
  }
  return { acts: out, sideActs, meta: { passes: out.passes, ms: out.ms, views: sources.length, side: !!sideActs } };
}

// Ergebnis: Song. onStage(stage, frac 0..1, text) – stage: prep | ai | spec | melody | grid | drums
export async function analyzeAudio(data, { title, effort = 3, onStage = () => {}, signal = null } = {}) {
  const cfg = effortOf(effort).analysis;
  const base = { channels: data.channels, sampleRate: data.sampleRate, title, effort };
  let acts = null;
  // 1) Vorbereiten (Trennen) und KI im Hauptfenster
  try {
    const prepared = await callWorker({ task: 'prepare', channels: data.channels, sampleRate: data.sampleRate, hpss: cfg.hpss }, { onStage, signal });
    acts = await aiOnMainThread(prepared, cfg, onStage, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.info('KI im Hauptfenster nicht nutzbar:', e.message);
  }
  if (acts && acts.acts.nOut > 0) {
    const transfer = [acts.acts.frames.buffer, acts.acts.onsets.buffer];
    const aiActs = { frames: acts.acts.frames, onsets: acts.acts.onsets, nOut: acts.acts.nOut, multi: acts.acts.multi };
    let aiSideActs = null;
    if (acts.sideActs) {
      aiSideActs = { frames: acts.sideActs.frames, onsets: acts.sideActs.onsets, nOut: acts.sideActs.nOut, multi: false };
      transfer.push(aiSideActs.frames.buffer, aiSideActs.onsets.buffer);
    }
    return (await callWorker({ ...base, task: 'analyze', ai: false, aiActs, aiSideActs, aiMeta: acts.meta }, { onStage, transfer, signal })).song;
  }
  // 2) KI im Worker auf dem Prozessor
  try {
    onStage('ai', 0, 'Lokale KI rechnet auf dem Prozessor (dauert länger)');
    return (await callWorker({ ...base, task: 'analyze', ai: true, aiBackend: 'cpu' }, { onStage, watchAi: true, signal })).song;
  } catch (e) {
    if (!e.aiStall) throw e;
    // 3) ohne KI
    onStage('ai', 1, 'KI reagiert nicht – Analyse ohne KI');
    const song = (await callWorker({ ...base, task: 'analyze', ai: false }, { onStage, signal })).song;
    song.warnings = [...(song.warnings || []), 'Die lokale KI konnte auf diesem Gerät nicht rechnen – die Noten wurden ohne KI erkannt und sind ungenauer.'];
    return song;
  }
}
