// Nachbearbeitung & Qualitätsprüfung:
//  - Tonumfang-Garantie
//  - Bewegungs-Regel (lange Melodietöne -> Bewegung in Mittelstimmen)
//  - Quint-/Oktavparallelen erkennen & korrigieren
//  - Atempausen für Bläser
//  - Spezialeffekte (Fall-off, Scoop, Doit, Posaunen-Glissando mit Zugphysik,
//    Horn-Rip & gestopft, Trompeten-Shake, Dämpfer, Pizzicato/Bogenstriche, Doppelgriffe)
//  - Dynamik & Hairpins
//  - Rechtschreibung (Vorzeichen) aller Töne
import { mod, dynShift } from '../core/constants.js';
import { chordAt } from '../model/song.js';
import { keyCenter, lofNear } from '../theory/pitch.js';
import { chordScale } from '../theory/chords.js';
import { meterInfo, singleValueDur } from '../output/notation.js';
import { fxAllowed } from './difficulty.js';
import { slideGlissPossible, trombonePartialFor, doubleStopPossible, mutes, isWind, hasFx } from './instruments.js';
import { ev, addArt, addFx, chordToneNear, lofForChordPc, isChordTone, cleanLine } from './context.js';

const LEAD_ROLES = new Set(['melody', 'solo', 'hook', 'subject']);
const PRIORITY = { melody: 9, solo: 9, hook: 8, subject: 8, tutti: 7, hits: 6, final: 6, riff: 6, bass: 5, counter: 4, fill: 2, comp: 3, stabs: 3, pad: 2, background: 2 };

export function keyAtFactory(blocks, mt, grid = null) {
  return (t) => {
    let k = blocks[0].key;
    for (const b of blocks) if ((grid ? grid.start(b.startBar) : b.startBar * mt) <= t) k = b.key;
    return k;
  };
}

// ---------- Tonumfang ----------------------------------------------------------
export function enforceRange(line, inst, report) {
  const fit = (m) => {
    let x = m;
    while (x < inst.range[0]) x += 12;
    while (x > inst.range[1]) x -= 12;
    if (x < inst.range[0]) x = inst.range[0]; // nur bei extrem engem Umfang
    return x;
  };
  for (const e of line) {
    e.pitches = e.pitches.map((m) => {
      const x = fit(m);
      if (x !== m) report.rangeFixes++;
      return x;
    });
    e.pitches = [...new Set(e.pitches)];
    if (e.lofs && e.lofs.length > e.pitches.length) e.lofs = e.lofs.slice(0, e.pitches.length);
    if (e.grace) {
      while (e.grace.midi < inst.range[0]) e.grace.midi += 12;
      while (e.grace.midi > inst.range[1]) e.grace.midi -= 12;
    }
  }
}

// ---------- Bewegungs-Regel ---------------------------------------------------
export function ensureMovement(arr, report) {
  const { voices, blocks, mt, chordTrack } = arr;
  const beat = arr.beat;
  for (const b of blocks) {
    if (!['theme', 'recap', 'variation', 'trio'].includes(b.type)) continue;
    const a0 = b.startBar * mt;
    const a1 = a0 + b.measures * mt;
    const roles = b.segments[0].roles;
    const lead = roles.findIndex((r) => r === 'melody');
    if (lead < 0) continue;
    const helpers = roles.map((r, i) => ({ r, i })).filter((x) => ['counter', 'fill', 'comp', 'pad'].includes(x.r));
    for (const e of voices[lead].events) {
      if (e.start < a0 || e.start >= a1 || e.dur < beat * 2) continue;
      const s = e.start + 1;
      const f = e.start + e.dur;
      report.longNotes++;
      const moving = helpers.some((h) => voices[h.i].events.some((x) => x.start >= s && x.start < f));
      if (moving) {
        report.longNotesCovered++;
        continue;
      }
      // Fill-In injizieren: Arpeggio in Achteln in der ersten Helferstimme
      const h = helpers[0];
      if (!h) continue;
      const line = voices[h.i];
      const inst = line.inst;
      const t0 = e.start + beat;
      const n = Math.min(4, Math.floor((f - t0) / (beat / 2)));
      if (n < 2) continue;
      const chord = chordAt(chordTrack, t0);
      const prevEv = line.events.filter((x) => x.start < t0).slice(-1)[0];
      let cur = prevEv ? prevEv.pitches[0] : Math.round((inst.comfort[0] + inst.comfort[1]) / 2);
      const hi = Math.min(inst.comfort[1], e.pitches[0] - 3);
      const lo = inst.comfort[0];
      if (hi - lo < 5) continue;
      const fig = [];
      for (let k = 0; k < n; k++) {
        const c = chordToneNear(chord, cur + (k % 2 ? -3 : 4), lo, hi, { exclude: [cur] });
        const x = ev(t0 + (k * beat) / 2, beat / 2, c.midi, c.lof);
        x.role = h.r;
        x.injected = true;
        fig.push(x);
        cur = c.midi;
      }
      // vorhandene Liegetöne an der Stelle kürzen
      const ta = fig[0].start;
      const tb = fig[fig.length - 1].start + fig[fig.length - 1].dur;
      const kept = [];
      for (const x of line.events) {
        if (x.start + x.dur <= ta || x.start >= tb) kept.push(x);
        else if (x.start < ta) kept.push({ ...x, dur: ta - x.start });
        else if (x.start + x.dur > tb && x.start + x.dur - tb >= beat) kept.push({ ...x, start: tb, dur: x.start + x.dur - tb });
      }
      line.events = cleanLine([...kept, ...fig]);
      report.longNotesCovered++;
      report.fillsInjected++;
    }
  }
}

// ---------- Parallelen ------------------------------------------------------
function attackMap(line) {
  const m = new Map();
  for (const e of line.events) m.set(e.start, e);
  return m;
}

export function fixParallels(arr, report) {
  const { voices, blocks, mt, chordTrack } = arr;
  const strictAll = arr.style.strict;
  for (const b of blocks) {
    const a0 = b.startBar * mt;
    const a1 = a0 + b.measures * mt;
    // Paare bestimmen
    const pairs = [];
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++) {
        const outer = (i === 0 && j === 3) || voices[i].events.some((e) => e.start >= a0 && e.start < a1 && LEAD_ROLES.has(e.role)) && j === 3;
        if (strictAll || outer) pairs.push([i, j]);
      }
    for (const [i, j] of pairs) {
      const A = voices[i].events.filter((e) => e.start >= a0 && e.start < a1);
      const Bm = attackMap({ events: voices[j].events.filter((e) => e.start >= a0 && e.start < a1) });
      let prev = null;
      for (const ea of A) {
        const eb = Bm.get(ea.start);
        if (!eb) {
          prev = null;
          continue;
        }
        if (prev) {
          const [pa, pb] = prev;
          const i1 = mod(pa.pitches[0] - pb.pitches[0], 12);
          const i2 = mod(ea.pitches[0] - eb.pitches[0], 12);
          const da = ea.pitches[0] - pa.pitches[0];
          const db = eb.pitches[0] - pb.pitches[0];
          const perfect = (x) => x === 0 || x === 7;
          if (perfect(i1) && i1 === i2 && da !== 0 && db !== 0 && Math.sign(da) === Math.sign(db)) {
            report.parallelsFound++;
            // Stimme mit niedrigerer Priorität anpassen
            const pa_ = PRIORITY[ea.role] ?? 3;
            const pb_ = PRIORITY[eb.role] ?? 3;
            const target = pa_ >= pb_ ? eb : ea;
            const other = target === eb ? ea : eb;
            const prevT = target === eb ? pb : pa;
            const prevO = target === eb ? pa : pb;
            const inst = voices[target === eb ? j : i].inst;
            const chord = chordAt(chordTrack, target.start);
            let fixed = false;
            const cands = [];
            for (const t of chord.tones) for (let m = inst.range[0]; m <= inst.range[1]; m++) if (mod(m, 12) === t.pc) cands.push({ m, lof: t.lof, role: t.role });
            cands.sort((x, y) => Math.abs(x.m - target.pitches[0]) - Math.abs(y.m - target.pitches[0]));
            for (const c of cands) {
              if (Math.abs(c.m - target.pitches[0]) > 5) break;
              if (c.m === target.pitches[0]) continue;
              if (target.role === 'bass' && c.role !== 'root' && c.role !== 'third' && c.role !== 'fifth') continue;
              const ni = mod(other.pitches[0] - c.m, 12);
              const pi = mod(prevO.pitches[0] - prevT.pitches[0], 12);
              const stillPar = perfect(ni) && ni === pi && Math.sign(c.m - prevT.pitches[0]) === Math.sign(other.pitches[0] - prevO.pitches[0]);
              if (stillPar) continue;
              target.pitches = [c.m];
              target.lofs = [c.lof];
              fixed = true;
              break;
            }
            if (fixed) report.parallelsFixed++;
          }
        }
        prev = [ea, eb];
      }
    }
  }
}

// ---------- Atmung --------------------------------------------------------
export function insertBreaths(line, inst, tempo, report, factor = 1) {
  if (!isWind(inst)) return;
  const sec = 60 / tempo / 24; // Sekunden pro Tick
  const maxTicks = (inst.breath * factor) / sec;
  const minGap = Math.max(6, Math.round(0.22 / sec / 6) * 6);
  const evs = line.events;
  let runStart = evs.length ? evs[0].start : 0;
  let lastIdx = 0;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const prev = evs[i - 1];
    if (prev && e.start - (prev.start + prev.dur) >= minGap) {
      runStart = e.start;
      lastIdx = i;
    }
    const end = e.start + e.dur;
    if (end - runStart > maxTicks) {
      // besten Atempunkt im aktuellen Lauf suchen: langer Ton, endet auf Zählzeit
      let best = null;
      // bevorzugt eine Note VOR dem aktuellen Ton kürzen (damit vor ihm geatmet wird)
      for (let k = Math.max(lastIdx, i - 16); k <= i; k++) {
        const c = evs[k];
        const cEnd = c.start + c.dur;
        if (cEnd - runStart < maxTicks * 0.2 && k < i) continue;
        if (c.dur < minGap * 2 || c.tieToNext) continue;
        const score = c.dur + (cEnd % 24 === 0 ? 12 : 0) + (c.role && LEAD_ROLES.has(c.role) ? 0 : 6) + (k < i ? 1000 : 0);
        if (!best || score > best.score) best = { k, score };
      }
      const k = best ? best.k : i;
      const c = evs[k];
      const cut = Math.min(minGap, Math.floor(c.dur / 2 / 6) * 6 || 6);
      if (c.dur > cut) {
        c.dur -= cut;
        c.breathAfter = LEAD_ROLES.has(c.role);
        report.breaths++;
        runStart = c.start + c.dur + cut;
        lastIdx = k + 1;
      } else {
        runStart = end;
      }
    }
  }
}

// ---------- Effekte ----------------------------------------------------------
function phrasesOfEvents(events, gap = 12) {
  const out = [];
  let cur = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const p = events[i - 1];
    if (p && e.start - (p.start + p.dur) >= gap) {
      out.push(cur);
      cur = [];
    }
    cur.push(e);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function decorate(arr, report) {
  const { voices, style, rng, mt, blocks } = arr;
  const rate = style.fxRate;
  const jazzy = style.id === 'funk' || style.id === 'secondline' || style.id === 'swing';
  for (let v = 0; v < voices.length; v++) {
    const line = voices[v];
    const inst = line.inst;
    const lv = arr.levels ? arr.levels[v] : null;
    const ok = (fx) => fxAllowed(lv, fx);
    const evs = line.events;
    const brassy = inst.family === 'brass' || inst.family === 'sax';
    let lastGliss = -Infinity;
    // Phrasen-Effekte
    for (const ph of phrasesOfEvents(evs)) {
      const first = ph[0];
      const last = ph[ph.length - 1];
      const leadish = (e) => LEAD_ROLES.has(e.role) || e.role === 'tutti';
      if (ok('falloff') && brassy && jazzy && leadish(last) && last.dur >= arr.beat && !last.fermata && rng.chance(rate * 0.45)) {
        addFx(last, 'falloff');
        report.fx.falloff++;
      } else if (ok('doit') && brassy && jazzy && leadish(last) && last.dur <= 12 && last.art.includes('accent') && hasFx(inst, 'doit') && rng.chance(rate * 0.2)) {
        addFx(last, 'doit');
        report.fx.doit++;
      }
      if (ok('scoop') && (inst.family === 'sax' || inst.id === 'trombone' || (jazzy && brassy)) && leadish(first) && first.dur >= arr.beat && style.id !== 'classical' && style.id !== 'polka' && rng.chance(rate * 0.3)) {
        addFx(first, 'scoop');
        report.fx.scoop++;
      }
    }
    // Posaunen-Glissando (nur physikalisch mögliche Züge auf demselben Teilton)
    if (ok('gliss') && hasFx(inst, 'gliss') && inst.family === 'brass') {
      for (let i = 0; i < evs.length - 1; i++) {
        const a = evs[i];
        const b = evs[i + 1];
        if (a.start + a.dur !== b.start) continue;
        const iv = Math.abs(b.pitches[0] - a.pitches[0]);
        if (iv < 3 || iv > 6 || a.dur < 12) continue;
        if (!['melody', 'solo', 'counter', 'hook', 'tutti'].includes(a.role)) continue;
        if (a.start - lastGliss < mt * 2) continue;
        if (!slideGlissPossible(a.pitches[0], b.pitches[0], inst)) continue;
        if (!rng.chance(rate * 0.4 + (a.role === 'solo' ? 0.15 : 0))) continue;
        addFx(a, 'glissStart');
        addFx(b, 'glissStop');
        lastGliss = a.start;
        report.fx.gliss++;
      }
    }
    for (const e of evs) {
      // Schluss-Hits & Haltetöne
      if (ok('falloff') && e.finalHit && brassy && style.id !== 'classical' && style.id !== 'ballad') {
        addFx(e, 'falloff');
        report.fx.falloff++;
      }
      if ((e.finalHold || e.soloClimax) && ok('shake')) {
        if (inst.id === 'trumpet' || inst.id === 'cornet') {
          if (jazzy && e.pitches[0] >= inst.comfort[1] - 6) {
            e.orn = ['shake'];
            report.fx.shake++;
          }
        } else if (hasFx(inst, 'gliss') && inst.family === 'brass' && jazzy && !e.grace) {
          // Glissando von unten in den Schlusston – gleicher Teilton (Zugphysik)
          const opts = trombonePartialFor(e.pitches[0]);
          if (opts.length) {
            const p = opts[0];
            const from = p.partial - 6; // Zugposition 7
            if (from < e.pitches[0] - 2 && from >= inst.range[0]) {
              e.grace = { midi: from, lof: null, slash: false, gliss: true };
              report.fx.gliss++;
            }
          }
        } else if (inst.id === 'horn' && jazzy && !e.grace) {
          e.grace = { midi: e.pitches[0] - 7, lof: null, slash: false, gliss: true, rip: true };
          report.fx.rip++;
        } else if ((inst.family === 'sax') && jazzy && e.soloClimax && hasFx(inst, 'growl')) {
          e.words = 'growl';
        }
      }
      // Horn: gestopfte Töne bei kurzen Akzenten in Stabs
      if (ok('stopped') && inst.id === 'horn' && e.role === 'stabs' && e.art.includes('accent') && rng.chance(0.25)) {
        addFx(e, 'stopped');
        report.fx.stopped++;
      }
      // Streicher-Doppelgriffe im Tutti
      if (ok('doubleStops') && inst.strings && ['tutti', 'hits', 'final'].includes(e.role) && e.pitches.length === 1 && e.dur >= arr.beat) {
        const chord = chordAt(arr.chordTrack, e.start);
        const top = e.pitches[0];
        for (let d = 3; d <= 9; d++) {
          const lo = top - d;
          if (!isChordTone(chord, lo) || mod(lo, 12) === mod(top, 12)) continue;
          if (doubleStopPossible(lo, top, inst)) {
            e.pitches = [lo, top];
            e.lofs = [lofForChordPc(chord, mod(lo, 12), arr.keyAt(e.start)), e.lofs[0]];
            report.fx.doubleStops++;
            break;
          }
        }
      }
    }
    // Streicher: Pizzicato für Bass-Rollen in rhythmischen Stilen, Bogenstriche
    if (inst.strings) {
      let pizz = false;
      for (const b of blocks) {
        const a0 = barTick(arr, b.startBar);
        const a1 = barTick(arr, b.startBar + b.measures);
        const blockEvs = evs.filter((e) => e.start >= a0 && e.start < a1);
        if (!blockEvs.length) continue;
        const wantPizz = (style.id !== 'classical' && style.id !== 'ballad' && blockEvs.every((e) => e.role === 'bass' || e.role === 'comp' || e.role === 'stabs')) || (blockEvs.every((e) => e.role === 'stabs'));
        if (wantPizz !== pizz) {
          line.dirs.push({ t: blockEvs[0].start, kind: 'words', text: wantPizz ? 'pizz.' : 'arco' });
          pizz = wantPizz;
          report.fx.pizz += wantPizz ? 1 : 0;
        }
        if (!wantPizz) {
          for (const e of blockEvs) {
            if (e.start % mt === 0 && e.art.includes('accent')) addFx(e, 'downbow');
            else if (e.start % mt === mt - arr.beat && e.dur <= arr.beat) {
              const n = blockEvs.find((x) => x.start === e.start + e.dur);
              if (n && n.start % mt === 0) addFx(e, 'upbow');
            }
          }
        }
      }
    }
    // Dämpfer für Solo-Backgrounds (nur mit genug Pause zum Ein-/Ausbauen)
    const muteList = mutes(inst);
    if (muteList.length && inst.family !== 'string') {
      for (const b of blocks) {
        if (b.type !== 'solo') continue;
        const a0 = b.startBar * mt;
        const a1 = a0 + b.measures * mt;
        const bEvs = evs.filter((e) => e.start >= a0 && e.start < a1);
        if (!bEvs.length || bEvs.some((e) => e.role !== 'background')) continue;
        const before = evs.filter((e) => e.start < bEvs[0].start).slice(-1)[0];
        const restBefore = before ? bEvs[0].start - (before.start + before.dur) : Infinity;
        const lastB = bEvs[bEvs.length - 1];
        const after = evs.find((e) => e.start >= a1);
        const restAfter = after ? after.start - (lastB.start + lastB.dur) : Infinity;
        if (restBefore >= arr.beat * 2 && restAfter >= arr.beat * 2) {
          const m = style.id === 'swing' || style.id === 'ballad' ? muteList.find((x) => /Harmon|Cup/.test(x)) || muteList[0] : muteList.find((x) => /Cup|Plunger/.test(x)) || muteList[0];
          line.dirs.push({ t: bEvs[0].start, kind: 'words', text: m });
          if (after) line.dirs.push({ t: after.start, kind: 'words', text: 'open' });
          report.fx.mutes++;
        }
      }
    }
  }
}

// ---------- Dynamik --------------------------------------------------------
// Tick eines Taktanfangs (mit Taktartwechseln über das Taktraster)
const barTick = (arr, bar) => (arr.grid ? arr.grid.start(bar) : bar * arr.mt);

export function applyDynamics(arr) {
  const { voices, blocks, mt } = arr;
  const roleOffset = (r) => (LEAD_ROLES.has(r) || r === 'tutti' || r === 'hits' || r === 'final' || r === 'riff' ? 0 : r === 'bass' ? 0 : -1);
  for (let v = 0; v < voices.length; v++) {
    const line = voices[v];
    let current = null;
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      const a0 = barTick(arr, b.startBar);
      if (b.copyOf !== undefined) {
        current = null; // nach einem D.S.-Rücksprung Dynamik neu setzen
        continue;
      }
      for (const seg of b.segments) {
        if (seg.copyOfSeg !== undefined) continue;
        const s0 = barTick(arr, b.startBar + seg.startBar);
        const s1 = barTick(arr, b.startBar + seg.startBar + seg.bars);
        const first = line.events.find((e) => e.start >= s0 && e.start < s1);
        if (!first) continue;
        let dyn = dynShift(b.dyn, roleOffset(seg.roles[v]));
        if (seg.roles[v] === 'solo') dyn = dynShift(b.dyn, 1);
        if (dyn !== current) {
          line.dirs.push({ t: first.start, kind: 'dyn', value: dyn });
          current = dyn;
        }
        // Crescendo im Build-up
        if (seg.climax && seg.roles[v] !== 'rest') {
          line.dirs.push({ t: s0, kind: 'wedge', type: 'crescendo' });
          const lastE = line.events.filter((e) => e.start < s1).slice(-1)[0];
          line.dirs.push({ t: lastE ? lastE.start : s1 - 1, kind: 'wedge', type: 'stop' });
          current = null;
        }
      }
      // Crescendo vor dem Shout Chorus
      const nb = blocks[bi + 1];
      if (nb && (nb.type === 'shout' || nb.type === 'coda') && b.measures >= 2) {
        const c0 = barTick(arr, b.startBar + b.measures - 2);
        const evIn = line.events.filter((e) => e.start >= c0 && e.start < barTick(arr, b.startBar + b.measures));
        if (evIn.length >= 2) {
          line.dirs.push({ t: evIn[0].start, kind: 'wedge', type: 'crescendo' });
          line.dirs.push({ t: evIn[evIn.length - 1].start, kind: 'wedge', type: 'stop' });
        }
      }
    }
    // Schluss: Crescendo (Funk/Swing) bzw. Diminuendo (Ballade)
    const hold = line.events.find((e) => e.finalHold);
    if (hold) {
      const type = arr.style.id === 'ballad' ? 'diminuendo' : 'crescendo';
      line.dirs.push({ t: hold.start, kind: 'wedge', type });
      line.dirs.push({ t: hold.start + hold.dur - 1, kind: 'wedge', type: 'stop', endOf: hold });
      if (arr.style.id === 'ballad' || arr.style.id === 'classical') hold.fermata = true;
    }
  }
}

// ---------- Rechtschreibung -------------------------------------------------
export function spellAll(arr) {
  const { voices, chordTrack } = arr;
  for (const line of voices) {
    const evs = line.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      const key = arr.keyAt(e.start);
      const chord = chordAt(chordTrack, e.start);
      const scale = chordScale(chord, key);
      const next = evs[i + 1];
      e.lofs = e.pitches.map((m, k) => {
        const l = e.lofs?.[k];
        if (l !== null && l !== undefined && mod(l * 7, 12) === mod(m, 12)) return l;
        return spellPitch(m, chord, key, scale, next ? next.pitches[0] - m : 0);
      });
      if (e.grace && (e.grace.lof === null || e.grace.lof === undefined)) e.grace.lof = spellPitch(e.grace.midi, chord, key, scale, e.pitches[0] - e.grace.midi);
    }
  }
}

export function spellPitch(m, chord, key, scale, dirToNext) {
  const pc = mod(m, 12);
  if (chord) {
    const t = [...chord.tones, ...chord.tens].find((x) => x.pc === pc);
    if (t) return t.lof;
  }
  const center = keyCenter(key);
  if (scale.includes(pc)) {
    const l = chord ? lofForChordPc(chord, pc, key) : lofNear(pc, center);
    return l;
  }
  // chromatisch: aufwärts mit #, abwärts mit b
  const base = lofNear(pc, center);
  if (dirToNext > 0) {
    const sharp = base + (base < center ? 12 : 0);
    return Math.abs(sharp - center) <= 9 ? sharp : base;
  }
  if (dirToNext < 0) {
    const flat = base - (base > center ? 12 : 0);
    return Math.abs(flat - center) <= 9 ? flat : base;
  }
  return base;
}

export function newReport() {
  return {
    rangeFixes: 0,
    parallelsFound: 0,
    parallelsFixed: 0,
    breaths: 0,
    longNotes: 0,
    longNotesCovered: 0,
    fillsInjected: 0,
    fx: { falloff: 0, doit: 0, scoop: 0, gliss: 0, shake: 0, rip: 0, stopped: 0, pizz: 0, doubleStops: 0, mutes: 0 },
  };
}

export { addArt };

// ---------- Lesbarkeit: kurze Stakkato-Noten statt Pausen-Wirrwarr ---------
// Eine Stakkato-16tel mit folgender 16tel-Pause wird als Stakkato-Achtel notiert,
// eine Stakkato-Achtel mit Pause bis zur nächsten Zählzeit als Stakkato-Viertel.
// Der Stakkato-Punkt bewahrt den kurzen Klang (Wiedergabe spielt kurz).
export function simplifyForReading(arr, meter) {
  const mi0 = meterInfo(meter);
  const g = arr.grid; // Taktartwechsel: Takt & Schlag je Takt
  for (const line of arr.voices) {
    const evs = line.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      const bar = g ? g.barAt(e.start) : Math.floor(e.start / mi0.measureTicks);
      const mi = g ? meterInfo(g.meters[Math.min(bar, g.meters.length - 1)] || meter) : mi0;
      const mt = mi.measureTicks;
      const beat = mi.beatTicks;
      if (!e.art.includes('staccato') || e.dur > beat / 2 || e.fermata) continue;
      const next = evs[i + 1];
      const barStart = g ? g.start(bar) : bar * mt;
      const limit = Math.min(next ? next.start : Infinity, barStart + mt, barStart + Math.ceil((e.start - barStart + 1) / beat) * beat);
      const maxDur = limit - e.start;
      if (maxDur <= e.dur) continue;
      const d = singleValueDur(e.start - barStart, maxDur, mi, e.dur);
      if (d && d > e.dur) {
        e.playDur = e.dur;
        e.dur = d;
      }
    }
  }
}

// ---------- Vortragsangaben -------------------------------------------------
export function tempoTerm(bpm) {
  if (bpm < 60) return 'Largo';
  if (bpm < 72) return 'Adagio';
  if (bpm < 88) return 'Andante';
  if (bpm < 100) return 'Moderato';
  if (bpm < 116) return 'Allegretto';
  if (bpm < 140) return 'Allegro';
  if (bpm < 168) return 'Vivace';
  return 'Presto';
}

export function tempoHeading(style, bpm) {
  // kurz & üblich: Stil- bzw. Tempowort, Metronomzahl folgt separat
  switch (style.id) {
    case 'swing':
      return { text: bpm < 110 ? 'Slow Swing' : bpm < 170 ? 'Medium Swing' : 'Up-Tempo Swing', hint: 'Achtel triolisch' };
    case 'funk':
      return { text: 'Funky', hint: 'Straight 16ths' };
    case 'secondline':
      return { text: 'Second Line', hint: 'New Orleans Groove' };
    case 'ballad':
      return { text: 'Ballad', hint: 'con espressione' };
    case 'polka':
      return { text: 'Tempo di Polka', hint: null };
    default:
      return { text: tempoTerm(bpm), hint: null };
  }
}

const EXPR = {
  melody: { funk: 'marcato', secondline: 'con brio', swing: 'legato', ballad: 'espressivo', classical: 'cantabile', polka: 'leggiero' },
  counter: { ballad: 'dolce', classical: 'dolce', swing: 'legato', polka: 'dolce', funk: 'Gegenstimme', secondline: 'Gegenstimme' },
  fill: { ballad: 'dolce', classical: 'dolce', swing: 'Fills', funk: 'Fills', secondline: 'Fills', polka: 'dolce' },
  stabs: { all: 'sempre staccato' },
  comp: { funk: 'leggiero', secondline: 'leggiero', swing: 'Comping', ballad: 'legato', classical: 'sostenuto', polka: 'Nachschlag, leggiero' },
  pad: { all: 'sostenuto' },
  bass: { funk: 'Groove', secondline: 'Groove', swing: 'Walking', ballad: 'legato', polka: 'leggiero' },
  background: { all: 'Background' },
  tutti: { funk: 'Tutti – marcato', secondline: 'Tutti – marcato', swing: 'Tutti – Shout', ballad: 'Tutti', classical: 'Tutti – maestoso', polka: 'Tutti – maestoso' },
  hits: { all: 'Tutti' },
  riff: { all: 'Riff' },
  subject: { all: 'cantabile' },
  hook: { funk: 'Hook – marcato', secondline: 'Hook', swing: 'Hook', ballad: 'espressivo', classical: 'cantabile', polka: 'leggiero' },
};

const DRUM_TEXT = { funk: 'Funk-Groove', secondline: 'Second-Line-Groove', swing: 'Swing (Ride, HH auf 2 & 4)', ballad: 'Ballade (Rim-Click)', classical: 'Konzertant, sparsam', polka: 'Polka' };

export function addPerformanceMarks(arr, drumsLine = null) {
  const { voices, blocks, mt, style } = arr;
  for (let v = 0; v < voices.length; v++) {
    const line = voices[v];
    let lastText = null;
    let lastRole = null;
    for (const b of blocks) {
      if (b.copyOf !== undefined) {
        lastText = null;
        lastRole = null;
        continue;
      }
      for (const seg of b.segments) {
        if (seg.copyOfSeg !== undefined) continue;
        const role = seg.roles[v];
        const s0 = barTick(arr, b.startBar + seg.startBar);
        const s1 = barTick(arr, b.startBar + seg.startBar + seg.bars);
        const first = line.events.find((e) => e.start >= s0 && e.start < s1);
        if (!first || role === 'rest' || role === 'final' || role === 'solo') {
          if (role !== 'rest') lastRole = role;
          continue;
        }
        const map = EXPR[role];
        const text = map ? map[style.id] ?? map.all ?? null : null;
        if (text && (text !== lastText || role !== lastRole)) line.dirs.push({ t: first.start, kind: 'words', text, placement: 'below' });
        lastText = text;
        lastRole = role;
      }
    }
  }
  // rit. am Schluss (Ballade, Klassik, Swing) + Tempo-Verlauf für die Wiedergabe
  arr.tempoMap = [{ t: 0, bpm: arr.tempo }];
  const coda = blocks[blocks.length - 1];
  if (coda && !arr.tempoFromSource && (style.id === 'ballad' || style.id === 'classical' || style.id === 'swing')) {
    const finSeg = coda.segments[coda.segments.length - 1];
    const ritBars = style.id === 'swing' ? 1 : 2;
    const rStart = (coda.startBar + finSeg.startBar) * mt - (style.id === 'swing' ? 0 : mt * (ritBars - 1));
    const rEnd = (coda.startBar + coda.measures) * mt;
    for (const line of voices) {
      const e = line.events.find((x) => x.start >= rStart && x.start < rEnd);
      if (e) line.dirs.push({ t: e.start, kind: 'words', text: 'rit.' });
    }
    const steps = Math.max(1, Math.round((rEnd - rStart) / arr.beat));
    for (let k = 0; k <= steps; k++) {
      const bpm = Math.round(arr.tempo * (1 - 0.3 * (k / steps)));
      arr.tempoMap.push({ t: rStart + k * arr.beat, bpm });
    }
    arr.ritStart = rStart;
  }
  // Schlagzeug: Groove-Bezeichnungen an Formteilen (nicht bei 1:1 aus der Vorlage – dort ist es der Original-Groove)
  if (drumsLine && !arr.tempoFromSource) {
    let last = null;
    for (const b of blocks) {
      const t = barTick(arr, b.startBar);
      const has = drumsLine.events.some((e) => e.start >= t && e.start < barTick(arr, b.startBar + b.measures));
      if (!has) continue;
      const txt = b.type === 'coda' ? 'Fills & Hits mit den Bläsern' : DRUM_TEXT[style.id];
      if (txt !== last) drumsLine.dirs.push({ t, kind: 'words', text: txt });
      last = txt;
    }
  }
}
