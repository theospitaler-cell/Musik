// Standard-MIDI-Datei (Typ 1): Tempo-Map, Taktart, Tonart, eine Spur pro Stimme,
// Schlagzeug auf Kanal 10, Pitch-Bend für Fall-offs/Scoops/Glissandi.
import { performArrangement } from './performance.js';

const PPQ = 480;

function varLen(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function track(events) {
  // events: [{tick, data:[...]}]
  events.sort((a, b) => a.tick - b.tick || (a.order ?? 0) - (b.order ?? 0));
  const out = [];
  let last = 0;
  for (const e of events) {
    const tk = Math.max(0, Math.round(e.tick));
    out.push(...varLen(tk - last), ...e.data);
    last = tk;
  }
  out.push(0, 0xff, 0x2f, 0);
  const len = out.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...out];
}

function textMeta(type, str) {
  const b = [...new TextEncoder().encode(str)];
  return [0xff, type, ...varLen(b.length), ...b];
}

export function exportMidi(arr) {
  const perf = performArrangement(arr);
  // Wiedergabe in Sekunden -> konstante Tick-Basis über Tempo 60 nicht nötig:
  // wir schreiben die Tempo-Map und rechnen Sekunden über die Uhr zurück in Ticks.
  const toTick = (sec) => (perf.clock.toTick(sec) * PPQ) / 24;
  const tracks = [];
  const meta = [];
  meta.push({ tick: 0, data: textMeta(0x03, arr.meta.title || 'NoteCode') });
  meta.push({ tick: 0, data: [0xff, 0x58, 4, arr.meter.beats, Math.log2(arr.meter.beatType), 24, 8] });
  meta.push({ tick: 0, data: [0xff, 0x59, 2, (arr.key.fifths + 256) & 0xff, arr.key.mode === 'minor' ? 1 : 0] });
  for (const tm of arr.tempoMap || [{ t: 0, bpm: arr.tempo }]) {
    const us = Math.round(60000000 / tm.bpm);
    meta.push({ tick: (tm.t * PPQ) / 24, data: [0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] });
  }
  tracks.push(track(meta));
  arr.voices.forEach((v, vi) => {
    const ch = vi < 9 ? vi : Math.min(15, vi + 1); // Kanal 10 (Index 9) gehört dem Schlagzeug
    const evs = [];
    evs.push({ tick: 0, data: textMeta(0x03, `${v.label} – ${v.inst.name}`), order: -2 });
    evs.push({ tick: 0, data: [0xc0 | ch, v.inst.midiProgram], order: -1 });
    evs.push({ tick: 0, data: [0xb0 | ch, 101, 0], order: -1 });
    evs.push({ tick: 0, data: [0xb0 | ch, 100, 0], order: -1 });
    evs.push({ tick: 0, data: [0xb0 | ch, 6, 12], order: -1 }); // Pitch-Bend-Bereich ±12
    for (const n of perf.notes) {
      if (n.part !== vi) continue;
      const a = toTick(n.t);
      const b = toTick(n.t + n.d);
      evs.push({ tick: a, data: [0x90 | ch, n.midi, n.vel], order: 1 });
      evs.push({ tick: b, data: [0x80 | ch, n.midi, 0], order: 0 });
      const bend = (semi) => {
        const v = Math.max(0, Math.min(16383, Math.round(8192 + (semi / 12) * 8191)));
        return [0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f];
      };
      if (n.fx.scoop) {
        evs.push({ tick: a, data: bend(n.fx.scoop), order: 0.5 });
        evs.push({ tick: a + PPQ / 8, data: bend(0), order: 2 });
      }
      if (n.fx.fall) {
        const st = b - PPQ / 4;
        for (let k = 1; k <= 6; k++) evs.push({ tick: st + (k * PPQ) / 24, data: bend((n.fx.fall * k) / 6), order: 2 });
        evs.push({ tick: b + 1, data: bend(0), order: 3 });
      }
      if (n.fx.glideTo !== undefined) {
        const diff = n.fx.glideTo - n.midi;
        const st = a + (b - a) * 0.6;
        for (let k = 1; k <= 8; k++) evs.push({ tick: st + ((b - st) * k) / 8, data: bend((diff * k) / 8), order: 2 });
        evs.push({ tick: b + 1, data: bend(0), order: 3 });
      }
    }
    tracks.push(track(evs));
  });
  if (arr.drums) {
    const evs = [{ tick: 0, data: textMeta(0x03, 'Schlagzeug'), order: -2 }];
    for (const n of perf.notes) {
      if (n.part !== 'drums') continue;
      const a = toTick(n.t);
      evs.push({ tick: a, data: [0x99, n.midi, n.vel], order: 1 });
      evs.push({ tick: a + PPQ / 8, data: [0x89, n.midi, 0], order: 0 });
    }
    tracks.push(track(evs));
  }
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (tracks.length >> 8) & 0xff, tracks.length & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff];
  const total = header.length + tracks.reduce((s, t) => s + t.length, 0);
  const out = new Uint8Array(total);
  out.set(header, 0);
  let p = header.length;
  for (const t of tracks) {
    out.set(t, p);
    p += t.length;
  }
  return out;
}
