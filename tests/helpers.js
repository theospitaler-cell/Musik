import { parseABC } from '../src/input/abc.js';
import { DEMOS } from './fixtures/songs.js';
import { parseXML } from '../src/core/xml.js';

export const demoSong = (id = 'saints') => parseABC(DEMOS.find((d) => d.id === id).abc);

// Summe der Notendauern pro Takt/Stimme aus MusicXML (prüft vollständige Takte)
export function measureDurations(xml) {
  const root = parseXML(xml);
  const out = [];
  for (const part of root.all('part')) {
    let divisions = 24;
    let beats = 4;
    let beatType = 4;
    for (const m of part.all('measure')) {
      const voices = {};
      let pos = 0;
      for (const el of m.children) {
        if (el.name === 'attributes') {
          divisions = el.num('divisions', divisions);
          if (el.child('time')) {
            beats = el.num('time/beats');
            beatType = el.num('time/beat-type');
          }
        } else if (el.name === 'backup') pos -= el.num('duration');
        else if (el.name === 'forward') pos += el.num('duration');
        else if (el.name === 'note') {
          if (el.has('grace') || el.has('chord')) continue;
          const v = el.val('voice') || '1';
          const d = el.num('duration', 0);
          voices[v] = (voices[v] || 0) + d;
          pos += d;
        }
      }
      const expected = (beats * divisions * 4) / beatType;
      for (const [v, d] of Object.entries(voices)) out.push({ part: part.attrs.id, measure: m.attrs.number, voice: v, dur: d, expected });
    }
  }
  return out;
}

// Minimale Standard-MIDI-Datei schreiben (Typ 1, 96 Ticks/Viertel).
// tracks: [{name, events: [{t, d, key, ch, vel}], programs: {ch: prog}}]
export function makeMidi(tracks, { tempo = 100, tempos = null, timeSigs = null } = {}) {
  const vlq = (n) => {
    const b = [n & 0x7f];
    while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80);
    return b;
  };
  const chunk = (id, data) => [...id].map((c) => c.charCodeAt(0)).concat([(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255], data);
  const out = [...chunk('MThd', [0, 1, 0, tracks.length + 1, 0, 96])];
  // Dirigentenspur: Tempo- und Taktart-Events (t in Ticks, 96 je Viertel)
  const cond = [];
  for (const e of tempos || [{ t: 0, bpm: tempo }]) {
    const us = Math.round(60000000 / e.bpm);
    cond.push({ t: e.t, b: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
  }
  for (const e of timeSigs || [{ t: 0, beats: 4, beatType: 4 }]) cond.push({ t: e.t, b: [0xff, 0x58, 4, e.beats, Math.log2(e.beatType), 24, 8] });
  cond.sort((a, b) => a.t - b.t);
  const cd = [];
  let lt = 0;
  for (const e of cond) {
    cd.push(...vlq(e.t - lt), ...e.b);
    lt = e.t;
  }
  cd.push(0, 0xff, 0x2f, 0);
  out.push(...chunk('MTrk', cd));
  for (const tr of tracks) {
    const ev = [];
    if (tr.name) {
      const nm = [...new TextEncoder().encode(tr.name)];
      ev.push({ t: 0, o: 0, b: [0xff, 0x03, nm.length, ...nm] });
    }
    for (const [ch, p] of Object.entries(tr.programs || {})) ev.push({ t: 0, o: 1, b: [0xc0 | Number(ch), p] });
    for (const n of tr.events) {
      ev.push({ t: n.t, o: 3, b: [0x90 | n.ch, n.key, n.vel ?? 90] });
      ev.push({ t: n.t + n.d, o: 2, b: [0x80 | n.ch, n.key, 0] });
    }
    ev.sort((a, b) => a.t - b.t || a.o - b.o);
    const data = [];
    let last = 0;
    for (const e of ev) {
      data.push(...vlq(e.t - last), ...e.b);
      last = e.t;
    }
    data.push(0, 0xff, 0x2f, 0);
    out.push(...chunk('MTrk', data));
  }
  return new Uint8Array(out);
}
