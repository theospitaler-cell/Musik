// Schnelle Läufe und Tonwiederholungen: Anschlag-Erkennung (Transienten), Muster auf dem Raster,
// Rettung kurzer Noten, Lesbarkeits-Vereinfachung lässt sie unangetastet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAttackDetector, markFastNotes } from '../src/input/fast.js';
import { tidyAiNotes, withFastNotes, simplifyLine } from '../src/input/voices.js';
import { transcribe } from '../src/input/audio.js';
import { synthSong } from './synth-audio.js';

const SR = 22050;
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Ton mit Obertönen und kurzer Hüllkurve in x einmischen
function tone(x, t0, t1, midi, amp = 0.2) {
  const a = Math.floor(t0 * SR);
  const z = Math.min(x.length, Math.floor(t1 * SR));
  const f = hz(midi);
  const len = (t1 - t0) * SR;
  for (let i = a; i < z; i++) {
    const s = (i - a) / SR;
    const env = Math.min(1, s / 0.006) * Math.min(1, (len - (i - a)) / (0.012 * SR));
    let v = 0;
    for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * s) / h;
    x[i] += amp * env * v;
  }
}

test('Anschlag-Erkennung: zwei Anschläge mit Lücke ja, ein gehaltener Ton nein', () => {
  const x = new Float32Array(SR * 2);
  tone(x, 0.2, 0.55, 72); // C5
  tone(x, 0.62, 1.0, 72); // gleicher Ton, neuer Anschlag nach 70 ms Lücke
  tone(x, 1.2, 1.9, 76); // E5 gehalten
  const det = makeAttackDetector(x, SR);
  const re = det.reattack(0.2, 0.62, 72);
  assert.ok(re.ok && re.strong, `Neuanschlag erkannt (Tiefe ${re.depth.toFixed(2)}, Anstieg ${re.rise.toFixed(1)})`);
  const held = det.reattack(1.2, 1.55, 76);
  assert.ok(!held.ok, `gehaltener Ton ist kein Anschlag (Tiefe ${held.depth.toFixed(2)})`);
});

// Schlag-Raster: 120 BPM
const beatSec = Array.from({ length: 80 }, (_, i) => i * 0.5);
const note = (start, midi, dur = 0.11, amp = 0.7) => ({ start, end: start + dur, midi, amp });
const run = (t0, midis, step) => midis.map((m, i) => note(t0 + i * step, m));
const yes = () => ({ ok: true, strong: true, depth: 0.9, rise: 5 });
const no = () => ({ ok: false, strong: false, depth: 0.02, rise: 1.1 });

test('Muster: 16tel-Lauf (Tonleiter) wird erkannt, auch wenn die Töne unter 120 ms kurz sind', () => {
  const notes = run(2.0, [72, 74, 76, 77, 79, 81, 83, 84], 0.125);
  const m = markFastNotes(notes, beatSec);
  assert.equal(m.size, 8);
  assert.ok([...m.values()].every((v) => v.kind === 'run' && v.grid === 6));
});

test('Muster: Achtel-Triolen (Abstand 167 ms) liegen auf dem Triolen-Raster', () => {
  const notes = run(4.0, [79, 77, 76, 74, 72, 71], 0.5 / 3);
  const m = markFastNotes(notes, beatSec);
  assert.equal(m.size, 6);
  assert.ok([...m.values()].every((v) => v.grid === 8));
});

test('Muster: Tonwiederholungen brauchen einen echten Anschlag dazwischen', () => {
  const notes = run(3.0, [76, 76, 76, 76, 76], 0.125);
  assert.equal(markFastNotes(notes, beatSec, { attack: yes }).size, 5);
  assert.equal(markFastNotes(notes, beatSec, { attack: no }).size, 0, 'ohne Einbruch: ein Ton, den die KI zerlegt hat');
  const m = markFastNotes(notes, beatSec, { attack: yes });
  assert.ok([...m.values()].every((v) => v.kind === 'rep'));
});

test('Muster: Gesang, Gleiten und Vibrato sind keine Läufe', () => {
  // langsamer als 155 ms (Balladen-16tel bei Tempo 79)
  const slow = Array.from({ length: 80 }, (_, i) => i * 0.76);
  assert.equal(markFastNotes(run(3.0, [72, 74, 76, 77], 0.19), slow).size, 0);
  // Achtel bleiben Achtel
  assert.equal(markFastNotes(run(3.0, [72, 74, 76, 77], 0.25), beatSec).size, 0);
  // unregelmäßige Abstände
  const irr = [note(3.0, 72), note(3.1, 74), note(3.32, 76), note(3.43, 77)];
  assert.equal(markFastNotes(irr, beatSec).size, 0);
  // Vibrato: zwei Tonhöhen im Halbtonabstand hin und her
  assert.equal(markFastNotes(run(3.0, [63, 64, 63, 64, 63, 64], 0.125), beatSec).size, 0);
  // Portamento: Halbtonschritte schneller als 100 ms
  assert.equal(markFastNotes(run(3.0, [72, 73, 74, 75, 76], 0.07), beatSec).size, 0);
  // Töne unter einem deutlich lauteren Ton sind Begleitung
  const loud = run(3.0, [72, 74, 76, 77, 79], 0.125);
  const under = run(3.0, [72, 74, 76, 77, 79], 0.125).map((n) => ({ ...n, midi: n.midi + 7, amp: 1.0 }));
  assert.equal(markFastNotes([...loud.map((n) => ({ ...n, amp: 0.45 })), ...under], beatSec).size, [...under].length, 'nur die lauten (oberen) Töne bleiben');
});

test('Muster: Instrumentalläufe bei Tempo 94 und in dichten, leisen Mischungen bleiben erhalten', () => {
  // 94 BPM: Sechzehntel im Abstand von 160 ms (Gesang in Balladen bei Tempo 79 liegt bei 190 ms)
  const b94 = Array.from({ length: 80 }, (_, i) => i * (60 / 94));
  const step = 60 / 94 / 4;
  const lick = run((8 * 60) / 94, [67, 69, 71, 72, 74, 72, 71, 69], step); // beginnt auf Schlag 9
  assert.equal(markFastNotes(lick, b94).size, 8, '16tel-Lauf bei Tempo 94');
  // dichte Mischung: alle KI-Lautstärken liegen um 0,3 – der Lauf ist relativ gesehen genauso laut
  const quiet = lick.map((n) => ({ ...n, amp: 0.32 }));
  const filler = Array.from({ length: 40 }, (_, i) => note(10 + i * 0.5, 55 + (i % 5), 0.3, 0.3));
  assert.equal(markFastNotes([...quiet, ...filler], b94).size, 8, 'leiser Lauf in leiser Mischung');
  // Begleitung, die nur etwas lauter ist (1,4×), nimmt dem Lauf die Führung nicht – eine deutlich lautere (2×) schon
  const near = lick.map((n) => ({ ...n, midi: n.midi + 4, amp: n.amp * 1.4 }));
  assert.equal(markFastNotes([...lick, ...near], b94).size, 16, 'beide Linien laufen (Terzen, fast gleich laut)');
  const loud = lick.map((n) => ({ ...n, midi: n.midi + 4, amp: Math.min(1, n.amp * 2.2) }));
  assert.equal(markFastNotes([...lick.map((n) => ({ ...n, amp: 0.4 })), ...loud], b94).size, 8, 'nur die laute Linie');
});

test('KI-Rohnoten: Splitter + gleicher Ton ohne Anschlag = ein Ton ab dem früheren Einsatz', () => {
  const ai = [
    { start: 1.0, end: 1.08, midi: 63, amp: 0.7 }, // Doppel-Trigger: Beginn des Tons
    { start: 1.08, end: 1.4, midi: 63, amp: 0.74 },
  ];
  const merged = tidyAiNotes(ai, { attack: no });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].start, 1.0);
  assert.equal(merged[0].end, 1.4);
  // mit Anschlag dazwischen: der Splitter bleibt ein Splitter (weg), der Ton beginnt bei seinem Einsatz
  const kept = tidyAiNotes(ai, { attack: yes });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].start, 1.08);
  // ohne Audio: wie bisher
  assert.equal(tidyAiNotes(ai)[0].start, 1.08);
});

test('KI-Rohnoten: Halte-Regel verschmilzt Vibrato-Abrisse, aber keine tiefe Lücke mit steilem Anstieg', () => {
  const ai = [
    { start: 2.0, end: 2.5, midi: 72, amp: 0.7 },
    { start: 2.55, end: 3.0, midi: 72, amp: 0.65 },
  ];
  const vib = tidyAiNotes(ai, { attack: () => ({ ok: true, strong: false, depth: 0.4, rise: 1.5 }) });
  assert.equal(vib.length, 1, 'mäßiger Einbruch: Vibrato');
  const restrike = tidyAiNotes(ai, { attack: yes });
  assert.equal(restrike.length, 2, 'tiefe Lücke: zwei Töne');
});

test('Lesbarkeit: schnelle Noten behalten Einsatz und Wert, die Umgebung wird weiter vereinfacht', () => {
  const fast = (start, midi, grid = 6) => ({ start, dur: grid, midi, fast: 'run', grid });
  const line = [
    { start: 0, dur: 12, midi: 60 },
    fast(12, 62),
    fast(18, 64),
    fast(24, 65),
    fast(30, 67),
    { start: 42, dur: 6, midi: 69 }, // Splitter zwischen zwei Achteln – entfällt wie bisher
    { start: 48, dur: 24, midi: 71 },
  ];
  const out = simplifyLine(line, { beat: 24, allowPush: true });
  const by = new Map(out.map((n) => [n.start, n]));
  for (const t of [12, 18, 24, 30]) assert.equal(by.get(t)?.dur, 6, `16tel bei ${t}`);
  assert.ok(!by.has(42), 'Durchgangs-Splitter entfällt');
  // Triolen behalten ihre 8 Ticks
  const tri = simplifyLine([fast(0, 72, 8), fast(8, 71, 8), fast(16, 69, 8), { start: 24, dur: 24, midi: 67 }], { beat: 24 });
  assert.deepEqual(tri.slice(0, 3).map((n) => [n.start, n.dur]), [[0, 8], [8, 8], [16, 8]]);
  // gleiche Töne als schnelle Wiederholung verschmelzen nicht
  const rep = simplifyLine([fast(0, 72), fast(6, 72), fast(12, 72), fast(18, 72), { start: 24, dur: 24, midi: 67 }], { beat: 24, mergeRepeats: true });
  assert.equal(rep.filter((n) => n.midi === 72).length, 4);
  // withFastNotes: kurze Noten eines Musters kommen zurück, Rest bleibt weg
  const raw = [...run(2.0, [72, 74, 76, 77, 79], 0.125), note(5.0, 60, 0.05)];
  const marks = markFastNotes(raw, beatSec);
  const back = withFastNotes(tidyAiNotes(raw), marks);
  assert.equal(back.filter((n) => n.fast).length, 5);
  assert.ok(!back.some((n) => n.midi === 60));
});

// ---------- Ganze Kette: Audio + KI-Noten -> Noten im Taktraster ----------
function fastSong({ bpm = 120, patterns }) {
  const bars = patterns.length + 2;
  const s = synthSong({ groove: 'rock8', bars, bpm, band: false, fills: false, crashEvery: 0, seed: 5 });
  const x = s.audio;
  const tickSec = (tick) => {
    const b = tick / 24;
    const i = Math.floor(b);
    return s.beatSec[i] + (b - i) * (s.beatSec[i + 1] - s.beatSec[i]);
  };
  const truth = [];
  const ai = [];
  patterns.forEach((p, bi) => {
    const base = (bi + 1) * 96;
    for (const [t, midi, dur, stac] of p) {
      const t0 = tickSec(base + t);
      const t1 = tickSec(base + t + dur);
      const len = (t1 - t0) * (stac ? 0.55 : 0.92);
      tone(x, t0, t0 + len, midi, 0.22);
      truth.push({ tick: base + t, midi, dur, sec: t0 });
      // so hört die KI schnelle Töne: Anfang gut, Ende etwas kurz
      ai.push({ start: t0 + 0.004, end: t0 + Math.max(0.058, len * 0.95), midi, amp: 0.7 });
    }
    // Bass auf 1 und 3 (KI-Noten, damit „KI vorhanden“ gilt)
    for (const q of [0, 48]) {
      const t0 = tickSec(base + q);
      ai.push({ start: t0, end: t0 + 0.4, midi: 36 + (bi % 2) * 5, amp: 0.8 });
    }
  });
  // Auftakt-Takt und Schlussklang, damit Beat-Tracking & Form Anker haben
  return { audio: x, truth, ai: ai.sort((a, b) => a.start - b.start), bpm };
}

test('Aufnahme -> Noten: 16tel-Läufe und Tonwiederholungen bei Tempo 120 bleiben erhalten', () => {
  const P = [
    // Wiederholungen: 8 × 16tel Staccato, dann Viertel
    [...Array.from({ length: 8 }, (_, i) => [i * 6, 76, 6, true]), [48, 79, 24], [72, 77, 24]],
    // aufsteigender 16tel-Lauf
    [...[72, 74, 76, 77, 79, 81, 83, 84].map((m, i) => [i * 6, m, 6]), [48, 84, 48]],
    // Triolen
    [...[79, 77, 76, 74, 72, 71].map((m, i) => [i * 8, m, 8]), [48, 76, 24], [72, 74, 24]],
    // Wiederholung und Lauf gemischt
    [...Array.from({ length: 4 }, (_, i) => [i * 6, 72, 6, true]), ...[74, 76, 77, 79].map((m, i) => [24 + i * 6, m, 6]), [48, 81, 48]],
  ];
  const f = fastSong({ bpm: 120, patterns: P });
  const song = transcribe(f.audio, { title: 'Schnell', ai: f.ai });
  assert.ok(Math.abs(song.tempo - 120) <= 3, `Tempo ${song.tempo}`);
  const { beatSec: bs, firstBeat, beatTicks } = song.timing;
  const tickOf = (sec) => {
    let i = 0;
    while (i < bs.length - 2 && sec >= bs[i + 1]) i++;
    return (i + (sec - bs[i]) / (bs[i + 1] - bs[i]) - firstBeat) * beatTicks;
  };
  let hit = 0;
  let exactDur = 0;
  const fastTruth = f.truth.filter((t) => t.dur <= 8);
  for (const t of fastTruth) {
    const k = tickOf(t.sec);
    const n = song.melody.find((m) => m.midi === t.midi && Math.abs(m.start - k) <= 1.5);
    if (n) {
      hit++;
      if (n.dur === t.dur) exactDur++;
    }
  }
  assert.ok(hit / fastTruth.length >= 0.95, `schnelle Töne erhalten: ${hit}/${fastTruth.length}`);
  assert.ok(exactDur / fastTruth.length >= 0.85, `Notenwerte stimmen: ${exactDur}/${fastTruth.length}`);
  // kein Verschleifen: gleiche Töne bleiben getrennte Anschläge (keine lange Note aus acht 16teln)
  const longest = Math.max(...song.melody.filter((m) => m.midi === 76).map((m) => m.dur));
  assert.ok(longest <= 24, `längste E-Note ${longest} Ticks`);
});

// ---------- Halbes Tempo bei schnellen Liedern (ab ~150 BPM) ----------
// Melodie (16tel-Wiederholungen, Läufe, Triolen) über Rock-Schlagzeug; dazu die KI-Noten, wie sie
// die lokale KI liefert (Einsatz leicht verzögert, Ton mindestens 58 ms)
function mixSong(bpm) {
  const C5 = 72;
  const SC = [0, 2, 4, 5, 7, 9, 11, 12];
  const scale = (from, k) => from + SC[k % 8] + 12 * Math.floor(k / 8);
  const rep = (n, midi, step, d) => Array.from({ length: n }, (_, i) => [i * step, midi, d, 'stac']);
  const pat = {
    rep16: () => [...rep(8, C5 + 4, 6, 6), [48, C5 + 7, 24], [72, C5 + 5, 24]],
    run16: () => [...Array.from({ length: 8 }, (_, i) => [i * 6, scale(C5, i), 6]), [48, C5 + 12, 48]],
    rep8: () => [...rep(4, C5 + 2, 12, 12), [48, C5, 48]],
    down: () => [...Array.from({ length: 8 }, (_, i) => [i * 6, scale(C5, 7 - i), 6]), [48, C5, 48]],
    tri8: () => [...Array.from({ length: 6 }, (_, i) => [i * 8, scale(C5, 5 - i), 8]), [48, C5 + 4, 24], [72, C5 + 2, 24]],
  };
  const order = ['rep16', 'run16', 'rep8', 'down', 'tri8', 'run16', 'rep16', 'down'];
  const s = synthSong({ groove: 'rock8', bars: order.length + 2, bpm, band: false, fills: false, crashEvery: 0, seed: 4 });
  const x = s.audio;
  const tickSec = (tick) => {
    const b = tick / 24;
    const i = Math.floor(b);
    return s.beatSec[i] + (b - i) * (s.beatSec[i + 1] - s.beatSec[i]);
  };
  const add = (t0, len, fn) => {
    const a = Math.floor(t0 * SR);
    for (let i = 0; i < len * SR && a + i < x.length; i++) if (a + i >= 0) x[a + i] += fn(i / SR);
  };
  const truth = [];
  const ai = [];
  order.forEach((name, bi) => {
    const base = (bi + 1) * 96;
    for (const [t, midi, dur, stac] of pat[name]()) {
      const t0 = tickSec(base + t);
      const t1 = tickSec(base + t + dur);
      const len = (t1 - t0) * (stac ? 0.55 : 0.92);
      const f = hz(midi);
      add(t0, len, (sec) => {
        const env = Math.min(1, sec / 0.008) * Math.min(1, (len - sec) / 0.015);
        let v = 0;
        for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * sec) / h;
        return 0.22 * env * v;
      });
      truth.push({ midi, dur, sec: t0 });
      ai.push({ start: t0 + 0.004, end: t0 + Math.max(0.058, len * 0.95), midi, amp: 0.7 });
    }
    for (const p of [0, 48]) {
      const f = 65.4 * (bi % 2 ? 1.335 : 1);
      const t0 = tickSec(base + p);
      const d = (tickSec(base + p + 48) - t0) * 0.9;
      add(t0, d, (sec) => 0.2 * Math.min(1, sec / 0.01, (d - sec) / 0.08) * Math.exp(-sec / 0.6) * (Math.sin(2 * Math.PI * f * sec) + 0.4 * Math.sin(4 * Math.PI * f * sec)));
      ai.push({ start: t0, end: t0 + 0.4, midi: 36 + (bi % 2) * 5, amp: 0.8 });
    }
  });
  return { audio: x, truth, ai: ai.sort((a, b) => a.start - b.start) };
}

test('Halbes Tempo: schnelle Lieder (150, 160 BPM) werden mit den KI-Noten auf das richtige Tempo korrigiert', () => {
  for (const bpm of [150, 160, 170]) {
    const f = mixSong(bpm);
    const song = transcribe(f.audio, { title: 'Schnell', ai: f.ai });
    assert.ok(Math.abs(song.tempo - bpm) <= 0.04 * bpm, `Soll ${bpm}, erkannt ${song.tempo}`);
    assert.equal(song.meter.beats, 4, `Takt ${song.meter.beats}/${song.meter.beatType} bei ${bpm}`);
    // die schnellen Töne (16tel, Triolen) stehen auf ihrem Raster
    const { beatSec: bs, firstBeat, beatTicks } = song.timing;
    const tickOf = (sec) => {
      let i = 0;
      while (i < bs.length - 2 && sec >= bs[i + 1]) i++;
      return (i + (sec - bs[i]) / (bs[i + 1] - bs[i]) - firstBeat) * beatTicks;
    };
    const fast = f.truth.filter((t) => t.dur <= 8);
    const hit = fast.filter((t) => song.melody.some((m) => m.midi === t.midi && Math.abs(m.start - tickOf(t.sec)) <= 1.5)).length;
    assert.ok(hit / fast.length >= 0.9, `bei ${bpm} BPM: ${hit}/${fast.length} schnelle Töne`);
  }
});

test('Halbes Tempo: ein echtes langsames Lied mit dichten Sechzehteln wird nicht verdoppelt', () => {
  // 80 BPM, Sechzehntel-Läufe (Abstand 188 ms = 0,25 Schlag) – kein 32tel-Material
  const bpm = 80;
  const s = synthSong({ groove: 'rock8', bars: 8, bpm, band: false, fills: false, crashEvery: 0, seed: 4 });
  const tickSec = (tick) => {
    const b = tick / 24;
    const i = Math.floor(b);
    return s.beatSec[i] + (b - i) * (s.beatSec[i + 1] - s.beatSec[i]);
  };
  const ai = [];
  for (let bar = 1; bar < 7; bar++) {
    [72, 74, 76, 77, 79, 77, 76, 74].forEach((m, i) => {
      const t0 = tickSec(bar * 96 + i * 6);
      tone(s.audio, t0, t0 + 0.16, m, 0.22);
      ai.push({ start: t0 + 0.004, end: t0 + 0.16, midi: m, amp: 0.7 });
    });
    for (const q of [0, 48]) {
      const t0 = tickSec(bar * 96 + q);
      ai.push({ start: t0, end: t0 + 0.9, midi: 36, amp: 0.8 });
    }
  }
  ai.sort((a, b) => a.start - b.start);
  const song = transcribe(s.audio, { title: 'Langsam', ai });
  assert.ok(song.tempo < 100, `Tempo ${song.tempo} – nicht verdoppelt`);
  assert.ok(!song.warnings.some((w) => w.startsWith('Tempo auf')), 'keine Tempo-Korrektur');
});
