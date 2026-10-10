import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, resampleMono } from '../src/input/audio.js';
import { arrange } from '../src/arrange/engine.js';
import { demoSong } from './helpers.js';
import { performArrangement } from '../src/output/performance.js';

const SR = 22050;

// Testaufnahme synthetisieren: Melodie (Obertonklang) + Bass Drum 1/3, Snare 2/4, Hi-Hat Achtel
function synth(song, { bpm = 100, lead = 0.37, seed = 7 } = {}) {
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
  for (let b = 0; b < bars * 4; b++) {
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
  assert.ok(Math.abs(off * barSec) < 0.04, `Taktanfang ${t1.toFixed(3)} s`);
  const shiftBars = Math.round((t1 - lead) / barSec);
  // Melodie: Großteil der Töne mit richtiger Tonhöhe an richtiger Stelle
  let hitCount = 0;
  for (const n of src.melody) {
    const tick = n.start - shiftBars * 96;
    if (song.melody.some((m) => Math.abs(m.start - tick) <= 6 && m.midi === n.midi)) hitCount++;
  }
  assert.ok(hitCount / src.melody.length > 0.7, `Melodie ${hitCount}/${src.melody.length}`);
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
