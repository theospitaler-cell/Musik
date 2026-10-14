// Oktavieren: das ganze Stück, eine Zeile, einzelne Takte oder einzelne Töne um Oktaven nach oben/unten schieben.
// Nur die Oktavzahl der gewählten Töne ändert sich – Vorzeichen, Schlüssel, Rhythmus und Texte bleiben.
import { readScore, writeScore, partsOf, measuresOf, setText, removeChildren } from './xml.js';

const MIN_OCTAVE = 0;
const MAX_OCTAVE = 9;

const pitchNode = (note) => note.child('pitch');
const isPitched = (note) => note.name === 'note' && !!pitchNode(note);
const num = (v, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v));

function readPitch(note) {
  const p = pitchNode(note);
  return { step: p.val('step') || 'C', alter: num(p.val('alter')), octave: num(p.val('octave'), 4) };
}

// Gewählte Takte/Töne (1-basiert; Töne je Takt in Dokumentreihenfolge gezählt)
// opts: { octaves, measures: [von, bis] | null, notes: [{ measure, index }] | null, parts: [id] | null }
export function shiftOctavesRoot(root, opts = {}) {
  const octaves = Math.trunc(Number(opts.octaves || 0));
  const out = { changed: 0, clamped: 0, ties: 0 };
  if (!octaves) return out;
  const ids = opts.parts || null;
  const parts = partsOf(root).filter((p) => !ids || ids.includes(p.attrs.id));
  const [from, to] = opts.measures || [1, Infinity];
  const noteSet = opts.notes ? new Set(opts.notes.map((n) => `${n.measure}:${n.index}`)) : null;
  for (const part of parts) {
    const touched = [];
    measuresOf(part).forEach((m, mi) => {
      const mNo = mi + 1;
      if (!noteSet && (mNo < from || mNo > to)) return;
      let idx = 0;
      for (const n of m.children) {
        if (!isPitched(n)) continue;
        idx++;
        if (noteSet && !noteSet.has(`${mNo}:${idx}`)) continue;
        const p = pitchNode(n);
        const o = num(p.val('octave'), 4) + octaves;
        if (o < MIN_OCTAVE || o > MAX_OCTAVE) {
          out.clamped++;
          continue;
        }
        setText(p.child('octave'), o);
        touched.push(n);
        out.changed++;
      }
    });
    if (touched.length) out.ties += fixTies(part);
  }
  return out;
}

// Haltebögen zwischen Tönen verschiedener Höhe sind nach teilweisem Oktavieren sinnlos: entfernen
function fixTies(part) {
  let removed = 0;
  const pending = new Map(); // Stimme/Notenzeile + Tonhöhe -> Ton mit Haltebogen-Anfang
  const key = (n, p) => `${n.val('voice') || '1'}|${n.val('staff') || '1'}|${p.step}${p.alter}`;
  const stripTie = (n, type) => {
    n.children = n.children.filter((c) => !(c.name === 'tie' && c.attrs.type === type));
    const notations = n.child('notations');
    if (notations) {
      notations.children = notations.children.filter((c) => !(c.name === 'tied' && c.attrs.type === type));
      if (!notations.children.length) removeChildren(n, 'notations');
    }
  };
  const hasTie = (n, type) => n.all('tie').some((t) => t.attrs.type === type);
  for (const m of measuresOf(part)) {
    for (const n of m.children) {
      if (!isPitched(n)) continue;
      const p = readPitch(n);
      const k = key(n, p);
      // Ende eines Haltebogens: passt der Anfang (gleiche Stufe/Vorzeichen) in der Oktave?
      if (hasTie(n, 'stop')) {
        const start = pending.get(k);
        // Anfang auf einer früheren Seite (nicht bekannt): unverändert lassen
        if (start && start.octave !== p.octave) {
          stripTie(n, 'stop');
          stripTie(start.note, 'start');
          removed++;
        }
        pending.delete(k);
      }
      if (hasTie(n, 'start')) pending.set(k, { note: n, octave: p.octave });
    }
  }
  return removed;
}

export function shiftOctavesXml(xmlText, opts = {}) {
  const root = readScore(xmlText);
  const info = shiftOctavesRoot(root, opts);
  return { xml: info.changed ? writeScore(root) : xmlText, ...info };
}

// ---- Auswahlhilfen für die Oberfläche -------------------------------------------------------------
const GERMAN = { C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', A: 'A', B: 'H' };
export function noteLabel(p) {
  let name = GERMAN[p.step] || p.step;
  if (p.step === 'B' && p.alter === -1) name = 'B';
  else if (p.alter > 0) name += '♯'.repeat(p.alter);
  else if (p.alter < 0) name += '♭'.repeat(-p.alter);
  return `${name}${p.octave}`;
}

// Takte der (ersten oder gewählten) Stimme und deren Töne – für Auswahl einzelner Töne
// -> { measures: Anzahl, notes: [{ index, label, rest: false, chord: bool, grace: bool }] } für Takt `measure`
export function describeMeasure(xmlText, { measure = 1, partId = null } = {}) {
  const root = readScore(xmlText);
  const parts = partsOf(root);
  const part = parts.find((p) => p.attrs.id === partId) || parts[0];
  if (!part) return { measures: 0, notes: [] };
  const ms = measuresOf(part);
  const m = ms[measure - 1];
  const notes = [];
  if (m) {
    let idx = 0;
    for (const n of m.children) {
      if (!isPitched(n)) continue;
      idx++;
      notes.push({ index: idx, label: noteLabel(readPitch(n)), chord: !!n.child('chord'), grace: !!n.child('grace') });
    }
  }
  return { measures: ms.length, notes };
}

export function measureCount(xmlText, partId = null) {
  const root = readScore(xmlText);
  const parts = partsOf(root);
  const part = parts.find((p) => p.attrs.id === partId) || parts[0];
  return part ? measuresOf(part).length : 0;
}
