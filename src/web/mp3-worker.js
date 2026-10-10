// Web-Worker (klassisch): MP3-Kodierung mit LAME (vendor/lame.min.js), ohne die Oberfläche zu
// blockieren. Eingang: {channels: Float32Array[] (1–2), sampleRate, kbps}; Ausgang: Fortschritt
// und die MP3-Datenblöcke.
/* global lamejs */
importScripts('../../vendor/lame.min.js');
self.postMessage({ type: 'ready' });

function toPcm16(src, from, n, dst) {
  for (let i = 0; i < n; i++) {
    const v = src[from + i];
    dst[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
  }
}

self.onmessage = (e) => {
  const { channels, sampleRate, kbps = 192 } = e.data;
  try {
    const nch = Math.min(2, channels.length);
    const enc = new lamejs.Mp3Encoder(nch, sampleRate, kbps);
    const len = channels[0].length;
    const BLOCK = 1152 * 32;
    const L = new Int16Array(BLOCK);
    const R = new Int16Array(BLOCK);
    const chunks = [];
    let lastReport = 0;
    for (let i = 0; i < len; i += BLOCK) {
      const n = Math.min(BLOCK, len - i);
      toPcm16(channels[0], i, n, L);
      if (nch > 1) toPcm16(channels[1], i, n, R);
      const out = nch > 1 ? enc.encodeBuffer(L.subarray(0, n), R.subarray(0, n)) : enc.encodeBuffer(L.subarray(0, n));
      if (out.length) chunks.push(new Uint8Array(out.buffer, out.byteOffset, out.length));
      if (i - lastReport > sampleRate * 5) {
        lastReport = i;
        self.postMessage({ type: 'progress', frac: i / len });
      }
    }
    const end = enc.flush();
    if (end.length) chunks.push(new Uint8Array(end.buffer, end.byteOffset, end.length));
    // eigene Puffer, damit sie übertragen statt kopiert werden können
    const parts = chunks.map((c) => (c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice()));
    self.postMessage({ type: 'done', chunks: parts }, parts.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
