// NoteCode – Speicher & geräteübergreifende Synchronisierung.
// Lokal: IndexedDB (Fallback localStorage). Cloud: Supabase (Auth + PostgREST)
// per fetch – ohne zusätzliche Bibliotheken. Konfliktlösung: "neuester Stand gewinnt".

const DB_NAME = 'notecode';
const DB_VERSION = 1;

function idb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('kein IndexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('arrangements')) db.createObjectStore('arrangements', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

export class LocalStore {
  async open() {
    try {
      this.db = await idb();
    } catch {
      this.db = null; // Fallback localStorage
    }
    return this;
  }
  async list() {
    if (!this.db) return JSON.parse(localStorage.getItem('notecode:arr') || '[]');
    return tx(this.db, 'arrangements', 'readonly', (s) => reqP(s.getAll()));
  }
  async get(id) {
    if (!this.db) return (await this.list()).find((x) => x.id === id) || null;
    return tx(this.db, 'arrangements', 'readonly', (s) => reqP(s.get(id)));
  }
  async put(item) {
    if (!this.db) {
      const all = (await this.list()).filter((x) => x.id !== item.id);
      all.push(item);
      localStorage.setItem('notecode:arr', JSON.stringify(all));
      return item;
    }
    await tx(this.db, 'arrangements', 'readwrite', (s) => reqP(s.put(item)));
    return item;
  }
  async remove(id) {
    if (!this.db) {
      localStorage.setItem('notecode:arr', JSON.stringify((await this.list()).filter((x) => x.id !== id)));
      return;
    }
    await tx(this.db, 'arrangements', 'readwrite', (s) => reqP(s.delete(id)));
  }
  async getKV(key, def = null) {
    if (!this.db) {
      const v = localStorage.getItem('notecode:kv:' + key);
      return v === null ? def : JSON.parse(v);
    }
    const v = await tx(this.db, 'kv', 'readonly', (s) => reqP(s.get(key)));
    return v === undefined ? def : v;
  }
  async setKV(key, value) {
    if (!this.db) return localStorage.setItem('notecode:kv:' + key, JSON.stringify(value));
    await tx(this.db, 'kv', 'readwrite', (s) => reqP(s.put(value, key)));
  }
}

// ---------------------------------------------------------------------------
export class Cloud {
  constructor(url, key) {
    this.url = (url || '').replace(/\/+$/, '');
    this.key = key || '';
    this.session = null;
  }
  get configured() {
    return /^https?:\/\//.test(this.url) && this.key.length > 20;
  }
  get user() {
    return this.session?.user || null;
  }
  headers(auth = true) {
    const h = { apikey: this.key, 'Content-Type': 'application/json' };
    if (auth && this.session?.access_token) h.Authorization = `Bearer ${this.session.access_token}`;
    return h;
  }
  async call(path, opts = {}, auth = true) {
    if (!this.configured) throw new Error('Cloud-Sync ist nicht eingerichtet (Einstellungen → Konto & Sync).');
    if (auth && this.session && this.session.expires_at && Date.now() / 1000 > this.session.expires_at - 60) await this.refresh();
    const res = await fetch(this.url + path, { ...opts, headers: { ...this.headers(auth), ...(opts.headers || {}) } });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && (data.msg || data.message || data.error_description || data.error)) || `HTTP ${res.status}`;
      throw new Error(translateAuthError(msg));
    }
    return data;
  }
  setSession(data) {
    if (!data || !data.access_token) return null;
    this.session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      user: data.user ? { id: data.user.id, email: data.user.email } : this.session?.user,
    };
    return this.session;
  }
  async signUp(email, password) {
    const data = await this.call('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
    if (data && data.access_token) return { session: this.setSession(data), confirm: false };
    return { session: null, confirm: true };
  }
  async signIn(email, password) {
    const data = await this.call('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
    return this.setSession(data);
  }
  async refresh() {
    if (!this.session?.refresh_token) return null;
    const res = await fetch(this.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.session.refresh_token }),
    });
    if (!res.ok) {
      this.session = null;
      throw new Error('Sitzung abgelaufen – bitte erneut anmelden.');
    }
    return this.setSession(await res.json());
  }
  async signOut() {
    try {
      if (this.session) await this.call('/auth/v1/logout', { method: 'POST' });
    } catch {
      /* egal */
    }
    this.session = null;
  }
  async fetchArrangements() {
    return this.call('/rest/v1/arrangements?select=id,title,data,updated_at,deleted&order=updated_at.desc');
  }
  async upsertArrangements(rows) {
    if (!rows.length) return;
    await this.call('/rest/v1/arrangements?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.map((r) => ({ ...r, user_id: this.user.id }))),
    });
  }
  async fetchSettings() {
    const rows = await this.call('/rest/v1/user_settings?select=data,updated_at');
    return rows && rows[0] ? rows[0] : null;
  }
  async saveSettings(data) {
    await this.call('/rest/v1/user_settings?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: this.user.id, data, updated_at: new Date().toISOString() }]),
    });
  }
}

function translateAuthError(msg) {
  const m = String(msg);
  if (/Invalid login credentials/i.test(m)) return 'E-Mail oder Passwort ist falsch.';
  if (/already registered/i.test(m)) return 'Diese E-Mail ist bereits registriert – bitte anmelden.';
  if (/Email not confirmed/i.test(m)) return 'Bitte zuerst die Bestätigungs-E-Mail öffnen.';
  if (/Password should be/i.test(m)) return 'Das Passwort ist zu kurz (mind. 6 Zeichen).';
  if (/relation .* does not exist/i.test(m)) return 'Die Datenbank-Tabellen fehlen – bitte supabase/schema.sql im Supabase-SQL-Editor ausführen.';
  return m;
}

// ---------------------------------------------------------------------------
// Bibliothek mit Sync: lokale Kopie ist immer aktuell, die Cloud wird abgeglichen.
export class Library extends EventTarget {
  constructor(local) {
    super();
    this.local = local;
    this.cloud = new Cloud('', '');
    this.status = 'lokal';
    this.syncing = false;
  }
  async init(cfg) {
    await this.configure(cfg);
    const sess = await this.local.getKV('session');
    if (sess && this.cloud.configured) {
      this.cloud.session = sess;
      this.sync().catch((e) => this.setStatus('Fehler: ' + e.message));
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => this.cloud.user && this.sync().catch(() => {}));
      setInterval(() => this.cloud.user && document.visibilityState === 'visible' && this.sync().catch(() => {}), 60000);
    }
  }
  async configure({ supabaseUrl, supabaseKey }) {
    const sess = this.cloud.session;
    this.cloud = new Cloud(supabaseUrl, supabaseKey);
    this.cloud.session = sess;
  }
  setStatus(s) {
    this.status = s;
    this.dispatchEvent(new Event('status'));
  }
  changed() {
    this.dispatchEvent(new Event('change'));
  }
  async persistSession() {
    await this.local.setKV('session', this.cloud.session);
    this.dispatchEvent(new Event('auth'));
  }
  async signIn(email, pw) {
    await this.cloud.signIn(email, pw);
    await this.persistSession();
    await this.sync();
  }
  async signUp(email, pw) {
    const r = await this.cloud.signUp(email, pw);
    if (r.session) {
      await this.persistSession();
      await this.sync();
    }
    return r;
  }
  async signOut() {
    await this.cloud.signOut();
    await this.persistSession();
    this.setStatus('lokal');
  }
  async list() {
    return (await this.local.list()).filter((x) => !x.deleted).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  async get(id) {
    return this.local.get(id);
  }
  async save(item) {
    const now = new Date().toISOString();
    const it = { ...item, id: item.id || uuid(), createdAt: item.createdAt || now, updatedAt: now, dirty: true };
    await this.local.put(it);
    this.changed();
    if (this.cloud.user) this.sync().catch((e) => this.setStatus('Fehler: ' + e.message));
    return it;
  }
  async remove(id) {
    const it = await this.local.get(id);
    if (!it) return;
    await this.local.put({ ...it, deleted: true, updatedAt: new Date().toISOString(), dirty: true });
    this.changed();
    if (this.cloud.user) this.sync().catch(() => {});
  }
  async sync() {
    if (!this.cloud.user || this.syncing) return;
    this.syncing = true;
    this.setStatus('synchronisiere …');
    try {
      const remote = await this.cloud.fetchArrangements();
      const localAll = await this.local.list();
      const byId = new Map(localAll.map((x) => [x.id, x]));
      // Remote -> lokal
      for (const r of remote || []) {
        const l = byId.get(r.id);
        const rTime = r.updated_at || '';
        if (!l || rTime > (l.updatedAt || '')) {
          await this.local.put({ ...(r.data || {}), id: r.id, title: r.title, updatedAt: rTime, deleted: !!r.deleted, dirty: false });
        }
      }
      // lokal -> Remote
      const remoteIds = new Map((remote || []).map((r) => [r.id, r.updated_at || '']));
      const push = [];
      for (const l of await this.local.list()) {
        const rt = remoteIds.get(l.id);
        if (l.dirty || rt === undefined || (l.updatedAt || '') > rt) {
          const { dirty, ...data } = l;
          void dirty;
          push.push({ id: l.id, title: l.title || 'Ohne Titel', data, updated_at: l.updatedAt || new Date().toISOString(), deleted: !!l.deleted });
        }
      }
      await this.cloud.upsertArrangements(push);
      for (const p of push) {
        const l = await this.local.get(p.id);
        if (l) await this.local.put({ ...l, dirty: false });
      }
      this.setStatus(`synchronisiert ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`);
      this.changed();
    } finally {
      this.syncing = false;
    }
  }
}

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
