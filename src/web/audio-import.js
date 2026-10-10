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

export function analyzeAudio({ channels, sampleRate }, { title, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(new Error('Audio-Analyse wird von diesem Browser nicht unterstützt: ' + e.message));
      return;
    }
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.text, m.frac);
      else if (m.type === 'done') {
        worker.terminate();
        resolve(m.song);
      } else if (m.type === 'error') {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Audio-Analyse fehlgeschlagen'));
    };
    worker.postMessage({ channels, sampleRate, title }, channels.map((c) => c.buffer));
  });
}
