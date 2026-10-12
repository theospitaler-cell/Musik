// Klangerzeugung (WebAudio) – gemeinsam für die Live-Wiedergabe (AudioContext) und den
// Audio-Export (OfflineAudioContext → MP3). Einfache, aber charakteristische Klangmodelle
// je Instrumentenfamilie – inkl. hörbarer Effekte (Fall-off, Scoop, Glissando, Shake, Vibrato).

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function profileFor(inst) {
  if (!inst) return 'drums';
  const id = inst.id;
  if (id === 'piano') return 'piano';
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

// Original-Spuren (Play-along): Klang nach General-MIDI-Programm
export function profileForProgram(p) {
  if (p <= 7) return 'piano';
  if (p >= 16 && p <= 23) return 'organ';
  if (p >= 24 && p <= 31) return 'guitar';
  if (p >= 32 && p <= 39) return 'bass';
  if (p >= 40 && p <= 55) return 'strings';
  if (p >= 56 && p <= 63) return 'brass';
  if (p >= 64 && p <= 71) return 'sax';
  if (p >= 72 && p <= 79) return 'flute';
  return 'pad';
}

// GM-Percussion -> Klangmodell
const DRUM_SYNTH = { 35: 36, 40: 38, 39: 38, 43: 41, 47: 45, 50: 48, 52: 49, 55: 49, 57: 49, 53: 51, 59: 51 };

export const PROFILES = {
  piano: { types: ['triangle', 'square'], cutoff: [900, 3800], q: 0.6, attack: 0.004, release: 0.25, vibrato: 0, level: 0.14, pluck: true },
  guitar: { types: ['sawtooth'], cutoff: [700, 2600], q: 1.4, attack: 0.004, release: 0.15, vibrato: 0, level: 0.12, pluck: true },
  organ: { types: ['square', 'sine'], cutoff: [1200, 2400], q: 0.5, attack: 0.02, release: 0.06, vibrato: 0, level: 0.1 },
  pad: { types: ['sawtooth', 'triangle'], cutoff: [600, 1600], q: 0.5, attack: 0.12, release: 0.3, vibrato: 0, level: 0.1, detune: 9 },
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

export function makeNoise(ctx) {
  const len = ctx.sampleRate * 1.5;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export function makeReverb(ctx) {
  const c = ctx.createConvolver();
  const len = Math.floor(ctx.sampleRate * 1.6);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  c.buffer = buf;
  return c;
}

// Der Kompressor (DynamicsCompressorNode) schaut 6 ms voraus und verzögert damit alles um 6 ms
// (Noten und Aufnahme gleich – für Anzeige und Export wird das ausgeglichen; gemessen).
export const COMPRESSOR_DELAY = 0.006;

// Mischpult-Graph: je Stimme Lautstärke -> Panorama -> Kompressor (+ Hall-Anteil) -> Gesamt.
// parts: [{key, pan}] – liefert {out, masterGain, reverb, noise, nodes: Map(key -> {gain, panner})}
export function buildGraph(ctx, parts, { master = 0.9 } = {}) {
  const out = ctx.createDynamicsCompressor();
  out.threshold.value = -14;
  out.ratio.value = 3;
  const masterGain = ctx.createGain();
  masterGain.gain.value = master;
  out.connect(masterGain).connect(ctx.destination);
  const reverb = makeReverb(ctx);
  reverb.connect(out);
  const nodes = new Map();
  for (const p of parts) {
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = p.pan || 0;
      gain.connect(panner).connect(out);
      const send = ctx.createGain();
      send.gain.value = 0.18;
      panner.connect(send).connect(reverb);
    } else gain.connect(out);
    nodes.set(String(p.key), { gain, panner });
  }
  return { out, masterGain, reverb, nodes, noise: makeNoise(ctx) };
}

// Klangmodell einer Note (Stimme des Arrangements oder Original-Spur)
export function profileOf(part, n) {
  return PROFILES[part.orig ? profileForProgram(n.prog ?? 0) : profileFor(part.inst)];
}

// Einen Ton (Note aus performArrangement) zur Kontextzeit "when" auf "dest" spielen.
// speed < 1: langsamer (Übe-Tempo) – die Dauer wird entsprechend gestreckt.
// Liefert einen Griff zum vorzeitigen Ausblenden (Pause) oder null (Schlagzeug).
export function playNote(ctx, n, when, dest, prof, speed = 1) {
  const dur = n.d / speed;
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
  filt.connect(g).connect(dest);
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
  if (fx.scoop)
    setAll((o) => {
      o.frequency.setValueAtTime(f * Math.pow(2, fx.scoop / 12), when);
      o.frequency.exponentialRampToValueAtTime(f, when + Math.min(0.12, dur / 2));
    });
  if (fx.fall)
    setAll((o) => {
      const st = Math.max(when + 0.05, end - 0.18);
      o.frequency.setValueAtTime(f, st);
      o.frequency.exponentialRampToValueAtTime(f * Math.pow(2, fx.fall / 12), end + 0.08);
    });
  if (fx.glideTo !== undefined)
    setAll((o) => {
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
  return { g, end: end + prof.release, stop: (t) => oscs.forEach((o) => o.stop(t)) };
}

// Schlagzeug (GM-Percussion), noiseBuf aus makeNoise()
export function playDrum(ctx, n, when, dest, noiseBuf) {
  const v = n.vel / 127;
  const g = ctx.createGain();
  g.connect(dest);
  const noise = (hp, lp, decay, level) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
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
  switch (DRUM_SYNTH[n.midi] || n.midi) {
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
  return null;
}

// Note einer Stimme (part aus Player.parts) über deren Mischpult-Kanal spielen
export function scheduleNote(ctx, part, dest, n, when, { speed = 1, noise } = {}) {
  if (n.drum) return playDrum(ctx, n, when, dest, noise);
  return playNote(ctx, n, when, dest, profileOf(part, n), speed);
}

// Tempo-Strecker (AudioWorklet) für die Original-Aufnahme laden – pro Kontext einmal.
// Liefert false, wenn der Browser keine AudioWorklets kann (dann Media-Element als Rückfall).
const workletLoads = new WeakMap();
export function loadStretchWorklet(ctx) {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.resolve(false);
  if (!workletLoads.has(ctx))
    workletLoads.set(
      ctx,
      ctx.audioWorklet.addModule(new URL('./stretch-worklet.js', import.meta.url).href).then(
        () => true,
        (e) => {
          console.warn('Tempo-Strecker nicht verfügbar:', e);
          return false;
        },
      ),
    );
  return workletLoads.get(ctx);
}

// Kanäle eines AudioBuffers für den Strecker (Kopien, max. Stereo)
export function bufferChannels(buf) {
  const out = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) out.push(buf.getChannelData(c).slice());
  return out;
}

// Knoten für die gestreckte Aufnahme. play = {at, pos, speed} startet sofort (Offline-Export).
export function createStretchNode(ctx, channels, play = null) {
  return new AudioWorkletNode(ctx, 'nc-stretch', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels.length || 1],
    processorOptions: { channels, play },
  });
}
