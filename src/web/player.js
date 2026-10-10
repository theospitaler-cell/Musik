// Browser-Wiedergabe (WebAudio) mit Mischpult: Lautstärke, Stumm, Solo, Panorama.
// Einfache, aber charakteristische Klangmodelle je Instrumentenfamilie –
// inkl. hörbarer Effekte (Fall-off, Scoop, Glissando, Shake, Vibrato).
import { performArrangement } from '../output/performance.js';

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function profileFor(inst) {
  if (!inst) return 'drums';
  const id = inst.id;
  if (id === 'tuba' || id === 'sousaphone' || id === 'bassTrombone') return 'lowbrass';
  if (id === 'horn') return 'horn';
  if (inst.family === 'brass') return 'brass';
  if (inst.family === 'sax') return 'sax';
  if (id === 'flute') return 'flute';
  if (id === 'clarinet' || id === 'bassClarinet') return 'clarinet';
  if (id === 'oboe' || id === 'bassoon') return 'reed';
  if (id === 'ebass' || id === 'contrabass') return 'bass';
  if (inst.family === 'string') return 'strings';
  return 'brass';
}

const PROFILES = {
  brass: { types: ['sawtooth'], cutoff: [700, 4200], q: 1.2, attack: 0.03, release: 0.07, vibrato: 0, level: 0.22 },
  lowbrass: { types: ['sawtooth'], cutoff: [300, 1500], q: 0.9, attack: 0.035, release: 0.08, vibrato: 0, level: 0.3 },
  horn: { types: ['triangle', 'sawtooth'], cutoff: [500, 1800], q: 0.7, attack: 0.05, release: 0.12, vibrato: 0, level: 0.26 },
  sax: { types: ['square', 'sawtooth'], cutoff: [900, 3000], q: 2, attack: 0.025, release: 0.08, vibrato: 14, level: 0.16 },
  flute: { types: ['sine', 'triangle'], cutoff: [2500, 6000], q: 0.5, attack: 0.05, release: 0.1, vibrato: 18, level: 0.28 },
  clarinet: { types: ['square'], cutoff: [1200, 2600], q: 0.8, attack: 0.03, release: 0.08, vibrato: 0, level: 0.16 },
  reed: { types: ['sawtooth'], cutoff: [900, 2200], q: 3, attack: 0.03, release: 0.08, vibrato: 10, level: 0.18 },
  strings: { types: ['sawtooth', 'sawtooth'], cutoff: [1600, 4500], q: 0.6, attack: 0.09, release: 0.18, vibrato: 16, level: 0.16, detune: 7 },
  bass: { types: ['triangle'], cutoff: [600, 1400], q: 0.8, attack: 0.005, release: 0.12, vibrato: 0, level: 0.4, pluck: true },
};

export class Player {
  constructor(arr, { onPosition = null, onEnd = null } = {}) {
    this.arr = arr;
    this.perf = performArrangement(arr);
    this.onPosition = onPosition;
    this.onEnd = onEnd;
    this.ctx = null;
    this.playing = false;
    this.speed = 1;
    this.offset = 0; // Position in Sekunden (Partiturzeit)
    this.cursor = 0;
    this.parts = arr.voices.map((v, i) => ({ key: i, name: `${v.label} – ${v.inst.name}`, short: v.inst.short, inst: v.inst, volume: 0.8, mute: false, solo: false, pan: [-0.45, -0.15, 0.15, 0.45][i] }));
    if (arr.drums) this.parts.push({ key: 'drums', name: 'Schlagzeug', short: 'Schlz.', inst: null, volume: 0.7, mute: false, solo: false, pan: 0 });
    this.master = 0.9;
  }

  ensureCtx() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.out = this.ctx.createDynamicsCompressor();
    this.out.threshold.value = -14;
    this.out.ratio.value = 3;
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.master;
    this.out.connect(this.masterGain).connect(this.ctx.destination);
    this.reverb = this.makeReverb();
    this.reverb.connect(this.out);
    for (const p of this.parts) {
      p.gain = this.ctx.createGain();
      p.panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      if (p.panner) {
        p.panner.pan.value = p.pan;
        p.gain.connect(p.panner).connect(this.out);
        const send = this.ctx.createGain();
        send.gain.value = 0.18;
        p.panner.connect(send).connect(this.reverb);
      } else p.gain.connect(this.out);
    }
    this.noise = this.makeNoise();
    this.applyMix();
  }

  makeNoise() {
    const len = this.ctx.sampleRate * 1.5;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  makeReverb() {
    const c = this.ctx.createConvolver();
    const len = Math.floor(this.ctx.sampleRate * 1.6);
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    c.buffer = buf;
    return c;
  }

  // ---- Mischpult ----
  setVolume(key, v) {
    this.part(key).volume = v;
    this.applyMix();
  }
  setMute(key, m) {
    this.part(key).mute = m;
    this.applyMix();
  }
  setSolo(key, s) {
    this.part(key).solo = s;
    this.applyMix();
  }
  setPan(key, pan) {
    const p = this.part(key);
    p.pan = pan;
    if (p.panner) p.panner.pan.value = pan;
  }
  setMaster(v) {
    this.master = v;
    if (this.masterGain) this.masterGain.gain.value = v;
  }
  part(key) {
    return this.parts.find((p) => String(p.key) === String(key));
  }
  applyMix() {
    if (!this.ctx) return;
    const anySolo = this.parts.some((p) => p.solo);
    for (const p of this.parts) {
      const audible = !p.mute && (!anySolo || p.solo);
      p.gain.gain.setTargetAtTime(audible ? p.volume : 0, this.ctx.currentTime, 0.02);
    }
  }

  // ---- Transport ----
  get duration() {
    return this.perf.total;
  }
  position() {
    if (!this.playing) return this.offset;
    return this.offset + (this.ctx.currentTime - this.startedAt) * this.speed;
  }
  play() {
    this.ensureCtx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.playing) return;
    this.playing = true;
    this.startedAt = this.ctx.currentTime + 0.05;
    this.cursor = this.perf.notes.findIndex((n) => n.t >= this.offset - 0.001);
    if (this.cursor < 0) this.cursor = this.perf.notes.length;
    this.timer = setInterval(() => this.schedule(), 40);
    this.schedule();
    const tick = () => {
      if (!this.playing) return;
      const pos = this.position();
      if (this.onPosition) this.onPosition(pos, this.perf.secToBar(pos));
      if (pos >= this.duration) {
        this.stop();
        if (this.onEnd) this.onEnd();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  pause() {
    if (!this.playing) return;
    this.offset = this.position();
    this.playing = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    this.silence();
  }
  stop() {
    this.pause();
    this.offset = 0;
    if (this.onPosition) this.onPosition(0, 0);
  }
  seekSec(sec) {
    const was = this.playing;
    this.pause();
    this.offset = Math.max(0, Math.min(sec, this.duration));
    if (this.onPosition) this.onPosition(this.offset, this.perf.secToBar(this.offset));
    if (was) this.play();
  }
  seekBar(bar) {
    this.seekSec(this.perf.barToSec(bar));
  }
  setSpeed(f) {
    const pos = this.position();
    const was = this.playing;
    this.pause();
    this.speed = f;
    this.offset = pos;
    if (was) this.play();
  }
  silence() {
    if (!this.active) return;
    const now = this.ctx.currentTime;
    for (const n of this.active) {
      try {
        n.g.gain.cancelScheduledValues(now);
        n.g.gain.setTargetAtTime(0, now, 0.02);
        n.stop(now + 0.1);
      } catch {
        /* bereits beendet */
      }
    }
    this.active = [];
  }

  schedule() {
    const ahead = 0.25;
    const nowScore = this.position();
    const notes = this.perf.notes;
    while (this.cursor < notes.length && notes[this.cursor].t < nowScore + ahead * this.speed) {
      const n = notes[this.cursor++];
      if (n.t < nowScore - 0.05) continue;
      const when = this.startedAt + (n.t - this.offset) / this.speed;
      this.voice(n, Math.max(this.ctx.currentTime, when));
    }
    if (this.active && this.active.length > 400) this.active = this.active.filter((x) => x.end > this.ctx.currentTime);
  }

  voice(n, when) {
    const part = this.part(n.part);
    if (!part) return;
    if (n.part === 'drums') return this.drum(n, when, part.gain);
    const prof = PROFILES[profileFor(part.inst)];
    const dur = n.d / this.speed;
    const ctx = this.ctx;
    const g = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = prof.q;
    const v = n.vel / 127;
    const peak = prof.level * (0.35 + 0.65 * v);
    const cutLo = prof.cutoff[0];
    const cutHi = prof.cutoff[0] + (prof.cutoff[1] - prof.cutoff[0]) * v;
    filt.frequency.setValueAtTime(cutLo, when);
    filt.frequency.linearRampToValueAtTime(cutHi, when + prof.attack * 2);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + prof.attack);
    const end = when + dur;
    if (prof.pluck) {
      g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak * 0.15), Math.min(end, when + 0.6));
    } else g.gain.setValueAtTime(peak * 0.85, Math.max(when + prof.attack, end - prof.release));
    g.gain.linearRampToValueAtTime(0.0001, end + prof.release);
    filt.connect(g).connect(part.gain);
    const f = mtof(n.midi);
    const oscs = prof.types.map((type, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, when);
      if (prof.detune) o.detune.value = i ? prof.detune : -prof.detune;
      o.connect(filt);
      return o;
    });
    // Effekte
    const fx = n.fx || {};
    const setAll = (fn) => oscs.forEach(fn);
    if (fx.scoop) setAll((o) => {
      o.frequency.setValueAtTime(f * Math.pow(2, fx.scoop / 12), when);
      o.frequency.exponentialRampToValueAtTime(f, when + Math.min(0.12, dur / 2));
    });
    if (fx.fall) setAll((o) => {
      const st = Math.max(when + 0.05, end - 0.18);
      o.frequency.setValueAtTime(f, st);
      o.frequency.exponentialRampToValueAtTime(f * Math.pow(2, fx.fall / 12), end + 0.08);
    });
    if (fx.glideTo !== undefined) setAll((o) => {
      const st = when + dur * 0.55;
      o.frequency.setValueAtTime(f, st);
      o.frequency.exponentialRampToValueAtTime(mtof(fx.glideTo), end);
    });
    if (fx.shake || prof.vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = fx.shake ? 7.5 : 5.4;
      lfo.type = fx.shake ? 'square' : 'sine';
      depth.gain.setValueAtTime(0, when);
      depth.gain.linearRampToValueAtTime(fx.shake ? fx.shake * 50 : prof.vibrato, when + Math.min(0.35, dur * 0.6));
      lfo.connect(depth);
      setAll((o) => depth.connect(o.detune));
      lfo.start(when);
      lfo.stop(end + prof.release + 0.05);
    }
    oscs.forEach((o) => {
      o.start(when);
      o.stop(end + prof.release + 0.05);
    });
    const handle = { g, end: end + prof.release, stop: (t) => oscs.forEach((o) => o.stop(t)) };
    (this.active ||= []).push(handle);
  }

  drum(n, when, dest) {
    const ctx = this.ctx;
    const v = n.vel / 127;
    const g = ctx.createGain();
    g.connect(dest);
    const noise = (hp, lp, decay, level) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f1 = ctx.createBiquadFilter();
      f1.type = 'highpass';
      f1.frequency.value = hp;
      const f2 = ctx.createBiquadFilter();
      f2.type = 'lowpass';
      f2.frequency.value = lp;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(level * v, when);
      ng.gain.exponentialRampToValueAtTime(0.0005, when + decay);
      src.connect(f1).connect(f2).connect(ng).connect(g);
      src.start(when, Math.random() * 0.5);
      src.stop(when + decay + 0.05);
    };
    const tone = (f0, f1, decay, level, type = 'sine') => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, when);
      o.frequency.exponentialRampToValueAtTime(f1, when + decay * 0.8);
      const og = ctx.createGain();
      og.gain.setValueAtTime(level * v, when);
      og.gain.exponentialRampToValueAtTime(0.0005, when + decay);
      o.connect(og).connect(g);
      o.start(when);
      o.stop(when + decay + 0.05);
    };
    switch (n.midi) {
      case 36:
        tone(140, 45, 0.28, 0.9);
        break;
      case 38:
        noise(900, 9000, 0.16, 0.5);
        tone(210, 160, 0.09, 0.35, 'triangle');
        break;
      case 37:
        tone(1800, 1600, 0.03, 0.25, 'square');
        break;
      case 42:
        noise(7000, 16000, 0.05, 0.22);
        break;
      case 44:
        noise(6000, 14000, 0.04, 0.16);
        break;
      case 46:
        noise(6000, 16000, 0.35, 0.22);
        break;
      case 49:
        noise(3500, 16000, 1.4, 0.32);
        break;
      case 51:
        noise(5000, 12000, 0.45, 0.14);
        tone(2400, 2300, 0.35, 0.05);
        break;
      case 48:
        tone(230, 160, 0.25, 0.6);
        break;
      case 45:
        tone(170, 120, 0.28, 0.6);
        break;
      case 41:
        tone(110, 80, 0.35, 0.65);
        break;
      default:
        noise(2000, 8000, 0.1, 0.2);
    }
  }

  dispose() {
    this.stop();
    if (this.ctx) this.ctx.close();
    this.ctx = null;
  }
}
