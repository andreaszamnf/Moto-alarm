import assert from 'node:assert/strict';
import test from 'node:test';
import { handleReport, quickStatus, setArmed, sharedView, snapshot, startShare } from '../src/logic.js';
import { MemoryStore } from '../src/store.js';
import {
  GOOGLE_PER_DAY,
  GOOGLE_PER_MONTH,
  checkGoogleKey,
  googleUsage,
  normalizeWifi,
  takeGoogleLookup,
  validGoogleKey,
  wifiLocate,
} from '../src/wifiloc.js';

const PARK = { lat: 37.9838, lon: 23.7275 };
const T0 = Date.UTC(2026, 10, 18, 10, 0, 0);
const min = (n) => n * 60_000;
const GOOGLE_KEY = `AIza${'x'.repeat(35)}`;

// Access points as the device sends them.
const HERE = [
  { m: '10:20:30:40:50:61', s: -61 },
  { m: '10:20:30:40:50:62', s: -75 },
  { m: '10:20:30:40:50:63', s: -82 },
];
const ELSEWHERE = [
  { m: '70:80:90:a0:b0:c1', s: -58 },
  { m: '70:80:90:a0:b0:c2', s: -66 },
];

function answer(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('only real, fixed access points are sent, strongest first', () => {
  const list = normalizeWifi([
    { m: 'A8-BB-CC-DD-EE-01', s: -80 },
    { m: '10:20:30:40:50:61', s: -50 },
    { m: '10:20:30:40:50:61', s: -52 }, // the same one twice
    { m: '02:00:00:00:00:01', s: -40 }, // locally administered: a phone hotspot
    { m: '01:00:5e:00:00:01', s: -40 }, // multicast
    { m: 'not a mac', s: -40 },
    { m: '10:20:30:40:50:62' }, // no signal strength is fine
    { m: '10:20:30:40:50:63', s: 12 }, // nonsense strength is dropped, the access point kept
  ]);
  assert.deepEqual(list, [
    { macAddress: '10:20:30:40:50:61', signalStrength: -50 },
    { macAddress: 'a8:bb:cc:dd:ee:01', signalStrength: -80 },
    { macAddress: '10:20:30:40:50:62' },
    { macAddress: '10:20:30:40:50:63' },
  ]);
  assert.deepEqual(normalizeWifi('nope'), []);
  assert.equal(normalizeWifi(Array.from({ length: 40 }, (_, i) => ({ m: `10:20:30:40:51:${i.toString(16).padStart(2, '0')}`, s: -60 - i }))).length, 15);
});

test('Google is asked first, beaconDB when Google does not know the place', async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    asked.push(String(url));
    const body = JSON.parse(init.body);
    assert.equal(body.considerIp, false, 'never a guess from the IP address');
    assert.equal(body.wifiAccessPoints.length, 3);
    if (String(url).includes('googleapis')) return answer(404, { error: { errors: [{ reason: 'notFound' }] } });
    return answer(200, { location: { lat: 37.99, lng: 23.73 }, accuracy: 42.6 });
  };
  const found = await wifiLocate(normalizeWifi(HERE), { googleKey: GOOGLE_KEY, fetchFn });
  assert.deepEqual(found, { lat: 37.99, lon: 23.73, acc: 43, by: 'beacondb' });
  assert.match(asked[0], /googleapis\.com\/geolocation\/v1\/geolocate\?key=AIza/);
  assert.match(asked[1], /api\.beacondb\.net/);
});

test('guesses from an IP address or a cell tower are not positions', async () => {
  const fallback = async () => answer(200, { location: { lat: 38, lng: 23.7 }, accuracy: 50, fallback: 'ipf' });
  assert.equal(await wifiLocate(normalizeWifi(HERE), { fetchFn: fallback }), null);
  const vague = async () => answer(200, { location: { lat: 38, lng: 23.7 }, accuracy: 25000 });
  assert.equal(await wifiLocate(normalizeWifi(HERE), { fetchFn: vague }), null);
  const broken = async () => {
    throw new Error('offline');
  };
  assert.equal(await wifiLocate(normalizeWifi(HERE), { googleKey: GOOGLE_KEY, fetchFn: broken }), null);
  assert.equal(await wifiLocate(normalizeWifi(HERE.slice(0, 1)), { fetchFn: fallback }), null, 'one access point is not enough');
});

test('a Google key is checked before it is kept', async () => {
  assert.equal(validGoogleKey(GOOGLE_KEY), true);
  assert.equal(validGoogleKey('AIza-too-short'), false);
  assert.equal(await checkGoogleKey(GOOGLE_KEY, async () => answer(404, { error: { errors: [{ reason: 'notFound' }] } })), null);
  const google = (status, error) => async () => answer(status, { error });
  assert.equal(await checkGoogleKey(GOOGLE_KEY, google(400, { errors: [{ reason: 'keyInvalid' }] })), 'invalid');
  assert.equal(
    await checkGoogleKey(
      GOOGLE_KEY,
      google(400, { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] }),
    ),
    'invalid',
  );
  assert.equal(
    await checkGoogleKey(
      GOOGLE_KEY,
      google(403, {
        status: 'PERMISSION_DENIED',
        message: 'Geolocation API has not been used in project 123 before or it is disabled.',
        details: [{ reason: 'SERVICE_DISABLED' }],
      }),
    ),
    'not_enabled',
  );
  assert.equal(
    await checkGoogleKey(
      GOOGLE_KEY,
      google(403, {
        errors: [{ reason: 'forbidden' }],
        status: 'PERMISSION_DENIED',
        message: 'This API method requires billing to be enabled.',
        details: [{ reason: 'BILLING_DISABLED' }],
      }),
    ),
    'billing',
  );
  assert.equal(await checkGoogleKey(GOOGLE_KEY, google(429, { errors: [{ reason: 'dailyLimitExceeded' }] })), 'quota');
  assert.equal(
    await checkGoogleKey(GOOGLE_KEY, async () => {
      throw new Error('offline');
    }),
    'unreachable',
  );
});

test('Google lookups stop at 300 a day and 9,000 a month, inside the free 10,000', async () => {
  assert.ok(GOOGLE_PER_DAY * 31 < 10_000 || GOOGLE_PER_MONTH < 10_000);
  const store = new MemoryStore();
  for (let i = 0; i < GOOGLE_PER_DAY; i++) assert.equal(await takeGoogleLookup(store, T0), true);
  assert.equal(await takeGoogleLookup(store, T0), false, 'the 301st today is refused');
  assert.equal(await takeGoogleLookup(store, T0 + 86_400_000), true, 'a new day starts again');
  assert.equal(await googleUsage(store, T0 + 86_400_000), GOOGLE_PER_DAY + 1);

  await store.set('wifiloc_usage', { day: '2026-11-30', dayCount: 0, month: '2026-11', monthCount: GOOGLE_PER_MONTH });
  const lateNovember = Date.UTC(2026, 10, 30, 12);
  assert.equal(await takeGoogleLookup(store, lateNovember), false, 'the month is used up');
  assert.equal(await takeGoogleLookup(store, Date.UTC(2026, 11, 1, 0, 30)), true, 'December starts again');
  assert.equal(await googleUsage(store, Date.UTC(2026, 11, 1, 1)), 1);
});

function setup(geolocate) {
  const store = new MemoryStore();
  const calls = [];
  const lookup = async (accessPoints) => {
    calls.push(accessPoints);
    return geolocate(accessPoints);
  };
  const report = (r, now) => handleReport({ store, report: r, now, geolocate: lookup });
  return { store, calls, report };
}

test('no GPS: the position comes from the Wi-Fi around the bike, marked as rough', async () => {
  const { store, calls, report } = setup(async () => ({ lat: 37.985, lon: 23.729, acc: 60, by: 'google' }));
  await report({ reason: 'heartbeat', wifi: HERE }, T0);
  const snap = await snapshot(store, T0);
  assert.equal(snap.position.src, 'wifi');
  assert.equal(snap.position.acc, 60);
  assert.equal(calls.length, 1);
  assert.equal((await store.positions(0, T0 + 1)).length, 1, 'kept in the history too');
  assert.equal(quickStatus(snap).position.src, 'wifi');
  const share = await startShare({ store, token: 't', hours: 1, now: T0 });
  assert.equal((await sharedView({ store, share, now: T0 })).position.src, 'wifi');

  // With a GPS fix the Wi-Fi list is ignored.
  await report({ reason: 'heartbeat', fix: PARK, wifi: HERE }, T0 + min(1));
  assert.equal(calls.length, 1);
  assert.equal((await snapshot(store, T0 + min(1))).position.src, undefined);
});

test('the same Wi-Fi around a standing bike is looked up once, a new place again', async () => {
  const { calls, report } = setup(async () => null); // the service does not know these
  await report({ reason: 'track', wifi: HERE }, T0);
  await report({ reason: 'track', wifi: HERE.slice(0, 2) }, T0 + min(5));
  await report({ reason: 'track', wifi: HERE }, T0 + min(10));
  assert.equal(calls.length, 1, '"not known" is remembered as well');
  await report({ reason: 'track', wifi: ELSEWHERE }, T0 + min(15));
  assert.equal(calls.length, 2);
  await report({ reason: 'track', wifi: ELSEWHERE }, T0 + min(15) + 7 * 3_600_000);
  assert.equal(calls.length, 3, 'asked again after a few hours');
});

test('a rough Wi-Fi position never raises "moved" and never becomes the parking spot', async () => {
  const far = { lat: PARK.lat + 0.01, lon: PARK.lon, acc: 30, by: 'google' }; // about 1.1 km away
  const { store, report } = setup(async () => far);
  await report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 + min(1) });
  const res = await report({ reason: 'heartbeat', wifi: HERE }, T0 + min(2));
  assert.equal(res.track, false);
  assert.equal((await snapshot(store, T0 + min(2))).alarm.active, false);

  // Armed while the last position was from Wi-Fi: the next GPS fix sets the spot.
  await setArmed({ store, armed: false, now: T0 + min(3) });
  await setArmed({ store, armed: true, now: T0 + min(4) });
  assert.equal((await snapshot(store, T0 + min(4))).armed.park, null);
  await report({ reason: 'heartbeat', fix: PARK }, T0 + min(5));
  assert.deepEqual((await snapshot(store, T0 + min(5))).armed.park, { lat: PARK.lat, lon: PARK.lon });
});
