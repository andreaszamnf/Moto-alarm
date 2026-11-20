// Storage: Cloudflare D1 in production, an in-memory store for local development and tests.
// Both expose the same small async interface.

export class MemoryStore {
  #kv = new Map();
  #positions = [];
  #events = [];
  #subs = new Map();
  #services = new Map();
  #nextEventId = 1;
  #nextServiceId = 1;

  async get(key) {
    return this.#kv.has(key) ? structuredClone(this.#kv.get(key)) : null;
  }

  async set(key, value) {
    if (value === null || value === undefined) this.#kv.delete(key);
    else this.#kv.set(key, structuredClone(value));
  }

  async addPosition(p) {
    this.#positions.push({ ts: p.ts, lat: p.lat, lon: p.lon, acc: p.acc ?? null, speed: p.speed ?? null });
  }

  async addPositions(list) {
    for (const p of list) await this.addPosition(p);
  }

  async positions(from, to, limit = 5000) {
    return this.#positions.filter((p) => p.ts >= from && p.ts <= to).slice(-limit);
  }

  async addEvent(type, data = {}, ts = Date.now()) {
    const event = { id: this.#nextEventId++, ts, type, data };
    this.#events.push(event);
    return structuredClone(event);
  }

  async events(limit = 50) {
    return structuredClone(this.#events.slice(-limit).reverse());
  }

  async subs() {
    return [...this.#subs.values()];
  }

  async addSub(sub) {
    this.#subs.set(sub.endpoint, { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth });
  }

  async removeSub(endpoint) {
    this.#subs.delete(endpoint);
  }

  async prune(before) {
    this.#positions = this.#positions.filter((p) => p.ts >= before);
    this.#events = this.#events.filter((e) => e.ts >= before);
  }

  // Service book: { date, km, items, other, shop, cost, notes } plus the id it gets here.
  async services() {
    return structuredClone([...this.#services.values()]);
  }

  async addService(entry) {
    const id = this.#nextServiceId++;
    this.#services.set(id, { ...structuredClone(entry), id });
    return id;
  }

  async updateService(id, entry) {
    if (!this.#services.has(id)) return false;
    this.#services.set(id, { ...structuredClone(entry), id });
    return true;
  }

  async removeService(id) {
    return this.#services.delete(id);
  }
}

export class D1Store {
  constructor(db) {
    this.db = db;
  }

  async get(key) {
    const row = await this.db.prepare('SELECT v FROM kv WHERE k = ?').bind(key).first();
    return row ? JSON.parse(row.v) : null;
  }

  async set(key, value) {
    if (value === null || value === undefined) {
      await this.db.prepare('DELETE FROM kv WHERE k = ?').bind(key).run();
      return;
    }
    await this.db
      .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .bind(key, JSON.stringify(value))
      .run();
  }

  async addPosition(p) {
    await this.db
      .prepare('INSERT INTO positions (ts, lat, lon, acc, speed) VALUES (?, ?, ?, ?, ?)')
      .bind(p.ts, p.lat, p.lon, p.acc ?? null, p.speed ?? null)
      .run();
  }

  // Several at once (the points of a ride report): one round trip.
  async addPositions(list) {
    if (!list.length) return;
    const insert = this.db.prepare('INSERT INTO positions (ts, lat, lon, acc, speed) VALUES (?, ?, ?, ?, ?)');
    await this.db.batch(list.map((p) => insert.bind(p.ts, p.lat, p.lon, p.acc ?? null, p.speed ?? null)));
  }

  async positions(from, to, limit = 5000) {
    const { results } = await this.db
      .prepare('SELECT ts, lat, lon, acc, speed FROM positions WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?')
      .bind(from, to, limit)
      .all();
    return results.reverse();
  }

  async addEvent(type, data = {}, ts = Date.now()) {
    const result = await this.db
      .prepare('INSERT INTO events (ts, type, data) VALUES (?, ?, ?)')
      .bind(ts, type, JSON.stringify(data))
      .run();
    return { id: result.meta.last_row_id, ts, type, data };
  }

  async events(limit = 50) {
    const { results } = await this.db
      .prepare('SELECT id, ts, type, data FROM events ORDER BY id DESC LIMIT ?')
      .bind(limit)
      .all();
    return results.map((e) => ({ ...e, data: JSON.parse(e.data || '{}') }));
  }

  async subs() {
    const { results } = await this.db.prepare('SELECT endpoint, p256dh, auth FROM push_subs').all();
    return results;
  }

  async addSub(sub) {
    await this.db
      .prepare(
        'INSERT INTO push_subs (endpoint, p256dh, auth, created) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth',
      )
      .bind(sub.endpoint, sub.p256dh, sub.auth, Date.now())
      .run();
  }

  async removeSub(endpoint) {
    await this.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint).run();
  }

  async prune(before) {
    await this.db.batch([
      this.db.prepare('DELETE FROM positions WHERE ts < ?').bind(before),
      this.db.prepare('DELETE FROM events WHERE ts < ?').bind(before),
    ]);
  }

  // Service book: date and km in their own columns, the rest as JSON in `data`.
  async services() {
    const { results } = await this.db.prepare('SELECT id, date, km, data FROM services').all();
    return results.map((r) => ({ ...JSON.parse(r.data || '{}'), id: r.id, date: r.date, km: r.km ?? null }));
  }

  async addService(entry, now = Date.now()) {
    const { date, km, ...data } = entry;
    const result = await this.db
      .prepare('INSERT INTO services (date, km, data, created, updated) VALUES (?, ?, ?, ?, ?)')
      .bind(date, km ?? null, JSON.stringify(data), now, now)
      .run();
    return result.meta.last_row_id;
  }

  async updateService(id, entry, now = Date.now()) {
    const { date, km, ...data } = entry;
    const result = await this.db
      .prepare('UPDATE services SET date = ?, km = ?, data = ?, updated = ? WHERE id = ?')
      .bind(date, km ?? null, JSON.stringify(data), now, id)
      .run();
    return result.meta.changes > 0;
  }

  async removeService(id) {
    const result = await this.db.prepare('DELETE FROM services WHERE id = ?').bind(id).run();
    return result.meta.changes > 0;
  }
}

let memoryStore = null;

export function getStore(env) {
  if (env.DB) return new D1Store(env.DB);
  memoryStore ??= new MemoryStore();
  return memoryStore;
}
