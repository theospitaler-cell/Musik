import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/web/store.js';

class MemLocal {
  constructor() {
    this.items = new Map();
    this.kv = new Map();
  }
  async list() {
    return [...this.items.values()].map((x) => ({ ...x }));
  }
  async get(id) {
    return this.items.has(id) ? { ...this.items.get(id) } : null;
  }
  async put(it) {
    this.items.set(it.id, { ...it });
    return it;
  }
  async remove(id) {
    this.items.delete(id);
  }
  async getKV(k, d = null) {
    return this.kv.has(k) ? this.kv.get(k) : d;
  }
  async setKV(k, v) {
    this.kv.set(k, v);
  }
}

// gemeinsamer "Server" (wie Supabase-Tabelle eines Kontos)
function fakeCloud(server, email) {
  return {
    configured: true,
    session: { user: { id: 'u1', email } },
    get user() {
      return this.session.user;
    },
    async fetchArrangements() {
      return [...server.values()].map((r) => ({ ...r }));
    },
    async upsertArrangements(rows) {
      for (const r of rows) server.set(r.id, { ...r });
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('Zwei Geräte, ein Konto: Anlegen, Ändern und Löschen werden synchronisiert', async () => {
  const server = new Map();
  const phone = new Library(new MemLocal());
  const laptop = new Library(new MemLocal());
  phone.cloud = fakeCloud(server, 'theo@example.org');
  laptop.cloud = fakeCloud(server, 'theo@example.org');

  const it = await phone.save({ title: 'Saints – Funk', source: { name: 'x.abc', text: 'X:1' }, options: { style: 'funk' } });
  await tick();
  await phone.sync();
  await laptop.sync();
  let list = await laptop.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Saints – Funk');

  await new Promise((r) => setTimeout(r, 10));
  await laptop.save({ ...list[0], title: 'Saints – Swing' });
  await tick();
  await laptop.sync();
  await phone.sync();
  assert.equal((await phone.get(it.id)).title, 'Saints – Swing');

  await new Promise((r) => setTimeout(r, 10));
  await phone.remove(it.id);
  await tick();
  await phone.sync();
  await laptop.sync();
  assert.equal((await laptop.list()).length, 0);
});

test('Ohne Konto bleibt alles lokal', async () => {
  const lib = new Library(new MemLocal());
  await lib.save({ title: 'Lokal', options: {} });
  assert.equal((await lib.list()).length, 1);
});
