// Web-Worker: Audio-Analyse (MP3/WAV/…) ohne die Oberfläche zu blockieren.
//
// Aufgaben:
//  { task: 'prepare', channels, sampleRate, hpss }
//      -> { type: 'prepared', mid, harm, side }  (22,05 kHz mono; harm = ohne Schlagzeug-Transienten,
//         side = (L−R)/2 oder null bei Mono-Aufnahmen)
//  { task: 'analyze', channels, sampleRate, title, ai, aiNotes, aiMeta, aiBackend, effort }
//      -> { type: 'done', song }
//      aiNotes: die KI hat schon im Hauptfenster gehört (schnell, Grafikkarte). Sonst hört mit
//      ai !== false die lokale KI (Basic Pitch) hier – aiBackend 'cpu' = Prozessor.
//
// Fortschritt: { type: 'progress', stage, frac, text } – stage: prep | ai | spec | melody | grid | drums
import { resampleMono, transcribe } from '../input/audio.js';
import { effortOf } from '../core/effort.js';

const post = (stage, frac, text = '') => self.postMessage({ type: 'progress', stage, frac, text });

// Stufen der Signalanalyse (transcribe meldet 0…1 über alle Schritte)
const STAGES = [
  ['spec', 0, 0.55],
  ['melody', 0.55, 0.82],
  ['grid', 0.82, 0.93],
  ['drums', 0.93, 1.0],
];
function reportTranscribe(text, frac) {
  for (const [stage, a, b] of STAGES) {
    if (frac < b || stage === 'drums') {
      post(stage, Math.max(0, Math.min(1, (frac - a) / (b - a))), text);
      return;
    }
  }
}

function sideOf(channels, sampleRate) {
  if (channels.length < 2) return null;
  const n = Math.min(channels[0].length, channels[1].length);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = (channels[0][i] - channels[1][i]) * 0.5;
  return resampleMono([d], sampleRate);
}
const rms = (x) => {
  let s = 0;
  const step = Math.max(1, Math.floor(x.length / 200000));
  let c = 0;
  for (let i = 0; i < x.length; i += step) {
    s += x[i] * x[i];
    c++;
  }
  return Math.sqrt(s / Math.max(1, c));
};

async function prepare({ channels, sampleRate, hpss = true }) {
  post('prep', 0, 'Aufnahme wird vorbereitet');
  const mid = resampleMono(channels, sampleRate);
  let side = sideOf(channels, sampleRate);
  // Seitensignal nur, wenn es wirklich Musik enthält (bei Mono-Aufnahmen ist es fast leer)
  if (side && rms(side) < 0.12 * rms(mid)) side = null;
  post('prep', 0.1, 'Gesang und Begleitung werden getrennt');
  let harm = null;
  if (hpss) {
    const { harmonicPart } = await import('../input/hpss.js');
    harm = harmonicPart(mid, { onProgress: (f) => post('prep', 0.1 + 0.9 * f, 'Gesang und Begleitung werden getrennt') });
  }
  post('prep', 1, '');
  const transfer = [mid.buffer];
  if (harm) transfer.push(harm.buffer);
  if (side) transfer.push(side.buffer);
  self.postMessage({ type: 'prepared', mid, harm, side }, transfer);
}

async function analyze({ channels, sampleRate, title, ai: useAi = true, aiNotes = null, aiMeta = null, aiBackend = null, effort = 3 }) {
  const cfg = effortOf(effort).analysis;
  post('spec', 0, 'Audio wird vorbereitet');
  const mono = resampleMono(channels, sampleRate);
  let ai = aiNotes && aiNotes.length ? aiNotes : null;
  let meta = ai ? aiMeta : null;
  if (!ai && useAi) {
    try {
      post('ai', 0, 'Lokale KI wird geladen');
      const m = await import('../input/ai-pitch.js');
      await m.loadAi(aiBackend);
      if (cfg.passes > 1) {
        // Prozessor-Rückfall: gleiche Ansichten wie im Hauptfenster; das Zeitbudget bestimmt,
        // wie viele Durchgänge auf dem Prozessor möglich sind
        const sources = [{ audio: mono }];
        if (cfg.hpss) {
          post('prep', 0, 'Gesang und Begleitung werden getrennt');
          const { harmonicPart } = await import('../input/hpss.js');
          sources.push({ audio: harmonicPart(mono, { onProgress: (f) => post('prep', f, 'Gesang und Begleitung werden getrennt') }) });
          post('prep', 1, '');
        }
        const side = cfg.side ? sideOf(channels, sampleRate) : null;
        const out = await m.runEnsemble(sources, {
          budgetMs: Math.max(cfg.budgetMs * 2, 120000),
          passes: cfg.passes,
          onProgress: (f, k, n) => post('ai', f, `Durchgang ${k} von ${n}`),
        });
        ai = out.notes;
        meta = { passes: out.passes, ms: out.ms, views: sources.length };
        if (side && rms(side) >= 0.12 * rms(mono)) {
          const sd = await m.runEnsemble([{ audio: side }], { budgetMs: 60000, maxPasses: 1, onProgress: () => {} });
          m.flagSideNotes(ai, sd.notes);
          meta.side = true;
        }
      } else {
        const out = await m.runBasicPitch(mono, (f) => post('ai', f, 'Lokale KI hört die Noten'));
        ai = m.aiNotes(out);
        meta = { passes: 1, ms: 0, views: 1 };
      }
    } catch (err) {
      // ohne KI weiter (z. B. Gerät ohne Unterstützung) – die Signalanalyse allein funktioniert auch
      post('ai', 1, 'KI nicht verfügbar – Analyse ohne KI');
      void err;
    }
  }
  post('ai', 1, '');
  const song = transcribe(mono, { title, ai, onProgress: reportTranscribe });
  song.analysisEffort = effort;
  song.analysisQuality = cfg.passes > 1 ? 'thorough' : 'fast';
  if (meta) song.aiMeta = meta;
  self.postMessage({ type: 'done', song });
}

self.onmessage = async (e) => {
  try {
    if (e.data.task === 'prepare') await prepare(e.data);
    else await analyze(e.data);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
