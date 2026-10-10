// Deterministischer Zufallsgenerator (mulberry32), damit jedes Arrangement
// über den "Seed" reproduzierbar ist und per Klick neu gewürfelt werden kann.
export class Rng {
  constructor(seed = 1) {
    this.state = (Number(seed) >>> 0) || 0x9e3779b9;
  }

  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Ganzzahl in [lo, hi]
  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  // items: [[value, weight], ...]
  weighted(items) {
    const total = items.reduce((s, [, w]) => s + Math.max(0, w), 0);
    if (total <= 0) return items[0][0];
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= Math.max(0, w);
      if (r <= 0) return v;
    }
    return items[items.length - 1][0];
  }

  // Abgeleiteter, unabhängiger Generator (z. B. pro Stimme/Block)
  fork(salt) {
    let h = this.state ^ 0x85ebca6b;
    const s = String(salt);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x9e3779b1) >>> 0;
    return new Rng(h >>> 0);
  }
}
