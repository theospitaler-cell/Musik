// Ein Notenblatt-Projekt: eine oder mehrere Seiten (je ein MusicXML-Ausschnitt), Änderungen wirken auf alle
// Seiten gleich. Ein eingescanntes Blatt hat je Seite ein Bild; Datei-Importe (MusicXML, MIDI, ABC) haben eine
// einzige „Seite“ ohne Bild.
import { readScore, writeScore, partsOf, measuresOf, el } from './xml.js';
import { transposeXml, setClefXml, convertForInstrument, analyzeXml } from './transpose.js';
import { shiftOctavesXml, measureCount } from './octave.js';

export function newProject({ title = '', xml = null, pages = null, origin = 'datei', sourceInstrument = 'trumpet', original = null } = {}) {
  // base = erkannter Ausgangsstand je Seite: solange die Seite unverändert ist, bleibt das Original-Bild stehen
  const list = (pages && pages.length ? pages : [{ xml }]).map((p) => ({ xml: p.xml, image: p.image || null, base: p.base ?? p.xml }));
  return {
    title,
    origin, // 'scan' | 'datei' | 'bibliothek' | 'score'
    sourceInstrument, // Instrument, für das das Blatt notiert ist ('concert' = klingend)
    instrument: null, // Zielinstrument nach dem Umschreiben (nur Anzeige)
    pages: list,
    // der Stand beim Laden bzw. Erkennen: dorthin führt „Auf Original zurücksetzen“
    original: original || { pages: list.map((x) => ({ xml: x.xml, base: x.base })), sourceInstrument, instrument: null, origin },
    history: [],
    future: [],
  };
}

// Ganzer Zustand für Rückgängig/Wiederholen (auch wenn Stimmen dazukommen und sich die Seiten ändern)
const snapshot = (p) => ({
  pages: p.pages.map((x) => ({ xml: x.xml, base: x.base })),
  sourceInstrument: p.sourceInstrument,
  instrument: p.instrument,
  origin: p.origin,
});

function restore(p, s) {
  p.pages = s.pages.map((x, i) => ({ xml: x.xml, base: x.base, image: p.pages[i]?.image || null }));
  p.sourceInstrument = s.sourceInstrument;
  p.instrument = s.instrument;
  p.origin = s.origin;
}

function push(p) {
  p.history.push(snapshot(p));
  if (p.history.length > 30) p.history.shift();
  p.future = [];
}

export function undo(p) {
  if (!p.history.length) return false;
  p.future.push(snapshot(p));
  restore(p, p.history.pop());
  return true;
}

export function redo(p) {
  if (!p.future.length) return false;
  p.history.push(snapshot(p));
  restore(p, p.future.pop());
  return true;
}

// Steht das Projekt noch auf dem Original (Töne, Seiten, Instrument)?
export function isOriginal(p) {
  const o = p.original;
  if (!o) return true;
  if (o.pages.length !== p.pages.length) return false;
  if ((o.origin || p.origin) !== p.origin) return false;
  if ((o.sourceInstrument ?? null) !== (p.sourceInstrument ?? null)) return false;
  return o.pages.every((x, i) => x.xml === p.pages[i].xml);
}

// Alle Änderungen zurücknehmen: Töne, Schlüssel, Tonart, Instrument, dazugeschriebene Stimmen.
// Der Schritt selbst lässt sich mit „Rückgängig“ wieder zurücknehmen.
export function resetToOriginal(p) {
  if (isOriginal(p)) return false;
  push(p);
  restore(p, { pages: p.original.pages, sourceInstrument: p.original.sourceInstrument, instrument: p.original.instrument ?? null, origin: p.original.origin || p.origin });
  return true;
}

// Aus dem Blatt wird eine Partitur (Stimmen dazugeschrieben): ein einziges Dokument; Rückgängig bringt das Blatt zurück
export function replaceWithScore(p, { xml, sourceInstrument = null, instrument = null }) {
  push(p);
  p.pages = [{ xml, image: null, base: xml }];
  p.origin = 'score';
  p.sourceInstrument = sourceInstrument;
  p.instrument = instrument;
}

// Seiten zu einem Blatt: weitere Seiten hängen ihre Takte an (Nummern laufen weiter), unveränderte Vorzeichen,
// Taktart und Schlüssel am Anfang einer Folgeseite werden nicht erneut gesetzt.
export function concatPages(xmls) {
  if (xmls.length === 1) return xmls[0];
  const root = readScore(xmls[0]);
  const part = partsOf(root)[0];
  let n = measuresOf(part).length;
  const state = { key: null, time: null, clef: null };
  const sig = (node) => (node ? writeScoreNode(node) : null);
  for (const m of measuresOf(part)) {
    for (const at of m.all('attributes')) {
      if (at.child('key')) state.key = sig(at.child('key'));
      if (at.child('time')) state.time = sig(at.child('time'));
      if (at.child('clef')) state.clef = sig(at.child('clef'));
    }
  }
  for (const x of xmls.slice(1)) {
    const r = readScore(x);
    const p = partsOf(r)[0];
    if (!p) continue;
    let first = true;
    for (const m of measuresOf(p)) {
      n++;
      m.attrs = { ...m.attrs, number: String(n) };
      if (first) {
        for (const at of m.all('attributes')) {
          at.children = at.children.filter((c) => {
            if (c.name === 'key' && sig(c) === state.key) return false;
            if (c.name === 'time' && sig(c) === state.time) return false;
            if (c.name === 'clef' && sig(c) === state.clef) return false;
            return true;
          });
        }
        m.children = m.children.filter((c) => !(c.name === 'attributes' && !c.children.length));
        // Seitenwechsel als neue Zeile markieren
        if (!m.all('print').length) m.children.unshift(el('print', null, { 'new-page': 'yes' }));
        first = false;
      }
      part.children.push(m);
      for (const at of m.all('attributes')) {
        if (at.child('key')) state.key = sig(at.child('key'));
        if (at.child('time')) state.time = sig(at.child('time'));
        if (at.child('clef')) state.clef = sig(at.child('clef'));
      }
    }
  }
  return writeScore(root);
}

function writeScoreNode(node) {
  // einfacher Vergleichsschlüssel (Name, Attribute, Text, Kinder)
  const kids = node.children.map(writeScoreNode).join('');
  return `<${node.name}${Object.entries(node.attrs || {}).map(([k, v]) => ` ${k}=${v}`).join('')}>${node.text}${kids}</${node.name}>`;
}

export function projectXml(p) {
  return concatPages(p.pages.map((x) => x.xml));
}

export function infoOf(p) {
  return analyzeXml(projectXml(p));
}

// ---- Änderungen (auf alle Seiten) ---------------------------------------------------------------------
export function transposeProject(p, opts) {
  push(p);
  // Zieltonart/Stufen aus dem ganzen Stück bestimmen, dann überall gleich anwenden
  const total = transposeXml(projectXml(p), opts);
  if (!total.changed) {
    p.history.pop();
    return { changed: false };
  }
  const fixed = { chromatic: total.chromatic, octaves: 0, parts: opts.parts || null };
  p.pages.forEach((pg) => {
    pg.xml = transposeXml(pg.xml, fixed).xml;
  });
  return { changed: true, chromatic: total.chromatic, fifthsBefore: total.fifthsBefore, fifthsAfter: total.fifthsAfter };
}

export function setClefProject(p, clefId, { parts = null } = {}) {
  push(p);
  p.pages.forEach((pg) => {
    pg.xml = setClefXml(pg.xml, clefId, { parts });
  });
}

// Für ein anderes Instrument umschreiben: Töne 1:1; Oktavlage und Schlüssel passend zum Instrument
export function convertProject(p, { targetId, sourceId = undefined, octave = 'auto', clef = 'auto', tenorClef = true, partId = null } = {}) {
  push(p);
  const src = sourceId === undefined ? p.sourceInstrument : sourceId;
  const total = convertForInstrument(projectXml(p), { sourceId: src, targetId, octave, clef, tenorClef, partId });
  p.pages.forEach((pg) => {
    pg.xml = convertForInstrument(pg.xml, { sourceId: src, targetId, octave: total.octaves, clef: total.clef, partId }).xml;
  });
  p.sourceInstrument = targetId;
  p.instrument = targetId;
  return total;
}

export function setSourceInstrument(p, id) {
  p.sourceInstrument = id;
}

// Oktavieren: ganzes Stück (measures/notes = null), Takte (1-basiert, einschließlich) oder einzelne Töne
// ({ measure, index } – Takt im ganzen Stück, Ton in Dokumentreihenfolge). Gilt über alle Seiten.
export function shiftOctaveProject(p, { octaves = 0, measures = null, notes = null, parts = null } = {}) {
  push(p);
  const counts = p.pages.map((pg) => measureCount(pg.xml));
  let offset = 0;
  let changed = 0;
  let clamped = 0;
  p.pages.forEach((pg, i) => {
    const n = counts[i];
    const o = { octaves, parts };
    let skip = false;
    if (notes) {
      const local = notes.filter((x) => x.measure > offset && x.measure <= offset + n).map((x) => ({ measure: x.measure - offset, index: x.index }));
      if (!local.length) skip = true;
      else o.notes = local;
    } else if (measures) {
      const a = Math.max(measures[0], offset + 1);
      const b = Math.min(measures[1], offset + n);
      if (a > b) skip = true;
      else o.measures = [a - offset, b - offset];
    }
    if (!skip) {
      const r = shiftOctavesXml(pg.xml, o);
      pg.xml = r.xml;
      changed += r.changed;
      clamped += r.clamped;
    }
    offset += n;
  });
  if (!changed) p.history.pop();
  return { changed, clamped };
}
