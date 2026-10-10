// Einheitlicher Einstieg für alle Vorlagen-Formate.
import { parseABC } from './abc.js';
import { readMusicXMLFile, songFromMusicXML } from './musicxml.js';
import { songFromMidi } from './midi.js';

export function detectFormat(name = '', bytesOrText = null) {
  const n = name.toLowerCase();
  if (/\.(mid|midi|kar)$/.test(n)) return 'midi';
  if (/\.(mxl)$/.test(n)) return 'musicxml';
  if (/\.(musicxml|xml)$/.test(n)) return 'musicxml';
  if (/\.(abc|txt)$/.test(n)) return 'abc';
  if (bytesOrText instanceof Uint8Array || bytesOrText instanceof ArrayBuffer) {
    const b = new Uint8Array(bytesOrText);
    if (b[0] === 0x4d && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64) return 'midi';
    if (b[0] === 0x50 && b[1] === 0x4b) return 'musicxml';
    const head = new TextDecoder().decode(b.subarray(0, 400));
    if (/<score-partwise|<\?xml/.test(head)) return 'musicxml';
    return 'abc';
  }
  if (typeof bytesOrText === 'string') {
    if (/<score-partwise|<\?xml/.test(bytesOrText.slice(0, 400))) return 'musicxml';
    return 'abc';
  }
  return 'abc';
}

// source: {name, data (string | Uint8Array | ArrayBuffer), melodyPart}
export async function loadSong(source) {
  const fmt = source.format || detectFormat(source.name, source.data);
  if (fmt === 'midi') {
    const s = songFromMidi(source.data, { melodyPart: source.melodyPart ?? null, title: stripExt(source.name) });
    return s;
  }
  if (fmt === 'musicxml') {
    const text = await readMusicXMLFile(source.data, source.name);
    const s = songFromMusicXML(text, { melodyPart: source.melodyPart ?? null });
    if (!s.title || s.title === 'Ohne Titel') s.title = stripExt(source.name) || s.title;
    return s;
  }
  const text = typeof source.data === 'string' ? source.data : new TextDecoder().decode(source.data);
  return parseABC(text);
}

function stripExt(n) {
  return n ? n.replace(/\.[^.]+$/, '') : null;
}
