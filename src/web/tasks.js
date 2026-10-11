// Fortschritt in Aufgaben: jede Aufgabe hat ihren eigenen Balken und eine geschätzte Restzeit.
// Die Anzeige ist „glatt“: sie läuft stetig weiter (auch zwischen den Meldungen der Arbeit),
// springt nie zurück und richtet sich nach dem tatsächlichen Stand, sobald der bekannt ist.
//
//   const tl = new TaskList([{ id: 'ai', label: 'Lokale KI hört die Noten', expect: 40000 }]);
//   tl.start('ai'); tl.set('ai', 0.3, 'Durchgang 2 von 4'); tl.done('ai');
//   tl.update(now)  -> aktualisiert die angezeigten Werte (z. B. alle 100–200 ms)
//   tl.view()       -> [{ id, label, state, shown, etaMs, detail }]
//
// Die erwartete Dauer (expect) ist nur der Anfangswert; ab ~5 % echtem Fortschritt wird die
// Gesamtdauer aus der gemessenen Geschwindigkeit geschätzt und weich nachgeführt.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class TaskList {
  constructor(defs = [], { now = () => Date.now() } = {}) {
    this.now = now;
    this.tasks = [];
    for (const d of defs) this.add(d);
  }

  add({ id, label, expect = 10000, detail = '' }) {
    if (this.get(id)) return this.get(id);
    const t = { id, label, prior: Math.max(300, expect), state: 'wait', rep: 0, shown: 0, t0: 0, t1: 0, est: Math.max(300, expect), detail, last: 0 };
    this.tasks.push(t);
    return t;
  }

  get(id) {
    return this.tasks.find((t) => t.id === id) || null;
  }

  start(id, expect = null) {
    const t = this.get(id);
    if (!t || t.state === 'done') return;
    if (t.state !== 'run') {
      t.state = 'run';
      t.t0 = this.now();
      t.last = t.t0;
    }
    if (expect) {
      t.prior = Math.max(300, expect);
      t.est = t.prior;
    }
  }

  // frac: 0..1 echter Stand (null = unbekannt, nur Zeitschätzung); detail: kurzer Zusatztext
  set(id, frac = null, detail = null) {
    const t = this.get(id);
    if (!t || t.state === 'done') return;
    if (t.state === 'wait') this.start(id);
    if (detail !== null && detail !== undefined) t.detail = detail;
    if (frac !== null && frac !== undefined && Number.isFinite(frac)) {
      t.rep = Math.max(t.rep, clamp(frac, 0, 1));
      t.last = this.now();
    }
  }

  done(id) {
    const t = this.get(id);
    if (!t || t.state === 'done') return;
    if (t.state === 'wait') t.t0 = this.now();
    t.state = 'done';
    t.rep = 1;
    t.t1 = this.now();
  }

  // alle noch offenen Aufgaben abschließen (Vorgang beendet oder abgebrochen)
  finish() {
    for (const t of this.tasks) this.done(t.id);
  }

  // Anzeige fortschreiben. dtMs: Zeit seit dem letzten Aufruf (für die Glättung)
  update(dtMs = 100) {
    const now = this.now();
    for (const t of this.tasks) {
      if (t.state === 'wait') continue;
      if (t.state === 'done') {
        // läuft in den letzten Millimetern zügig ins Ziel
        t.shown += (1 - t.shown) * (1 - Math.exp(-dtMs / 120));
        if (1 - t.shown < 0.002) t.shown = 1;
        continue;
      }
      const el = Math.max(1, now - t.t0);
      // Gesamtdauer: aus der Messung (ab 4 % Stand), davor die Erwartung; weich nachgeführt
      let target = t.prior;
      if (t.rep >= 0.04) {
        const meas = el / t.rep;
        const w = clamp(t.rep * 2.5, 0, 1);
        target = t.prior * (1 - w) + meas * w;
      }
      t.est += (target - t.est) * (1 - Math.exp(-dtMs / 700));
      t.est = Math.max(t.est, el * 1.02);
      // Zeit-Fortschritt (nähert sich 0,95 an, solange kein echter Stand ankommt)
      const byTime = 0.97 * (1 - Math.exp((-1.6 * el) / t.est));
      // nie weit vor dem echten Stand, aber auch nie stehenbleiben: ohne neue Meldung wächst die
      // Anzeige mit der Zeit weiter (höchstens 18 Punkte vor dem Gemeldeten)
      const ahead = t.rep > 0 ? Math.min(byTime, t.rep + 0.18) : byTime;
      const goal = clamp(Math.max(t.rep, ahead), 0, 0.985);
      const k = 1 - Math.exp(-dtMs / 260);
      t.shown = Math.max(t.shown, t.shown + (goal - t.shown) * k);
    }
  }

  // Restzeit (ms) einer Aufgabe, weich: wartende Aufgaben mit ihrer Erwartung
  etaOf(t) {
    if (t.state === 'done') return 0;
    if (t.state === 'wait') return t.prior;
    const el = Math.max(0, this.now() - t.t0);
    return Math.max(0, t.est - el);
  }

  totalEta() {
    return this.tasks.reduce((s, t) => s + this.etaOf(t), 0);
  }

  // Anteil des gesamten Vorgangs (nach Erwartungsdauer gewichtet) 0..1
  overall() {
    const tot = this.tasks.reduce((s, t) => s + (t.state === 'done' ? Math.max(1, t.t1 - t.t0) : t.est), 0) || 1;
    const done = this.tasks.reduce((s, t) => s + (t.state === 'done' ? Math.max(1, t.t1 - t.t0) : t.state === 'run' ? t.est * t.shown : 0), 0);
    return clamp(done / tot, 0, 1);
  }

  view() {
    return this.tasks.map((t) => ({ id: t.id, label: t.label, state: t.state, shown: t.shown, etaMs: this.etaOf(t), detail: t.detail, last: t.last }));
  }

  // Sekunden über die letzte Meldung hinaus (für „hängt“-Erkennung)
  idleMs() {
    const run = this.tasks.filter((t) => t.state === 'run');
    if (!run.length) return 0;
    const now = this.now();
    return Math.min(...run.map((t) => now - Math.max(t.last, t.t0)));
  }
}

// Restzeit lesbar: „gleich fertig“, „ca. 40 s“, „ca. 2 Min. 10 s“, „ca. 12 Min.“
export function formatEta(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, ms / 1000);
  if (s < 4) return 'gleich fertig';
  if (s < 60) return `noch ca. ${Math.max(5, Math.round(s / 5) * 5)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round((s - m * 60) / 10) * 10;
  if (m >= 10) return `noch ca. ${m + (r >= 30 ? 1 : 0)} Min.`;
  return r === 60 ? `noch ca. ${m + 1} Min.` : r === 0 ? `noch ca. ${m} Min.` : `noch ca. ${m} Min. ${r} s`;
}

// Erwartete Dauer je Aufgabe aus bisherigen Läufen lernen (ms je Sekunde Audio, weich gemittelt)
export function learnSpeed(store, key, ms, units) {
  if (!store || !(ms > 0) || !(units > 0)) return;
  const per = ms / units;
  const old = Number(store[key]);
  store[key] = Number.isFinite(old) && old > 0 ? old * 0.6 + per * 0.4 : per;
}
