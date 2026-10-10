// Einheitlicher Einstieg für alle Vorlagen-Formate.
import { parseABC } from './abc.js';
import { readMusicXMLFile, songFromMusicXML } from './musicxml.js';
import { songFromMidi } from './midi.js';

export const AUDIO_EXT = /\.(mp3|wav|wave|m4a|aac|ogg|oga|opus|flac|webm|aif|aiff)$/i;

function isAudioBytes(b) {
  const s = (i, str) => [...str].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (s(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return true; // MP3
  if (s(0, 'RIFF') && s(8, 'WAVE')) return true;
  if (s(0, 'fLaC') || s(0, 'OggS') || s(0, 'FORM')) return true;
  if (s(4, 'ftyp')) return true; // M4A/AAC
  return false;
}

export function detectFormat(name = '', bytesOrText = null) {
  const n = name.toLowerCase();
  if (AUDIO_EXT.test(n)) return 'audio';
  if (/\.(mid|midi|kar)$/.test(n)) return 'midi';
  if (/\.(mxl)$/.test(n)) return 'musicxml';
  if (/\.(musicxml|xml)$/.test(n)) return 'musicxml';
  if (/\.(abc|txt)$/.test(n)) return 'abc';
  if (bytesOrText instanceof Uint8Array || bytesOrText instanceof ArrayBuffer) {
    const b = new Uint8Array(bytesOrText);
    if (b[0] === 0x4d && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64) return 'midi';
    if (b[0] === 0x50 && b[1] === 0x4b) return 'musicxml';
    if (isAudioBytes(b)) return 'audio';
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
  // Audio wird in der Oberfläche dekodiert & im Worker analysiert; gespeicherte Analyse direkt nutzen
  if (fmt === 'audio') {
    if (source.song) return structuredClone(source.song);
    throw new Error('Audio muss zuerst analysiert werden');
  }
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
