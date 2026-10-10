// ABC-Notation (Teilmenge) -> Song.
// Unterstützt: Kopfzeilen X T C M L Q K P R, Noten/Pausen, Vorzeichen,
// Oktavierungen, Längen, Bindebögen (-), Triolen (3, punktierte Rhythmen > <,
// Akkordsymbole "G7", Wiederholungen |: :| mit Klammern [1 [2, Teile [P:A].
import { DIV } from '../core/constants.js';
import { letterAlterToLof, parseNoteName, stepAlterOctaveToMidi } from '../theory/pitch.js';
import { parseChord } from '../theory/chords.js';
import { makeKey } from '../theory/keys.js';
import { finalizeSong } from '../theory/analysis.js';
import { measureTicks } from '../model/song.js';
import { expandOrder } from '../model/repeats.js';

const MODE_OFFSETS = { '': 0, maj: 0, ion: 0, mix: -1, dor: -2, m: -3, min: -3, aeo: -3, phr: -4, loc: -5, lyd: 1 };
const MINORISH = new Set(['m', 'min', 'aeo', 'dor', 'phr', 'loc']);

function parseKeyField(v) {
  const s = v.trim();
  if (!s || /^none/i.test(s)) return { sig: 0, key: makeKey(0, 'major') };
  if (/^hp/i.test(s)) return { sig: 2, key: makeKey(2, 'major') };
  const m = /^([A-G])([#b]?)\s*([A-Za-z]*)/.exec(s);
  if (!m) return { sig: 0, key: makeKey(0, 'major') };
  const tonicLof = parseNoteName(m[1] + m[2]);
  const modeRaw = m[3].toLowerCase();
  const mode3 = modeRaw === 'm' ? 'm' : modeRaw.slice(0, 3);
  const off = MODE_OFFSETS[mode3] ?? 0;
  const sig = tonicLof + off;
  const minor = MINORISH.has(mode3);
  const key = minor ? makeKey(tonicLof - 3, 'minor') : makeKey(tonicLof, 'major');
  return { sig, key };
}

function sigAlters(sig) {
  // Buchstabe -> Alteration gemäß Vorzeichen
  const map = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  const sharps = 'FCGDAEB';
  const flats = 'BEADGCF';
  if (sig > 0) for (let i = 0; i < Math.min(7, sig); i++) map[sharps[i]] = 1;
  if (sig < 0) for (let i = 0; i < Math.min(7, -sig); i++) map[flats[i]] = -1;
  return map;
}

function parseFraction(s, def) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(s);
  if (m) return Number(m[1]) / Number(m[2]);
  return def;
}

function parseMeter(v) {
  const s = v.trim();
  if (s === 'C') return { beats: 4, beatType: 4 };
  if (s === 'C|') return { beats: 2, beatType: 2 };
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(s);
  if (m) return { beats: Number(m[1]), beatType: Number(m[2]) };
  return { beats: 4, beatType: 4 };
}

function parseTempo(v) {
  // "1/4=120" oder "120" oder "\"Allegro\" 1/4=120"
  const m = /(\d+)\s*\/\s*(\d+)\s*=\s*(\d+)/.exec(v);
  if (m) return (Number(m[3]) * (Number(m[1]) / Number(m[2]))) / 0.25;
  const n = /(\d+)/.exec(v);
  return n ? Number(n[1]) : null;
}

export function parseABC(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const head = { title: null, composer: null, meter: { beats: 4, beatType: 4 }, unit: null, tempo: null, keyInfo: null, rhythm: '' };
  let bodyLines = [];
  let inBody = false;
  let firstVoice = null;
  let skipVoice = false;
  for (let raw of lines) {
    const line = raw.replace(/(^|[^\\])%.*$/, '$1');
    const f = /^([A-Za-z]):\s*(.*)$/.exec(line);
    if (!inBody) {
      if (!f) continue;
      const [, k, v] = f;
      if (k === 'T' && !head.title) head.title = v.trim();
      else if (k === 'C') head.composer = v.trim();
      else if (k === 'M') head.meter = parseMeter(v);
      else if (k === 'L') head.unit = parseFraction(v, null);
      else if (k === 'Q') head.tempo = parseTempo(v);
      else if (k === 'R') head.rhythm = v.trim();
      else if (k === 'K') {
        head.keyInfo = parseKeyField(v);
        inBody = true;
      }
      continue;
    }
    if (f && 'KMLQPVwWTCNRIXZ'.includes(f[1])) {
      const [, k, v] = f;
      if (k === 'V') {
        const id = v.trim().split(/\s+/)[0];
        if (firstVoice === null) firstVoice = id;
        skipVoice = id !== firstVoice;
        continue;
      }
      if (k === 'w' || k === 'W') continue;
      if (skipVoice) continue;
      if ('KMLQP'.includes(k)) bodyLines.push(`[${k}:${v.trim()}]`);
      continue;
    }
    if (skipVoice) continue;
    bodyLines.push(line);
  }
  if (!head.keyInfo) head.keyInfo = parseKeyField('C');
  const body = bodyLines.join('\n').replace(/\\\n/g, ' ');
  return buildSong(head, body);
}

function buildSong(head, body) {
  let meter = head.meter;
  let unitFrac = head.unit ?? (meter.beats / meter.beatType < 0.75 ? 1 / 16 : 1 / 8);
  let unit = 4 * DIV * unitFrac;
  let sig = head.keyInfo.sig;
  let keyAlters = sigAlters(sig);
  const key = head.keyInfo.key;
  const warnings = [];

  const measures = [];
  let cur = newMeasure();
  function newMeasure() {
    return { notes: [], chords: [], len: 0, startRepeat: false, endRepeat: false, ending: 0, label: null, doubleBar: false };
  }
  let barAcc = {};
  let pendingChord = null;
  let tieNext = false;
  let tuplet = null; // {left, num, den}
  let brokenNext = null; // Faktor für nächste Note
  let currentEnding = 0;
  let ending1Len = 0;
  let endingCount = 0;
  let pendingLabel = null;

  function pushMeasure(flags = {}) {
    if (cur.notes.length || cur.len > 0 || cur.chords.length) {
      if (currentEnding) {
        cur.ending = currentEnding;
        endingCount++;
        if (currentEnding === 1) ending1Len = endingCount;
      }
      measures.push(cur);
      if (currentEnding === 2 && ending1Len && endingCount >= ending1Len) currentEnding = 0;
    }
    const prev = measures[measures.length - 1];
    if (flags.endRepeat && prev) {
      prev.endRepeat = true;
      if (currentEnding === 1) currentEnding = 0;
    }
    if (flags.doubleBar && prev) {
      prev.doubleBar = true;
      if (currentEnding === 2) currentEnding = 0;
    }
    cur = newMeasure();
    if (flags.startRepeat) {
      cur.startRepeat = true;
      if (currentEnding === 2) currentEnding = 0;
    }
    if (pendingLabel) {
      cur.label = pendingLabel;
      pendingLabel = null;
    }
    barAcc = {};
  }

  function addNote(midi, lof, dur, isRest) {
    let d = dur;
    if (brokenNext !== null) {
      d = d * brokenNext;
      brokenNext = null;
    }
    if (tuplet) {
      d = (d * tuplet.den) / tuplet.num;
      tuplet.left--;
      if (tuplet.left <= 0) tuplet = null;
    }
    d = Math.round(d);
    if (pendingChord) {
      cur.chords.push({ start: cur.len, symbol: pendingChord });
      pendingChord = null;
    }
    if (!isRest) {
      const last = cur.notes[cur.notes.length - 1];
      const prevMeasureLast = !last && measures.length ? measures[measures.length - 1].notes.slice(-1)[0] : null;
      const tieTarget = last || prevMeasureLast;
      if (tieNext && tieTarget && tieTarget.midi === midi) {
        cur.notes.push({ start: cur.len, dur: d, midi, lof, tiedFrom: true });
      } else cur.notes.push({ start: cur.len, dur: d, midi, lof });
    }
    tieNext = false;
    cur.len += d;
    return d;
  }

  let i = 0;
  const s = body;
  const n = s.length;
  const noteRe = /^(\^\^|\^|__|_|=)?([A-Ga-g])([',]*)(\d*)(\/*)(\d*)/;
  const restRe = /^([zx])(\d*)(\/*)(\d*)/;
  function lenMul(num, slashes, den) {
    let x = num ? Number(num) : 1;
    if (slashes) {
      const d = den ? Number(den) : 2 ** slashes.length;
      x /= den ? d : d;
      if (den && slashes.length > 1) x /= 2 ** (slashes.length - 1);
    }
    return x;
  }

  while (i < n) {
    const ch = s[i];
    const rest = s.slice(i, i + 40);
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '`' || ch === 'y') {
      i++;
      continue;
    }
    if (ch === '"') {
      const e = s.indexOf('"', i + 1);
      const txt = s.slice(i + 1, e < 0 ? n : e);
      i = e < 0 ? n : e + 1;
      if (/^[A-G]/.test(txt)) pendingChord = txt.trim();
      continue;
    }
    if (ch === '!' || ch === '+') {
      const e = s.indexOf(ch, i + 1);
      i = e < 0 ? i + 1 : e + 1;
      continue;
    }
    if (ch === '{') {
      const e = s.indexOf('}', i + 1);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (ch === '[') {
      const inl = /^\[([KMLQPIVNRTw]):([^\]]*)\]/.exec(rest);
      if (inl) {
        const [, k, v] = inl;
        if (k === 'K') {
          const ki = parseKeyField(v);
          sig = ki.sig;
          keyAlters = sigAlters(sig);
        } else if (k === 'M') {
          meter = parseMeter(v);
          if (measures.length) warnings.push('Taktwechsel im Stück: es wird mit der ersten Taktart weitergearbeitet.');
        } else if (k === 'L') {
          unitFrac = parseFraction(v, unitFrac);
          unit = 4 * DIV * unitFrac;
        } else if (k === 'P') {
          const lab = v.trim().split(/\s+/)[0];
          if (cur.notes.length || cur.len) pendingLabel = lab;
          else cur.label = lab;
        }
        i += inl[0].length;
        continue;
      }
      const end = /^\[([12])/.exec(rest);
      if (end) {
        currentEnding = Number(end[1]);
        endingCount = 0;
        i += 2;
        continue;
      }
      if (rest.startsWith('[|')) {
        pushMeasure({ doubleBar: true });
        i += 2;
        continue;
      }
      // Akkord [CEG] -> höchste Note
      const e = s.indexOf(']', i);
      const inner = s.slice(i + 1, e);
      let j = e + 1;
      const lm = /^(\d*)(\/*)(\d*)/.exec(s.slice(j));
      j += lm[0].length;
      const mul = lenMul(lm[1], lm[2], lm[3]);
      let best = null;
      let pos = 0;
      while (pos < inner.length) {
        const mm = noteRe.exec(inner.slice(pos));
        if (!mm) {
          pos++;
          continue;
        }
        const nt = resolveNote(mm);
        if (!best || nt.midi > best.midi) best = { ...nt, mul: lenMul(mm[4], mm[5], mm[6]) };
        pos += mm[0].length;
      }
      if (best) addNote(best.midi, best.lof, unit * best.mul * mul, false);
      if (s[j] === '-') {
        tieNext = true;
        j++;
      }
      i = j;
      continue;
    }
    if (ch === '|' || ch === ':') {
      const bm = /^(:\|:|::|:*\|\]|:*\|\||:*\|:|:+\|?|\|:*)/.exec(rest);
      const tok = bm ? bm[0] : ch;
      let flags = {};
      if (tok.startsWith(':')) flags.endRepeat = true;
      if (tok.endsWith(':') && tok !== ':') flags.startRepeat = true;
      if (tok === '::' || tok === ':|:') flags = { endRepeat: true, startRepeat: true };
      if (tok.includes('||') || tok.includes('|]')) flags.doubleBar = true;
      pushMeasure(flags);
      i += tok.length;
      const end = /^\[?([12])/.exec(s.slice(i));
      if (end && !/^[12]\d*\//.test(s.slice(i))) {
        currentEnding = Number(end[1]);
        endingCount = 0;
        i += end[0].length;
      }
      continue;
    }
    if (ch === '(') {
      const tm = /^\((\d)(?::(\d*))?(?::(\d*))?/.exec(rest);
      if (tm) {
        const p = Number(tm[1]);
        let q = tm[2] ? Number(tm[2]) : { 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 }[p] ?? 2;
        if (!tm[2] && [5, 7, 9].includes(p)) q = meter.beatType === 8 && meter.beats % 3 === 0 ? 3 : 2;
        const r = tm[3] ? Number(tm[3]) : p;
        tuplet = { num: p, den: q, left: r };
        i += tm[0].length;
      } else i++;
      continue;
    }
    if (ch === ')' || ch === '.' || ch === '~' || ch === '&') {
      i++;
      continue;
    }
    if (ch === '-') {
      tieNext = true;
      i++;
      continue;
    }
    if (ch === '>' || ch === '<') {
      let cnt = 1;
      while (s[i + cnt] === ch) cnt++;
      const factor = cnt === 1 ? 0.5 : cnt === 2 ? 0.25 : 0.125;
      const last = cur.notes[cur.notes.length - 1];
      // vorherige Note/Pause verlängern bzw. verkürzen
      const lastDur = last && last.start + last.dur === cur.len ? last : null;
      const prevD = lastDur ? lastDur.dur : null;
      if (prevD !== null) {
        const nd = ch === '>' ? prevD * (2 - factor) : prevD * factor;
        cur.len += nd - prevD;
        lastDur.dur = Math.round(nd);
        brokenNext = ch === '>' ? factor : 2 - factor;
      }
      i += cnt;
      continue;
    }
    const rm = restRe.exec(rest);
    if (rm) {
      addNote(null, null, unit * lenMul(rm[2], rm[3], rm[4]), true);
      i += rm[0].length;
      continue;
    }
    const mr = /^Z(\d*)/.exec(rest);
    if (mr) {
      const count = mr[1] ? Number(mr[1]) : 1;
      for (let k = 0; k < count; k++) {
        addNote(null, null, measureTicks(meter), true);
        if (k < count - 1) pushMeasure();
      }
      i += mr[0].length;
      continue;
    }
    const nm = noteRe.exec(rest);
    if (nm) {
      const nt = resolveNote(nm);
      addNote(nt.midi, nt.lof, unit * lenMul(nm[4], nm[5], nm[6]), false);
      i += nm[0].length;
      continue;
    }
    // unbekannte Dekorationszeichen (H..W, u, v ...) überspringen
    i++;
  }
  pushMeasure();

  function resolveNote(mm) {
    const [, acc, letterRaw, octs] = mm;
    const letter = letterRaw.toUpperCase();
    let octave = letterRaw === letter ? 4 : 5;
    for (const o of octs) octave += o === "'" ? 1 : -1;
    const accKey = letter + octave;
    let alter;
    if (acc) {
      alter = { '^': 1, '^^': 2, _: -1, __: -2, '=': 0 }[acc];
      barAcc[accKey] = alter;
    } else if (accKey in barAcc) alter = barAcc[accKey];
    else alter = keyAlters[letter];
    return { midi: stepAlterOctaveToMidi(letter, alter, octave), lof: letterAlterToLof(letter, alter) };
  }

  // Wiederholungen ausschreiben
  const expanded = expandRepeats(measures);
  return assemble(expanded, { head, meter, key, warnings });
}

export function expandRepeats(measures) {
  return expandOrder(measures).map((i) => measures[i]);
}

function assemble(measures, { head, meter, key, warnings }) {
  const mt = measureTicks(meter);
  const melody = [];
  const chords = [];
  const sections = [];
  let t = 0;
  let pickup = 0;
  measures.forEach((m, idx) => {
    if (idx === 0 && m.len > 0 && m.len < mt && measures.length > 1) {
      pickup = m.len;
      t = -m.len;
    }
    for (const nt of m.notes) {
      const abs = t + nt.start;
      const prev = melody[melody.length - 1];
      if (nt.tiedFrom && prev && prev.midi === nt.midi && prev.start + prev.dur === abs) prev.dur += nt.dur;
      else melody.push({ start: abs, dur: nt.dur, midi: nt.midi, lof: nt.lof });
    }
    for (const c of m.chords) {
      const chord = parseChord(c.symbol);
      if (chord) chords.push({ start: Math.max(0, t + c.start), chord });
    }
    if (m.label && t >= 0) sections.push({ label: m.label, start: Math.round(t / mt) });
    t += m.len;
  });
  const total = Math.max(0, t);
  const measureCount = Math.max(1, Math.ceil(total / mt - 0.01));
  const swing = /swing|jazz|shuffle/i.test(head.rhythm || '');
  const song = {
    title: head.title,
    composer: head.composer,
    key,
    meter,
    tempo: head.tempo ? Math.round(head.tempo) : null,
    swing,
    pickup,
    measureCount,
    melody,
    chords,
    sections,
    warnings,
    source: 'abc',
  };
  return finalizeSong(song);
}
