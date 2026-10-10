// Homophone Passagen – nur gezielt an Höhepunkten, Fanfaren, Riffs
// und Schlusskadenzen (Regel A: "Homophonie nur als Akzent").
import { mod, clamp } from '../../core/constants.js';
import { colorTones, isDominant } from '../../theory/chords.js';
import { parseRhythm, fitRhythmString } from '../styles.js';
import { ev, addArt, cleanLine, placePc, lofForChordPc, isChordTone } from '../context.js';
import { fitOctave } from '../instruments.js';
import { adaptMelody, articulate } from './melody.js';

// Verfügbare Voicing-Töne (pc + lof) für Akkord, abhängig vom Stil
function voicingTones(chord, styleId, melPc) {
  let tones = chord.tones.map((t) => ({ pc: t.pc, lof: t.lof, role: t.role }));
  const jazzy = styleId === 'funk' || styleId === 'secondline' || styleId === 'swing';
  if (jazzy) {
    const colors = colorTones(chord, styleId);
    const nine = colors.find((c) => c.iv === '9');
    const thirteen = colors.find((c) => c.iv === '13');
    // 9 ersetzt den Grundton (der Bass hat ihn), 13 ersetzt die Quinte bei Dominanten
    if (nine && melPc !== nine.pc) tones = tones.map((t) => (t.role === 'root' ? { ...nine, role: 'tension' } : t));
    if (thirteen && isDominant(chord) && melPc !== thirteen.pc) tones = tones.map((t) => (t.role === 'fifth' ? { ...thirteen, role: 'tension' } : t));
  } else {
    // Klassik: Grundton verdoppeln statt Terz
  }
  return tones;
}

// Close-Voicing unter einer Spitzennote, dann auf Instrumentenlagen verteilen
export function voiceBelow(chord, topMidi, insts, styleId, prevLower = []) {
  const melPc = mod(topMidi, 12);
  const tones = voicingTones(chord, styleId, melPc).filter((t) => t.pc !== melPc);
  const n = insts.length;
  const result = [];
  let cur = topMidi;
  const used = new Set([melPc]);
  for (let k = 0; k < n; k++) {
    // nächster Akkordton unterhalb
    let cand = null;
    for (let m = cur - 1; m >= cur - 12; m--) {
      const t = tones.find((x) => x.pc === mod(m, 12) && !used.has(x.pc));
      if (t) {
        cand = { midi: m, lof: t.lof };
        break;
      }
    }
    if (!cand) {
      // Verdopplung (bevorzugt Grundton/Quinte)
      const dbl = chord.tones.find((t) => t.role === 'root') || chord.tones[0];
      cand = { midi: placePc(dbl.pc, cur - 4, cur - 12, cur - 1), lof: dbl.lof };
    }
    used.add(mod(cand.midi, 12));
    // Instrumentlage einhalten (Drop-Voicing)
    const inst = insts[k];
    let m = cand.midi;
    while (m < inst.comfort[0]) m += 12;
    while (m > inst.comfort[1] + 2) m -= 12;
    // glatte Stimmführung zur vorherigen Lage
    const pl = prevLower[k];
    if (pl !== undefined && pl !== null) {
      const alt = [m - 12, m + 12].filter((x) => x >= inst.comfort[0] && x <= inst.comfort[1] + 2);
      for (const a of alt) if (Math.abs(a - pl) < Math.abs(m - pl) - 4) m = a;
    }
    result.push({ midi: m, lof: cand.lof });
    cur = cand.midi;
  }
  return result;
}

// Tutti: Melodie oben, Mittelstimmen harmonisieren darunter
export function genTutti(ctx, voices, melody, { adapt = 1, octaveUp = false } = {}) {
  const top = voices[0];
  const topInst = ctx.inst[top];
  const fit = fitOctave(melody, topInst, { allowClimax: true, prefer: octaveUp ? 1 : 0 });
  let topLine = cleanLine(melody.map((n) => ev(n.start, n.dur, n.midi + fit.shift, n.lof)));
  topLine = adaptMelody(ctx, topLine, adapt);
  articulate(ctx, topLine, topInst);
  const lowerVoices = voices.slice(1);
  const lowerLines = lowerVoices.map(() => []);
  const insts = lowerVoices.map((v) => ctx.inst[v]);
  let prev = lowerVoices.map((v) => ctx.lastPitch(v, null));
  for (const e of topLine) {
    const chord = ctx.chordAt(e.start);
    const m = e.pitches[0];
    const strong = e.start % ctx.beat === 0;
    const harmonize = isChordTone(chord, m) || e.dur >= ctx.beat || strong;
    if (!lowerLines.length) continue; // nur eine Stimme im Tutti (Duo): Melodie allein
    if (!harmonize && lowerLines[0].length) {
      // Durchgangston: Unterstimmen halten
      for (const l of lowerLines) {
        const last = l[l.length - 1];
        if (last && last.start + last.dur <= e.start + e.dur) last.dur = e.start + e.dur - last.start;
      }
      continue;
    }
    const vc = voiceBelow(chord, m, insts, ctx.style.id, prev);
    vc.forEach((p, k) => {
      const x = ev(e.start, e.dur, p.midi, p.lof);
      x.art = [...e.art.filter((a) => a !== 'tenuto' || e.dur >= ctx.beat)];
      if (e.slurStart) x.slurStart = true;
      if (e.slurEnd) x.slurEnd = true;
      lowerLines[k].push(x);
    });
    prev = vc.map((p) => p.midi);
  }
  const res = {};
  res[top] = topLine;
  lowerVoices.forEach((v, k) => {
    res[v] = cleanLine(lowerLines[k]);
    if (res[v].length) ctx.setLast(v, res[v][res[v].length - 1].pitches[0]);
  });
  if (topLine.length) ctx.setLast(top, topLine[topLine.length - 1].pitches[0]);
  return res;
}

const HIT_PATTERNS = {
  funk: ['X..X..X...X.X-..', 'X.X.X.X.X-......'],
  secondline: ['X..X..X...X.X-..', 'X.X.X.X.X-......'],
  swing: ['X-.x..X-....x-..', 'X-.x..X-..X-....'],
  ballad: ['X-------X-------', 'X---------------'],
  classical: ['X--xX--xX---X---', 'X--xX--xX-------'],
  polka: ['X--xX--xX---X---', 'X--xX--xX---....'],
};

// Tutti-Hits / Fanfaren (homophoner Rhythmus, steigende Spitzenstimme)
export function genHits(ctx, voices, { rising = true } = {}) {
  const pats = (HIT_PATTERNS[ctx.style.id] || HIT_PATTERNS.funk).map((p) => fitRhythmString(p, ctx.steps));
  const top = voices[0];
  const topInst = ctx.inst[top];
  const lineMap = {};
  for (const v of voices) lineMap[v] = [];
  let topP = clamp(ctx.lastPitch(top, topInst.comfort[0] + 7), topInst.comfort[0] + 3, topInst.comfort[1] - 4);
  const bv = ctx.bassVoice ?? 3;
  const hasBass = voices.includes(bv) && ctx.inst[bv].bassCapable;
  const upper = hasBass ? voices.filter((v) => v !== bv) : voices;
  let prevLower = upper.slice(1).map((v) => ctx.lastPitch(v, null));
  for (let bar = 0; bar < ctx.measures; bar++) {
    const isLast = bar === ctx.measures - 1;
    const pat = parseRhythm(pats[isLast ? 1 : 0]);
    for (const hit of pat) {
      const t = bar * ctx.mt + hit.step * 6;
      const d = Math.min(hit.len * 6, ctx.len - t);
      if (d <= 0) continue;
      const chord = ctx.chordAt(t);
      // Spitzenton: nächster Akkordton, bei Build-up steigend
      const tones = chord.tones.map((x) => x.pc);
      let m = topP + (rising ? 1 : 0);
      for (let k = 0; k < 12 && !tones.includes(mod(m, 12)); k++) m++;
      if (m > topInst.comfort[1] + (rising ? 2 : 0)) m = placePc(chord.tones[0].pc, topInst.comfort[1] - 5, topInst.comfort[0], topInst.comfort[1]);
      topP = m;
      const te = ev(t, d, m, lofForChordPc(chord, mod(m, 12), ctx.key));
      if (hit.accent) addArt(te, 'accent');
      if (d <= 6 || hit.short) addArt(te, 'staccato');
      lineMap[top].push(te);
      const lowerInsts = upper.slice(1).map((v) => ctx.inst[v]);
      const vc = voiceBelow(chord, m, lowerInsts, ctx.style.id, prevLower);
      upper.slice(1).forEach((v, k) => {
        const x = ev(t, d, vc[k].midi, vc[k].lof);
        x.art = [...te.art];
        lineMap[v].push(x);
      });
      prevLower = vc.map((p) => p.midi);
      if (hasBass) {
        const bi = ctx.inst[bv];
        const root = placePc(chord.bassPc ?? chord.rootPc, ctx.lastPitch(bv, bi.comfort[0] + 7), bi.range[0], bi.comfort[0] + 14);
        const be = ev(t, d, root, chord.bassLof ?? chord.rootLof);
        be.art = [...te.art];
        lineMap[bv].push(be);
        ctx.setLast(bv, root);
      }
    }
  }
  for (const v of voices) {
    lineMap[v] = cleanLine(lineMap[v]);
    const l = lineMap[v];
    if (l.length) ctx.setLast(v, l[l.length - 1].pitches[0]);
  }
  return lineMap;
}

// Riff (Send-off / Interlude): wiederholtes 1-Takt-Motiv, harmonisiert
export function genRiff(ctx, voices) {
  const riffs = ctx.style.comp.riffs.map((p) => fitRhythmString(p, ctx.steps));
  const pat = parseRhythm(riffs[ctx.rng.int(0, riffs.length - 1)]);
  const top = voices[0];
  const ti = ctx.inst[top];
  const center = Math.round(ti.comfort[0] + (ti.comfort[1] - ti.comfort[0]) * 0.6);
  // Kontur in Skalenschritten relativ zum Startakkordton
  const contour = pat.map((_, k) => [0, 2, 1, 3, 2, 4, 1, 0][k % 8]);
  const lineMap = {};
  for (const v of voices) lineMap[v] = [];
  let prevLower = voices.slice(1).map((v) => ctx.lastPitch(v, null));
  for (let bar = 0; bar < ctx.measures; bar++) {
    const chord0 = ctx.chordAt(bar * ctx.mt);
    const tonesSorted = [];
    for (let m = center - 7; m <= center + 9; m++) if (chord0.tones.some((t) => t.pc === mod(m, 12))) tonesSorted.push(m);
    pat.forEach((hit, k) => {
      const t = bar * ctx.mt + hit.step * 6;
      const d = Math.min(hit.len * 6, ctx.len - t);
      if (d <= 0) return;
      const chord = ctx.chordAt(t);
      let m = tonesSorted[Math.min(tonesSorted.length - 1, 1 + contour[k])] ?? center;
      if (!isChordTone(chord, m)) m = placePc(chord.tones[1]?.pc ?? chord.rootPc, m, ti.comfort[0], ti.comfort[1]);
      const te = ev(t, d, m, lofForChordPc(chord, mod(m, 12), ctx.key));
      if (hit.accent) addArt(te, 'accent');
      if (hit.short || d <= 6) addArt(te, 'staccato');
      lineMap[top].push(te);
      const vc = voiceBelow(chord, m, voices.slice(1).map((v) => ctx.inst[v]), ctx.style.id, prevLower);
      voices.slice(1).forEach((v, j) => {
        const x = ev(t, d, vc[j].midi, vc[j].lof);
        x.art = [...te.art];
        lineMap[v].push(x);
      });
      prevLower = vc.map((p) => p.midi);
    });
  }
  for (const v of voices) {
    lineMap[v] = cleanLine(lineMap[v]);
    const l = lineMap[v];
    if (l.length) ctx.setLast(v, l[l.length - 1].pitches[0]);
  }
  return lineMap;
}

// Schlussakkord(e) – stilabhängig gehalten oder als kurzer "Button"
export function genFinal(ctx, voices) {
  const st = ctx.style.id;
  const chord = ctx.chordAt(0);
  const lineMap = {};
  const top = voices[0];
  const ti = ctx.inst[top];
  const climax = st !== 'ballad';
  const topTarget = climax ? Math.min(ti.range[1] - 2, ti.comfort[1] + 2) : ti.comfort[1] - 5;
  // Spitzenton: Grundton/Terz/9 nahe Zielhöhe
  const topRoles = st === 'funk' || st === 'secondline' || st === 'swing' ? ['root', 'tension', 'third'] : ['root', 'third', 'fifth'];
  const cands = [];
  for (const t of [...chord.tones, ...chord.tens]) if (topRoles.includes(t.role)) cands.push(t);
  let best = null;
  for (const t of cands) {
    const m = placePc(t.pc, topTarget, ti.comfort[0], ti.range[1] - 1);
    if (!best || Math.abs(m - topTarget) < Math.abs(best.midi - topTarget)) best = { midi: m, lof: t.lof };
  }
  const bv = ctx.bassVoice ?? 3;
  const hasBass = voices.includes(bv) && ctx.inst[bv].bassCapable;
  const upper = hasBass ? voices.filter((v) => v !== bv) : voices;
  const vc = voiceBelow(chord, best.midi, upper.slice(1).map((v) => ctx.inst[v]), st, upper.slice(1).map((v) => ctx.lastPitch(v, null)));
  const pitches = { [top]: best };
  upper.slice(1).forEach((v, k) => (pitches[v] = vc[k]));
  if (hasBass) {
    const bi = ctx.inst[bv];
    pitches[bv] = { midi: placePc(chord.rootPc, bi.comfort[0] + 3, bi.range[0], bi.comfort[0] + 12), lof: chord.rootLof };
  }
  const mt = ctx.mt;
  for (const v of voices) {
    const p = pitches[v];
    const l = [];
    if (st === 'funk' || st === 'secondline' || st === 'swing' || st === 'polka') {
      // Takt 1: lang gehalten (Crescendo), Takt 2: kurzer Schluss-Hit
      const hold = ev(0, mt - (ctx.beat / 2), p.midi, p.lof);
      hold.finalHold = true;
      l.push(hold);
      const hit = ev(mt, ctx.beat / 2, p.midi, p.lof);
      addArt(hit, 'accent');
      addArt(hit, 'staccato');
      hit.finalHit = true;
      l.push(hit);
    } else {
      const hold = ev(0, mt * 2, p.midi, p.lof);
      hold.finalHold = true;
      hold.fermata = true;
      l.push(hold);
    }
    lineMap[v] = l;
  }
  return lineMap;
}
