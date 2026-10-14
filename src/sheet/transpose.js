// Transponieren, Schlüssel wechseln und für ein anderes Instrument umschreiben – direkt auf dem MusicXML.
// Geändert werden nur Tonhöhen (Notennamen), Vorzeichen (<key>), Schlüssel (<clef>), <transpose>
// und Akkordsymbole. Alles andere (Titel, Komponist, Texte, Dynamik, Bindebögen …) bleibt unverändert.
import { INSTRUMENTS } from '../arrange/instruments.js';
import { readScore, writeScore, el, setText, ensureChild, removeChildren, partsOf, measuresOf } from './xml.js';

export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NAT = [0, 2, 4, 5, 7, 9, 11];
const mod = (n, m) => ((n % m) + m) % m;

// Diatonische Stufen je Halbtonschritt (0–11): reine/kleine/große Intervalle
const DIA = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];

export const midiOf = (p) => 12 * (p.octave + 1) + NAT[STEPS.indexOf(p.step)] + (p.alter || 0);

// Notenname um d Stufen und c Halbtöne versetzen
export function transposePitch(p, d, c) {
  const idx = STEPS.indexOf(p.step) + d;
  const octave = p.octave + Math.floor(idx / 7);
  const step = STEPS[mod(idx, 7)];
  const target = midiOf(p) + c;
  let alter = target - (12 * (octave + 1) + NAT[STEPS.indexOf(step)]);
  if (Math.abs(alter) > 2) {
    // Doppelkreuz/-b überschritten: den näheren Nachbarstufen-Namen nehmen
    let best = null;
    for (const dd of [-1, 1]) {
      const i2 = idx + dd;
      const o2 = p.octave + Math.floor(i2 / 7);
      const s2 = STEPS[mod(i2, 7)];
      const a2 = target - (12 * (o2 + 1) + NAT[STEPS.indexOf(s2)]);
      if (!best || Math.abs(a2) < Math.abs(best.alter)) best = { step: s2, octave: o2, alter: a2 };
    }
    return best;
  }
  return { step, alter, octave };
}

// Für c Halbtöne (inkl. Oktaven) die diatonischen Stufen so wählen, dass die neue Tonart möglichst wenige
// Vorzeichen hat. Rückgabe: Stufen gesamt, Verschiebung auf dem Quintenzirkel, neue Vorzeichenzahl.
export function chooseInterval(c, fifths = 0, { preferFlats = true } = {}) {
  const cMod = mod(c, 12);
  const oct = (c - cMod) / 12;
  const base = DIA[cMod];
  let best = null;
  for (const d of [base - 1, base, base + 1]) {
    const delta = 7 * cMod - 12 * d;
    const nf = fifths + delta;
    if (Math.abs(nf) > 7) continue;
    const score = Math.abs(nf) * 10 + (d === base ? 0 : 0.4) + (preferFlats && nf > 0 ? 0.5 : 0);
    if (!best || score < best.score) best = { d, delta, nf, score };
  }
  if (!best) best = { d: base, delta: 7 * cMod - 12 * base, nf: fifths + 7 * cMod - 12 * base, score: 0 };
  return { diatonic: best.d + 7 * oct, chromatic: c, fifthsDelta: best.delta, fifths: best.nf };
}

const textOf = (n, path, def = null) => {
  const v = n.val(path);
  return v === null || v === '' ? def : v;
};

function pitchOf(note) {
  const p = note.child('pitch');
  if (!p) return null;
  return { step: textOf(p, 'step', 'C'), alter: Number(textOf(p, 'alter', 0)) || 0, octave: Number(textOf(p, 'octave', 4)) };
}

function setPitch(note, q) {
  const p = note.child('pitch');
  setText(p.child('step'), q.step);
  const a = p.child('alter');
  if (q.alter) {
    if (a) setText(a, q.alter);
    else {
      const node = el('alter', q.alter);
      const idx = p.children.indexOf(p.child('step')) + 1;
      p.children.splice(idx, 0, node);
    }
  } else if (a) removeChildren(p, 'alter');
  setText(p.child('octave'), q.octave);
}

// Erste Vorzeichenzahl des Stücks (für die Wahl der Stufen)
export function firstFifths(root, partIdx = 0) {
  const part = partsOf(root)[partIdx];
  if (!part) return 0;
  for (const m of measuresOf(part)) {
    for (const at of m.all('attributes')) {
      const k = at.child('key');
      if (k) return Number(textOf(k, 'fifths', 0)) || 0;
    }
  }
  return 0;
}

// ---- Transponieren (alle oder gewählte Stimmen) ------------------------------------------------------
// opts: { chromatic: Halbtöne (negativ = abwärts), octaves: zusätzliche Oktaven, parts: [id] | null,
//         toFifths: gewünschte Zieltonart (Vorzeichenzahl) statt fester Halbtöne, preferFlats }
export function transposeXml(xmlText, opts = {}) {
  const root = readScore(xmlText);
  const info = transposeRoot(root, opts);
  return { xml: writeScore(root), ...info };
}

export function transposeRoot(root, opts = {}) {
  const ids = opts.parts || null;
  const parts = partsOf(root).filter((p) => !ids || ids.includes(p.attrs.id));
  const fifths0 = firstFifths(root, partsOf(root).indexOf(parts[0] || partsOf(root)[0]));
  let c = Number(opts.chromatic || 0) + 12 * Number(opts.octaves || 0);
  if (opts.toFifths !== undefined && opts.toFifths !== null) {
    // Zieltonart: kürzester Weg (höchstens ±6 Halbtöne) zu einer Tonart mit der gewünschten Vorzeichenzahl
    const want = Number(opts.toFifths);
    const cMod = mod(7 * (want - fifths0), 12); // Halbtonschritte nach oben
    c = (cMod > 6 ? cMod - 12 : cMod) + 12 * Number(opts.octaves || 0);
  }
  if (c === 0) return { chromatic: 0, diatonic: 0, fifthsBefore: fifths0, fifthsAfter: fifths0, changed: false };
  const iv = chooseInterval(c, fifths0, { preferFlats: opts.preferFlats !== false });
  for (const part of parts) {
    for (const m of measuresOf(part)) {
      for (const n of m.children) {
        if (n.name === 'note') {
          const p = pitchOf(n);
          if (p) setPitch(n, transposePitch(p, iv.diatonic, iv.chromatic));
        } else if (n.name === 'attributes') {
          const key = n.child('key');
          if (key && key.child('fifths')) setText(key.child('fifths'), Number(textOf(key, 'fifths', 0)) + iv.fifthsDelta);
        } else if (n.name === 'harmony') {
          for (const [rootTag, stepTag, alterTag] of [['root', 'root-step', 'root-alter'], ['bass', 'bass-step', 'bass-alter']]) {
            const r = n.child(rootTag);
            if (!r || !r.child(stepTag)) continue;
            const q = transposePitch({ step: textOf(r, stepTag, 'C'), alter: Number(textOf(r, alterTag, 0)) || 0, octave: 4 }, iv.diatonic, iv.chromatic);
            setText(r.child(stepTag), q.step);
            const a = r.child(alterTag);
            if (q.alter) {
              if (a) setText(a, q.alter);
              else r.children.splice(r.children.indexOf(r.child(stepTag)) + 1, 0, el(alterTag, q.alter));
            } else if (a) removeChildren(r, alterTag);
          }
        }
      }
    }
  }
  return { chromatic: iv.chromatic, diatonic: iv.diatonic, fifthsBefore: fifths0, fifthsAfter: fifths0 + iv.fifthsDelta, changed: true };
}

// ---- Schlüssel ----------------------------------------------------------------------------------------
export const CLEFS = {
  G2: { sign: 'G', line: 2, name: 'Violinschlüssel' },
  'G2-8': { sign: 'G', line: 2, octave: -1, name: 'Violinschlüssel (Oktave tiefer)' },
  F4: { sign: 'F', line: 4, name: 'Bassschlüssel' },
  F3: { sign: 'F', line: 3, name: 'Baritonschlüssel' },
  C3: { sign: 'C', line: 3, name: 'Altschlüssel' },
  C4: { sign: 'C', line: 4, name: 'Tenorschlüssel' },
  C1: { sign: 'C', line: 1, name: 'Sopranschlüssel' },
};

function clefNode(c, number) {
  const n = el('clef', null, number ? { number: String(number) } : {});
  n.children.push(el('sign', c.sign), el('line', c.line));
  if (c.octave) n.children.push(el('clef-octave-change', c.octave));
  return n;
}

const AFTER_CLEF = ['staff-details', 'transpose', 'directive', 'measure-style'];

// Schlüssel der ersten Notenzeile setzen; spätere Schlüsselwechsel in dieser Stimme entfallen.
export function setClefRoot(root, clefId, { parts = null, staff = 1 } = {}) {
  const c = CLEFS[clefId];
  if (!c) throw new Error(`Unbekannter Schlüssel: ${clefId}`);
  let n = 0;
  for (const part of partsOf(root)) {
    if (parts && !parts.includes(part.attrs.id)) continue;
    const ms = measuresOf(part);
    let placed = false;
    for (const m of ms) {
      for (const at of m.all('attributes')) {
        const keep = [];
        for (const ch of at.children) {
          if (ch.name === 'clef' && Number(ch.attrs.number || 1) === staff) {
            if (!placed && m === ms[0]) {
              keep.push(clefNode(c, ch.attrs.number));
              placed = true;
            }
            continue;
          }
          keep.push(ch);
        }
        at.children = keep;
      }
    }
    if (!placed && ms[0]) {
      let at = ms[0].child('attributes');
      if (!at) {
        at = el('attributes');
        ms[0].children.unshift(at);
      }
      const node = clefNode(c, null);
      const idx = at.children.findIndex((x) => AFTER_CLEF.includes(x.name));
      if (idx >= 0) at.children.splice(idx, 0, node);
      else at.children.push(node);
    }
    n++;
  }
  return n;
}

export function setClefXml(xmlText, clefId, opts = {}) {
  const root = readScore(xmlText);
  setClefRoot(root, clefId, opts);
  return writeScore(root);
}

export function clefOf(part) {
  for (const m of measuresOf(part)) {
    for (const at of m.all('attributes')) {
      for (const c of at.all('clef')) {
        if (Number(c.attrs.number || 1) === 1) {
          const sign = textOf(c, 'sign', 'G');
          const line = Number(textOf(c, 'line', 2));
          const oct = Number(textOf(c, 'clef-octave-change', 0));
          const id = Object.entries(CLEFS).find(([, v]) => v.sign === sign && v.line === line && (v.octave || 0) === oct)?.[0];
          return id || `${sign}${line}`;
        }
      }
    }
  }
  return 'G2';
}

// ---- Übersicht -----------------------------------------------------------------------------------------
export function analyzeXml(xmlText) {
  const root = readScore(xmlText);
  const list = root.get('part-list');
  const names = {};
  if (list) for (const sp of list.all('score-part')) names[sp.attrs.id] = sp.val('part-name', '');
  const parts = partsOf(root).map((p) => {
    let lo = Infinity;
    let hi = -Infinity;
    let count = 0;
    let rests = 0;
    let chrom = 0;
    let octave = 0;
    for (const m of measuresOf(p)) {
      for (const n of m.all('note')) {
        const q = pitchOf(n);
        if (!q) {
          if (n.child('rest')) rests++;
          continue;
        }
        const v = midiOf(q);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        count++;
      }
      for (const at of m.all('attributes')) {
        const tr = at.child('transpose');
        if (tr) {
          chrom = Number(textOf(tr, 'chromatic', 0)) || 0;
          octave = Number(textOf(tr, 'octave-change', 0)) || 0;
        }
      }
    }
    return {
      id: p.attrs.id,
      name: names[p.attrs.id] || p.attrs.id,
      clef: clefOf(p),
      measures: measuresOf(p).length,
      notes: count,
      rests,
      lowest: count ? lo : null,
      highest: count ? hi : null,
      transposeSemis: -(chrom + 12 * octave) || 0, // notiert = klingend + semis
    };
  });
  return {
    title: root.val('work/work-title') || root.val('movement-title') || '',
    composer: root.all('identification').flatMap((i) => i.all('creator')).find((c) => c.attrs.type === 'composer')?.text || '',
    fifths: firstFifths(root),
    parts,
  };
}

// ---- Instrument wechseln ----------------------------------------------------------------------------
const DIA_TR = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];

function transposeElement(semis) {
  // notiert = klingend + semis -> <transpose> beschreibt klingend aus notiert: negativ
  if (!semis) return null;
  const s = mod(semis, 12);
  const octaves = (semis - s) / 12;
  const t = el('transpose');
  t.children.push(el('diatonic', -DIA_TR[s]), el('chromatic', -s));
  if (octaves) t.children.push(el('octave-change', -octaves));
  return t;
}

function setTransposeElement(part, semis) {
  const first = measuresOf(part)[0];
  if (!first) return;
  let at = first.child('attributes');
  if (!at) {
    at = el('attributes');
    first.children.unshift(at);
  }
  removeChildren(at, 'transpose');
  const t = transposeElement(semis);
  if (t) {
    const idx = at.children.findIndex((x) => ['directive', 'measure-style'].includes(x.name));
    if (idx >= 0) at.children.splice(idx, 0, t);
    else at.children.push(t);
  }
}

// Ton-Kosten eines Oktavversatzes: Töne außerhalb des Kernbereichs zählen quadratisch, außerhalb des
// Tonumfangs sehr stark.
function fitCost(soundingPitches, inst, shiftOctaves) {
  const [rl, rh] = inst.range;
  const [cl, ch] = inst.comfort;
  let cost = 0;
  for (const m of soundingPitches) {
    const v = m + 12 * shiftOctaves;
    if (v < rl) cost += 400 + (rl - v) ** 2 * 20;
    else if (v > rh) cost += 400 + (v - rh) ** 2 * 20;
    else if (v < cl) cost += (cl - v) ** 2;
    else if (v > ch) cost += (v - ch) ** 2;
  }
  return cost;
}

// opts: { sourceId: Instrument, auf dem das Blatt notiert ist (null = die Datei sagt es über <transpose>,
//   sonst klingend), targetId, partId, octave: 'auto' | Zahl, clef: 'auto' | Schlüssel-Kennung | null }
export function convertForInstrument(xmlText, opts) {
  const target = INSTRUMENTS[opts.targetId];
  if (!target) throw new Error(`Unbekanntes Instrument: ${opts.targetId}`);
  const root = readScore(xmlText);
  const all = partsOf(root);
  const part = all.find((p) => p.attrs.id === opts.partId) || all[0];
  if (!part) throw new Error('Keine Stimme im Blatt');
  // Quelle: Notierung des Blatts
  let sourceSemis = 0;
  if (opts.sourceId && INSTRUMENTS[opts.sourceId]) sourceSemis = INSTRUMENTS[opts.sourceId].transpose.semis;
  else if (opts.sourceId === null || opts.sourceId === undefined) {
    const a = analyzeXml(xmlText).parts.find((p) => p.id === part.attrs.id);
    sourceSemis = a ? a.transposeSemis : 0;
  }
  const written = [];
  for (const m of measuresOf(part)) for (const n of m.all('note')) {
    const q = pitchOf(n);
    if (q) written.push(midiOf(q));
  }
  const sounding = written.map((w) => w - sourceSemis);
  // Oktavlage: ganzes Stück gemeinsam in den bequemen Bereich des Zielinstruments
  let octaves = 0;
  if (typeof opts.octave === 'number') octaves = opts.octave;
  else if (sounding.length) {
    let best = null;
    for (let o = -4; o <= 4; o++) {
      const cost = fitCost(sounding, target, o) + Math.abs(o) * 0.01;
      if (!best || cost < best.cost) best = { o, cost };
    }
    octaves = best.o;
  }
  const targetSemis = target.transpose.semis;
  const net = targetSemis - sourceSemis;
  const c = net + 12 * octaves;
  const fifths0 = firstFifths(root, all.indexOf(part));
  // Tonart des Zielinstruments: Stufen nach Vorzeichenzahl (konzertante Tonart = notierte − Quelle)
  const iv = chooseInterval(c, fifths0);
  for (const m of measuresOf(part)) {
    for (const n of m.children) {
      if (n.name === 'note') {
        const p = pitchOf(n);
        if (p) setPitch(n, transposePitch(p, iv.diatonic, iv.chromatic));
      } else if (n.name === 'attributes') {
        const key = n.child('key');
        if (key && key.child('fifths')) setText(key.child('fifths'), Number(textOf(key, 'fifths', 0)) + iv.fifthsDelta);
      } else if (n.name === 'harmony') {
        for (const [rt, st, al] of [['root', 'root-step', 'root-alter'], ['bass', 'bass-step', 'bass-alter']]) {
          const r = n.child(rt);
          if (!r || !r.child(st)) continue;
          const q = transposePitch({ step: textOf(r, st, 'C'), alter: Number(textOf(r, al, 0)) || 0, octave: 4 }, iv.diatonic, iv.chromatic);
          setText(r.child(st), q.step);
          const a = r.child(al);
          if (q.alter) {
            if (a) setText(a, q.alter);
            else r.children.splice(r.children.indexOf(r.child(st)) + 1, 0, el(al, q.alter));
          } else if (a) removeChildren(r, al);
        }
      }
    }
  }
  setTransposeElement(part, targetSemis);
  // Schlüssel nach dem Tonumfang des Ergebnisses
  const soundNew = sounding.map((s) => s + 12 * octaves);
  let clefId = null;
  if (opts.clef && opts.clef !== 'auto') clefId = opts.clef;
  else if (opts.clef === 'auto' || opts.clef === undefined) clefId = autoClef(target, soundNew, targetSemis, opts.tenorClef !== false);
  if (clefId) setClefRoot(root, clefId, { parts: [part.attrs.id] });
  // Stimmenname
  const list = root.get('part-list');
  const sp = list && list.all('score-part').find((x) => x.attrs.id === part.attrs.id);
  if (sp) {
    const pn = sp.child('part-name');
    if (pn) setText(pn, target.name);
    const pa = sp.child('part-abbreviation');
    if (pa) setText(pa, target.short);
    for (const mi of sp.all('midi-instrument')) {
      const pr = mi.child('midi-program');
      if (pr) setText(pr, target.midiProgram + 1);
    }
  }
  return {
    xml: writeScore(root),
    octaves,
    chromatic: iv.chromatic,
    fifthsBefore: fifths0,
    fifthsAfter: fifths0 + iv.fifthsDelta,
    clef: clefId,
    sourceSemis,
    targetSemis,
    outOfRange: soundNew.filter((v) => v < target.range[0] || v > target.range[1]).length,
    notes: soundNew.length,
  };
}

// Schlüssel nach Lage: Violin-/Bassschlüssel des Instruments; Tenorschlüssel bei hoher Lage (Posaune, Cello …)
export function autoClef(inst, soundingPitches, semis = 0, tenorClef = true) {
  if (!soundingPitches.length) return inst.clef;
  const sorted = [...soundingPitches].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  if (inst.highClef === 'C4' && tenorClef) return median >= 63 && min >= 52 ? 'C4' : inst.clef;
  if (inst.highClef === 'G2') return median >= 74 && min >= 62 ? 'G2' : inst.clef;
  void semis;
  return inst.clef;
}
