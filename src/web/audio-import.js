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

// Wächter: hängt die lokale KI (z. B. beim ersten Start der Grafikbeschleunigung) länger als
// AI_STALL_MS ohne Fortschritt, wird sie abgebrochen und die Analyse läuft ohne KI weiter.
const AI_STALL_MS = 25000;
// höchstens so lange darf die KI insgesamt brauchen (sonst lieber ohne KI – schnell & zuverlässig)
const AI_MAX_MS = 90000;

function runWorker({ channels, sampleRate }, { title, ai, onProgress }) {
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
      // zu langsam (z. B. ohne Grafikbeschleunigung): absehbare KI-Dauer > AI_MAX_MS
      const el = aiStart ? Date.now() - aiStart : 0;
      const slow = inAi && aiStart && el > 12000 && (aiFrac <= 0.02 || el / Math.max(0.01, aiFrac) > AI_MAX_MS);
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
    worker.postMessage({ channels, sampleRate, title, ai });
  });
}

export async function analyzeAudio(data, { title, onProgress = () => {} } = {}) {
  try {
    return await runWorker(data, { title, ai: true, onProgress });
  } catch (e) {
    if (!e.aiStall) throw e;
    onProgress('KI reagiert nicht – Analyse ohne KI', 0.05);
    const song = await runWorker(data, { title, ai: false, onProgress });
    song.warnings = [...(song.warnings || []), 'Die lokale KI hat auf diesem Gerät zu lange gebraucht – die Noten wurden ohne KI erkannt.'];
    return song;
  }
}
