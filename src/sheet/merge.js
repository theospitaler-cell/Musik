// Mehrere Einzelstimmen (Notenblätter) zu einer Partitur zusammenführen.
// Jede Stimme behält ihre Noten, Schlüssel, Transposition und Vorzeichen; Titel/Komponist kommen aus der
// ersten Stimme (oder den Angaben). Kürzere Stimmen werden mit ganztaktigen Pausen aufgefüllt.
import { XNode } from '../core/xml.js';
import { readScore, writeScore, el, cloneNode, partsOf, measuresOf, removeChildren, setText } from './xml.js';

function measureLength(part) {
  // Taktdauer in <divisions>-Einheiten nach dem letzten gültigen Zeitzeichen
  let divisions = 1;
  let beats = 4;
  let beatType = 4;
  for (const m of measuresOf(part)) {
    const at = m.child('attributes');
    if (!at) continue;
    if (at.child('divisions')) divisions = Number(at.val('divisions', 1)) || 1;
    const t = at.child('time');
    if (t) {
      beats = Number(t.val('beats', 4)) || 4;
      beatType = Number(t.val('beat-type', 4)) || 4;
    }
  }
  return Math.round((beats * 4 * divisions) / beatType);
}

function restMeasure(number, duration) {
  const m = el('measure', null, { number: String(number) });
  const n = el('note');
  n.children.push(el('rest', null, { measure: 'yes' }), el('duration', duration), el('voice', 1));
  m.children.push(n);
  return m;
}

function renameIds(node, oldId, newId) {
  const prefix = `${oldId}-`;
  if (node.attrs && typeof node.attrs.id === 'string' && node.attrs.id.startsWith(prefix)) node.attrs.id = `${newId}-${node.attrs.id.slice(prefix.length)}`;
  for (const c of node.children) renameIds(c, oldId, newId);
}

// items: [{ xml, partId?: Stimme der Datei (Standard: die erste), name?: Stimmenname }]
// opts: { title, composer }
export function mergeScores(items, opts = {}) {
  if (!items.length) throw new Error('Keine Stimmen zum Zusammenführen');
  const first = readScore(items[0].xml);
  const out = new XNode('score-partwise', { ...first.attrs, version: '4.0' });
  // Kopf: Werk, Identifikation, Layout-Angaben der ersten Stimme
  for (const name of ['work', 'movement-number', 'movement-title', 'identification', 'defaults', 'credit']) {
    for (const c of first.all(name)) out.children.push(cloneNode(c));
  }
  if (opts.title) {
    let work = out.child('work');
    if (!work) {
      work = el('work');
      out.children.unshift(work);
    }
    let wt = work.child('work-title');
    if (!wt) {
      wt = el('work-title');
      work.children.push(wt);
    }
    setText(wt, opts.title);
  }
  if (opts.composer) {
    let id = out.child('identification');
    if (!id) {
      id = el('identification');
      const w = out.children.findIndex((c) => c.name === 'work');
      out.children.splice(w + 1, 0, id);
    }
    for (const c of id.all('creator').filter((x) => x.attrs.type === 'composer')) id.children.splice(id.children.indexOf(c), 1);
    id.children.unshift(el('creator', opts.composer, { type: 'composer' }));
  }
  const list = el('part-list');
  out.children.push(list);
  const parts = [];
  let maxMeasures = 0;
  items.forEach((it, k) => {
    const root = readScore(it.xml);
    const all = partsOf(root);
    const src = all.find((p) => p.attrs.id === it.partId) || all[0];
    if (!src) throw new Error(`Stimme ${k + 1} enthält keine Noten`);
    const newId = `P${k + 1}`;
    const oldId = src.attrs.id;
    const part = cloneNode(src);
    part.attrs = { id: newId };
    renameIds(part, oldId, newId);
    const sp = root.get('part-list')?.all('score-part').find((x) => x.attrs.id === oldId);
    const score = sp ? cloneNode(sp) : el('score-part');
    score.attrs = { ...score.attrs, id: newId };
    renameIds(score, oldId, newId);
    if (it.name) {
      let pn = score.child('part-name');
      if (!pn) {
        pn = el('part-name');
        score.children.unshift(pn);
      }
      setText(pn, it.name);
      removeChildren(score, 'part-name-display');
    }
    list.children.push(score);
    parts.push(part);
    maxMeasures = Math.max(maxMeasures, measuresOf(part).length);
  });
  // gleiche Taktzahl
  for (const part of parts) {
    const len = measureLength(part);
    let n = measuresOf(part).length;
    while (n < maxMeasures) {
      n++;
      part.children.push(restMeasure(n, len));
    }
  }
  out.children.push(...parts);
  return { xml: writeScore(out), parts: parts.length, measures: maxMeasures };
}
