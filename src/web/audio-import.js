// Audio-Datei -> Song: Dekodieren (Browser) + Analyse im Web-Worker, mit Fortschritt.
export async function decodeAudio(bytes) {
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new AC(1, 2, 44100);
  // decodeAudioData übernimmt den Puffer -> Kopie übergeben
  const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const channels = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).slice());
  return { channels, sampleRate: buf.sampleRate, duration: buf.duration };
}

// Die lokale KI (Basic Pitch) liefert Melodie, Bass und Begleitstimmen – ohne sie sind die Noten
// deutlich ungenauer. Sie läuft deshalb zuerst dort, wo sie schnell ist:
//   1. im Hauptfenster mit Grafikbeschleunigung (WebGL): wenige Sekunden für ein ganzes Lied.
//      (Im Web-Worker bleibt WebGL in manchen Umgebungen hängen – daher nicht dort.)
//   2. sonst im Web-Worker auf dem Prozessor: langsamer (rund 1–2 s je 2 s Musik), aber sicher.
// Nur wenn beides scheitert, wird ohne KI analysiert (mit Hinweis).
// Wächter für den Worker: so lange darf ein einzelner Schritt ohne Fortschritt dauern …
const AI_STALL_MS = 40000;
// … und so lange die KI insgesamt (absehbar)
const AI_MAX_MS = 900000;
// Hauptfenster: langsamer als so viele ms je Fenster (2 s Musik) heißt "keine echte Beschleunigung"
const MAIN_SLOW_MS = 900;

async function aiOnMainThread({ channels, sampleRate }, onProgress) {
  const [{ resampleMono }, ai] = await Promise.all([import('../input/audio.js'), import('../input/ai-pitch.js')]);
  onProgress('Lokale KI wird geladen', 0.01);
  const backend = await ai.loadAi();
  if (backend !== 'webgl') throw new Error('keine Grafikbeschleunigung');
  const mono = resampleMono(channels, sampleRate);
  onProgress('Lokale KI hört die Noten', 0.02);
  let t0 = null;
  let done = 0;
  const out = await ai.runBasicPitch(mono, (f, w, n) => {
    // das erste Fenster enthält das Aufwärmen der Grafikkarte – danach wird gemessen
    if (w === 1) t0 = performance.now();
    done = w;
    if (w >= 4 && n > 8 && (performance.now() - t0) / (w - 1) > MAIN_SLOW_MS) throw Object.assign(new Error('zu langsam'), { slow: true });
    onProgress('Lokale KI hört die Noten', 0.02 + 0.53 * f);
  });
  void done;
  return ai.aiNotes(out);
}

function runWorker({ channels, sampleRate }, { title, ai, aiNotes = null, aiBackend = null, onProgress }) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(new Error('Audio-Analyse wird von diesem Browser nicht unterstützt: ' + e.message));
      return;
    }
    let inAi = ai;
    let last = Date.now();
    const t0 = Date.now();
    let aiStart = null;
    let aiFrac = 0;
    const timer = setInterval(() => {
      const el = aiStart ? Date.now() - aiStart : 0;
      const slow = inAi && aiStart && el > 30000 && el / Math.max(0.005, aiFrac) > AI_MAX_MS;
      if ((inAi && Date.now() - last > AI_STALL_MS) || slow || (inAi && Date.now() - t0 > AI_MAX_MS)) {
        clearInterval(timer);
        worker.terminate();
        reject(Object.assign(new Error('KI hängt'), { aiStall: true }));
      }
    }, 1000);
    const done = () => {
      clearInterval(timer);
      worker.terminate();
    };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        last = Date.now();
        inAi = ai && /KI/.test(m.text) && !/ohne KI/.test(m.text);
        // Anteil der KI-Arbeit (Worker meldet 0,02 … 0,55 für die KI)
        if (inAi && /hört/.test(m.text)) {
          if (aiStart === null) aiStart = Date.now();
          aiFrac = Math.max(0, (m.frac - 0.02) / 0.53);
        }
        onProgress(m.text, m.frac);
      } else if (m.type === 'done') {
        done();
        resolve(m.song);
      } else if (m.type === 'error') {
        done();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      done();
      reject(new Error(e.message || 'Audio-Analyse fehlgeschlagen'));
    };
    // Kopie senden (nicht übertragen): bei einem Neustart ohne KI werden die Daten noch gebraucht
    worker.postMessage({ channels, sampleRate, title, ai, aiNotes, aiBackend });
  });
}

export async function analyzeAudio(data, { title, onProgress = () => {} } = {}) {
  // 1) KI im Hauptfenster (Grafikkarte)
  let aiNotes = null;
  try {
    aiNotes = await aiOnMainThread(data, onProgress);
  } catch (e) {
    console.info('KI im Hauptfenster nicht nutzbar:', e.message);
  }
  if (aiNotes && aiNotes.length) return runWorker(data, { title, ai: false, aiNotes, onProgress });
  // 2) KI im Worker auf dem Prozessor
  try {
    onProgress('Lokale KI rechnet auf dem Prozessor (dauert länger)', 0.02);
    return await runWorker(data, { title, ai: true, aiBackend: 'cpu', onProgress });
  } catch (e) {
    if (!e.aiStall) throw e;
    // 3) ohne KI
    onProgress('KI reagiert nicht – Analyse ohne KI', 0.05);
    const song = await runWorker(data, { title, ai: false, onProgress });
    song.warnings = [...(song.warnings || []), 'Die lokale KI konnte auf diesem Gerät nicht rechnen – die Noten wurden ohne KI erkannt und sind ungenauer.'];
    return song;
  }
}
