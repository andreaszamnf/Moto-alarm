import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import {
  ServiceError,
  addMonths,
  athensToday,
  checkServiceReminders,
  normalizeService,
  removeService,
  saveOdometer,
  saveService,
  saveServicePrefs,
  serviceView,
} from '../src/service.js';
import { MemoryStore } from '../src/store.js';

// 19 November 2026: 08:00 and 11:00 in Greece (UTC+2 in winter).
const EARLY = Date.UTC(2026, 10, 19, 6, 0);
const NOON = Date.UTC(2026, 10, 19, 9, 0);
const DAY = 86_400_000;
const TODAY = '2026-11-19';

const refused = (code) => (err) => err instanceof ServiceError && err.code === code;

// A small book: oil 250 km before it is due, brake fluid more than two years old, a chain kit.
async function sampleBook() {
  const store = new MemoryStore();
  const add = (body) => saveService({ store, body, now: NOON });
  const oil = await add({ date: '2026-01-10', km: 8000, items: ['oil_filter', 'oil'], shop: 'Moto Service', cost: 120 });
  const chain = await add({ date: '2026-03-12', km: 9400, items: ['chain_kit', 'pads_front'], shop: 'Moto Service', cost: 310.5 });
  const fluids = await add({ date: '2024-10-01', km: 2000, items: ['brake_fluid', 'coolant'], shop: 'Μόνος μου', cost: 80 });
  await saveOdometer({ store, km: 19750, now: NOON });
  return { store, ids: { oil, chain, fluids } };
}

test('Greek date and hour, and months that end early', () => {
  assert.deepEqual(athensToday(EARLY), { day: TODAY, hour: 8 });
  assert.deepEqual(athensToday(Date.UTC(2026, 6, 1, 21, 30)), { day: '2026-07-02', hour: 0 }, 'summer time, after midnight');
  assert.equal(addMonths('2026-03-12', 12), '2027-03-12');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2025-11-30', 3), '2026-02-28');
});

test('an entry is checked and tidied', () => {
  const entry = normalizeService(
    {
      date: '2026-11-02',
      km: 12345,
      items: ['tyre_rear', 'oil', 'oil'],
      shop: '  Moto \n Service ',
      cost: 85.499,
      notes: 'Motul\r\n\r\n\r\n\r\nκαι φίλτρο  ',
      other: '',
    },
    TODAY,
  );
  assert.deepEqual(entry, {
    date: '2026-11-02',
    km: 12345,
    items: ['oil', 'tyre_rear'],
    other: '',
    shop: 'Moto Service',
    cost: 85.5,
    notes: 'Motul\n\nκαι φίλτρο',
  });
  assert.equal(normalizeService({ date: TODAY, other: 'ΚΤΕΟ' }, TODAY).km, null, 'kilometres and cost may stay empty');
  assert.equal(normalizeService({ date: '2026-11-20', items: ['oil'] }, TODAY).date, '2026-11-20', 'a day ahead is fine');

  const base = { date: TODAY, km: 1000, items: ['oil'] };
  assert.throws(() => normalizeService({ ...base, date: '2026-02-30' }, TODAY), refused('bad_date'));
  assert.throws(() => normalizeService({ ...base, date: '2026-11-22' }, TODAY), refused('bad_date'));
  assert.throws(() => normalizeService({ ...base, date: '19/11/2026' }, TODAY), refused('bad_date'));
  assert.throws(() => normalizeService({ ...base, km: 12.5 }, TODAY), refused('bad_km'));
  assert.throws(() => normalizeService({ ...base, km: -3 }, TODAY), refused('bad_km'));
  assert.throws(() => normalizeService({ ...base, km: '12000' }, TODAY), refused('bad_km'));
  assert.throws(() => normalizeService({ ...base, items: ['oil', 'turbo'] }, TODAY), refused('bad_items'));
  assert.throws(() => normalizeService({ ...base, items: 'oil' }, TODAY), refused('bad_items'));
  assert.throws(() => normalizeService({ ...base, items: [] }, TODAY), refused('no_items'));
  assert.throws(() => normalizeService({ ...base, cost: '85,50' }, TODAY), refused('bad_cost'));
  assert.throws(() => normalizeService({ ...base, cost: -1 }, TODAY), refused('bad_cost'));
  assert.throws(() => normalizeService({ ...base, notes: 'α'.repeat(2001) }, TODAY), refused('too_long'));
  assert.throws(() => normalizeService({ ...base, shop: 42 }, TODAY), refused('bad_text'));
});

test('the book: newest first, the kilometres, cost per year and where each job stands', async () => {
  const { store, ids } = await sampleBook();
  const view = await serviceView({ store, now: NOON });

  assert.equal(view.today, TODAY);
  assert.deepEqual(view.entries.map((e) => e.id), [ids.chain, ids.oil, ids.fluids]);
  assert.deepEqual(view.entries[1].items, ['oil', 'oil_filter'], 'jobs in the order of the list');
  assert.deepEqual(view.odometer, { km: 19750, measured: 19750, gps: 0, date: TODAY, src: 'reading' });
  assert.deepEqual(view.years, [
    { year: 2026, count: 2, cost: 430.5 },
    { year: 2024, count: 1, cost: 80 },
  ]);
  assert.deepEqual(view.total, { count: 3, cost: 510.5 });
  assert.deepEqual(view.shops, ['Moto Service', 'Μόνος μου']);
  assert.ok(view.items.some((i) => i.id === 'oil' && i.label === 'Λάδια κινητήρα' && i.km === 12000 && i.months === 12));

  // Most urgent first: brake fluid is late, the oil is 250 km away, then the rest.
  assert.deepEqual(
    view.reminders.map((r) => [r.item, r.status]),
    [
      ['brake_fluid', 'due'],
      ['oil', 'soon'],
      ['coolant', 'ok'],
      ['oil_filter', 'ok'],
      ['pads_front', 'none'],
      ['chain_kit', 'none'],
    ],
  );
  const oil = view.reminders.find((r) => r.item === 'oil');
  assert.deepEqual(oil.last, { id: ids.oil, date: '2026-01-10', km: 8000 });
  assert.deepEqual(oil.ago, { days: 313, km: 11750 });
  assert.deepEqual(oil.next, { km: 20000, date: '2027-01-10' });
  assert.deepEqual(oil.left, { km: 250, days: 52 });
  assert.equal(oil.own, false, 'an entry without its own "next time" follows the interval');
  assert.equal(oil.progress, 0.979);
  const fluid = view.reminders.find((r) => r.item === 'brake_fluid');
  assert.deepEqual(fluid.next, { km: null, date: '2026-10-01' });
  assert.equal(fluid.left.days, -49);
  const pads = view.reminders.find((r) => r.item === 'pads_front');
  assert.deepEqual(pads.ago, { days: 252, km: 10350 }, 'worn parts: how long and how far since');
  assert.equal(pads.next, null);
  assert.deepEqual(view.untracked, ['air_filter', 'chain_lube', 'spark_plugs', 'valves']);
});

test('without kilometres there is no countdown in kilometres', async () => {
  const store = new MemoryStore();
  await saveService({ store, body: { date: '2026-05-01', items: ['valves'] }, now: NOON });
  let [valves] = (await serviceView({ store, now: NOON })).reminders;
  assert.equal(valves.status, 'none', 'an interval in km needs the km of the entry');
  assert.equal(valves.ago.km, null);
  await saveService({ store, body: { id: 1, date: '2026-05-01', items: ['valves'], next: { valves: { km: 30000 } } }, now: NOON });
  [valves] = (await serviceView({ store, now: NOON })).reminders;
  assert.equal(valves.status, 'unknown', 'a next time in km, but no kilometres known yet');
});

test('changing and deleting entries', async () => {
  const { store, ids } = await sampleBook();
  await saveService({ store, body: { id: ids.chain, date: '2026-03-13', km: 9450, items: ['chain_kit'] }, now: NOON });
  const changed = (await serviceView({ store, now: NOON })).entries.find((e) => e.id === ids.chain);
  assert.deepEqual([changed.date, changed.km, changed.items, changed.cost], ['2026-03-13', 9450, ['chain_kit'], null]);

  await removeService({ store, id: ids.fluids });
  const view = await serviceView({ store, now: NOON });
  assert.equal(view.entries.length, 2);
  assert.ok(view.untracked.includes('brake_fluid'));

  await assert.rejects(removeService({ store, id: ids.fluids }), refused('service_not_found'));
  await assert.rejects(saveService({ store, body: { id: 999, date: TODAY, items: ['oil'] }, now: NOON }), refused('service_not_found'));
  await assert.rejects(saveService({ store, body: { id: '1', date: TODAY, items: ['oil'] }, now: NOON }), refused('service_not_found'));
});

test('kilometres: the highest known count, never below a service', async () => {
  const { store } = await sampleBook();
  await assert.rejects(saveOdometer({ store, km: 9000, now: NOON }), refused('km_below_service'));
  await assert.rejects(saveOdometer({ store, km: 12.5, now: NOON }), refused('bad_km'));
  // A later service with more kilometres than the last reading counts as the newest count.
  await saveService({ store, body: { date: TODAY, km: 19800, items: ['chain_lube'] }, now: NOON });
  assert.deepEqual((await serviceView({ store, now: NOON })).odometer, { km: 19800, measured: 19800, gps: 0, date: TODAY, src: 'service' });
});

test('own intervals, back to Honda, and the reminder switch', async () => {
  const { store } = await sampleBook();
  await saveServicePrefs({ store, body: { intervals: { oil: { km: 15000, months: null }, brake_fluid: { km: null, months: null } } } });
  let view = await serviceView({ store, now: NOON });
  assert.deepEqual(view.intervals.oil, { km: 15000, months: null });
  const oil = view.reminders.find((r) => r.item === 'oil');
  assert.deepEqual([oil.status, oil.left.km, oil.left.days], ['ok', 3250, null]);
  assert.equal(view.reminders.find((r) => r.item === 'brake_fluid').status, 'none', 'no interval, no reminder');

  // Honda's own value is not kept as an override.
  await saveServicePrefs({ store, body: { intervals: { oil: { km: 12000, months: 12 } } } });
  assert.equal((await store.get('service_prefs')).intervals.oil, undefined);

  await saveServicePrefs({ store, body: { notify: false } });
  await saveServicePrefs({ store, body: { reset: true } });
  view = await serviceView({ store, now: NOON });
  assert.equal(view.notify, false, 'reset touches only the intervals');
  assert.deepEqual(view.intervals.brake_fluid, { km: null, months: 24 });

  const sneaky = JSON.parse('{"__proto__": {"km": 1000}}'); // as it would arrive in a request
  for (const intervals of [{ oil: { km: 50 } }, { oil: { months: 0 } }, { turbo: { km: 1000 } }, { oil: { km: '1000' } }, ['oil'], sneaky]) {
    await assert.rejects(saveServicePrefs({ store, body: { intervals } }), refused('bad_interval'), JSON.stringify(intervals));
  }
});

test('daily reminder: after 10:00, once when close, once when due, again after a new entry only when due', async () => {
  const { store } = await sampleBook();
  const sent = [];
  const notify = async (payload) => sent.push(payload);
  const check = (now) => checkServiceReminders({ store, now, notify });

  assert.equal(await check(EARLY), null, 'not before 10:00');
  assert.deepEqual(await check(NOON), ['brake_fluid', 'oil']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Σέρβις μηχανής');
  assert.equal(sent[0].body, 'Ήρθε η ώρα: υγρό φρένων. Πλησιάζει: λάδια κινητήρα (σε 250 χλμ).');
  assert.equal(sent[0].tag, 'moto-service');

  assert.equal(await check(NOON + 3_600_000), null, 'once a day');
  assert.equal(await check(NOON + DAY), null, 'nothing new the next day');
  assert.equal(sent.length, 1);

  await saveOdometer({ store, km: 20100, now: NOON + DAY });
  assert.deepEqual(await check(NOON + 2 * DAY), ['oil']);
  assert.equal(sent[1].body, 'Ήρθε η ώρα: λάδια κινητήρα.');

  await saveService({ store, body: { date: '2026-11-21', km: 20100, items: ['oil', 'oil_filter'] }, now: NOON + 2 * DAY });
  assert.equal(await check(NOON + 3 * DAY), null, 'a fresh oil change: nothing to say');

  await saveServicePrefs({ store, body: { notify: false } });
  await saveOdometer({ store, km: 33000, now: NOON + 3 * DAY });
  assert.equal(await check(NOON + 4 * DAY), null, 'reminders turned off');
  assert.equal(sent.length, 2);
});

test('the owner sets "next time" in each entry; the suggestion is only a starting point', async () => {
  const store = new MemoryStore();
  const base = { date: '2026-06-01', km: 15000, items: ['oil', 'chain_lube', 'tyre_rear'] };
  const id = await saveService({
    store,
    body: { ...base, next: { oil: { km: 22000, date: '2027-03-01' }, chain_lube: { km: 15600, date: null }, tyre_rear: { km: null, date: null } } },
    now: NOON,
  });
  await saveOdometer({ store, km: 15500, now: NOON });
  const view = await serviceView({ store, now: NOON });
  assert.deepEqual(view.entries[0].next.oil, { km: 22000, date: '2027-03-01' });
  const by = Object.fromEntries(view.reminders.map((r) => [r.item, r]));
  assert.deepEqual([by.chain_lube.status, by.chain_lube.left.km, by.chain_lube.own], ['soon', 100, true], 'within 30% of 600 km');
  assert.deepEqual([by.oil.status, by.oil.next, by.oil.left.km], ['ok', { km: 22000, date: '2027-03-01' }, 6500]);
  assert.equal(by.tyre_rear.status, 'none', 'both empty: no reminder, even for a job with a suggestion');

  const bad = (next) => saveService({ store, body: { ...base, id, next }, now: NOON });
  await assert.rejects(bad({ coolant: { km: 30000 } }), refused('bad_next'), 'only jobs of this entry');
  await assert.rejects(bad({ oil: { km: 15000 } }), refused('bad_next'), 'after the km of the entry');
  await assert.rejects(bad({ oil: { date: '2026-06-01' } }), refused('bad_next'), 'after the date of the entry');
  await assert.rejects(bad({ oil: { km: '22000' } }), refused('bad_next'));
  await assert.rejects(bad(['oil']), refused('bad_next'));
});

test('the odometer adds the rides measured by GPS after the last count, and a new count replaces them', async () => {
  const store = new MemoryStore();
  await saveService({ store, body: { date: '2026-11-10', km: 19000, items: ['oil'], next: { oil: { km: 20000 } } }, now: NOON });
  const h = 3_600_000;
  await store.set('trips', [
    { start: Date.UTC(2026, 10, 10, 8), m: 30_000 }, // the morning of the service day: before it, not counted
    { start: Date.UTC(2026, 10, 12, 8), m: 120_400 },
    { start: NOON - 2 * h, m: 5_000 },
  ]);
  await store.set('ride', { start: NOON - h, m: 9_700 }); // under way
  let view = await serviceView({ store, now: NOON });
  assert.deepEqual(view.odometer, { km: 19135, measured: 19000, gps: 135, date: '2026-11-10', src: 'service' });
  assert.deepEqual([view.reminders[0].left.km, view.reminders[0].ago.km], [865, 135]);

  // The owner reads the dashboard: 19.200. Only rides after that count from now on.
  await saveOdometer({ store, km: 19200, now: NOON });
  await store.set('trips', [...(await store.get('trips')), { start: NOON + h, m: 42_000 }]);
  await store.set('ride', null);
  view = await serviceView({ store, now: NOON + 3 * h });
  assert.deepEqual(view.odometer, { km: 19242, measured: 19200, gps: 42, date: TODAY, src: 'reading' });
});

// ---------- over the API ----------
const env = { APP_PASSWORD: 'correct horse', TOKEN_SECRET: 'test-token-secret', DEVICE_KEY: 'device-secret' };
const ctx = { waitUntil: (p) => p };

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    ctx,
  );
  return { status: res.status, data: await res.json() };
}

test('service book over the API: login needed, add, change, delete, kilometres and intervals', async () => {
  assert.equal((await call('/api/service')).status, 401);
  assert.equal((await call('/api/service', { method: 'POST', body: { date: TODAY, items: ['oil'] } })).status, 401);
  const token = (await call('/api/login', { method: 'POST', body: { password: 'correct horse' } })).data.token;

  const empty = await call('/api/service', { token });
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.data.entries, empty.data.odometer, empty.data.notify], [[], null, true]);
  assert.equal(empty.data.items.length, 15);

  const added = await call('/api/service', { method: 'POST', token, body: { date: '2026-01-10', km: 8000, items: ['oil'], cost: 95.5, notes: 'Motul' } });
  assert.equal(added.status, 200);
  assert.equal(typeof added.data.id, 'number');
  assert.deepEqual(added.data.entries.map((e) => [e.id, e.cost, e.notes]), [[added.data.id, 95.5, 'Motul']]);
  assert.equal(added.data.reminders[0].item, 'oil');

  const changed = await call('/api/service', { method: 'POST', token, body: { id: added.data.id, date: '2026-01-11', km: 8000, items: ['oil'], cost: 99 } });
  assert.equal(changed.data.id, added.data.id);
  assert.deepEqual(changed.data.entries.map((e) => [e.date, e.cost]), [['2026-01-11', 99]]);

  const bad = await call('/api/service', { method: 'POST', token, body: { date: '2999-01-01', items: ['oil'] } });
  assert.deepEqual([bad.status, bad.data.error], [400, 'bad_date']);
  assert.equal((await call('/api/service', { method: 'POST', token, body: { date: TODAY, items: [] } })).data.error, 'no_items');
  const missing = await call('/api/service', { method: 'POST', token, body: { id: 12345, date: '2026-01-11', items: ['oil'] } });
  assert.deepEqual([missing.status, missing.data.error], [404, 'service_not_found']);

  const km = await call('/api/service/odometer', { method: 'POST', token, body: { km: 10500 } });
  assert.equal(km.data.odometer.km, 10500);
  assert.equal(km.data.reminders[0].ago.km, 2500);
  assert.equal((await call('/api/service/odometer', { method: 'POST', token, body: { km: 7000 } })).data.error, 'km_below_service');

  const prefs = await call('/api/service/prefs', { method: 'POST', token, body: { notify: false, intervals: { oil: { km: 10000, months: 12 } } } });
  assert.equal(prefs.data.notify, false);
  assert.deepEqual(prefs.data.intervals.oil, { km: 10000, months: 12 });
  assert.equal((await call('/api/service/prefs', { method: 'POST', token, body: { intervals: { oil: { km: 1 } } } })).data.error, 'bad_interval');

  const deleted = await call('/api/service/delete', { method: 'POST', token, body: { id: added.data.id } });
  assert.deepEqual(deleted.data.entries, []);
  assert.equal((await call('/api/service/delete', { method: 'POST', token, body: { id: added.data.id } })).status, 404);
});
