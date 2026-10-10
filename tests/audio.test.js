import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, resampleMono } from '../src/input/audio.js';
import { arrange } from '../src/arrange/engine.js';
import { demoSong } from './helpers.js';
import { performArrangement } from '../src/output/performance.js';
import { synthSong, TEMPOS, drumScore, beatScore, downbeatScore } from './synth-audio.js';

const SR = 22050;

// Testaufnahme synthetisieren: Melodie (Obertonklang) + Bass Drum 1/3, Snare 2/4, Hi-Hat Achtel
function synth(song, { bpm = 100, lead = 0.37, seed = 7, drums = true } = {}) {
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const spb = 60 / bpm;
  const bars = song.measureCount;
  const total = lead + (bars * 4 + 2) * spb;
  const x = new Float32Array(Math.ceil(total * SR));
  const add = (t0, len, fn) => {
    const a = Math.floor(t0 * SR);
    for (let i = 0; i < len * SR && a + i < x.length; i++) if (a + i >= 0) x[a + i] += fn(i / SR);
  };
  const t = (tick) => lead + (tick / 24) * spb;
  for (const n of song.melody) {
    const f = 440 * Math.pow(2, (n.midi - 69) / 12);
    const d = (n.dur / 24) * spb * 0.92;
    add(t(n.start), d, (s) => {
      const env = Math.min(1, s / 0.02) * Math.min(1, (d - s) / 0.03);
      let v = 0;
      for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * s) / h;
      return 0.18 * env * v;
    });
  }
  // Bass (Grundton auf 1 und 3) und leiser Akkord-Teppich
  for (const c of song.chords) {
    for (let tk = c.start; tk < c.start + c.dur; tk += 48) {
      const f = 440 * Math.pow(2, (36 + c.chord.rootPc - 69) / 12);
      const d = Math.min(48, c.start + c.dur - tk) / 24 * spb * 0.9;
      add(t(tk), d, (s) => 0.25 * Math.min(1, s / 0.01, (d - s) / 0.08) * Math.exp(-s / 0.6) * (Math.sin(2 * Math.PI * f * s) + 0.4 * Math.sin(4 * Math.PI * f * s)));
    }
    const d = (c.dur / 24) * spb * 0.95;
    for (const tone of c.chord.tones.slice(0, 3)) {
      const f = 440 * Math.pow(2, (60 + tone.pc - 69) / 12);
      add(t(c.start), d, (s) => 0.03 * Math.min(1, s / 0.05) * Math.min(1, (d - s) / 0.05) * Math.sin(2 * Math.PI * f * s));
    }
  }
  let prev = 0;
  for (let b = 0; b < (drums ? bars * 4 : 0); b++) {
    const tb = lead + b * spb;
    if (b % 2 === 0) add(tb, 0.2, (s) => 0.6 * Math.exp(-s / 0.05) * Math.sin(2 * Math.PI * (50 + 70 * Math.exp(-s / 0.03)) * s));
    else add(tb, 0.15, (s) => Math.exp(-s / 0.04) * (0.35 * rnd() + 0.2 * Math.sin(2 * Math.PI * 200 * s)));
    for (const h of [0, 0.5]) add(tb + h * spb, 0.05, () => {
      const n = rnd();
      const v = n - prev;
      prev = n;
      return 0.12 * v;
    });
  }
  return x;
}

test('Audio-Import: Tempo, Taktanfang, Melodie & Schlagzeug aus einer Aufnahme', () => {
  const src = demoSong('ode');
  const lead = 0.37;
  const audio = synth(src, { bpm: 100, lead });
  const song = transcribe(audio, { title: 'Test' });
  assert.ok(Math.abs(song.tempo - 100) <= 3, `Tempo ${song.tempo}`);
  assert.equal(song.meter.beats, 4);
  // Takt 1 der Datei beginnt bei "lead" Sekunden (±40 ms) – oder einen ganzen Takt später/früher
  const t1 = song.timing.beatSec[song.timing.firstBeat];
  const barSec = 4 * 0.6;
  const off = ((t1 - lead) / barSec) - Math.round((t1 - lead) / barSec);
  assert.ok(Math.abs(off * barSec) < 0.015, `Taktanfang ${t1.toFixed(3)} s`);
  const shiftBars = Math.round((t1 - lead) / barSec);
  // Melodie: Großteil der Töne mit richtiger Tonhöhe an richtiger Stelle
  let hitCount = 0;
  for (const n of src.melody) {
    const tick = n.start - shiftBars * 96;
    if (song.melody.some((m) => Math.abs(m.start - tick) <= 6 && m.midi === n.midi)) hitCount++;
  }
  assert.ok(hitCount / src.melody.length > 0.7, `Melodie ${hitCount}/${src.melody.length}`);
  // rhythmisch exakt: Einsatz genau auf dem richtigen 16tel (für synchrones Playback)
  let exact = 0;
  for (const n of src.melody) if (song.melody.some((m) => m.start === n.start - shiftBars * 96 && m.midi === n.midi)) exact++;
  assert.ok(exact / src.melody.length >= 0.8, `exakte Einsätze ${exact}/${src.melody.length}`);
  // Beats auf ±15 ms genau
  const bs = song.timing.beatSec;
  const errs = bs.slice(2, -2).map((b) => Math.abs(((b - lead) / 0.6 - Math.round((b - lead) / 0.6)) * 0.6));
  assert.ok(Math.max(...errs) < 0.015, `Beat-Abweichung max ${(Math.max(...errs) * 1000).toFixed(1)} ms`);
  // Schlagzeug: Bass Drum auf 1, Snare auf 2 und 4, Hi-Hat in Achteln
  const bar = 4 * 96;
  const inBar = song.drumNotes.filter((d) => d.start >= bar && d.start < bar + 96).map((d) => `${d.start - bar}:${d.midi}`);
  assert.ok(inBar.includes('0:36'), inBar.join(' '));
  assert.ok(inBar.includes('24:38') && inBar.includes('72:38'), inBar.join(' '));
  assert.ok(inBar.includes('12:42') && inBar.includes('60:42'), inBar.join(' '));
});

test('Play-along aus Audio: Noten laufen synchron zur Aufnahme', () => {
  const src = demoSong('ode');
  const lead = 0.37;
  const song = transcribe(synth(src, { bpm: 100, lead }), { title: 'Test' });
  const a = arrange(song, { ensemble: 'solo', playback: true, soloInstrument: 'drums' });
  assert.equal(a.totalBars, song.measureCount + (song.pickup > 0 ? 1 : 0));
  const perf = performArrangement(a);
  // Takt 1 der Vorlage erklingt genau dort, wo er in der Datei liegt
  const bar1 = perf.barToSec(a.sourceOffset / a.mt);
  assert.ok(Math.abs(bar1 - perf.audioStart - song.timing.beatSec[song.timing.firstBeat]) < 0.002);
  void resampleMono;
});

// Schlagzeug mit Variationen: Fills (16tel Snare/Toms) am Ende jeder 4-Takt-Phrase,
// Crash danach, zusätzliche Bass-Drum auf "3+" in jedem dritten Takt der Phrase
function synthDrums(bars, { bpm = 100, lead = 0.4, seed = 5 } = {}) {
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const spb = 60 / bpm;
  const x = new Float32Array(Math.ceil((lead + (bars * 4 + 2) * spb) * SR));
  const add = (t0, len, fn) => {
    const a = Math.floor(t0 * SR);
    for (let i = 0; i < len * SR && a + i < x.length; i++) if (a + i >= 0) x[a + i] += fn(i / SR);
  };
  const kick = (t) => add(t, 0.2, (s) => 0.6 * Math.exp(-s / 0.05) * Math.sin(2 * Math.PI * (50 + 70 * Math.exp(-s / 0.03)) * s));
  const snare = (t, lvl = 1) => add(t, 0.15, (s) => lvl * Math.exp(-s / 0.04) * (0.35 * rnd() + 0.2 * Math.sin(2 * Math.PI * 200 * s)));
  let prev = 0;
  const hat = (t, lvl = 0.12, dec = 0.05) => add(t, dec * 3, (s) => {
    const n = rnd();
    const v = n - prev;
    prev = n;
    return lvl * v * Math.exp(-s / dec);
  });
  for (let b = 0; b < bars; b++) {
    const t0 = lead + b * 4 * spb;
    const fill = b % 4 === 3;
    const crash = b % 4 === 0 && b > 0;
    for (let q = 0; q < 4; q++) {
      const tq = t0 + q * spb;
      if (q === 0 || q === 2) kick(tq);
      if (q === 1 || (q === 3 && !fill)) snare(tq);
      if (!(fill && q === 3)) for (const h of [0, 0.5]) if (!(crash && q === 0 && h === 0)) hat(tq + h * spb);
    }
    if (crash) hat(t0, 0.35, 0.5);
    if (b % 4 === 2) kick(t0 + 2.5 * spb);
    if (fill) for (let k = 0; k < 4; k++) snare(t0 + 3 * spb + (k * spb) / 4, 0.9);
  }
  return x;
}

test('Schlagzeug aus Audio Takt für Takt: Fills, Crash und Variationen wie im Original', () => {
  const bars = 16;
  const lead = 0.4;
  // Band (Melodie, Bass, Akkorde) + Schlagzeug mit Variationen
  const band = synth(demoSong('ode'), { bpm: 100, lead, drums: false });
  const drums = synthDrums(bars, { lead });
  const audio = new Float32Array(Math.max(band.length, drums.length));
  for (let i = 0; i < audio.length; i++) audio[i] = (band[i] || 0) + (drums[i] || 0);
  const song = transcribe(audio, { title: 'Drums' });
  const t1 = song.timing.beatSec[song.timing.firstBeat];
  const shift = Math.round((t1 - lead) / 2.4);
  const inBar = (b) => song.drumNotes.filter((d) => d.start >= (b - shift) * 96 && d.start < (b - shift + 1) * 96).map((d) => ({ t: d.start - (b - shift) * 96, m: d.midi }));
  let fills = 0;
  let crashes = 0;
  let extraKick = 0;
  let falseKick = 0;
  let checked = 0;
  for (let b = 1; b < bars - 1; b++) {
    if (b - shift < 0 || b - shift >= song.measureCount) continue;
    checked++;
    const h = inBar(b);
    if (b % 4 === 3 && h.filter((x) => x.t >= 72 && [38, 48, 45, 41].includes(x.m)).length >= 3) fills++;
    if (b % 4 === 0 && h.some((x) => x.t === 0 && x.m === 49)) crashes++;
    if (h.some((x) => x.t === 60 && x.m === 36)) (b % 4 === 2 ? extraKick++ : falseKick++);
  }
  assert.ok(checked >= 12);
  assert.ok(fills >= 2, `Fills erkannt: ${fills}`);
  assert.ok(crashes >= 2, `Crashes erkannt: ${crashes}`);
  assert.ok(extraKick >= 2, `Variation (Bass Drum 3+): ${extraKick}`);
  assert.ok(falseKick <= 1, `falsche Bass Drums: ${falseKick}`);
});

// Allgemeine Testsammlung: verschiedene Grooves, Taktarten und Tempoverläufe. Verbesserungen
// müssen hier für ALLE Lieder gelten – nicht nur für einen einzelnen Song.
const CORPUS = [
  { name: 'Rock 8tel', groove: 'rock8', bpm: 100 },
  { name: 'Halftime', groove: 'halftime', bpm: 80 },
  { name: 'Shuffle', groove: 'shuffle', bpm: 96, meter: '12/8' },
  { name: 'Walzer schnell', groove: 'waltz', bpm: 150, bars: 24, meter: '3/4' },
  { name: 'Funk 16tel', groove: 'funk', bpm: 104 },
  { name: 'Ride', groove: 'ride8', bpm: 120 },
  { name: 'Ritardando', groove: 'rock8', bpm: 110, tempo: TEMPOS.rit(110, 2, 4, 0.65), marks: ['rit@14'] },
  { name: 'Tempowechsel 96→128', groove: 'rock8', bpm: 96, tempo: TEMPOS.change(96, 128, 32), bars: 20, marks: ['tempo@8'] },
  { name: 'leichtes Schwanken (kein Tempowechsel)', groove: 'rock8', bpm: 112, tempo: TEMPOS.drift(112, 0.05), tempoTol: 8, marks: [] },
  { name: 'nur Schlagzeug', groove: 'rock16', bpm: 118, band: false },
];
for (const c of CORPUS) {
  test(`Audio-Testsammlung: ${c.name} – Tempo, Takt, Beats & Schlagzeug`, () => {
    const s = synthSong({ bars: 16, ...c });
    const song = transcribe(s.audio, { title: c.name });
    // Tempo wird immer in Vierteln angegeben (12/8: punktierte Viertel × 1,5)
    const want = c.meter === '12/8' ? c.bpm * 1.5 : c.bpm;
    assert.ok(Math.abs(song.tempo - want) <= (c.tempoTol || 4), `Tempo ${song.tempo} statt ${want}`);
    assert.equal(`${song.meter.beats}/${song.meter.beatType}`, c.meter || '4/4');
    assert.ok(beatScore(song, s.beatSec) >= 0.93, `Beats ${beatScore(song, s.beatSec)}`);
    assert.ok(downbeatScore(song, s.barSec) >= 0.85, `Taktanfänge ${downbeatScore(song, s.barSec)}`);
    const ds = drumScore(song, s.truth);
    assert.ok(ds.kick.f1 >= 0.8, `Bass Drum F1 ${ds.kick.f1.toFixed(2)}`);
    assert.ok(ds.snare.f1 >= 0.85, `Snare F1 ${ds.snare.f1.toFixed(2)}`);
    assert.ok(ds.hat.f1 >= 0.8, `Hi-Hat/Ride F1 ${ds.hat.f1.toFixed(2)}`);
    assert.ok(!ds.crash || ds.crash.f1 >= 0.7, `Crash F1 ${ds.crash && ds.crash.f1.toFixed(2)}`);
    // Tempoangaben: nur echte Wechsel (rit., neues Tempo), keine für kleine Schwankungen
    const marks = (song.tempoMarks || []).filter((m) => m.bar > 0).map((m) => `${m.kind}@${m.bar}`);
    if (c.marks) assert.deepEqual(marks, c.marks);
    else assert.deepEqual(marks, [], `unerwartete Tempoangaben ${marks}`);
  });
}
