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
