// Wie weit sind die Töne einer Seite gegenüber dem erkannten Ausgangsstand verschoben? Das bestimmt, um wie viel
// die Akkordsymbole im Bild mitwandern (Oktaven spielen keine Rolle, nur Stufe und Halbton modulo Oktave).
import { readScore, partsOf, measuresOf } from './xml.js';
import { STEPS } from './transpose.js';

const NAT = [0, 2, 4, 5, 7, 9, 11];
const mod = (n, m) => ((n % m) + m) % m;

// Töne der ersten Stimme in Dokumentreihenfolge: [{ step, alter }]
function pitches(xmlText, limit = 64) {
  const root = readScore(xmlText);
  const part = partsOf(root)[0];
  const out = [];
  if (!part) return out;
  for (const m of measuresOf(part)) {
    for (const n of m.children) {
      if (n.name !== 'note') continue;
      const p = n.child('pitch');
      if (!p) continue;
      out.push({ step: p.val('step') || 'C', alter: Number(p.val('alter') || 0) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// -> { diatonic: 0..6, chromatic: 0..11 } oder null, wenn sich nichts vergleichen lässt
export function chordShiftBetween(baseXml, xml) {
  if (baseXml === xml) return { diatonic: 0, chromatic: 0 };
  const a = pitches(baseXml);
  const b = pitches(xml);
  const n = Math.min(a.length, b.length);
  if (!n) return null;
  // Abstimmung über mehrere Töne: der häufigste Abstand (Stufen/Halbtöne modulo Oktave) gewinnt
  const votes = new Map();
  for (let i = 0; i < n; i++) {
    const d = mod(STEPS.indexOf(b[i].step) - STEPS.indexOf(a[i].step), 7);
    const c = mod(NAT[STEPS.indexOf(b[i].step)] + b[i].alter - (NAT[STEPS.indexOf(a[i].step)] + a[i].alter), 12);
    const k = `${d}:${c}`;
    votes.set(k, (votes.get(k) || 0) + 1);
  }
  let best = null;
  for (const [k, v] of votes) if (!best || v > best.v) best = { k, v };
  const [d, c] = best.k.split(':').map(Number);
  return { diatonic: d, chromatic: c };
}
