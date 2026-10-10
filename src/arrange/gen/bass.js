// Bass-Fundament: Funk-Riffs (Sousaphon-Stil), Walking Bass, Balladen-Bass,
// klassische Bassführung (mit Umkehrungen & Gegenbewegung), Oom-pah (Polka).
import { mod, clamp } from '../../core/constants.js';
import { toneByRole, isMinorish } from '../../theory/chords.js';
import { ev, addArt, placePc, scaleStep, cleanLine, melodyDirection, lofForChordPc } from '../context.js';

function bassRange(inst) {
  // Fundament im unteren Kernbereich, aber ohne Hilfslinien-Berge
  const lo = Math.max(inst.range[0], inst.comfort[0]);
  const hi = Math.min(inst.comfort[1] - 3, inst.comfort[0] + 20);
  const center = clamp(inst.comfort[0] + 9, lo + 4, hi - 6);
  return { lo, hi, center };
}

function rootChoice(chord, prev, lo, hi, center, melDir) {
  const pc = chord.bassPc ?? chord.rootPc;
  let best = null;
  for (let m = lo; m <= hi; m++) {
    if (mod(m, 12) !== pc) continue;
    let cost = Math.abs(m - prev) + Math.abs(m - center) * 0.35;
    if (melDir > 0 && m > prev) cost += 3; // Gegenbewegung bevorzugen
    if (melDir < 0 && m < prev) cost += 3;
    if (!best || cost < best.cost) best = { m, cost };
  }
  return best ? best.m : placePc(pc, center, lo, hi);
}

function intervalOf(chord, role, def) {
  const t = toneByRole(chord, role);
  return t ? mod(t.pc - chord.rootPc, 12) : def;
}

function resolveToken(tok, chord, nextChord, root, lo, hi, key, ctx, t) {
  const r = root;
  let m;
  let lof = null;
  switch (tok) {
    case 'R':
      m = r;
      lof = chord.bassLof ?? chord.rootLof;
      break;
    case 'R8':
      m = r + 12 <= hi + 5 ? r + 12 : r;
      lof = chord.rootLof;
      break;
    case '5':
      m = r + intervalOf(chord, 'fifth', 7);
      break;
    case '5-':
      m = r + intervalOf(chord, 'fifth', 7) - 12;
      if (m < lo) m += 12;
      break;
    case '3':
      m = r + intervalOf(chord, 'third', 4);
      break;
    case '6':
      m = r + 9;
      break;
    case 'b7': {
      const sev = toneByRole(chord, 'seventh');
      let iv = sev ? mod(sev.pc - chord.rootPc, 12) : 10;
      if (iv === 9 && !isMinorish(chord) && chord.kind === 'major-sixth') iv = 9;
      if (!sev && (ctx.style.id === 'classical' || ctx.style.id === 'polka')) iv = 7;
      m = r + iv;
      break;
    }
    case 'A':
    case 'Ab': {
      const target = nextChord ? (nextChord.bassPc ?? nextChord.rootPc) : chord.rootPc;
      let tm = placePc(target, r, lo, hi);
      if (tm === r && nextChord && nextChord.rootPc === chord.rootPc) {
        // gleicher Akkord: Quinte unten als Durchgang
        m = r + intervalOf(chord, 'fifth', 7) - 12 >= lo ? r - 5 : r + 7;
        break;
      }
      m = tok === 'A' ? tm - 1 : tm + 1;
      if (m < lo) m = tm + 1;
      if (m > hi + 5) m = tm - 1;
      break;
    }
    case 'S': {
      const target = nextChord ? (nextChord.bassPc ?? nextChord.rootPc) : chord.rootPc;
      const tm = placePc(target, r, lo, hi);
      const scale = ctx.scaleAt(t);
      m = scaleStep(tm, tm > r ? -1 : 1, scale);
      break;
    }
    default:
      m = r;
  }
  while (m < lo) m += 12;
  while (m > hi + 7) m -= 12;
  if (lof === null) lof = lofForChordPc(chord, mod(m, 12), key);
  return { m, lof };
}

export function genBass(ctx, v, opts = {}) {
  const kind = opts.kind || ctx.style.bass.kind;
  if (kind === 'riff') return riffBass(ctx, v, opts);
  if (kind === 'walk') return walkingBass(ctx, v, opts);
  if (kind === 'ballad') return balladBass(ctx, v, opts);
  if (kind === 'classical') return classicalBass(ctx, v, opts);
  if (kind === 'oompah') return oompahBass(ctx, v, opts);
  return riffBass(ctx, v, opts);
}

function nextChordAfter(ctx, t) {
  for (const c of ctx.chords) if (c.start > t) return c.chord;
  return ctx.nextBlockChord || ctx.chordAt(ctx.len - 1);
}

function riffBass(ctx, v, opts) {
  const inst = ctx.inst[v];
  const { lo, hi, center } = bassRange(inst);
  const st = ctx.style.bass;
  const steps = ctx.steps;
  const fast = ctx.tempo >= 116;
  const slow = ctx.tempo <= 84;
  let pool = (fast && st.riffsFast) || (slow && st.riffsSlow) || st.riffs;
  const main = opts.riff ?? ctx.blockRiff ?? ctx.rng.int(0, pool.length - 1);
  ctx.blockRiff = main;
  const alt = (main + 1) % pool.length;
  const out = [];
  let prevRoot = ctx.lastPitch(v, center);
  const mel = ctx.melodyLine || [];
  for (let bar = 0; bar < ctx.measures; bar++) {
    const barStart = bar * ctx.mt;
    const phraseEnd = (bar + 1) % 4 === 0;
    let pat = pool[phraseEnd && pool.length > 1 && ctx.rng.chance(0.5) ? alt : main % pool.length];
    if (steps !== 16) pat = adaptPattern(pat, steps);
    let lastChord = null;
    let root = prevRoot;
    for (const [step, len, tok, art] of pat) {
      if (ctx.intensity < 0.35 && ![0, 6, 8, 14].includes(step) && step < steps - 2) continue;
      const t = barStart + step * 6;
      if (t >= ctx.len) continue;
      const chord = ctx.chordAt(t);
      if (chord !== lastChord) {
        const dir = melodyDirection(mel, t - ctx.beat, t + ctx.beat);
        root = rootChoice(chord, prevRoot, lo, hi - 7, center, dir);
        lastChord = chord;
        prevRoot = root;
      }
      // Akkordwechsel innerhalb der Note -> kürzen
      let dur = len * 6;
      for (const c of ctx.chords) if (c.start > t && c.start < t + dur) dur = c.start - t;
      const nextChord = nextChordAfter(ctx, t);
      const r = resolveToken(tok, chord, nextChord, root, lo, hi, ctx.key, ctx, t);
      const e = ev(t, dur, r.m, r.lof);
      if (art === 'acc') addArt(e, 'accent');
      if (art === 'st') addArt(e, 'staccato');
      out.push(e);
    }
  }
  const line = cleanLine(out);
  if (line.length) ctx.setLast(v, prevRoot);
  return line;
}

function adaptPattern(pat, steps) {
  const out = pat.filter(([s]) => s < steps - 2).map(([s, l, t, a]) => [s, Math.min(l, steps - s), t, a]);
  out.push([steps - 2, 2, 'A', '']);
  return out;
}

function walkingBass(ctx, v, opts) {
  const inst = ctx.inst[v];
  const { lo, hi, center } = bassRange(inst);
  const beat = ctx.beat;
  const out = [];
  let prev = ctx.lastPitch(v, center);
  const twoFeel = opts.twoFeel ?? ctx.intensity < 0.45;
  const mel = ctx.melodyLine || [];
  for (let ci = 0; ci < ctx.chords.length; ci++) {
    const seg = ctx.chords[ci];
    const chord = seg.chord;
    const next = ctx.chords[ci + 1]?.chord || ctx.nextBlockChord || chord;
    const segBeats = Math.max(1, Math.round(seg.dur / beat));
    const dir = melodyDirection(mel, seg.start, seg.start + seg.dur);
    const root = rootChoice(chord, prev, lo, hi - 5, center, dir);
    const nextRootPc = next.bassPc ?? next.rootPc;
    if (twoFeel) {
      const halfBeats = Math.max(1, Math.floor(segBeats / 2));
      for (let b = 0; b < segBeats; b += halfBeats) {
        const t = seg.start + b * beat;
        const d = Math.min(halfBeats, segBeats - b) * beat;
        let m = root;
        let lof = chord.bassLof ?? chord.rootLof;
        if (b > 0) {
          const fifth = toneByRole(chord, 'fifth');
          m = root + (fifth ? mod(fifth.pc - chord.rootPc, 12) : 7);
          if (m > hi) m -= 12;
          lof = fifth ? fifth.lof : null;
          if (b + halfBeats >= segBeats && ctx.rng.chance(0.4)) {
            const tm = placePc(nextRootPc, root, lo, hi);
            m = tm + (tm > root ? -1 : 1);
            lof = null;
          }
        }
        out.push(ev(t, d, m, lof));
        prev = m;
      }
      continue;
    }
    // Walking: Viertel
    let cur = root;
    const targetNext = placePc(nextRootPc, root + (ctx.rng.chance(0.5) ? 3 : -3), lo, hi);
    let direction = targetNext >= root ? 1 : -1;
    const scale = ctx.scaleAt(seg.start);
    for (let b = 0; b < segBeats; b++) {
      const t = seg.start + b * beat;
      let m;
      let lof = null;
      if (b === 0) {
        m = root;
        lof = chord.bassLof ?? chord.rootLof;
      } else if (b === segBeats - 1) {
        // Annäherung an nächsten Grundton
        const r = ctx.rng.next();
        if (r < 0.55) m = targetNext + (targetNext > cur ? -1 : 1);
        else if (r < 0.8) m = scaleStep(targetNext, targetNext > cur ? -1 : 1, scale);
        else m = targetNext + 7 > hi ? targetNext - 5 : targetNext + 7;
      } else {
        const r = ctx.rng.next();
        if (r < 0.45) {
          // Akkordton in Bewegungsrichtung
          const tones = chord.tones.map((x) => x.pc);
          let mm = cur + direction;
          for (let k = 0; k < 12 && !tones.includes(mod(mm, 12)); k++) mm += direction;
          m = mm;
        } else m = scaleStep(cur, direction, scale);
      }
      if (m > hi) {
        m -= 12;
        direction = -1;
      }
      if (m < lo) {
        m += 12;
        direction = 1;
      }
      const e = ev(t, beat, m, lof);
      out.push(e);
      cur = m;
    }
    prev = root;
  }
  const line = cleanLine(out);
  if (line.length) ctx.setLast(v, line[line.length - 1].pitches[0]);
  return line;
}

function balladBass(ctx, v) {
  const inst = ctx.inst[v];
  const { lo, hi, center } = bassRange(inst);
  const out = [];
  let prev = ctx.lastPitch(v, center);
  const mel = ctx.melodyLine || [];
  const busy = ctx.intensity >= 0.6;
  for (let ci = 0; ci < ctx.chords.length; ci++) {
    const seg = ctx.chords[ci];
    const chord = seg.chord;
    const next = ctx.chords[ci + 1]?.chord || ctx.nextBlockChord;
    const dir = melodyDirection(mel, seg.start, seg.start + seg.dur);
    const root = rootChoice(chord, prev, lo, hi - 5, center, dir);
    const lofR = chord.bassLof ?? chord.rootLof;
    // in Takte zerlegen
    let t = seg.start;
    const end = seg.start + seg.dur;
    while (t < end) {
      const barEnd = (Math.floor(t / ctx.mt) + 1) * ctx.mt;
      const d = Math.min(barEnd, end) - t;
      const isLastPiece = Math.min(barEnd, end) === end;
      if (busy && d >= ctx.beat * 3) {
        out.push(ev(t, ctx.beat * 1.5, root, lofR));
        const fifth = toneByRole(chord, 'fifth');
        out.push(ev(t + ctx.beat * 1.5, ctx.beat / 2, root + (fifth ? mod(fifth.pc - chord.rootPc, 12) : 7), fifth?.lof ?? null));
        out.push(ev(t + ctx.beat * 2, d - ctx.beat * 2, root, lofR));
      } else if (isLastPiece && next && d >= ctx.beat * 2 && ctx.rng.chance(0.5)) {
        // Durchgang zum nächsten Akkord
        const tm = placePc(next.bassPc ?? next.rootPc, root, lo, hi);
        const scale = ctx.scaleAt(t);
        out.push(ev(t, d - ctx.beat, root, lofR));
        const pass = Math.abs(tm - root) <= 2 ? root : scaleStep(tm, tm > root ? -1 : 1, scale);
        out.push(ev(t + d - ctx.beat, ctx.beat, pass, null));
      } else out.push(ev(t, d, root, lofR));
      t += d;
    }
    prev = root;
  }
  const line = cleanLine(out);
  if (line.length) ctx.setLast(v, prev);
  return line;
}

function classicalBass(ctx, v) {
  const inst = ctx.inst[v];
  const { lo, hi, center } = bassRange(inst);
  const out = [];
  let prev = ctx.lastPitch(v, center);
  const mel = ctx.melodyLine || [];
  const moving = ctx.intensity >= 0.5;
  for (let ci = 0; ci < ctx.chords.length; ci++) {
    const seg = ctx.chords[ci];
    const chord = seg.chord;
    const next = ctx.chords[ci + 1]?.chord || ctx.nextBlockChord;
    const isCadence = !ctx.chords[ci + 1] || (next && mod(chord.rootPc - next.rootPc, 12) === 7);
    const dir = melodyDirection(mel, seg.start, seg.start + seg.dur);
    // Grundstellung oder Sextakkord (Terz im Bass) – glattere Linie gewinnt
    const rootM = rootChoice(chord, prev, lo, hi - 5, center, dir);
    let bassM = rootM;
    let bassLof = chord.bassLof ?? chord.rootLof;
    const third = toneByRole(chord, 'third');
    if (!isCadence && third && chord.bassPc === null) {
      const thirdM = placePc(third.pc, prev, lo, hi - 5);
      const costR = Math.abs(rootM - prev) + (dir > 0 && rootM > prev ? 2 : 0);
      const costT = Math.abs(thirdM - prev) + 1.5 + (dir > 0 && thirdM > prev ? 2 : 0);
      if (costT < costR && ctx.rng.chance(0.6)) {
        bassM = thirdM;
        bassLof = third.lof;
      }
    }
    const beats = Math.max(1, Math.round(seg.dur / ctx.beat));
    if (moving && beats >= 2 && next) {
      // Viertel-Bewegung mit diatonischen Durchgängen
      const tm = placePc(next.bassPc ?? next.rootPc, bassM, lo, hi);
      const scale = ctx.scaleAt(seg.start);
      let cur = bassM;
      for (let b = 0; b < beats; b++) {
        const t = seg.start + b * ctx.beat;
        let m = cur;
        if (b === 0) m = bassM;
        else {
          const remaining = beats - b;
          const dist = tm - cur;
          if (Math.abs(dist) > remaining) m = scaleStep(cur, Math.sign(dist) || 1, scale);
          else if (Math.abs(dist) > 0 && remaining === 1) m = scaleStep(cur, Math.sign(dist), scale);
          else {
            const c5 = toneByRole(chord, 'fifth');
            m = c5 ? placePc(c5.pc, cur, lo, hi) : cur;
          }
        }
        out.push(ev(t, ctx.beat, m, b === 0 ? bassLof : null));
        cur = m;
      }
    } else {
      out.push(ev(seg.start, seg.dur, bassM, bassLof));
    }
    prev = bassM;
  }
  const line = cleanLine(out);
  if (line.length) ctx.setLast(v, prev);
  return line;
}

function oompahBass(ctx, v) {
  const inst = ctx.inst[v];
  const { lo, hi, center } = bassRange(inst);
  const out = [];
  let prev = ctx.lastPitch(v, center);
  const steps = ctx.steps;
  const beat = ctx.beat;
  for (let bar = 0; bar < ctx.measures; bar++) {
    const b0 = bar * ctx.mt;
    const chord = ctx.chordAt(b0);
    const root = rootChoice(chord, prev, lo, hi - 7, center, 0);
    prev = root;
    const fifth = toneByRole(chord, 'fifth');
    const f = fifth ? mod(fifth.pc - chord.rootPc, 12) : 7;
    const fifthBelow = root + f - 12 >= lo ? root + f - 12 : root + f;
    const lofR = chord.bassLof ?? chord.rootLof;
    const phraseEnd = (bar + 1) % 4 === 0 && bar < ctx.measures - 1;
    if (phraseEnd && steps >= 8) {
      // Basslauf zum nächsten Grundton
      const nextChord = ctx.chordAt(b0 + ctx.mt);
      const tm = placePc(nextChord.bassPc ?? nextChord.rootPc, root, lo, hi);
      const n = steps === 8 ? 4 : steps === 12 ? 3 : 4;
      const d = ctx.mt / n;
      const scale = ctx.scaleAt(b0);
      const dir = tm >= root ? 1 : -1;
      let cur = root;
      const pitches = [root];
      for (let k = 1; k < n; k++) {
        cur = scaleStep(cur, dir, scale);
        pitches.push(cur);
      }
      // so verschieben, dass der Lauf schrittweise im Zielton landet
      const last = pitches[pitches.length - 1];
      const off = scaleStep(tm, -dir, scale) - last;
      if (Math.abs(off) <= 4) for (let k = 1; k < n; k++) pitches[k] += off;
      pitches.forEach((p, k) => {
        const e = ev(b0 + k * d, d, clamp(p, lo, hi + 5), k === 0 ? lofR : null);
        if (k === 0) addArt(e, 'accent');
        out.push(e);
      });
      continue;
    }
    // Oom-pah: Grundton / Quinte
    const hits = steps === 12 ? [0] : steps === 8 ? [0, 1] : [0, 2];
    hits.forEach((h, k) => {
      const t = b0 + h * beat;
      const chordHere = ctx.chordAt(t);
      const rr = chordHere === chord ? root : rootChoice(chordHere, root, lo, hi - 7, center, 0);
      // Wechselbass: Grundton auf 1, Quinte (unten) auf der nächsten Schwerpunktzeit
      const m = k === 0 ? (chordHere === chord ? root : rr) : chordHere === chord ? fifthBelow : rr;
      const e = ev(t, beat, m, m === root ? lofR : null);
      if (ctx.tempo >= 100) addArt(e, 'staccato');
      out.push(e);
    });
  }
  const line = cleanLine(out);
  if (line.length) ctx.setLast(v, prev);
  return line;
}
