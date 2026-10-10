// Übe-Tempo für die Original-Aufnahme: langsamer (oder schneller) abspielen, ohne dass sich
// die Tonhöhe ändert (WSOLA – Überlappen & Addieren mit Ähnlichkeitssuche).
// Läuft als AudioWorklet im selben AudioContext wie die Noten-Wiedergabe und ist dadurch
// sample-genau synchron: das Ausgabe-Sample zur Kontextzeit τ entspricht immer der
// Aufnahmeposition pos + (τ − at) · speed (± Suchfenster von ca. 12 ms, ohne Drift).
// Die Klasse StretchEngine ist ohne WebAudio nutzbar (Tests, Offline-Export).

export class StretchEngine {
  // tolMs: Suchbereich; penalty: Abweichungen von der Sollposition kosten etwas Ähnlichkeit –
  // hält Schlagzeug-Einsätze nahe an ihrer Stelle (gemessen: Schwerpunkt ±1 ms statt bis 15 ms)
  constructor(channels, sampleRate, { tolMs = 10, penalty = 0.15 } = {}) {
    this.ch = channels || [];
    this.nch = this.ch.length;
    this.len = this.nch ? this.ch[0].length : 0;
    this.sr = sampleRate;
    const N = sampleRate > 64000 ? 2048 : 1024; // ca. 21–23 ms Fenster
    this.N = N;
    this.H = N >> 1; // 50 % Überlappung
    this.tol = Math.round((tolMs / 1000) * sampleRate); // Suchbereich
    this.penalty = penalty;
    // periodisches Hann-Fenster: zwei um H verschobene Fenster ergeben exakt 1
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.acc = this.ch.map(() => new Float32Array(N));
    this.blk = this.ch.map(() => new Float32Array(this.H));
    this.tgt = new Float32Array(this.H);
    this.speed = 1;
    this.pos0 = 0;
    this.j = 0;
    this.m = 0;
    this.prevX = null;
    this.rd = this.H;
  }

  // Neuer Abschnitt: Ausgabe-Sample 0 entspricht der Eingabeposition pos (in Samples, auch negativ)
  start(pos, speed) {
    this.pos0 = pos;
    this.speed = speed;
    this.copy = Math.abs(speed - 1) < 1e-6;
    this.j = 0;
    this.m = 0;
    this.prevX = null;
    for (const a of this.acc) a.fill(0);
    this.rd = this.H;
    if (!this.copy) {
      this.frame(); // Rahmen 0 deckt die Ausgabe [−H, 0) ab – verworfen
      this.rd = this.H;
    }
  }

  mono(i) {
    if (i < 0 || i >= this.len) return 0;
    let v = this.ch[0][i];
    if (this.nch > 1) v += this.ch[1][i];
    return v;
  }

  // Beste Position nahe "nominal", deren Anfang der natürlichen Fortsetzung "target" ähnelt
  search(nominal, target) {
    const H = this.H;
    const tgt = this.tgt;
    let tEn = 0;
    for (let i = 0; i < H; i++) {
      const v = this.mono(target + i);
      tgt[i] = v;
      tEn += v * v;
    }
    if (tEn < 1e-9) return nominal;
    const tol = this.tol;
    const pen = this.penalty;
    const score = (x, step) => {
      let dot = 0;
      let en = 1e-9;
      for (let i = 0; i < H; i += step) {
        const v = this.mono(x + i);
        dot += v * tgt[i];
        en += v * v;
      }
      // normierte Korrelation (−1..1), leicht zur Sollposition hin gewichtet
      const corr = dot / Math.sqrt((en * tEn) / step);
      const d = (x - nominal) / tol;
      return corr - pen * d * d;
    };
    let best = nominal;
    let bestS = -Infinity;
    for (let d = -tol; d <= tol; d += 4) {
      const s = score(nominal + d, 4);
      if (s > bestS) {
        bestS = s;
        best = nominal + d;
      }
    }
    const c = best;
    bestS = -Infinity;
    for (let d = -3; d <= 3; d++) {
      const s = score(c + d, 2);
      if (s > bestS) {
        bestS = s;
        best = c + d;
      }
    }
    return best;
  }

  // Rahmen m: Ausgabe [(m−1)·H, (m+1)·H), Mitte m·H ↔ Eingabe pos0 + m·H·speed
  frame() {
    const { N, H } = this;
    const nominal = Math.round(this.pos0 + this.m * H * this.speed - H);
    let x = nominal;
    const silent = nominal + N + this.tol < 0 || nominal - this.tol >= this.len;
    if (!silent && this.prevX !== null) x = this.search(nominal, this.prevX + H);
    if (!silent) {
      const lo = Math.max(0, -x);
      const hi = Math.min(N, this.len - x);
      for (let c = 0; c < this.nch; c++) {
        const a = this.acc[c];
        const src = this.ch[c];
        const w = this.win;
        for (let i = lo; i < hi; i++) a[i] += w[i] * src[x + i];
      }
    }
    for (let c = 0; c < this.nch; c++) {
      const a = this.acc[c];
      this.blk[c].set(a.subarray(0, H));
      a.copyWithin(0, H);
      a.fill(0, H);
    }
    this.prevX = x;
    this.m++;
    this.rd = 0;
  }

  // n Samples ab dst[c][off] schreiben (dst: ein Float32Array je Kanal)
  render(dst, off, n) {
    if (this.copy) {
      const base = Math.round(this.pos0) + this.j;
      for (let c = 0; c < dst.length; c++) {
        const src = this.ch[Math.min(c, this.nch - 1)];
        const d = dst[c];
        if (!src) continue;
        for (let k = 0; k < n; k++) {
          const i = base + k;
          d[off + k] = i >= 0 && i < this.len ? src[i] : 0;
        }
      }
      this.j += n;
      return;
    }
    let k = 0;
    while (k < n) {
      if (this.rd >= this.H) this.frame();
      const take = Math.min(n - k, this.H - this.rd);
      for (let c = 0; c < dst.length; c++) {
        const b = this.blk[Math.min(c, this.nch - 1)];
        if (b) dst[c].set(b.subarray(this.rd, this.rd + take), off + k);
      }
      this.rd += take;
      k += take;
    }
    this.j += n;
  }
}

const FADE = 256;

if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  class StretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const o = (options && options.processorOptions) || {};
      this.engine = new StretchEngine(o.channels || [], sampleRate);
      this.cur = null; // {stopF, fadeIn, fadeOut}
      this.next = null; // {F0, pos, speed}
      this.port.onmessage = (e) => this.msg(e.data);
      if (o.play) this.msg({ type: 'play', ...o.play });
    }

    // play: {at (Kontextzeit s), pos (Aufnahme-Sekunde, auch negativ), speed}; stop: {at}
    msg(m) {
      if (!m) return;
      if (m.type === 'play') this.next = { F0: Math.round(m.at * sampleRate), pos: m.pos * sampleRate, speed: m.speed || 1 };
      else if (m.type === 'stop') {
        this.next = null;
        if (this.cur) this.cur.stopF = Math.max(currentFrame, Math.round((m.at || 0) * sampleRate));
      }
    }

    run(out, a, b) {
      const cur = this.cur;
      if (!cur || b <= a) return;
      this.engine.render(out, a, b - a);
      for (let k = a; k < b; k++) {
        let g = 1;
        if (cur.fadeIn < FADE) g = cur.fadeIn++ / FADE;
        const f = currentFrame + k;
        if (f >= cur.stopF) {
          g *= Math.max(0, 1 - cur.fadeOut++ / FADE);
        }
        if (g !== 1) for (const c of out) c[k] *= g;
      }
      if (cur.fadeOut >= FADE) this.cur = null;
    }

    process(inputs, outputs) {
      const out = outputs[0];
      if (!out || !out.length) return true;
      const n = out[0].length;
      for (const c of out) c.fill(0);
      if (!this.engine.nch) return true;
      let start = n;
      const nx = this.next;
      if (nx && nx.F0 < currentFrame + n) {
        // zu spät angekommen: Zuordnung beibehalten, nur den Anfang auslassen
        if (nx.F0 < currentFrame) {
          nx.pos += (currentFrame - nx.F0) * nx.speed;
          nx.F0 = currentFrame;
        }
        start = nx.F0 - currentFrame;
      }
      this.run(out, 0, start);
      if (start < n) {
        this.next = null;
        this.engine.start(nx.pos, nx.speed);
        // mitten in der Aufnahme kurz einblenden, sonst knackt es
        this.cur = { stopF: Infinity, fadeIn: nx.pos > 0 ? 0 : FADE, fadeOut: 0 };
        for (const c of out) c.fill(0, start);
        this.run(out, start, n);
      }
      return true;
    }
  }
  registerProcessor('nc-stretch', StretchProcessor);
}
