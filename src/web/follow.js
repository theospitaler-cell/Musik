// Mitlesen: der aktuelle Takt wird in den Noten markiert, ein Cursor läuft mit und die
// Ansicht "blättert" automatisch weiter, sobald die nächste Zeile nicht mehr sichtbar wäre.
// Takte werden über ihre gedruckte Nummer (Verovio: data-n) zugeordnet – so stimmt die
// Markierung auch bei Mehrtaktpausen in Einzelstimmen (ein SVG-Takt für mehrere Takte).
export class ScoreFollower {
  constructor(box, { onChange = null } = {}) {
    this.box = box; // #pages
    this.enabled = true;
    this.userPaused = false; // Nutzer hat selbst gescrollt -> bis zum nächsten Start nicht folgen
    this.onChange = onChange;
    this.slots = [];
    this.starts = new Map();
    this.geo = new Map();
    this.sys = null;
    this.playing = false;
    this.watchUser();
  }

  // Nach jedem Notensatz: gedruckter Takt (Index) -> SVG-Takt
  attach(printedCount) {
    this.clear();
    const els = [...this.box.querySelectorAll('g.measure')];
    const byN = new Map();
    for (const el of els) {
      const n = parseInt(el.getAttribute('data-n'), 10);
      if (n > 0 && !byN.has(n)) byN.set(n, el);
    }
    if (!byN.size) els.forEach((el, i) => byN.set(i + 1, el)); // ohne Taktnummern: Reihenfolge
    this.slots = new Array(printedCount).fill(null);
    this.starts = new Map();
    let cur = null;
    for (let i = 0; i < printedCount; i++) {
      const el = byN.get(i + 1);
      if (el) {
        cur = { el, start: i, len: 1 };
        this.starts.set(el, i);
      } else if (cur) cur.len++; // in einer Mehrtaktpause
      this.slots[i] = cur;
    }
    this.systems = [...this.box.querySelectorAll('g.system')];
    this.geo = new Map();
  }

  // gedruckter Takt-Index eines angeklickten SVG-Takts
  indexOf(el) {
    return this.starts.has(el) ? this.starts.get(el) : -1;
  }

  setEnabled(on) {
    this.enabled = on;
    this.userPaused = false;
    if (on && this.slot) this.turnPage(this.slot.el);
    this.onChange?.(this);
  }
  // Beim Start wieder folgen (auch wenn zwischendurch selbst gescrollt wurde): die aktuelle
  // Zeile wird beim nächsten Update geprüft und bei Bedarf wieder ins Bild geholt
  resume() {
    const was = this.userPaused;
    this.userPaused = false;
    this.sys = null;
    if (was) {
      if (this.slot && this.enabled) this.turnPage(this.slot.el);
      this.onChange?.(this);
    }
  }
  get following() {
    return this.enabled && !this.userPaused;
  }

  clear() {
    this.boxEl?.remove();
    this.cursorEl?.remove();
    this.boxEl = null;
    this.cursorEl = null;
    this.slot = null;
    this.sys = null;
  }

  // idx: gedruckter Takt (oder null), frac: Anteil des Takts 0..1
  update(idx, frac, { playing = false, visible = true } = {}) {
    this.playing = playing;
    const slot = idx === null || idx === undefined ? null : this.slots[idx];
    if (!slot || !visible) {
      if (!visible) this.clear();
      else this.hide();
      return;
    }
    const g = this.geometry(slot.el);
    if (!g) return;
    const page = slot.el.closest('.page');
    if (!this.boxEl) {
      this.boxEl = document.createElement('div');
      this.boxEl.className = 'nc-follow-box';
      this.cursorEl = document.createElement('div');
      this.cursorEl.className = 'nc-follow-cursor';
    }
    if (this.boxEl.parentNode !== page) page.append(this.boxEl, this.cursorEl);
    this.boxEl.hidden = false;
    this.cursorEl.hidden = false;
    if (this.slot !== slot) {
      const s = this.boxEl.style;
      s.left = `${g.l * 100}%`;
      s.width = `${(g.r - g.l) * 100}%`;
      s.top = `${g.t * 100}%`;
      s.height = `${(g.b - g.t) * 100}%`;
      this.cursorEl.style.top = s.top;
      this.cursorEl.style.height = s.height;
      this.slot = slot;
    }
    const f = Math.max(0, Math.min(1, (idx - slot.start + Math.max(0, Math.min(1, frac || 0))) / slot.len));
    this.cursorEl.style.left = `${(g.cl + (g.r - g.cl) * f) * 100}%`;
    // Umblättern: während der Wiedergabe bei jedem Zeilenwechsel prüfen (auch nach Sprüngen)
    const sys = slot.el.closest('g.system') || slot.el;
    if (playing && this.following && sys !== this.sys) {
      this.sys = sys;
      this.turnPage(slot.el);
    }
  }

  hide() {
    if (this.boxEl) this.boxEl.hidden = true;
    if (this.cursorEl) this.cursorEl.hidden = true;
    this.slot = null;
    this.sys = null;
  }

  // Lage eines Takts in Anteilen der Seitenbreite/-höhe (unabhängig von Zoom & Fenstergröße)
  geometry(el) {
    if (this.geo.has(el)) return this.geo.get(el);
    const page = el.closest('.page');
    if (!page) return null;
    const pr = page.getBoundingClientRect();
    if (!pr.width || !pr.height) return null;
    const union = (list) => {
      let r = null;
      for (const x of list) {
        const b = x.getBoundingClientRect();
        if (!b.width && !b.height) continue;
        r = r ? { left: Math.min(r.left, b.left), right: Math.max(r.right, b.right), top: Math.min(r.top, b.top), bottom: Math.max(r.bottom, b.bottom) } : { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      }
      return r;
    };
    // Notenlinien des Takts (alle Systeme der Partitur), sonst der ganze Takt
    const staff = union(el.querySelectorAll(':scope > g.staff > path')) || union([el]);
    if (!staff) return null;
    // Cursor beginnt beim ersten Notenzeichen (nicht im Schlüssel/Vorzeichen-Bereich)
    const content = union(el.querySelectorAll(':scope > g.staff > g.layer'));
    // etwas Luft über/unter den Linien (Hilfslinien, Hi-Hat-Kreuze) – bezogen auf ein System
    const first = el.querySelector(':scope > g.staff');
    const one = first ? union(first.querySelectorAll(':scope > path')) : null;
    const pad = Math.max(4, ((one || staff).bottom - (one || staff).top) * 0.45);
    const cl = content ? Math.max(staff.left, Math.min(staff.right - 4, content.left - 3)) : staff.left;
    const g = {
      l: (staff.left - pr.left) / pr.width,
      r: (staff.right - pr.left) / pr.width,
      cl: (cl - pr.left) / pr.width,
      t: (staff.top - pad - pr.top) / pr.height,
      b: (staff.bottom + pad - pr.top) / pr.height,
    };
    this.geo.set(el, g);
    return g;
  }

  // Sichtbarer Bereich: unter der Kopfleiste, über dem Player
  viewport() {
    let top = 0;
    let bottom = window.innerHeight;
    const bar = document.querySelector('.topbar');
    if (bar) {
      const r = bar.getBoundingClientRect();
      const pos = getComputedStyle(bar).position;
      if ((pos === 'sticky' || pos === 'fixed') && r.bottom > 0 && r.top <= 1) top = r.bottom;
    }
    const pl = document.getElementById('player');
    if (pl && !pl.classList.contains('hidden')) {
      const r = pl.getBoundingClientRect();
      if (r.top > top + 120) bottom = Math.min(bottom, r.top);
    }
    return { top, bottom };
  }

  scroller() {
    for (let el = this.box.parentElement; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) return el;
    }
    return null;
  }

  // Blättern: aktuelle Zeile nach oben holen, wenn sie oder die nächste Zeile nicht sichtbar ist
  turnPage(el) {
    const sys = el.closest('g.system') || el;
    const r = sys.getBoundingClientRect();
    if (!r.height) return;
    const v = this.viewport();
    const sc = this.scroller();
    if (sc) {
      const sr = sc.getBoundingClientRect();
      v.top = Math.max(v.top, sr.top);
      v.bottom = Math.min(v.bottom, sr.bottom);
    }
    const h = v.bottom - v.top;
    const next = this.systems?.[this.systems.indexOf(sys) + 1];
    const nr = next ? next.getBoundingClientRect() : null;
    const offTop = r.top < v.top + 4;
    const offBottom = r.bottom > v.bottom - 4;
    const nextHidden = nr && nr.bottom > v.bottom - 4 && r.top > v.top + h * 0.15;
    if (!(offTop || offBottom || nextHidden)) return;
    const dy = r.top - (v.top + Math.min(24, h * 0.05));
    if (Math.abs(dy) < 6) return;
    if (sc) sc.scrollBy({ top: dy, behavior: 'smooth' });
    else window.scrollBy({ top: dy, behavior: 'smooth' });
  }

  // Selbst gescrollt (Mausrad, Wischen, Tasten, Scrollleiste) -> Mitlaufen bis zum nächsten Start pausieren
  watchUser() {
    const ignore = (e) => e.target instanceof Element && e.target.closest('#player, .drawer, dialog, .menu');
    const pause = (e) => {
      if (!this.playing || !this.following || ignore(e)) return;
      this.userPaused = true;
      this.onChange?.(this);
    };
    window.addEventListener('wheel', pause, { passive: true });
    window.addEventListener('touchmove', pause, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) pause(e);
    });
    window.addEventListener('mousedown', (e) => {
      // Klick auf die Scrollleiste des Fensters
      if (e.target === document.documentElement && e.clientX >= document.documentElement.clientWidth) pause(e);
    });
  }
}
