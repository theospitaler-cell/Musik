// Schnelle Läufe und Tonwiederholungen aus den KI-Noten (Sekunden).
//
// Zwei Aufgaben:
//  1. Anschlag-Erkennung: Gibt es zwischen zwei Einsätzen derselben Tonhöhe wirklich einen neuen
//     Anschlag (Einbruch und Wiederanstieg der Energie auf den Teiltönen dieses Tons)? Nur dann
//     sind es zwei Noten – sonst zerlegt die KI einen Ton in Splitter (Doppel-Trigger, Vibrato).
//  2. Muster: Folgen von mindestens drei schnellen Tönen, die auf einem Raster des Schlags liegen
//     (16tel, Triolen-Achtel, 16tel-Triolen, 32tel), sind Läufe bzw. Tonwiederholungen. Ihre
//     Töne dürfen kürzer als 120 ms sein (bis herunter zu den 58 ms der KI) und werden bei der
//     Lesbarkeits-Vereinfachung (Achtel-Raster) nicht angetastet.
const SR = 22050;
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Teiltöne, über die der Anschlag gemessen wird (Gewichte): die höheren trennen Halbtöne besser
const PARTIALS = [
  [1, 0.5],
  [2, 1],
  [3, 1],
  [4, 0.7],
];

// x: Mono-Audio bei sr Hz. Rückgabe: { reattack(tPrev, tNext, midi) -> {depth, rise, ok} }
export function makeAttackDetector(x, sr = SR) {
  const WIN = Math.round(0.032 * sr); // 32 ms: Zeitauflösung für 16tel bis Tempo ~180
  const STEP = Math.max(1, Math.round(0.005 * sr));
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / WIN);

  // Hüllkurve der Teiltöne von midi zwischen t0 und t1 (Sekunden), Schritt 5 ms
  function envelope(t0, t1, midi) {
    const a = Math.max(0, Math.round(t0 * sr));
    const z = Math.min(x.length - WIN, Math.round(t1 * sr));
    const frames = Math.max(0, Math.floor((z - a) / STEP) + 1);
    const e = new Float32Array(frames);
    const out = { e, t0: a / sr + WIN / 2 / sr, step: STEP / sr };
    if (!frames) return out;
    const len = (frames - 1) * STEP + WIN;
    const re = new Float64Array(len);
    const im = new Float64Array(len);
    const f0 = midiHz(midi);
    for (const [h, w] of PARTIALS) {
      const f = f0 * h;
      if (f > 0.45 * sr) continue;
      const wc = (2 * Math.PI * f) / sr;
      const c = Math.cos(wc);
      const s = Math.sin(wc);
      // Demodulation mit e^{-jωn} (Drehzeiger statt sin/cos je Abtastwert)
      let pr = Math.cos(wc * a);
      let pi = -Math.sin(wc * a);
      for (let n = 0; n < len; n++) {
        const v = x[a + n];
        re[n] = v * pr;
        im[n] = v * pi;
        const nr = pr * c + pi * s;
        pi = pi * c - pr * s;
        pr = nr;
      }
      for (let k = 0; k < frames; k++) {
        const o = k * STEP;
        let sa = 0;
        let sb = 0;
        for (let i = 0; i < WIN; i++) {
          sa += re[o + i] * hann[i];
          sb += im[o + i] * hann[i];
        }
        e[k] += w * Math.sqrt(sa * sa + sb * sb);
      }
    }
    return out;
  }

  // Neuanschlag desselben Tons bei tNext (der vorige Einsatz war bei tPrev)?
  //  depth: Tiefe des Einbruchs vor dem Einsatz (0..1, bezogen auf den kleineren der beiden Gipfel)
  //  rise: Anstieg vom Tal zum Gipfel nach dem Einsatz
  function reattack(tPrev, tNext, midi) {
    const lo = Math.max(0, Math.min(tPrev, tNext - 0.25) - 0.04);
    const env = envelope(lo, tNext + 0.1, midi);
    const { e, t0, step } = env;
    if (e.length < 4) return { depth: 0, rise: 1, ok: false, strong: false };
    const idx = (t) => Math.max(0, Math.min(e.length - 1, Math.round((t - t0) / step)));
    // Gipfel des vorigen Tons (spätestens kurz vor dem neuen Einsatz), danach das tiefste Tal bis
    // zum neuen Einsatz, dann der Gipfel des neuen Tons. Ein bloßer Anstieg ist kein Einbruch.
    const preFrom = Math.max(tPrev - 0.01, tNext - 0.25);
    const kFrom = idx(preFrom);
    const kTo = Math.max(kFrom, idx(tNext - 0.02));
    let kPre = kFrom;
    for (let k = kFrom; k <= kTo; k++) if (e[k] >= e[kPre]) kPre = k;
    const pre = e[kPre];
    let valley = Infinity;
    for (let k = kPre; k <= Math.max(kPre, idx(tNext + 0.01)); k++) if (e[k] < valley) valley = e[k];
    let post = 0;
    for (let k = idx(tNext); k <= idx(tNext + 0.07); k++) if (e[k] > post) post = e[k];
    const ref = Math.min(pre, post);
    const depth = ref > 0 ? Math.max(0, 1 - valley / ref) : 0;
    const rise = post / Math.max(valley, 1e-9);
    // strong: tiefe Lücke und steiler Anstieg – ein echter neuer Ton, kein Vibrato-Einbruch
    return { depth, rise, ok: depth >= 0.3 && rise >= 1.25, strong: depth >= 0.7 && rise >= 2 };
  }
  // Wie schlagartig setzt dieser Ton bei t ein? Verhältnis des Gipfels nach dem Einsatz zur
  // mittleren Energie davor (auf den Teiltönen dieses Tons). Instrumente (Zunge, Anschlag) setzen
  // steil ein, Gesang gleitet hinein.
  function onsetRise(t, midi) {
    const { e, t0, step } = envelope(Math.max(0, t - 0.08), t + 0.09, midi);
    if (e.length < 4) return 1;
    const idx = (x) => Math.max(0, Math.min(e.length - 1, Math.round((x - t0) / step)));
    let pre = 0;
    let cnt = 0;
    for (let k = idx(t - 0.06); k <= idx(t - 0.02); k++, cnt++) pre += e[k];
    pre /= Math.max(1, cnt);
    let peak = 0;
    for (let k = idx(t); k <= idx(t + 0.07); k++) if (e[k] > peak) peak = e[k];
    return peak / Math.max(pre, 1e-9);
  }
  return { reattack, onsetRise };
}

// Raster, auf denen schnelle Läufe liegen können: g = Ticks (DIV = 24 je Viertel), per = Stufen je Schlag
const GRIDS = [
  { g: 6, per: 4 }, // 16tel
  { g: 8, per: 3 }, // Achtel-Triolen
  { g: 4, per: 6 }, // 16tel-Triolen
  { g: 3, per: 8 }, // 32tel
];

// Schwellen der Muster-Erkennung (zum Abstimmen an echten Aufnahmen überschreibbar: tune)
export const FAST_TUNE = {
  maxStep: 0.17, // s: größter Notenabstand eines 16tel-Laufs (16tel ab Tempo ~88; Balladen bei ~80 liegen bei 0,19 s)
  err16: 0.15, // mittlere Abweichung vom 16tel-Raster (in Stufen)
  errFine: 0.12, // Triolen/32tel: strenger
  worst: 0.35, // größte Abweichung einer einzelnen Note
  leadRatio: 1.6, // ein gleichzeitig klingender, mindestens so viel lauterer Ton macht die Note zur Begleitung
  // (dichte Instrumentalsätze spielen die Begleitung fast gleich laut – erst deutlich lautere Töne zählen)
  leadShare: 0.7, // Anteil der Kettentöne, die führen müssen
  candAmp: 0.55, // Töne unter diesem Anteil der mittleren KI-Lautstärke des Liedes sind keine Kandidaten (mind. 0,25)
  chainAmp: 0.7, // mittlere Lautstärke der Kette, als Anteil derselben (mind. 0,28)
};

// notes: [{start, end, midi, amp}] in Sekunden. beatSec: Zeit jedes Schlags (Sekunden).
// attack: reattack(tPrev, tNext, midi) aus makeAttackDetector – ohne Audio bleibt es bei Raster + Gleichmäßigkeit.
// Rückgabe: Map(Note -> {kind: 'run' | 'rep', grid}) für die Noten, die zu einem Lauf/einer Wiederholung gehören.
export function markFastNotes(notes, beatSec, { attack = null, tune = null, why = null } = {}) {
  const T = { ...FAST_TUNE, ...(tune || {}) };
  const no = (reason) => {
    if (why) why[reason] = (why[reason] || 0) + 1;
  };
  const marks = new Map();
  if (!notes.length || !beatSec || beatSec.length < 3) return marks;
  const nb = beatSec.length;
  const beatIdx = (sec) => {
    let lo = 0;
    let hi = nb - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beatSec[mid] <= sec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const blen = (sec) => beatSec[beatIdx(sec) + 1] - beatSec[beatIdx(sec)];
  const pos = (sec) => {
    const i = beatIdx(sec);
    return i + (sec - beatSec[i]) / (beatSec[i + 1] - beatSec[i]);
  };
  // Ströme: der nächste Ton gehört zu dem Strom, dessen letzter Ton ihm in der Tonhöhe am nächsten
  // liegt (höchstens eine Quinte) und höchstens eine Achtel-Triole davor begann
  // KI-Lautstärken sind relativ: in dichten Mischungen liegt der Median bei ~0,4, in klaren bei ~0,6
  const amps = notes.filter((n) => n.midi >= 48 && n.midi <= 96).map((n) => n.amp ?? 0.5).sort((a, b) => a - b);
  const ampRef = amps.length ? amps[Math.floor(amps.length / 2)] : 0.5;
  const minNote = Math.max(0.25, T.candAmp * ampRef);
  const minChain = Math.max(0.28, T.chainAmp * ampRef);
  const cand = notes.filter((n) => (n.amp ?? 0.5) >= minNote && n.midi >= 48 && n.midi <= 96).sort((a, b) => a.start - b.start || a.midi - b.midi);
  // Führt der Ton? Gleichzeitig erklingende, gleich hohe oder höhere Töne, die deutlich lauter sind,
  // machen ihn zur Begleitung (Gitarren-Anschläge, Akkord-Einwürfe) – die gehören nicht zu einem Lauf
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const leads = (n) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].start < n.start - 1.5) lo = mid + 1;
      else hi = mid;
    }
    const a = n.amp ?? 0.5;
    for (let k = lo; k < sorted.length && sorted[k].start <= n.start + 0.05; k++) {
      const o = sorted[k];
      if (o === n || o.midi < n.midi - 12 || o.midi === n.midi) continue;
      const sounding = o.start >= n.start - 0.05 || o.end > n.start + 0.04;
      if (sounding && (o.amp ?? 0.5) > T.leadRatio * a) return false;
    }
    return true;
  };
  const streams = [];
  let active = [];
  for (const n of cand) {
    const bl = blen(n.start);
    active = active.filter((s) => n.start - s[s.length - 1].start <= 0.42 * bl);
    let best = null;
    for (const s of active) {
      const l = s[s.length - 1];
      const d = n.start - l.start;
      if (d < 0.1 * bl) continue;
      // ein Lauf ist einstimmig: der vorige Ton klingt (fast) aus, wenn der nächste kommt
      if (l.end > n.start + 0.07) continue;
      const dp = Math.abs(n.midi - l.midi);
      if (dp > 7) continue;
      if (!best || dp < best.dp || (dp === best.dp && d < best.d)) best = { s, dp, d };
    }
    if (best) best.s.push(n);
    else {
      const s = [n];
      streams.push(s);
      active.push(s);
    }
  }
  // Eine Kette muss gleichmäßig laufen (Abstände nahezu gleich), im Abstand einer Rasterstufe
  // des Schlags und mit ihren Einsätzen genau auf dem Raster liegen. „Schnell“ ist absolut gemeint:
  // 16tel ab Tempo ~97 (Abstand höchstens 155 ms). Langsamere Figuren bleiben bei der
  // Lesbarkeits-Vereinfachung – Gesang ist rhythmisch frei, dort wäre jedes Raster Zufall.
  const gridError = (c, per) => {
    let err = 0;
    let worst = 0;
    const slots = new Set();
    for (const n of c) {
      const q = pos(n.start) * per;
      const e = Math.abs(q - Math.round(q));
      err += e;
      worst = Math.max(worst, e);
      slots.add(Math.round(q));
    }
    return { err: err / c.length, worst, distinct: slots.size === c.length };
  };
  const evalChain = (c) => {
    if (c.length < 2) return;
    const dps = c.slice(1).map((n, i) => n.midi - c[i].midi);
    const changes = dps.filter((d) => d !== 0).length;
    const kind = changes >= Math.ceil(0.5 * dps.length) ? 'run' : 'rep';
    if (c.length === 2 && kind !== 'rep') return;
    // Portamento: Halbtonschritte in einer Richtung, schneller als 100 ms – ein Gleiten, kein Lauf
    if (c.length >= 3 && (c[c.length - 1].start - c[0].start) / (c.length - 1) < 0.1 && dps.every((d) => d === dps[0] && Math.abs(d) === 1)) return;
    // Vibrato/Triller: zwei Tonhöhen im Halbtonabstand hin und her
    if (c.length >= 4 && new Set(c.map((n) => n.midi)).size <= 2 && Math.max(...dps.map(Math.abs)) <= 2 && changes >= 0.7 * dps.length) return;
    if (c.reduce((a, n) => a + (n.amp ?? 0.5), 0) / c.length < minChain) return no('leise');
    if (c.filter(leads).length < T.leadShare * c.length) return no('Begleitung');
    const sp = c.slice(1).map((n, i) => n.start - c[i].start);
    const step = [...sp].sort((a, b) => a - b)[Math.floor(sp.length / 2)];
    const bl = blen(c[0].start);
    // Rasterstufe: Abstand ≈ 1/per Schlag (±15 %); jede Stufe hat ihre eigenen Anforderungen
    let grid = null;
    for (const gr of GRIDS) {
      if (Math.abs((step / bl) * gr.per - 1) > 0.15) continue;
      const fit = gridError(c, gr.per);
      if (!fit.distinct || fit.worst > T.worst) continue;
      if (gr.g === 6) {
        // 16tel: schnell genug und genau; ein Paar gleicher Töne braucht zusätzlich tiefen Einbruch
        if (step > T.maxStep || fit.err > T.err16) continue;
      } else {
        // Triolen/32tel: nur lange Ketten, sehr genau, und das 16tel-Raster passt deutlich schlechter
        if (c.length < (gr.g === 8 ? 4 : 5) || step > 0.23 || fit.err > T.errFine) continue;
        if (gridError(c, 4).err < 0.17) continue;
      }
      grid = gr;
      break;
    }
    if (!grid) return no('Raster/Tempo');
    // Töne eines schnellen Laufs sind nicht viel länger als ihr Abstand (ein gehaltener Ton mit
    // Zierwerk davor/danach oder ein Gesangs-Abfall ist kein Lauf); 32tel/16tel-Triolen strenger
    const maxLen = (grid.g === 6 || grid.g === 8 ? 2 : 1.6) * step;
    const needShort = grid.g === 6 || grid.g === 8 ? 0.8 : 0.9;
    // (der letzte Ton darf lang sein: der Lauf löst sich auf einen gehaltenen Ton auf)
    const body = c.slice(0, -1);
    if (body.filter((n) => n.end - n.start <= maxLen).length < needShort * body.length) return no('Töne zu lang');
    // Wiederholungen brauchen einen echten Anschlag zwischen den Tönen; ein Paar ohne Beleg ist
    // nicht sicher genug
    if (attack) {
      let reps = 0;
      let seen = 0;
      let strong = 0;
      for (let i = 0; i < dps.length; i++) {
        if (dps[i] !== 0) continue;
        reps++;
        const r = attack(c[i].start, c[i + 1].start, c[i].midi);
        if (r.ok) seen++;
        if (r.strong) strong++;
      }
      // (ein Paar gleicher Töne nur mit tiefem Einbruch und steilem Anstieg)
      if (reps && (seen < Math.max(1, Math.ceil(0.6 * reps)) || (c.length === 2 && strong < reps))) return no('kein Anschlag');
    } else if (c.length === 2) return;
    no('erkannt');
    for (const n of c) marks.set(n, { kind, grid: grid.g });
  };
  for (const s of streams) {
    // in gleichmäßig laufende Ketten zerlegen: ein Abstand weicht deutlich vom vorigen ab (die KI
    // setzt Einsätze auf ±20 ms – bei 100 ms Abstand schwanken zwei Nachbarn um bis zu 60 %; das
    // Raster-Kriterium unten prüft die Genauigkeit gegen den Schlag)
    let chain = [s[0]];
    let prevSp = 0;
    for (let i = 1; i < s.length; i++) {
      const d = s[i].start - s[i - 1].start;
      if (prevSp && (d < 0.55 * prevSp || d > 1.8 * prevSp)) {
        evalChain(chain);
        chain = [s[i - 1]];
      }
      chain.push(s[i]);
      prevSp = d;
    }
    evalChain(chain);
  }
  return marks;
}

// Wie viele sehr schnelle, gleichmäßige Tonketten gibt es, wenn der Schlag B Sekunden dauert?
// Ketten aus mindestens vier einstimmig aufeinanderfolgenden Tönen im Abstand von 0,09–0,17 Schlag
// (32tel bis 16tel-Triolen). Regelmäßige Ketten dieser Geschwindigkeit sind bei richtigem Tempo
// selten (Läufe, Tremolo); sie häufen sich, wenn die Erkennung ein halbes Tempo gewählt hat –
// dann sind die Sechzehntel des Liedes zu 32teln geworden.
// notes: rohe KI-Noten [{start, end, midi, amp}] in Sekunden (nicht geglättet: die kurzen Töne
// zählen). Rückgabe: {chains, notes, share} – share = Anteil der Töne in solchen Ketten.
export function fineChains(notes, B) {
  const cand = notes.filter((n) => (n.amp ?? 0.5) >= 0.35 && n.midi >= 48 && n.midi <= 96).sort((a, b) => a.start - b.start || a.midi - b.midi);
  const streams = [];
  let active = [];
  for (const n of cand) {
    active = active.filter((s) => n.start - s[s.length - 1].start <= 0.25 * B);
    let best = null;
    for (const s of active) {
      const l = s[s.length - 1];
      if (n.start - l.start < 0.07 * B || l.end > n.start + 0.07) continue;
      const dp = Math.abs(n.midi - l.midi);
      if (dp > 7) continue;
      if (!best || dp < best.dp) best = { s, dp };
    }
    if (best) best.s.push(n);
    else {
      const s = [n];
      streams.push(s);
      active.push(s);
    }
  }
  let chains = 0;
  let count = 0;
  const flush = (c) => {
    if (c.length < 4) return;
    const sp = c.slice(1).map((n, i) => n.start - c[i].start);
    const med = [...sp].sort((a, b) => a - b)[Math.floor(sp.length / 2)];
    const rel = med / B;
    if (rel < 0.09 || rel > 0.17 || !sp.every((d) => d > 0.72 * med && d < 1.38 * med)) return;
    if (new Set(c.map((n) => n.midi)).size <= 2) return; // Vibrato/Triller
    if (c.reduce((a, n) => a + (n.amp ?? 0.5), 0) / c.length < 0.4) return;
    chains++;
    count += c.length;
  };
  for (const s of cand.length ? streams : []) {
    let c = [s[0]];
    for (let i = 1; i < s.length; i++) {
      const d = (s[i].start - s[i - 1].start) / B;
      if (d > 0.17 || d < 0.07) {
        flush(c);
        c = [s[i]];
      } else c.push(s[i]);
    }
    flush(c);
  }
  return { chains, notes: count, share: cand.length ? count / cand.length : 0 };
}

// Einzelne kurze Töne (Sechzehntel, Staccato): ein Ton unter 120 ms ohne Nachbarn gleicher Tonhöhe
// ist meist ein Einschwing- oder Abklingrest – oder eben eine einzelne Sechzehntel nach einer Pause
// bzw. zwischen längeren Tönen. Erst mehrere Merkmale zusammen machen ihn zur Note:
//  - sein Einsatz liegt genau auf dem 16tel-Raster (±0,15 Stufe),
//  - er ist mindestens so laut wie die typische Note des Liedes und setzt steil ein (≥ 4×),
//  - kein lauterer Ton eine Oktave/Quinte darunter beginnt gleichzeitig (Oberton),
//  - er ist melodisch angebunden: ein lauter, ausgehaltener Ton höchstens 5 Halbtöne entfernt
//    liegt höchstens 0,35 s davor oder danach.
// onsetRise(t, midi) aus makeAttackDetector. Rückgabe: Map(Note -> {kind: 'single', grid: 6}).
// Schwellen (zum Abstimmen an echten Aufnahmen überschreibbar: tune)
export const SINGLE_TUNE = {
  err: 0.15, // größte Abweichung vom 16tel-Raster (in Stufen)
  rise: 4, // Anstieg der Teiltonhüllkurve am Einsatz (Faktor)
  amp: 1.25, // Lautstärke relativ zur typischen Note des Liedes
  linkAmp: 0.9, // ein ausgehaltener Nachbar muss mindestens so laut sein (relativ zur typischen Note)
  linkDur: 0.12, // ... und so lange klingen (s)
  linkDist: 5, // ... und höchstens so viele Halbtöne entfernt sein
  linkGap: 0.35, // ... und höchstens so viele Sekunden davor/danach liegen
};
export function markSingleNotes(notes, beatSec, { onsetRise, tune = null } = {}) {
  const T = { ...SINGLE_TUNE, ...(tune || {}) };
  const marks = new Map();
  if (!notes.length || !beatSec || beatSec.length < 3 || !onsetRise) return marks;
  const amps = notes.filter((n) => n.midi >= 48 && n.midi <= 96).map((n) => n.amp ?? 0.5).sort((a, b) => a - b);
  const med = amps.length ? amps[Math.floor(amps.length / 2)] : 0.5;
  const nb = beatSec.length;
  const pos = (sec) => {
    let lo = 0;
    let hi = nb - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beatSec[mid] <= sec) lo = mid;
      else hi = mid - 1;
    }
    return lo + (sec - beatSec[lo]) / (beatSec[lo + 1] - beatSec[lo]);
  };
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  let first = 0;
  for (const n of sorted) {
    if (n.midi < 55 || n.midi > 90 || n.end - n.start >= 0.12 || (n.amp ?? 0.5) < T.amp * med) continue;
    const q = pos(n.start) * 4;
    if (Math.abs(q - Math.round(q)) > T.err) continue;
    while (first < sorted.length && sorted[first].start < n.start - 1) first++;
    let fragment = false;
    let harm = false;
    let linked = false;
    for (let k = first; k < sorted.length && sorted[k].start <= n.start + 1; k++) {
      const o = sorted[k];
      if (o === n) continue;
      // Fragment eines Tons: gleiche Tonhöhe direkt davor/danach
      if (o.midi === n.midi && ((o.start > n.start && o.start - n.start < 0.4 && o.start - n.end <= 0.15) || (o.start < n.start && n.start - o.start < 0.5 && n.start - o.end <= 0.15))) fragment = true;
      if (Math.abs(o.start - n.start) <= 0.06 && [12, 19, 24, 7, 28].includes(n.midi - o.midi) && (o.amp ?? 0.5) >= 0.8 * (n.amp ?? 0.5)) harm = true;
      if (o.end - o.start >= T.linkDur && (o.amp ?? 0.5) >= T.linkAmp * med && Math.abs(o.midi - n.midi) <= T.linkDist && ((o.end <= n.start + 0.04 && n.start - o.end <= T.linkGap) || (o.start >= n.end - 0.04 && o.start - n.end <= T.linkGap))) linked = true;
    }
    if (fragment || harm || !linked) continue;
    if (onsetRise(n.start, n.midi) < T.rise) continue;
    marks.set(n, { kind: 'single', grid: 6 });
  }
  return marks;
}
