// Notenblatt-Editor: MusicXML lesen, verändern und wieder schreiben.
// Es wird nur das geändert, was die Bearbeitung verlangt (Tonhöhen, Schlüssel, Vorzeichen, Transposition) –
// Titel, Komponist, Texte, Dynamik, Artikulation und Layout-Angaben bleiben, wie sie sind.
import { parseXML, XNode, esc } from '../core/xml.js';

export const XML_HEAD =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n';

export function readScore(xmlText) {
  const root = parseXML(String(xmlText));
  if (root.name !== 'score-partwise') throw new Error('Nur MusicXML „score-partwise“ wird unterstützt');
  return root;
}

function attrString(a) {
  let s = '';
  for (const [k, v] of Object.entries(a || {})) if (v !== undefined && v !== null) s += ` ${k}="${esc(v)}"`;
  return s;
}

function write(node, depth, out) {
  const pad = '  '.repeat(depth);
  const text = node.text;
  if (!node.children.length) {
    if (text === '') out.push(`${pad}<${node.name}${attrString(node.attrs)}/>`);
    else out.push(`${pad}<${node.name}${attrString(node.attrs)}>${esc(text)}</${node.name}>`);
    return;
  }
  out.push(`${pad}<${node.name}${attrString(node.attrs)}>`);
  for (const c of node.children) write(c, depth + 1, out);
  out.push(`${pad}</${node.name}>`);
}

export function writeScore(root) {
  const out = [];
  write(root, 0, out);
  return XML_HEAD + out.join('\n') + '\n';
}

// Hilfen zum Bauen/Ändern
export function el(name, text = null, attrs = {}) {
  const n = new XNode(name, attrs);
  if (text !== null && text !== undefined) n.textParts.push(String(text));
  return n;
}

export function setText(node, value) {
  node.textParts = [String(value)];
}

// Kind mit Namen holen oder (am Ende / vor einem der Nachbarn) anlegen
export function ensureChild(node, name, { before = null } = {}) {
  let c = node.child(name);
  if (c) return c;
  c = new XNode(name, {});
  if (before) {
    const idx = node.children.findIndex((x) => before.includes(x.name));
    if (idx >= 0) node.children.splice(idx, 0, c);
    else node.children.push(c);
  } else node.children.push(c);
  return c;
}

export function removeChildren(node, name) {
  node.children = node.children.filter((c) => c.name !== name);
}

export function cloneNode(n) {
  const c = new XNode(n.name, { ...n.attrs });
  c.textParts = [...n.textParts];
  c.children = n.children.map(cloneNode);
  return c;
}

export const partsOf = (root) => root.all('part');
export const measuresOf = (part) => part.all('measure');
