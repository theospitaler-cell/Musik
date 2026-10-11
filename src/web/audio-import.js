// Audio-Datei -> Song: Dekodieren (Browser) + Analyse im Web-Worker, mit Fortschritt je Aufgabe.
import { effortOf } from '../core/effort.js';
import { resolveStemPlan, encodeWav16, TONAL_STEMS } from '../input/stems.js';

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

// Spurentrennung (Demucs v4, nur Desktop-App): vocals + other + bass werden getrennt von der KI gehört,
// das Schlagzeug bleibt für Töne außen vor. Ergebnis: Aktivierungen je Stem (Grafikkarte).
async function aiStemsOnMainThread(stems, cfg, onStage, signal) {
  const ai = await import('../input/ai-pitch.js');
  onStage('ai', 0, 'Lokale KI wird geladen');
  const backend = await ai.loadAi();
  if (backend !== 'webgl') throw new Error('keine Grafikbeschleunigung');
  const out = {};
  let ms = 0;
  const names = TONAL_STEMS.filter((n) => stems[n]);
  for (let k = 0; k < names.length; k++) {
    const n = names[k];
    // die getrennten Spuren sind sauber: wenige Durchgänge genügen
    const a = await ai.runEnsembleActivations([{ audio: stems[n], name: n }], {
      budgetMs: Math.max(20000, cfg.budgetMs / names.length),
      passes: Math.min(cfg.passes || 1, 3),
      pitchViews: 0,
      signal,
      onProgress: (f) => onStage('ai', (k + f) / names.length, `Spur „${n}“ wird gehört (${k + 1} von ${names.length})`),
    });
    ms += a.ms;
    out[n] = { frames: a.frames, onsets: a.onsets, nOut: a.nOut, multi: a.multi };
  }
  onStage('ai', 1, '');
  return { acts: out, meta: { passes: Math.min(cfg.passes || 1, 3), ms, views: names.length, stems: true } };
}

// Demucs im Desktop-Hauptprozess; res null, wenn nicht genutzt (mit Hinweis in note)
async function separateStems(data, { stemsMode, stemsStatus, onStage, signal }) {
  const d = typeof window !== 'undefined' ? window.notecodeDesktop : null;
  const plan = resolveStemPlan(stemsMode, stemsStatus);
  if (!plan.use || !d || !d.separateStems) return { res: null, note: plan.reason };
  const off = d.onStemsProgress ? d.onStemsProgress((p) => onStage('stems', p.frac, p.text)) : () => {};
  const onAbort = () => d.cancelStems && d.cancelStems();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    onStage('stems', 0, 'Spuren werden getrennt');
    const wav = encodeWav16(data.channels, data.sampleRate);
    const res = await d.separateStems(wav, plan.device);
    onStage('stems', 1, '');
    return { res, note: null };
  } catch (e) {
    if (signal?.aborted || e.name === 'AbortError') throw aborted();
    console.info('Spurentrennung nicht möglich:', e.message);
    const why = String(e.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '').slice(0, 160);
    onStage('stems', 1, '');
    return { res: null, note: `Spurentrennung fehlgeschlagen (${why}) – direkte Analyse.` };
  } finally {
    off();
    signal?.removeEventListener('abort', onAbort);
  }
}

// Ergebnis: Song. onStage(stage, frac 0..1, text) – stage: stems | prep | ai | spec | melody | grid | drums
// stemsMode: 'auto' | 'force' | 'off'; stemsStatus: Zustand der Desktop-Umgebung (stems:status)
export async function analyzeAudio(data, { title, effort = 3, onStage = () => {}, signal = null, stemsMode = 'off', stemsStatus = null } = {}) {
  const cfg = effortOf(effort).analysis;
  const base = { channels: data.channels, sampleRate: data.sampleRate, title, effort };
  let acts = null;
  // 0) Spurentrennung (Demucs), falls gewünscht und möglich
  const sep = await separateStems(data, { stemsMode, stemsStatus, onStage, signal });
  if (sep.res) {
    const stems = {};
    for (const n of TONAL_STEMS) if (sep.res.stems[n]) stems[n] = sep.res.stems[n];
    const meta = { device: sep.res.device, ms: sep.res.ms };
    let sacts = null;
    try {
      sacts = await aiStemsOnMainThread(stems, cfg, onStage, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.info('KI (Spuren) im Hauptfenster nicht nutzbar:', e.message);
    }
    if (sacts) {
      const transfer = [];
      for (const a of Object.values(sacts.acts)) transfer.push(a.frames.buffer, a.onsets.buffer);
      const song = (await callWorker({ ...base, task: 'analyze', ai: false, stemActs: sacts.acts, aiMeta: { ...sacts.meta, ...meta } }, { onStage, transfer, signal })).song;
      song.stems = meta;
      return song;
    }
    // KI auf dem Prozessor, je Spur im Worker
    onStage('ai', 0, 'Lokale KI rechnet auf dem Prozessor (dauert länger)');
    const song = (await callWorker({ ...base, task: 'analyze', ai: true, aiBackend: 'cpu', stemAudio: stems, aiMeta: { stems: true, ...meta } }, { onStage, watchAi: true, signal })).song;
    song.stems = meta;
    return song;
  }
  if (sep.note) base.stemNote = sep.note;
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
