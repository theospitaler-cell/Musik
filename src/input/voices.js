// Stimmen aus mehrstimmig gehörten Noten (lokale KI): Melodie (oben), Bass (unten) und bis zu
// zwei Mittelstimmen. Grundlage für „Original übernehmen“ (jede Stimme spielt, was im Lied
// wirklich erklingt) und für Tonart, Akkorde und Form.
//
// Noten: [{start, dur, midi, amp}] in Ticks (auf das 16tel-Raster gesetzt), amp 0..1.
import { DIV } from '../core/constants.js';

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const keyOf = (n) => `${n.start}:${n.midi}`;

// Aufräumen: Dopplungen, Oberton-Geister (leise Oktave/Duodezime über einem lauten Ton),
// sehr leise Kurz-Töne, Überlappungen derselben Tonhöhe.
export function cleanPoly(notes, { step = 6 } = {}) {
  const amps = notes.map((n) => n.amp ?? 0.5).sort((a, b) => a - b);
  const ref = amps.length ? amps[Math.floor(amps.length * 0.8)] || 0.5 : 0.5;
  // gleiche Tonhöhe, gleicher Einsatz: stärkste/längste Note
  const byKey = new Map();
  for (const n of notes) {
    if (!(n.dur > 0)) continue;
    const k = keyOf(n);
    const o = byKey.get(k);
    if (!o) byKey.set(k, { ...n, amp: n.amp ?? 0.5 });
    else {
      o.dur = Math.max(o.dur, n.dur);
      o.amp = Math.max(o.amp, n.amp ?? 0.5);
    }
  }
  let list = [...byKey.values()].sort((a, b) => a.start - b.start || a.midi - b.midi);
  // Oberton-Geister
  const ghost = new Set();
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length && list[j].start - a.start <= step; j++) {
      const b = list[j];
      const [lo, hi] = a.midi < b.midi ? [a, b] : [b, a];
      const iv = hi.midi - lo.midi;
      if ((iv === 12 || iv === 19 || iv === 24 || iv === 28) && hi.amp < 0.55 * lo.amp) ghost.add(hi);
    }
  }
  list = list.filter((n) => !ghost.has(n) && !(n.dur <= step && n.amp < 0.3 * ref));
  // gleiche Tonhöhe: frühere Note endet am neuen Anschlag
  const last = new Map();
  for (const n of list) {
    const p = last.get(n.midi);
    if (p && p.start + p.dur > n.start) p.dur = n.start - p.start;
    last.set(n.midi, n);
  }
  return list.filter((n) => n.dur > 0);
}

// einstimmige Linie: Überlappungen kürzen
function mono(notes) {
  const s = [...notes].sort((a, b) => a.start - b.start);
  const out = [];
  for (const n of s) {
    const p = out[out.length - 1];
    if (p && p.start === n.start) continue;
    if (p && p.start + p.dur > n.start) p.dur = n.start - p.start;
    out.push({ ...n });
  }
  return out.filter((n) => n.dur > 0);
}

// Rohnoten der KI (Sekunden) glätten, bevor sie in Stimmen zerlegt werden:
//  - Fragmente unter minSec (120 ms) verwerfen – das sind Einschwing- und Abklingreste, keine Töne
//    (schnelle Läufe/Wiederholungen holt withFastNotes danach zurück)
//  - Die KI zerlegt einen Ton oft in mehrere Teile gleicher Tonhöhe (Doppel-Auslösung des Einsatzes,
//    Einbrüche durch andere Stimmen). Liegen zwei Teile höchstens joinGap (120 ms) auseinander und
//    gibt es zwischen ihnen keinen echten neuen Anschlag, sind sie ein Ton ab dem früheren Einsatz.
//    Echter Anschlag: tiefer Einbruch der Teiltöne (≥ 60 %) oder steiler Anstieg (≥ 3×) – an Wahrheit
//    gemessen trennt das alle echten Wiederholungen und nur 13 % der zerlegten Töne (der frühere
//    Schwellenwert 30 % trennte die Hälfte fälschlich).
// attack(tPrev, tNext, midi) -> {depth, rise, …}: Anschlag-Erkennung aus dem Audio (fast.js); ohne sie
// gelten nur Zeit-Regeln: ein gehaltener Ton (mind. holdSec) mit Abriss von höchstens gapSec bleibt einer.
export const isNewAttack = (r) => !!r && (r.depth >= 0.6 || r.rise >= 3);
// Schwellen (zum Abstimmen an echten Aufnahmen überschreibbar)
export const TIDY_TUNE = { minSec: 0.12, gapSec: 0.06, holdSec: 0.4, joinGap: 0.12, joinFirstMax: 0.12, shortMin: 0.06, shortRise: 4, shortAmp: 0.8 };
// rise(t, midi): Anstieg der Teiltonhüllkurve am Einsatz (fast.js, makeAttackDetector.onsetRise). Mit ihr bleiben
// kurze Töne (ab shortMin) mit steilem Einsatz und ausreichender Lautstärke – echte Staccato-/Schnell-Noten –
// statt an der 120-ms-Grenze zu fallen.
export function tidyAiNotes(ai, { minSec = TIDY_TUNE.minSec, gapSec = TIDY_TUNE.gapSec, holdSec = TIDY_TUNE.holdSec, attack = null, joinGap = TIDY_TUNE.joinGap, joinFirstMax = TIDY_TUNE.joinFirstMax, rise = null } = {}) {
  const byPitch = new Map();
  for (const n of [...(ai || [])].sort((a, b) => a.start - b.start)) {
    const key = n.stem ? `${n.stem}:${n.midi}` : n.midi;
    if (!byPitch.has(key)) byPitch.set(key, []);
    byPitch.get(key).push({ ...n });
  }
  const out = [];
  for (const list of byPitch.values()) {
    let cur = null;
    for (const n of list) {
      if (cur) {
        const gap = n.start - cur.end;
        // Kandidat: kurzer Anfang (Splitter) bis 120 ms Lücke, oder ein gehaltener Ton mit kleinem Abriss
        const cand = n.start >= cur.start && ((gap <= joinGap && cur.end - cur.start < joinFirstMax) || (cur.end - cur.start >= holdSec && gap <= gapSec));
        const join = attack ? cand && !isNewAttack(attack(cur.start, n.start, n.midi)) : cur.end - cur.start >= holdSec && gap <= gapSec;
        if (join) {
          cur.end = Math.max(cur.end, n.end);
          cur.amp = Math.max(cur.amp ?? 0, n.amp ?? 0);
          continue;
        }
        out.push(cur);
      }
      cur = n;
    }
    if (cur) out.push(cur);
  }
  let med = 0.5;
  if (rise) {
    const amps = out.filter((n) => n.midi >= 48 && n.midi <= 96).map((n) => n.amp ?? 0.5).sort((a, b) => a - b);
    if (amps.length) med = amps[Math.floor(amps.length / 2)];
  }
  const keep = (n) => {
    const d = n.end - n.start;
    if (d >= minSec) return true;
    if (!rise || d < TIDY_TUNE.shortMin || n.midi < 55 || n.midi > 90) return false;
    return (n.amp ?? 0.5) >= TIDY_TUNE.shortAmp * med && rise(n.start, n.midi) >= TIDY_TUNE.shortRise;
  };
  return out.filter(keep).sort((a, b) => a.start - b.start || a.midi - b.midi);
}

// Schnelle Läufe und Tonwiederholungen (fast.js) zurückholen: Noten eines Musters bleiben auch unter
// 120 ms (bis zu den 58 ms der KI) und tragen fast = 'run' | 'rep' und grid (Ticks je Stufe).
// tidy: Ergebnis von tidyAiNotes, marks: Ergebnis von markFastNotes(rohe KI-Noten, …).
export function withFastNotes(tidy, marks) {
  if (!marks || !marks.size) return tidy;
  const out = tidy.map((n) => ({ ...n }));
  const by = new Map();
  for (const n of out) {
    if (!by.has(n.midi)) by.set(n.midi, []);
    by.get(n.midi).push(n);
  }
  for (const [m, info] of marks) {
    const hit = (by.get(m.midi) || []).find((t) => Math.abs(t.start - m.start) <= 0.05);
    if (hit) Object.assign(hit, { fast: info.kind, grid: info.grid });
    else out.push({ ...m, fast: info.kind, grid: info.grid });
  }
  return out.sort((a, b) => a.start - b.start || a.midi - b.midi);
}

// Skyline-Band für die Lead-Melodie: 300–2500 Hz (MIDI 63–94). Töne darin tragen die Melodie;
// sehr tiefe Töne (Bass, Bass Drum) tragen sie nicht.
export const LEAD_BAND = [63, 94];
export function leadBandScore(midi) {
  if (midi >= LEAD_BAND[0] && midi <= LEAD_BAND[1]) return 0.25;
  return midi < 55 ? -0.3 : 0;
}

// Gruppen gleichzeitiger Anschläge (Töne absteigend)
function onsetGroups(notes) {
  const groups = [];
  for (const n of [...notes].sort((a, b) => a.start - b.start || b.midi - a.midi)) {
    const g = groups[groups.length - 1];
    if (g && g.start === n.start) g.notes.push(n);
    else groups.push({ start: n.start, notes: [n] });
  }
  return groups;
}

// Bass: tiefste Stimme. Die Lage ergibt sich aus dem jeweils tiefsten Ton je Schlag; Töne
// deutlich darüber (wenn der Bass pausiert) gehören nicht dazu.
function pickBass(notes, beat, mt, step) {
  const lowPerBeat = new Map();
  for (const n of notes) {
    const b = Math.floor(n.start / beat);
    if (!lowPerBeat.has(b) || n.midi < lowPerBeat.get(b)) lowPerBeat.set(b, n.midi);
  }
  // Lage: unteres Viertel der tiefsten Töne (der Bass pausiert in manchen Teilen – dort ist der
  // tiefste Ton eine Mittelstimme und würde den Mittelwert nach oben ziehen)
  const lows = [...lowPerBeat.values()].sort((a, b) => a - b);
  const center = lows[Math.floor(lows.length * 0.25)] ?? 40;
  const top = center + 10;
  const cands = notes.filter((n) => n.midi <= top && n.midi >= center - 16);
  let line = [];
  for (const g of onsetGroups(cands)) {
    // lautester Ton in der Basslage, bei Gleichstand der tiefere (Oktav-Dopplung: unten)
    const best = g.notes.reduce((a, b) => (b.amp > a.amp * 1.25 || (b.amp >= a.amp * 0.8 && b.midi < a.midi) ? b : a));
    line.push(best);
  }
  // Zusammenhang: ein Ton am oberen Rand der Basslage, dessen Nachbarn in der tiefsten Stimme
  // fast alle darüber liegen, gehört zu einer Mittelstimme (kein Bass in diesem Abschnitt)
  const lowest = onsetGroups(notes).map((g) => g.notes[g.notes.length - 1]);
  const inBand = lowest.map((n) => n.midi <= top);
  const keep = new Set();
  lowest.forEach((n, i) => {
    if (!inBand[i]) return;
    let near = 0;
    let band = 0;
    for (let j = i - 1; j >= 0 && n.start - lowest[j].start <= 8 * beat; j--) (near++, inBand[j] && band++);
    for (let j = i + 1; j < lowest.length && lowest[j].start - n.start <= 8 * beat; j++) (near++, inBand[j] && band++);
    if (!near || band / near >= 0.35 || n.midi <= center + 3) keep.add(n.start);
  });
  line = mono(line.filter((n) => keep.has(n.start) || n.midi <= center + 3));
  // Bass-Drum-Geister: die KI hört die Bass Drum oft als kurzen, immer gleichen tiefen Ton –
  // unabhängig von der Harmonie. Eine Tonhöhe, die in vielen Takten nur als kurzer Nebenton
  // auftaucht, wird dort gestrichen (bleibt aber, wo sie der Hauptton des Takts ist).
  const bars = new Map();
  for (const n of line) {
    const b = Math.floor(n.start / mt);
    if (!bars.has(b)) bars.set(b, []);
    bars.get(b).push(n);
  }
  const mainOf = new Map();
  const side = new Map();
  const under = new Map(); // Nebenton -> Haupttöne, neben denen er auftaucht
  for (const [b, ns] of bars) {
    const w = new Map();
    for (const n of ns) w.set(n.midi, (w.get(n.midi) || 0) + n.dur);
    const main = [...w.entries()].sort((x, y) => y[1] - x[1])[0][0];
    mainOf.set(b, main);
    for (const m of new Set(ns.filter((n) => n.midi !== main && n.dur <= 2 * step).map((n) => n.midi))) {
      side.set(m, (side.get(m) || 0) + 1);
      if (!under.has(m)) under.set(m, new Set());
      under.get(m).add(main);
    }
  }
  // (unabhängig von der Harmonie heißt: neben mindestens drei verschiedenen Haupttönen – ein
  // Grundton-Quint-Muster über gleichbleibender Harmonie ist dagegen echter Bass)
  const ghosts = new Set([...side.entries()].filter(([m, c]) => bars.size >= 8 && c >= 0.3 * bars.size && under.get(m).size >= 3).map(([m]) => m));
  if (ghosts.size) line = line.filter((n) => !(ghosts.has(n.midi) && n.dur <= 2 * step && mainOf.get(Math.floor(n.start / mt)) !== n.midi));
  return { line: mono(line), top, center };
}

// Melodie: führende Stimme. Dynamische Programmierung über die Anschlags-Gruppen:
//  - Die Gesangslinie der Signalanalyse (hint) zeigt, welcher gehörte Ton zur Melodie gehört.
//  - Laufen zwei Stimmen im gleichen Rhythmus parallel (Terzen/Sexten), führt die obere.
//  - Ohne Hinweis gilt der oberste deutliche Ton – aber nicht der oberste Ton eines dichten
//    Akkord-Einwurfs (Gitarre/Klavier), und nie ein Sprung zu einzelnen hohen Tönen.
function pickMelody(notes, beat, hint, step) {
  const groups = onsetGroups(notes);
  if (!groups.length) return [];
  const ampRef = median(notes.map((n) => n.amp)) || 0.5;
  // Lage: lautstärke-/dauergewichteter Mittelwert der Töne (Obertöne sind kurz & leise)
  const wts = notes.map((n) => [n.midi, n.amp * Math.min(n.dur, 2 * beat)]).sort((a, b) => a[0] - b[0]);
  const wSum = wts.reduce((s, x) => s + x[1], 0);
  let acc = 0;
  let center = wts[0][0];
  for (const [m, w] of wts) {
    acc += w;
    if (acc >= 0.6 * wSum) {
      center = m;
      break;
    }
  }
  const hs = hint ? [...hint].sort((a, b) => a.start - b.start) : [];
  let hi = 0;
  const hintAt = (t) => {
    while (hi < hs.length - 1 && hs[hi + 1].start <= t + step / 2) hi++;
    while (hi > 0 && hs[hi].start > t + step / 2) hi--;
    const h = hs[hi];
    return h && h.start <= t + step / 2 && h.start + h.dur > t ? h.midi : null;
  };
  const THRESH = 0.9;
  const local = (g, k, h) => {
    const n = g.notes[k];
    const dense = g.notes.length >= 4;
    let s = 0.5 * Math.min(1.5, n.amp / ampRef) + 0.2 * Math.min(1, n.dur / beat);
    s += (k === 0 ? 0.45 : k === 1 ? 0.15 : 0) * (dense ? 0.3 : 1);
    s -= 0.05 * Math.max(0, Math.abs(n.midi - center) - 10);
    s += leadBandScore(n.midi);
    // Spurentrennung: der Gesangs-Stem trägt die Melodie, der Bass-Stem nie
    // (nach Lautstärke gewichtet: leise Reste im Gesangs-Stem sind Durchsprechen, keine Melodie)
    if (n.stem === 'vocals') s += 1.2 * Math.min(1, n.amp / ampRef);
    else if (n.stem === 'bass') s -= 1;
    // Töne, die auch im Seitensignal (L−R) stehen, sind seitlich verteilte Gitarren/Streicher/Synths –
    // Gesang und Lead stehen in der Mitte. Kein Ausschluss, aber der Ton muss sich mehr beweisen.
    // (Nur im Vergleich innerhalb einer Gruppe: gibt es keinen Ton aus der Mitte, bleibt alles wie es war.)
    if (n.side && g.notes.some((m) => m !== n && !m.side)) s -= 0.3;
    else if (!n.side && g.notes.some((m) => m !== n && m.side)) s += 0.3;
    if (h !== null) {
      const d = n.midi - h;
      // die Signalanalyse irrt sich oft um eine Oktave – die Oktavlage entscheidet die Linie
      if (d % 12 === 0) s += 0.9;
      else if (Math.abs(d) === 1) s += 0.5;
      else {
        // obere Stimme eines parallelen Stimmenpaars (gleicher Einsatz, gleiche Länge)
        const partner = k === 0 && g.notes.some((m) => m !== n && (m.midi - h) % 12 === 0 && n.midi - m.midi >= 3 && n.midi - m.midi <= 9 && Math.abs(m.dur - n.dur) <= step && n.amp >= 0.6 * m.amp);
        // Abzug nur, wenn der Hinweis-Ton hier wirklich zur Wahl steht
        s += partner ? 1.0 : g.notes.some((m) => (m.midi - h) % 12 === 0) ? -0.25 : 0;
      }
    }
    return s - THRESH;
  };
  const trans = (a, b, gap) => {
    const d = Math.abs(a.midi - b.midi);
    // nach einer Pause sind Sprünge normal (neue Phrase)
    const w = gap >= 2 * beat ? 0.3 : 1;
    // Sprünge kosten: eine Melodie bleibt in ihrer Linie – das Hin und Her zu tiefen Akkordtönen
    // der Begleitung (Quinte abwärts und zurück) lohnt sich nur für deutlich gehörte Töne
    return -w * (0.09 * Math.max(0, d - 3) + (d >= 10 ? 0.5 : 0));
  };
  let prev = [{ score: 0, note: null, back: undefined, last: null }];
  for (const g of groups) {
    const cur = [];
    const h = hintAt(g.start);
    const opts = g.notes.slice(0, 4);
    for (let k = 0; k <= opts.length; k++) {
      const note = k < opts.length ? opts[k] : null;
      const loc = note ? local(g, k, h) : 0;
      let best = null;
      for (const p of prev) {
        let s = p.score + loc;
        if (note && p.last) s += trans(p.last, note, note.start - (p.last.start + p.last.dur));
        if (!best || s > best.score) best = { score: s, note, back: p, last: note || p.last };
      }
      cur.push(best);
    }
    prev = cur;
  }
  let node = prev.reduce((a, b) => (b.score > a.score ? b : a));
  const out = [];
  while (node && node.back !== undefined) {
    if (node.note) out.push({ ...node.note });
    node = node.back;
  }
  out.reverse();
  // Oktav-Flackern: ein einzelner Ton genau eine Oktave neben beiden Nachbarn gehört in deren Lage
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1].midi;
    const b = out[i].midi;
    const c = out[i + 1].midi;
    if (Math.abs(a - c) <= 5 && Math.abs(b - a) >= 9 && Math.abs(b - 12 * Math.round((b - a) / 12) - a) <= 5) out[i].midi = b - 12 * Math.round((b - a) / 12);
  }
  // Begleit-Einsprengsel: ein kurzer Ton, der zwischen zwei Melodietönen mindestens eine Quinte
  // nach unten ausschert, gehört zur Begleitung
  for (let i = 1; i < out.length - 1; i++) {
    const p = out[i - 1];
    const n = out[i];
    const x = out[i + 1];
    if (n.dur > 2 * step || n.start - p.start > 2 * beat || x.start - n.start > 2 * beat) continue;
    if (p.midi - n.midi >= 7 && x.midi - n.midi >= 7) out.splice(i--, 1);
  }
  // … ebenso ein kurzer Abstecher von ein bis zwei Tönen (höchstens ein Schlag), nach dem die
  // Linie auf derselben Höhe weitergeht: der obere Ton wird in Wahrheit gehalten oder wiederholt
  for (let i = 1; i < out.length - 1; i++) {
    const p = out[i - 1];
    for (const len of [2, 1]) {
      const x = out[i + len];
      if (!x) continue;
      const run = out.slice(i, i + len);
      if (Math.abs(p.midi - x.midi) > 2 || x.start - run[0].start > beat) continue;
      if (run.every((n) => p.midi - n.midi >= 5 && x.midi - n.midi >= 5)) {
        out.splice(i, len);
        i--;
        break;
      }
    }
  }
  return mono(out);
}

// Lücken von höchstens einer Sechzehntel schließen (gesungene Linie)
function legato(line, step = 6) {
  for (let i = 0; i < line.length - 1; i++) {
    const gap = line[i + 1].start - (line[i].start + line[i].dur);
    if (gap > 0 && gap <= step) line[i].dur += gap;
  }
  return line;
}

// Mittelstimmen: zwei Ströme, die jeweils in ihrer Lage bleiben (nächster Ton = der dem letzten
// Ton dieser Stimme am nächsten liegende); die obere bleibt über der unteren.
function pickInner(rest, melAt) {
  const up = [];
  const lo = [];
  if (!rest.length) return [up, lo];
  const ps = rest.map((n) => n.midi).sort((a, b) => a - b);
  let lastUp = ps[Math.floor(ps.length * 0.7)];
  let lastLo = ps[Math.floor(ps.length * 0.3)];
  // die dritte Stimme gibt es nur dort, wo zuletzt zwei Mittelstimmen-Töne zugleich erklangen
  let lastPair = -Infinity;
  for (const g of onsetGroups(rest)) {
    const m = melAt(g.start);
    // Töne über der Melodie zählen eine Oktave tiefer (Oberstimmen-Zusätze), der Rest wie gehört
    const ns = g.notes.map((n) => ({ n, p: m !== null && n.midi >= m ? n.midi - 12 * Math.ceil((n.midi - m + 1) / 12) : n.midi })).sort((a, b) => b.p - a.p);
    if (ns.length === 1) {
      const x = ns[0];
      // ein einzelner Ton gehört zur zweiten Stimme – außer er liegt klar in der Lage der dritten
      const loActive = g.start - lastPair <= 8 * DIV;
      if (!loActive || x.p >= lastLo - 1 || Math.abs(x.p - lastUp) <= Math.abs(x.p - lastLo)) (up.push({ ...x.n, midi: x.p }), (lastUp = x.p));
      else (lo.push({ ...x.n, midi: x.p }), (lastLo = x.p));
      continue;
    }
    // bestes Paar (oben > unten) nach Nähe zu den letzten Tönen
    let best = null;
    for (let i = 0; i < ns.length; i++)
      for (let j = i + 1; j < ns.length; j++) {
        if (ns[i].p === ns[j].p) continue;
        const c = Math.abs(ns[i].p - lastUp) + Math.abs(ns[j].p - lastLo) - 0.5 * (ns[i].n.amp + ns[j].n.amp);
        if (!best || c < best.c) best = { c, a: ns[i], b: ns[j] };
      }
    if (!best) {
      up.push({ ...ns[0].n, midi: ns[0].p });
      lastUp = ns[0].p;
      continue;
    }
    up.push({ ...best.a.n, midi: best.a.p });
    lo.push({ ...best.b.n, midi: best.b.p });
    lastUp = best.a.p;
    lastLo = best.b.p;
    lastPair = g.start;
  }
  return [mono(up), mono(lo)];
}

// Lesbar & spielbar machen: aus einer dichten Aufnahme hört die KI viele Sechzehntel-Splitter
// (Gesang ist rhythmisch frei, Gitarren-Anschläge, Bass-Drum-Reste). Gedruckte Stimmen stehen im
// Achtel-Raster; nur echte Synkopen bleiben: ein vorgezogener Ton (Sechzehntel vor der Achtel),
// der über sie hinaus klingt (push). Töne knapp nach der Zählzeit rücken auf sie, Durchgangs-
// Splitter zwischen zwei Achteln entfallen, gleiche Töne verschmelzen.
//   mergeRepeats: gleiche Töne auf aufeinanderfolgenden Achteln zu einem langen Ton (Liegeklang)
export function simplifyLine(line, { beat = DIV, allowPush = false, mergeRepeats = false } = {}) {
  const E = beat / 2;
  const S = beat / 4;
  if (S !== Math.round(S)) return line;
  const src = [...line].sort((a, b) => a.start - b.start);
  const starts = new Set(src.map((n) => n.start));
  const out = [];
  const at = (t) => out.find((m) => m.start === t);
  for (let i = 0; i < src.length; i++) {
    const n = src[i];
    // schnelle Läufe und Tonwiederholungen (fast.js): Einsatz bleibt auf seiner Rasterstufe
    if (n.fast) {
      const q = at(n.start);
      if (q && q.fast) continue;
      if (q) out.splice(out.indexOf(q), 1);
      out.push({ ...n });
      continue;
    }
    const off = (((n.start % E) + E) % E);
    const next = src[i + 1];
    let t = n.start;
    if (off) {
      const back = n.start - off;
      const fwd = back + E;
      const afterBeat = (((back % beat) + beat) % beat) === 0; // Sechzehntel direkt nach der Zählzeit
      const sustained = n.dur >= E && (!next || next.start >= fwd + S);
      if (allowPush && !afterBeat && sustained) t = n.start; // echte Synkope
      else if (afterBeat && !at(back)) t = back;
      else if (!starts.has(fwd)) t = fwd;
      else if (!at(back)) t = back;
      else {
        // kein Platz: gleicher Ton wie davor -> verlängern, sonst entfällt der Splitter
        const p = at(back);
        if (p && p.midi === n.midi) p.dur = Math.max(p.dur, n.start + n.dur - p.start);
        continue;
      }
    }
    const p = at(t);
    if (p && p.fast) continue;
    if (p) {
      if (p.midi === n.midi || n.dur > p.dur) Object.assign(p, { midi: n.dur > p.dur ? n.midi : p.midi, dur: Math.max(p.dur, n.start + n.dur - t), amp: Math.max(p.amp ?? 0, n.amp ?? 0) });
      continue;
    }
    out.push({ ...n, start: t, dur: Math.max(S, n.start + n.dur - t) });
  }
  out.sort((a, b) => a.start - b.start);
  // Längen: bis zum nächsten Einsatz, mindestens eine Achtel wo Platz ist, Enden auf dem Raster
  const res = [];
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    const nx = out[i + 1];
    const prev = res[res.length - 1];
    if (!n.fast && !(prev && prev.fast) && prev && prev.midi === n.midi && (mergeRepeats ? n.start - (prev.start + prev.dur) <= S : n.start < prev.start + prev.dur)) {
      prev.dur = Math.max(prev.dur, n.start + n.dur - prev.start);
      continue;
    }
    // schnelle Noten behalten ihre Rasterstufe (16tel, Triole, 32tel) als Wert
    const g = n.fast ? n.grid || S : null;
    let end = n.start + Math.max(n.dur, g || E);
    end = Math.ceil(end / (g || S)) * (g || S);
    if (nx && (n.fast || nx.midi !== n.midi)) end = Math.min(end, nx.start);
    else if (nx && !mergeRepeats) end = Math.min(end, nx.start);
    if (prev && prev.start + prev.dur > n.start) prev.dur = n.start - prev.start;
    res.push({ ...n, dur: Math.max(g ? 1 : S, end - n.start) });
  }
  for (let i = 0; i < res.length - 1; i++) if (res[i].start + res[i].dur > res[i + 1].start) res[i].dur = res[i + 1].start - res[i].start;
  return res.filter((n) => n.dur > 0);
}

// notes: gereinigte Noten (cleanPoly). hint: Melodie der Signalanalyse (optional, gleiche Ticks)
export function separateVoices(notes, { beat = DIV, mt = 4 * DIV, step = 6, hint = null } = {}) {
  if (!notes.length) return { melody: [], bass: [], inner: [[], []], bassTop: 0 };
  // Spurentrennung (Demucs): ist ein Bass-Stem da, kommt der Bass nur von dort
  const bassStem = notes.filter((n) => n.stem === 'bass');
  const stemmed = bassStem.length >= 8;
  const b = pickBass(stemmed ? bassStem : notes, beat, mt, step);
  const bassSet = new Set(b.line.map(keyOf));
  const isBass = (n) => bassSet.has(keyOf(n));
  // alles über der Basslage (mit Bass-Stem: alles, was nicht aus dem Bass-Stem kommt)
  let upper = notes.filter((n) => !isBass(n) && (stemmed ? n.stem !== 'bass' : n.midi > b.top));
  // Stücke ohne eigene Oberstimme (nur Bass + Akkorde): dann ist alles über dem Bass Kandidat
  if (upper.length < 0.15 * notes.length) upper = notes.filter((n) => !isBass(n));
  let melody = legato(pickMelody(upper, beat, hint, step), step);
  const parallel = new Set();
  // Eine Stimme, die im Rhythmus der Melodie mitläuft (gleicher Einsatz, gleiche Länge), ist eine
  // Parallelstimme – kein Bass, auch wenn sie gerade der tiefste gehörte Ton ist
  {
    const melBy = new Map(melody.map((n) => [n.start, n]));
    const par = b.line.filter((n) => {
      const m = melBy.get(n.start);
      return m && n.midi > b.center + 2 && m.midi - n.midi <= 16 && Math.abs(m.dur - n.dur) <= step;
    });
    if (par.length >= 0.25 * b.line.length || par.length >= 12) {
      const drop = parallel;
      for (const n of par) drop.add(keyOf(n));
      b.line = b.line.filter((n) => !drop.has(keyOf(n)));
      bassSet.clear();
      for (const n of b.line) bassSet.add(keyOf(n));
      upper = notes.filter((n) => !isBass(n) && (n.midi > b.top || drop.has(keyOf(n))));
      melody = legato(pickMelody(upper, beat, hint, step), step);
    }
  }
  const melSet = new Set(melody.map(keyOf));
  const at = (line) => {
    let i = 0;
    return (t) => {
      while (i < line.length - 1 && line[i + 1].start <= t) i++;
      while (i > 0 && line[i].start > t) i--;
      const m = line[i];
      return m && m.start <= t && m.start + m.dur > t ? m.midi : null;
    };
  };
  const melAt = at(melody);
  // Basston der letzten zwei Schläge (kurze Basstöne klingen im Ohr weiter)
  let bi = 0;
  const bassNear = (t) => {
    while (bi < b.line.length - 1 && b.line[bi + 1].start <= t) bi++;
    while (bi > 0 && b.line[bi].start > t) bi--;
    const m = b.line[bi];
    return m && m.start <= t && t - m.start <= 2 * beat ? m.midi : null;
  };
  // Mittelstimmen: was übrig bleibt – ohne Oktav-Dopplungen von Melodie und Bass, ohne Reste
  // in der Lücke direkt über dem Bass
  const rest = notes.filter((n) => {
    if (isBass(n) || melSet.has(keyOf(n))) return false;
    if (stemmed && n.stem === 'bass') return false;
    if (!stemmed && n.midi < b.top + 3 && !parallel.has(keyOf(n))) return false;
    const m = melAt(n.start);
    if (m !== null && n.midi !== m && (n.midi - m) % 12 === 0) return false;
    // genau eine Oktave über dem Basston: Oktav-Dopplung des Basses (bzw. sein Oberton)
    const bm = bassNear(n.start);
    if (bm !== null && n.midi - bm === 12 && n.midi <= b.top + 14) return false;
    return true;
  });
  const inner = pickInner(rest, at(melody));
  // Takte ohne Bass in der Basslage: dort ist die tiefste der übrigen Stimmen der Bass
  // (Bass, der zeitweise höher liegt – z. B. Chiptune, Walking Bass in hoher Lage)
  const barOf = (n) => Math.floor(n.start / mt);
  const bassBars = new Map();
  for (const n of b.line) bassBars.set(barOf(n), (bassBars.get(barOf(n)) || 0) + 1);
  const lowBars = new Map();
  for (const n of inner[1]) lowBars.set(barOf(n), (lowBars.get(barOf(n)) || 0) + 1);
  const move = new Set([...lowBars.entries()].filter(([bar, c]) => c >= 2 && (bassBars.get(bar) || 0) <= 1).map(([bar]) => bar));
  let bass = b.line;
  if (move.size) {
    bass = mono([...b.line.filter((n) => !move.has(barOf(n))), ...inner[1].filter((n) => move.has(barOf(n)))]);
    inner[1] = inner[1].filter((n) => !move.has(barOf(n)));
  }
  return { melody, bass, inner, bassTop: b.top };
}
