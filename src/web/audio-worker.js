// Web-Worker: Audio-Analyse (MP3/WAV/…) ohne die Oberfläche zu blockieren.
// Eingang: {channels: Float32Array[], sampleRate, title, ai, aiNotes, aiBackend}; Ausgang:
// Fortschritt & Song. aiNotes: die KI hat schon im Hauptfenster gehört (schnell, Grafikkarte).
// Sonst hört mit ai !== false die lokale KI (Basic Pitch) hier – aiBackend 'cpu' = Prozessor.
import { resampleMono, transcribe } from '../input/audio.js';

const progress = (text, frac) => self.postMessage({ type: 'progress', text, frac });

self.onmessage = async (e) => {
  const { channels, sampleRate, title, ai: useAi = true, aiNotes = null, aiBackend = null } = e.data;
  try {
    progress('Audio wird vorbereitet', aiNotes ? 0.55 : 0);
    const mono = resampleMono(channels, sampleRate);
    let ai = aiNotes && aiNotes.length ? aiNotes : null;
    if (!ai && useAi) {
      try {
        progress('Lokale KI wird geladen', 0.01);
        const { runBasicPitch, aiNotes: toNotes, loadAi } = await import('../input/ai-pitch.js');
        await loadAi(aiBackend);
        progress('Lokale KI hört die Noten', 0.02);
        const out = await runBasicPitch(mono, (f) => progress('Lokale KI hört die Noten', 0.02 + 0.53 * f));
        ai = toNotes(out);
      } catch (err) {
        // ohne KI weiter (z. B. Gerät ohne Unterstützung) – die Signalanalyse allein funktioniert auch
        progress('KI nicht verfügbar – Analyse ohne KI', 0.55);
        void err;
      }
    }
    const base = ai ? 0.55 : 0;
    const song = transcribe(mono, { title, ai, onProgress: (text, frac) => progress(text, base + (1 - base) * frac) });
    self.postMessage({ type: 'done', song });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
