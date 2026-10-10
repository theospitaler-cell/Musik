// Browser-Wiedergabe (WebAudio) mit Mischpult: Lautstärke, Stumm, Solo, Panorama – und
// Übe-Tempo: Noten und Original-Aufnahme werden gemeinsam langsamer (Tonhöhe bleibt).
// Die Klangmodelle liegen in synth.js und werden auch für den MP3-Export genutzt.
import { performArrangement } from '../output/performance.js';
import { buildGraph, scheduleNote, loadStretchWorklet, createStretchNode, COMPRESSOR_DELAY } from './synth.js';

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1.2;

export class Player {
  // audioUrl: Original-Aufnahme (Play-along mit MP3 usw.)
  constructor(arr, { onPosition = null, onEnd = null, audioUrl = null } = {}) {
    this.arr = arr;
    this.perf = performArrangement(arr);
    this.onPosition = onPosition;
    this.onEnd = onEnd;
    this.ctx = null;
    this.playing = false;
    this.speed = 1;
    this.offset = 0; // Position in Sekunden (Partiturzeit)
    this.cursor = 0;
    const n = arr.voices.length;
    const pan = (i) => (n <= 1 ? 0 : n === 4 ? [-0.45, -0.15, 0.15, 0.45][i] : -0.5 + i / (n - 1));
    this.parts = arr.voices.map((v, i) => ({
      key: i,
      title: arr.playAlong ? v.label : arr.soloMode ? 'Solo' : `Stimme ${i + 1}`,
      sub: v.inst.name,
      name: `${v.label} – ${v.inst.name}`,
      short: v.inst.short,
      inst: v.inst,
      volume: 0.8,
      mute: false,
      solo: false,
      pan: pan(i),
    }));
    if (arr.drums) this.parts.push({ key: 'drums', title: 'Schlagzeug', sub: arr.playAlong ? 'Noten' : 'Drums', name: 'Schlagzeug', short: 'Schlz.', inst: null, drum: true, volume: 0.7, mute: false, solo: false, pan: 0 });
    // Original zum Mitspielen
    this.audioUrl = audioUrl;
    const bk = arr.backing;
    if (bk) {
      for (const ch of bk.channels || []) {
        const isAudio = bk.kind === 'audio';
        if (isAudio && !audioUrl) continue;
        this.parts.push({ key: ch.key, title: ch.name.replace(/^Original: /, ''), sub: isAudio ? 'Aufnahme' : 'Original', name: ch.name, inst: null, orig: true, audio: isAudio, drum: !!ch.drum, volume: isAudio ? 0.85 : 0.6, mute: false, solo: false, pan: 0 });
      }
    }
    this.master = 0.9;
  }

  // Aufnahme schon vor dem ersten Start dekodieren (sonst kurz Media-Element)
  preload() {
    if (this.audioUrl) this.ensureCtx();
  }

  ensureCtx() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.graph = buildGraph(this.ctx, this.parts, { master: this.master });
    this.masterGain = this.graph.masterGain;
    for (const p of this.parts) Object.assign(p, this.graph.nodes.get(String(p.key)));
    // Aufnahme: dekodiert und über den Tempo-Strecker (AudioWorklet) im selben AudioContext wie
    // die Noten – sample-genau synchron bei jedem Tempo, Tonhöhe bleibt. Bis das fertig ist (oder
    // ohne AudioWorklet) spielt ein Media-Element, das regelmäßig nachsynchronisiert wird.
    const ap = this.parts.find((p) => p.audio);
    if (ap && this.audioUrl) {
      this.audioPart = ap;
      const ctx = this.ctx;
      this.bufferReady = fetch(this.audioUrl)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b))
        .then(async (buf) => {
          if (this.ctx !== ctx) return;
          if (await loadStretchWorklet(ctx)) {
            try {
              const chans = [];
              for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(buf.getChannelData(c));
              this.stretch = createStretchNode(ctx, chans);
              this.stretch.connect(ap.gain);
            } catch (e) {
              console.warn('Tempo-Strecker konnte nicht starten:', e);
              this.stretch = null;
            }
          }
          if (this.ctx !== ctx) return;
          if (!this.stretch) this.audioBuffer = buf; // Rückfall: Puffer bei Originaltempo
          // läuft gerade das Media-Element -> sample-genau übernehmen
          if (this.playing) this.syncAudio(true);
        })
        .catch((e) => {
          console.warn('Aufnahme konnte nicht dekodiert werden:', e);
          this.audioBuffer = null;
        });
      const el = new Audio();
      el.src = this.audioUrl;
      el.preload = 'auto';
      el.preservesPitch = true;
      el.mozPreservesPitch = true;
      el.webkitPreservesPitch = true;
      this.audioEl = el;
      const src = this.ctx.createMediaElementSource(el);
      src.connect(ap.gain);
    }
    this.applyMix();
  }

  // true, sobald die Aufnahme sample-genau (in jedem Tempo) läuft
  get recordingLocked() {
    return !!this.stretch || (!!this.audioBuffer && this.speed === 1);
  }

  // Rückfall ohne AudioWorklet: Aufnahme als AudioBuffer bei Originaltempo
  startBuffer() {
    this.stopBuffer();
    if (!this.audioBuffer || !this.playing) return;
    const audioStart = this.perf.audioStart || 0;
    const pos = this.position();
    const offsetInFile = pos - audioStart;
    if (offsetInFile >= this.audioBuffer.duration) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.audioBuffer;
    src.connect(this.audioPart.gain);
    // Kontext-Zeit, zu der Partiturzeit "pos" erklingt (gleiche Rechnung wie für die Noten)
    const scoreToCtx = (t) => this.startedAt + (t - this.offset) / this.speed;
    if (offsetInFile >= 0) src.start(Math.max(this.ctx.currentTime, scoreToCtx(pos)), offsetInFile);
    else src.start(scoreToCtx(audioStart), 0);
    this.bufferSrc = src;
  }
  stopBuffer() {
    if (this.bufferSrc) {
      try {
        this.bufferSrc.stop();
      } catch {
        /* schon beendet */
      }
      this.bufferSrc.disconnect();
      this.bufferSrc = null;
    }
  }

  // Aufnahme an die Partiturposition koppeln
  syncAudio(force = false) {
    const el = this.audioEl;
    if (this.stretch) {
      clearTimeout(this.audioTimer);
      el?.pause();
      const port = this.stretch.port;
      if (!this.playing) port.postMessage({ type: 'stop', at: this.ctx.currentTime });
      else if (force) {
        // Partiturzeit t erklingt zur Kontextzeit startedAt + (t − offset)/speed – wie die Noten
        const at = Math.max(this.startedAt, this.ctx.currentTime + 0.03);
        const pos = this.offset + (at - this.startedAt) * this.speed - (this.perf.audioStart || 0);
        port.postMessage({ type: 'play', at, pos, speed: this.speed });
      }
      return;
    }
    if (!el) return;
    if (this.audioBuffer && this.speed === 1) {
      // Puffer-Wiedergabe ist sample-genau – Media-Element bleibt stumm
      el.pause();
      if (!this.playing) this.stopBuffer();
      else if (force) this.startBuffer();
      return;
    }
    this.stopBuffer();
    const want = this.position() - (this.perf.audioStart || 0);
    clearTimeout(this.audioTimer);
    if (!this.playing) {
      el.pause();
      return;
    }
    if (want < 0) {
      el.pause();
      el.currentTime = 0;
      el.playbackRate = this.speed;
      this.audioTimer = setTimeout(() => this.syncAudio(true), (-want / this.speed) * 1000);
      return;
    }
    if (want >= (el.duration || Infinity)) {
      el.pause();
      return;
    }
    // kleine Abweichungen weich über die Abspielrate ausgleichen, große durch Springen
    const diff = el.currentTime - want;
    if (force || el.paused || Math.abs(diff) > 0.15) {
      el.currentTime = want;
      el.playbackRate = this.speed;
    } else el.playbackRate = this.speed * (1 - Math.max(-0.03, Math.min(0.03, diff * 0.5)));
    if (el.paused) el.play().catch(() => {});
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
  // hörbar laut Mischpult (Stumm/Solo)
  audible(p) {
    const anySolo = this.parts.some((x) => x.solo);
    return !p.mute && (!anySolo || p.solo);
  }
  applyMix() {
    if (!this.ctx) return;
    for (const p of this.parts) p.gain.gain.setTargetAtTime(this.audible(p) ? p.volume : 0, this.ctx.currentTime, 0.02);
  }

  // ---- Transport ----
  get duration() {
    return this.perf.total;
  }
  position() {
    if (!this.playing) return this.offset;
    return this.offset + (this.ctx.currentTime - this.startedAt) * this.speed;
  }
  // Was gerade aus dem Lautsprecher kommt (Ausgabe-Latenz abgezogen) – für Anzeige & Mitlesen
  displayPosition() {
    if (!this.playing) return this.offset;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) + COMPRESSOR_DELAY;
    return this.offset + Math.max(0, this.ctx.currentTime - lat - this.startedAt) * this.speed;
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
    this.syncAudio(true);
    this.audioCheck = setInterval(() => this.syncAudio(), 500);
    const tick = () => {
      if (!this.playing) return;
      const pos = this.position();
      if (pos >= this.duration) {
        this.stop();
        if (this.onEnd) this.onEnd();
        return;
      }
      const shown = this.displayPosition();
      if (this.onPosition) this.onPosition(shown, this.perf.secToBar(shown));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  pause() {
    if (!this.playing) return;
    this.offset = this.position();
    this.playing = false;
    clearInterval(this.timer);
    clearInterval(this.audioCheck);
    cancelAnimationFrame(this.raf);
    this.silence();
    this.syncAudio();
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
  // Übe-Tempo (0.5 = halb so schnell); Noten und Aufnahme bleiben zusammen
  setSpeed(f) {
    f = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(f * 100) / 100));
    if (f === this.speed) return;
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
    const h = scheduleNote(this.ctx, part, part.gain, n, when, { speed: this.speed, noise: this.graph.noise });
    if (h) (this.active ||= []).push(h);
  }

  dispose() {
    this.stop();
    this.stopBuffer();
    if (this.stretch) {
      this.stretch.port.postMessage({ type: 'stop', at: 0 });
      this.stretch.disconnect();
      this.stretch = null;
    }
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
      this.audioEl = null;
    }
    if (this.ctx) this.ctx.close();
    this.ctx = null;
  }
}
