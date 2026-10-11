// Spurentrennung (Stem-Separation) mit Demucs v4: reine Logik, die in Browser, Worker, Tests und
// im Desktop-Hauptprozess gleich läuft. Demucs selbst (Python/PyTorch) startet nur die Desktop-App
// (electron/stems.cjs) – im Browser und auf dem Handy gibt es keine Spurentrennung.
//
// Ablauf: Aufnahme -> 4 Stems (vocals, drums, bass, other) -> Basic Pitch hört
//   vocals + other  (Melodie/Lead, Bläser, Gitarren …)  und  bass  (Fundament) getrennt;
//   drums bleibt für Töne außen vor (keine Geisternoten durch Schlagzeug).
// Die Noten tragen ihre Herkunft (stem) – die Stimmentrennung nutzt das (Bass nur aus dem Bass-Stem).

export const STEM_MODES = [
  { id: 'auto', name: 'Automatisch (GPU nutzen falls vorhanden)' },
  { id: 'force', name: 'Erzwingen (Demucs immer aktiv, auch auf CPU)' },
  { id: 'off', name: 'Deaktiviert (Direkte Analyse ohne Spurentrennung)' },
];
export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
// Stems, die für Töne gehört werden (Schlagzeug nicht)
export const TONAL_STEMS = ['vocals', 'other', 'bass'];

export function normalizeStemMode(m) {
  return STEM_MODES.some((x) => x.id === m) ? m : 'auto';
}

// status: Antwort von stems:status des Desktop-Hauptprozesses (oder null: keine Desktop-App)
//   { desktop: true, gpu: {name, driver, memoryMB} | null, python: string | null,
//     demucs: {version} | null, cuda: boolean, device: 'cuda' | 'cpu' | null, error?: string }
export function describeHardware(status) {
  if (!status || !status.desktop) return { level: 'info', text: 'Spurentrennung gibt es nur in der Desktop-App (Windows) – hier läuft die direkte Analyse.' };
  const gpu = status.gpu ? `${status.gpu.name}${status.gpu.memoryMB ? ` (${Math.round(status.gpu.memoryMB / 1024)} GB)` : ''}` : null;
  if (!status.python) return { level: 'warn', text: `${gpu ? `GPU erkannt: ${gpu}. ` : 'Nur CPU verfügbar. '}Python wurde nicht gefunden – Demucs ist nicht eingerichtet (siehe README: „Spurentrennung einrichten“).` };
  if (!status.demucs) return { level: 'warn', text: `${gpu ? `GPU erkannt: ${gpu}. ` : 'Nur CPU verfügbar. '}Demucs ist in Python (${status.python}) nicht installiert – Einrichtung: node scripts/setup-demucs.mjs` };
  if (status.cuda) return { level: 'ok', text: `GPU erkannt: ${gpu || 'NVIDIA'} – CUDA aktiv (Demucs ${status.demucs.version || 'v4'} läuft auf der Grafikkarte).` };
  if (gpu) return { level: 'warn', text: `GPU erkannt: ${gpu}, aber PyTorch ohne CUDA – Demucs ${status.demucs.version || ''} würde auf dem Prozessor laufen (langsam). Mit node scripts/setup-demucs.mjs wird die CUDA-Version eingerichtet.` };
  return { level: 'info', text: `Nur CPU verfügbar – Demucs ${status.demucs.version || ''} wäre auf dem Prozessor langsam (etwa so lange wie das Lied dauert, mehrfach).` };
}

// Soll für diese Analyse getrennt werden, und auf welchem Gerät?
//   -> { use, device, reason } – reason: kurzer Hinweis, wenn auf die direkte Analyse zurückgefallen wird
export function resolveStemPlan(mode, status) {
  const m = normalizeStemMode(mode);
  if (m === 'off') return { use: false, device: null, reason: null };
  if (!status || !status.desktop) return { use: false, device: null, reason: null }; // keine Desktop-App: still
  if (!status.python || !status.demucs) return { use: false, device: null, reason: 'Demucs ist nicht eingerichtet – direkte Analyse ohne Spurentrennung.' };
  if (status.cuda) return { use: true, device: 'cuda', reason: null };
  if (m === 'force') return { use: true, device: 'cpu', reason: null };
  return { use: false, device: null, reason: 'Keine Grafikkarte mit CUDA gefunden – direkte Analyse (unter „Einstellungen → Audio-Vorverarbeitung“ lässt sich Demucs auch auf dem Prozessor erzwingen).' };
}

// ---- WAV lesen (PCM 8/16/24/32 Bit, Float32) -> Kanäle als Float32Array
export function parseWav(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const tag = (o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  if (u.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Keine WAV-Datei');
  let fmt = null;
  let data = null;
  for (let o = 12; o + 8 <= u.length; ) {
    const id = tag(o);
    let size = dv.getUint32(o + 4, true);
    if (o + 8 + size > u.length) size = u.length - o - 8; // gekürzte/streamende Datei
    if (id === 'fmt ') {
      let format = dv.getUint16(o + 8, true);
      const ch = dv.getUint16(o + 10, true);
      const rate = dv.getUint32(o + 12, true);
      const bits = dv.getUint16(o + 22, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(o + 8 + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, ch, rate, bits };
    } else if (id === 'data') {
      data = { o: o + 8, size };
      break;
    }
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV: fmt- oder data-Abschnitt fehlt');
  const { format, ch, rate, bits } = fmt;
  if (!(format === 1 || format === 3) || ch < 1) throw new Error(`WAV: Format ${format} nicht unterstützt`);
  const bytesPer = bits / 8;
  const frames = Math.floor(data.size / (bytesPer * ch));
  const out = Array.from({ length: ch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const p = data.o + (i * ch + c) * bytesPer;
      let v;
      if (format === 3 && bits === 32) v = dv.getFloat32(p, true);
      else if (format === 3 && bits === 64) v = dv.getFloat64(p, true);
      else if (bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (bits === 24) v = (((u[p + 2] << 24) | (u[p + 1] << 16) | (u[p] << 8)) >> 8) / 8388608;
      else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
      else if (bits === 8) v = (u[p] - 128) / 128;
      else throw new Error(`WAV: ${bits} Bit nicht unterstützt`);
      out[c][i] = v;
    }
  }
  return { channels: out, sampleRate: rate };
}

// ---- Noten der Stems zusammenführen
// parts: { vocals: [{start,end,midi,amp}], other: […], bass: […] } (Sekunden, je Stem eigene KI-Läufe)
//  - Bass-Stem: nur Töne bis C4 (darüber sind es Obertöne/Durchsprechen), Quelle 'bass'
//  - Vocals: Quelle 'vocals'; Other: Quelle 'other'
//  - Durchsprechen: dieselbe Tonhöhe fast gleichzeitig in mehreren Stems -> der „zuständige“ Stem
//    behält sie (Bass-Stem für tiefe Töne, sonst vocals vor other)
// Rückgabe: Noten mit stem: 'vocals' | 'other' | 'bass', nach Einsatz sortiert.
export function mergeStemNotes(parts, { bassMax = 60, bleedSec = 0.05 } = {}) {
  const tag = (list, stem) => (list || []).map((n) => ({ ...n, stem }));
  const bass = tag(parts.bass, 'bass').filter((n) => n.midi <= bassMax);
  const vocals = tag(parts.vocals, 'vocals');
  const other = tag(parts.other, 'other');
  const near = (list, n) => list.some((m) => m.midi === n.midi && Math.abs(m.start - n.start) <= bleedSec);
  // Vorrang: Bass (tiefe Töne) > Gesang > Rest
  const bassSet = bass;
  const vocOk = vocals.filter((n) => !(n.midi <= bassMax && near(bassSet, n)));
  const othOk = other.filter((n) => !(n.midi <= bassMax && near(bassSet, n)) && !near(vocOk, n));
  return [...bass, ...vocOk, ...othOk].sort((a, b) => a.start - b.start || a.midi - b.midi);
}

// ---- WAV schreiben (16 Bit PCM, 1–2 Kanäle) – Eingabe für Demucs: so braucht es kein ffmpeg
export function encodeWav16(channels, sampleRate) {
  const ch = Math.min(2, channels.length) || 1;
  const frames = channels[0].length;
  const buf = new ArrayBuffer(44 + frames * ch * 2);
  const dv = new DataView(buf);
  const put = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  put(0, 'RIFF');
  dv.setUint32(4, 36 + frames * ch * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, frames * ch * 2, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i] || 0));
      dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}
