import assert from 'node:assert/strict';
import test from 'node:test';
import { folderView, normalizeBike, savePhoto, startFolder } from '../src/folder.js';
import worker from '../src/index.js';
import { setLoan } from '../src/loan.js';
import { handleReport, runAutomation, setArmed, snapshot, updateSettings } from '../src/logic.js';
import { morningSummary } from '../src/morning.js';
import { tripList } from '../src/rides.js';
import { MemoryStore, getStore } from '../src/store.js';

const T0 = Date.UTC(2026, 10, 20, 9, 0, 0); // 11:00 in Greece
const sec = (n) => n * 1000;
const min = (n) => n * 60_000;
const DAY = 86_400_000;
const START = { lat: 37.9838, lon: 23.7275 };

function setup() {
  const store = new MemoryStore();
  const sent = [];
  const notify = async (payload) => sent.push(payload);
  const report = (r, now) => handleReport({ store, report: r, now, notify });
  return { store, sent, report };
}

// Points going north at `kmh`, one every 3 seconds.
function northPoints(from, count, kmh, startLat = START.lat) {
  const degPerS = kmh / 3.6 / 111_195;
  return Array.from({ length: count }, (_, i) => [Math.floor(from / 1000) + i * 3, startLat + degPerS * i * 3, START.lon, kmh]);
}

// A ride of `reports` live reports at `kmh`, from `from`; returns where it ended.
async function ride(report, from, reports, kmh) {
  let lat = START.lat;
  for (let i = 0; i < reports; i++) {
    const pts = northPoints(from + sec(i * 15), 5, kmh, lat);
    lat = pts[4][1] + (kmh / 3.6 / 111_195) * 3;
    await report({ reason: 'ride', moving: true, pts }, from + sec(i * 15 + 14));
  }
  return lat;
}

// ---------- lent out ----------

test('lent out: disarmed, a quiet note when it starts, a summary when it stops, the ride marked', async () => {
  const { store, sent, report } = setup();
  await setArmed({ store, armed: true, now: T0 });
  await setLoan({ store, on: true, now: T0 + min(1) });
  assert.equal((await snapshot(store, T0 + min(1))).armed.armed, false, 'lending disarms');

  const res = await report({ reason: 'motion', moving: true }, T0 + min(10));
  assert.equal(res.track, false, 'no alarm');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Η μηχανή ξεκίνησε');
  assert.equal(sent[0].quiet, true);

  const lat = await ride(report, T0 + min(10), 40, 60); // 10 minutes at 60 km/h
  const during = await snapshot(store, T0 + min(21));
  assert.equal(during.loan.riding, true);
  assert.ok(during.loan.m > 9000);

  await report({ reason: 'parked', fix: { lat, lon: START.lon } }, T0 + min(24));
  const summary = sent.find((p) => p.title === 'Η μηχανή σταμάτησε');
  assert.ok(summary, 'a summary when it stops');
  assert.match(summary.body, /χλμ σε \d+′, μέγιστη 60 χλμ\/ώ/);
  assert.ok(!sent.some((p) => p.title === 'Πάρκαρες;'), 'no "did you park?" reminder for the mechanic');
  const [trip] = await tripList(store);
  assert.equal(trip.loan, true);
  const after = await snapshot(store, T0 + min(25));
  assert.equal(after.loan.rides, 1);
  assert.equal(after.loan.max, 60);
});

test('lent out: one notification per ride above the speed limit the owner set', async () => {
  const { store, sent, report } = setup();
  await setLoan({ store, on: true, speedLimit: 100, now: T0 });
  await report({ reason: 'motion', moving: true }, T0 + min(1));
  await ride(report, T0 + min(1), 4, 90);
  assert.ok(!sent.some((p) => p.tag === 'moto-loan-speed'), 'not at 90');
  await ride(report, T0 + min(2), 4, 128);
  const fast = sent.filter((p) => p.tag === 'moto-loan-speed');
  assert.equal(fast.length, 1, 'once, not with every report');
  assert.equal(fast[0].title, 'Πάνω από 100 χλμ/ώ');
  assert.match(fast[0].body, /128 χλμ\/ώ/);
});

test('lent out: arming ends it; the daily schedule does not arm it', async () => {
  const { store, sent } = setup();
  await updateSettings(store, { schedule: { on: true, arm: '23:00', disarm: '' } }, T0);
  await setLoan({ store, on: true, now: T0 });
  // 23:00 in Greece is 21:00 UTC.
  await runAutomation({ store, now: Date.UTC(2026, 10, 20, 21, 1), notify: async (p) => sent.push(p) });
  assert.equal((await store.get('armed'))?.armed ?? false, false);
  assert.equal(sent.at(-1).title, 'Δεν οπλίστηκε');

  await setArmed({ store, armed: true, now: T0 + min(700) });
  assert.equal((await snapshot(store, T0 + min(700))).loan, null);
  const events = await store.events(10);
  assert.ok(events.some((e) => e.type === 'loan' && e.data.on === false));
});

test('without lending, nothing changes: movement while armed is an alarm', async () => {
  const { store, sent, report } = setup();
  await setArmed({ store, armed: true, now: T0 });
  const res = await report({ reason: 'motion', moving: true }, T0 + min(1));
  assert.equal(res.track, true);
  assert.ok(!sent.some((p) => p.tag === 'moto-loan'));
});

// ---------- theft folder ----------

test('bike details are cut to size and photos must really be images', async () => {
  const bike = normalizeBike({ plate: ' ioh1234 ', vin: 'jh2rc', model: 'Hornet', color: 'Μαύρο', extra: 'x' });
  assert.deepEqual(bike, { plate: 'IOH1234', vin: 'JH2RC', model: 'Hornet', color: 'Μαύρο', notes: '' });
  const store = new MemoryStore();
  await assert.rejects(savePhoto(store, 0, new TextEncoder().encode('<script>'), 'image/jpeg'), /bad_photo/);
  await assert.rejects(savePhoto(store, 5, new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg'), /bad_slot/);
  const big = new Uint8Array(800 * 1024);
  big.set([0xff, 0xd8, 0xff]);
  await assert.rejects(savePhoto(store, 0, big, 'image/jpeg'), /photo_too_large/);
  await savePhoto(store, 1, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'image/jpeg');
  assert.match(await store.get('bike_photo_1'), /^data:image\/jpeg;base64,/);
});

test('the folder shows the route from the alarm on, with times, and nothing from before', async () => {
  const { store, report } = setup();
  await report({ reason: 'parked', fix: START }, T0 - min(60));
  await setArmed({ store, armed: true, now: T0 - min(50) });
  await report({ reason: 'motion', moving: true }, T0);
  await report({ reason: 'track', moving: true, fix: { lat: START.lat + 0.01, lon: START.lon, spd: 40 } }, T0 + min(1));
  await report({ reason: 'track', moving: true, fix: { lat: START.lat + 0.02, lon: START.lon, spd: 55 } }, T0 + min(2));
  const share = await startFolder({ store, token: 't', days: 7, now: T0 + min(3) });
  assert.equal(share.from, T0);
  const view = await folderView({ store, share, now: T0 + min(3) });
  assert.equal(view.alarmAt, T0);
  assert.deepEqual(view.trail.map((p) => p[0]), [T0 + min(1), T0 + min(2)], 'not the parking report from before');
  assert.equal(view.trail[1][3], 55);
  assert.deepEqual(view.alarms.map((a) => a.reason), ['motion', 'moved'], 'and the alarm that followed when it left');
  assert.equal(view.bike.model, 'Honda Hornet 750');
});

test('folder link: works until it expires or is stopped, and needs the right token', async () => {
  const env = { APP_PASSWORD: 'pw', TOKEN_SECRET: 'secret-for-tests', DEVICE_KEY: 'dev' };
  const ctx = { waitUntil: (p) => p };
  const call = async (path, { method = 'GET', body, token, raw, type } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (raw) headers['Content-Type'] = type;
    const res = await worker.fetch(
      new Request(`http://localhost${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
      env,
      ctx,
    );
    return { status: res.status, data: await res.json() };
  };
  const { data } = await call('/api/login', { method: 'POST', body: { password: 'pw' } });
  const token = data.token;

  await call('/api/bike', { method: 'POST', body: { plate: 'ΙΟΗ1234', color: 'Μαύρο' }, token });
  const photo = await call('/api/bike/photo?slot=0', { method: 'POST', raw: new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 9]), type: 'image/jpeg', token });
  assert.equal(photo.status, 200);
  assert.ok(photo.data.photos[0]);
  assert.equal((await call('/api/bike/photo?slot=0', { method: 'POST', raw: new Uint8Array([1, 2, 3]), type: 'image/jpeg', token })).status, 400);
  assert.equal((await call('/api/folder', { method: 'POST', body: { days: 5 }, token })).status, 400);

  const made = await call('/api/folder', { method: 'POST', body: { days: 3 }, token });
  const link = made.data.share.token;
  const view = await call(`/api/folder/${link}`);
  assert.equal(view.status, 200, 'no login needed with the link');
  assert.equal(view.data.bike.plate, 'ΙΟΗ1234');
  assert.equal(view.data.photos.length, 1);
  assert.equal(view.data.armed, undefined, 'nothing else about the alarm');
  assert.equal((await call('/api/folder/wrong-token')).status, 404);

  await getStore(env).set('folder_share', { ...(await getStore(env).get('folder_share')), expires: Date.now() - 1 });
  assert.equal((await call(`/api/folder/${link}`)).status, 404, 'expired');
  const again = await call('/api/folder', { method: 'POST', body: { days: 7 }, token });
  await call('/api/folder/stop', { method: 'POST', token });
  assert.equal((await call(`/api/folder/${again.data.share.token}`)).status, 404, 'stopped');
});

// ---------- morning summary ----------

const MORNING = Date.UTC(2026, 10, 21, 6, 2); // 08:02 in Greece

test('morning: one quiet summary after 08:00, about the night', async () => {
  const { store, sent, report } = setup();
  await report({ reason: 'parked', fix: START, batt: { pct: 58 }, via: 'wifi', checkin: 900, touches: 2 }, MORNING - min(10));
  await setArmed({ store, armed: true, now: MORNING - min(9) });
  const notify = async (p) => sent.push(p);
  sent.length = 0;
  assert.equal(await morningSummary({ store, now: MORNING - min(5), notify }), null, 'not before 08:00');
  const text = await morningSummary({ store, now: MORNING, notify });
  assert.equal(text.title, 'Καλημέρα');
  assert.equal(text.body, 'Όλα καλά τη νύχτα · 2 αγγίγματα · μπαταρία 58% · σε επαφή από Wi-Fi · οπλισμένος');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].quiet, true);
  assert.equal(await morningSummary({ store, now: MORNING + min(5), notify }), null, 'once a day');
  assert.equal(await store.get('touch_tally'), null, 'touches counted afresh');
});

test('morning: what is wrong comes first, and the alarms of the night are counted', async () => {
  const { store, sent, report } = setup();
  await report({ reason: 'parked', fix: START, batt: { pct: 12 }, checkin: 900 }, MORNING - min(300));
  await setArmed({ store, armed: true, now: MORNING - min(299) });
  await report({ reason: 'motion', batt: { pct: 12 }, checkin: 900 }, MORNING - min(290));
  sent.length = 0;
  const text = await morningSummary({ store, now: MORNING, notify: async (p) => sent.push(p) });
  assert.equal(text.title, 'Η μηχανή θέλει προσοχή');
  assert.match(text.body, /^Ο συναγερμός χτυπάει τώρα · Χωρίς επαφή από τις 03:12 · Χαμηλή μπαταρία 12% · 1 συναγερμός/);
  assert.equal(sent[0].quiet, false);
});

test('morning: off in the settings, or hours late, sends nothing', async () => {
  const { store } = setup();
  await updateSettings(store, { morning: { on: false } }, MORNING - DAY);
  assert.equal(await morningSummary({ store, now: MORNING }), null);
  await updateSettings(store, { morning: { on: true, time: '07:30' } }, MORNING);
  assert.equal(await morningSummary({ store, now: MORNING + min(4 * 60) }), null, 'four hours late: wait for tomorrow');
  assert.ok(await morningSummary({ store, now: MORNING + DAY - min(30) }), 'the next morning at 07:32');
});

