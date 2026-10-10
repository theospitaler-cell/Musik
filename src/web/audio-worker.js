// Web-Worker: Audio-Analyse (MP3/WAV/…) ohne die Oberfläche zu blockieren.
// Eingang: {channels: Float32Array[], sampleRate, title}; Ausgang: Fortschritt & Song.
import { resampleMono, transcribe } from '../input/audio.js';

self.onmessage = (e) => {
  const { channels, sampleRate, title } = e.data;
  try {
    self.postMessage({ type: 'progress', text: 'Audio wird vorbereitet', frac: 0 });
    const mono = resampleMono(channels, sampleRate);
    const song = transcribe(mono, { title, onProgress: (text, frac) => self.postMessage({ type: 'progress', text, frac }) });
    self.postMessage({ type: 'done', song });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
