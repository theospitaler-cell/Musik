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
function callWorker(msg, { onStage, transfer = [], stall = AI_STALL_MS, watchAi = false } = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = spawn();
    } catch (e) {
      reject(e);
      return;
    }
    let last = Date.now();
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
async function aiOnMainThread(prepared, cfg, onStage) {
  const ai = await import('../input/ai-pitch.js');
  onStage('ai', 0, 'Lokale KI wird geladen');
  const backend = await ai.loadAi();
  if (backend !== 'webgl') throw new Error('keine Grafikbeschleunigung');
  const sources = [{ audio: prepared.mid, name: 'mid' }];
  if (prepared.harm) sources.push({ audio: prepared.harm, name: 'harm' });
  const out = await ai.runEnsemble(sources, {
    budgetMs: cfg.budgetMs,
    passes: cfg.passes,
    pitchViews: cfg.shifts || 0,
    onProgress: (f, k, n) => onStage('ai', f, n > 1 ? `Durchgang ${k} von ${n}` : 'Lokale KI hört die Noten'),
  });
  let side = false;
  if (cfg.side && prepared.side) {
    onStage('ai', 0.97, 'Seitensignal wird gehört');
    const sd = await ai.runEnsemble([{ audio: prepared.side }], { maxPasses: 1, budgetMs: 0 });
    ai.flagSideNotes(out.notes, sd.notes);
    side = sd.notes.length > 0;
  }
  return { notes: out.notes, meta: { passes: out.passes, ms: out.ms, views: sources.length, side } };
}

// Ergebnis: Song. onStage(stage, frac 0..1, text) – stage: prep | ai | spec | melody | grid | drums
export async function analyzeAudio(data, { title, effort = 3, onStage = () => {} } = {}) {
  const cfg = effortOf(effort).analysis;
  const base = { channels: data.channels, sampleRate: data.sampleRate, title, effort };
  let aiNotes = null;
  let aiMeta = null;
  // 1) Vorbereiten (Trennen) und KI im Hauptfenster
  try {
    const prepared = await callWorker({ task: 'prepare', channels: data.channels, sampleRate: data.sampleRate, hpss: cfg.hpss }, { onStage });
    const r = await aiOnMainThread(prepared, cfg, onStage);
    aiNotes = r.notes;
    aiMeta = r.meta;
  } catch (e) {
    console.info('KI im Hauptfenster nicht nutzbar:', e.message);
  }
  if (aiNotes && aiNotes.length) {
    onStage('ai', 1, '');
    return (await callWorker({ ...base, task: 'analyze', ai: false, aiNotes, aiMeta }, { onStage })).song;
  }
  // 2) KI im Worker auf dem Prozessor
  try {
    onStage('ai', 0, 'Lokale KI rechnet auf dem Prozessor (dauert länger)');
    return (await callWorker({ ...base, task: 'analyze', ai: true, aiBackend: 'cpu' }, { onStage, watchAi: true })).song;
  } catch (e) {
    if (!e.aiStall) throw e;
    // 3) ohne KI
    onStage('ai', 1, 'KI reagiert nicht – Analyse ohne KI');
    const song = (await callWorker({ ...base, task: 'analyze', ai: false }, { onStage })).song;
    song.warnings = [...(song.warnings || []), 'Die lokale KI konnte auf diesem Gerät nicht rechnen – die Noten wurden ohne KI erkannt und sind ungenauer.'];
    return song;
  }
}
