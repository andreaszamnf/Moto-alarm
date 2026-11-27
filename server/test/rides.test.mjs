import assert from 'node:assert/strict';
import test from 'node:test';
import { handleReport, setArmed, snapshot } from '../src/logic.js';
import { RIDE_GAP_MS, normalizePoints, tripList } from '../src/rides.js';
import { MemoryStore } from '../src/store.js';

const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const sec = (n) => n * 1000;
const min = (n) => n * 60_000;
const START = { lat: 37.9838, lon: 23.7275 };

function setup() {
  const store = new MemoryStore();
  const report = (r, now) => handleReport({ store, report: r, now });
  return { store, report };
}

// Points going north at `kmh`, one every 3 seconds, from `from` (ms).
function northPoints(from, count, kmh, startLat = START.lat) {
  const degPerS = kmh / 3.6 / 111_195;
  return Array.from({ length: count }, (_, i) => [
    Math.floor(from / 1000) + i * 3,
    startLat + degPerS * i * 3,
    START.lon,
    kmh,
  ]);
}

test('the board\'s ride points: bad ones left out, sorted, no duplicates', () => {
  const now = T0;
  const t = Math.floor(now / 1000);
  const pts = normalizePoints(
    [
      [t - 3, 37.9, 23.7, 50],
      [t - 6, 37.9, 23.7, 48],
      [t - 3, 37.9, 23.7, 50], // the same again
      [t + 600, 37.9, 23.7, 50], // from the future
      [t - 2 * 86_400, 37.9, 23.7, 50], // two days old
      [t - 1, 0, 0, 50], // no fix
      [t - 2, 37.9, 23.7, 999], // a speed glitch: the point stays, the speed goes
      'nonsense',
    ],
    now,
  );
  assert.deepEqual(pts.map((p) => p.ts), [now - sec(6), now - sec(3), now - sec(2)]);
  assert.equal(pts[2].speed, null);
  assert.deepEqual(normalizePoints(undefined, now), []);
});

test('riding: every point is kept and the app sees speed, distance and time as they happen', async () => {
  const { store, report } = setup();
  const res = await report({ reason: 'motion', moving: true }, T0);
  assert.equal(res.rideInterval, 15, 'the board learns how often to report');
  assert.equal((await snapshot(store, T0)).ride, null, 'not before the GPS sees the bike go: it may be a knock');

  // Two reports of five points each at 60 km/h, 3 seconds apart: 27 seconds, 450 m.
  const first = northPoints(T0 + sec(3), 5, 60);
  const second = northPoints(T0 + sec(18), 5, 60, first[4][1] + (60 / 3.6 / 111_195) * 3);
  const last = (pts) => ({ lat: pts[4][1], lon: pts[4][2], spd: pts[4][3], t: pts[4][0] });
  await report({ reason: 'ride', moving: true, fix: last(first), pts: first }, T0 + sec(16));
  await report({ reason: 'ride', moving: true, fix: last(second), pts: second }, T0 + sec(31));

  const positions = await store.positions(T0, T0 + min(1));
  assert.equal(positions.length, 10, 'each point once, the fix not twice');
  const { ride, position } = await snapshot(store, T0 + sec(33));
  assert.equal(ride.speed, 60);
  assert.equal(ride.max, 60);
  assert.ok(Math.abs(ride.m - 450) < 5, `about 450 m between the first and the last point, got ${ride.m}`);
  assert.equal(ride.movingS, 27);
  assert.equal(ride.avg, 60);
  assert.equal(position.lat, second[4][1], 'the bike on the map is where the newest point is');
});

test('an answer that never reached the board: the points it sends again are kept once (2026-11-26)', async () => {
  const { store, report } = setup();
  await report({ reason: 'motion', moving: true }, T0);
  const first = northPoints(T0 + sec(3), 5, 100);
  const later = northPoints(T0 + sec(18), 40, 100, first[4][1] + (100 / 3.6 / 111_195) * 3);
  await report({ reason: 'ride', moving: true, pts: first }, T0 + sec(16));
  // Its answer got lost: the board waited 2 minutes, taking points meanwhile (firmware 1.9.0), then
  // sent everything again, saying how the request had ended.
  await report({ reason: 'ride', moving: true, pts: [...first, ...later], fails: 1, hw: 'none 120s +HTTP_NONET_EVENT' }, T0 + min(2) + sec(20));
  const positions = await store.positions(T0, T0 + min(3));
  assert.equal(positions.length, 45, 'each point once');
  assert.equal(new Set(positions.map((p) => p.ts)).size, 45);
  const ride = await store.get('ride');
  assert.equal(ride.movingS, 132, 'the time counted once: 44 steps of 3 s');
  assert.deepEqual((await store.get('device')).hw, { text: 'none 120s +HTTP_NONET_EVENT', at: T0 + min(2) + sec(20) });
  await report({ reason: 'ride', moving: true, pts: northPoints(T0 + min(2) + sec(18), 5, 100, later[39][1]) }, T0 + min(2) + sec(35));
  assert.equal((await store.get('device')).hw.text, 'none 120s +HTTP_NONET_EVENT', 'kept until something newer comes');
});

test('points taken before the report that started the ride still belong to it, from its start', async () => {
  const { store, report } = setup();
  // The "motion" report got through 30 seconds after the bike moved off.
  await report({ reason: 'motion', moving: true }, T0 + sec(30));
  const pts = northPoints(T0, 20, 60);
  await report({ reason: 'ride', moving: true, pts }, T0 + sec(60));
  const end = pts[19];
  await report({ reason: 'parked', fix: { lat: end[1], lon: end[2], spd: 0, t: end[0] } }, T0 + min(4));
  const [trip] = await tripList(store);
  assert.equal(trip.start, T0, 'the ride starts at its first point');
  const route = await store.positions(trip.start, trip.end);
  assert.equal(route[0].ts, T0, 'the whole route is found from the start');
  assert.ok(route.length >= 20);
});

test('standing at a red light: the GPS wandering adds no distance', async () => {
  const { store, report } = setup();
  await report({ reason: 'motion', moving: true }, T0);
  const t = Math.floor(T0 / 1000);
  // Standing still, the GPS position jumps around by a few metres each time.
  const pts = [0, 1, 2, 3, 4, 5].map((i) => [t + i * 3, START.lat + (i % 2) * 0.00005, START.lon, 1.2]);
  await report({ reason: 'ride', pts }, T0 + sec(20));
  const ride = await store.get('ride');
  assert.equal(ride.m, 0);
  assert.equal(ride.movingS, 0);
  assert.equal((await snapshot(store, T0 + sec(20))).ride, null, 'and no «Οδηγείς τώρα» for a bike that went nowhere');
});

test('a knock on the desk: no «Οδηγείς τώρα» until the GPS sees the bike go 50 m (2026-11-24)', async () => {
  const { store, report } = setup();
  // The board on a desk at home, disarmed: every knock starts a "ride", the GPS sees it stand.
  const t = Math.floor(T0 / 1000);
  await report({ reason: 'motion', moving: true }, T0);
  const desk = [0, 1, 2, 3].map((i) => [t + 60 + i * 3, START.lat + (i % 2) * 0.00002, START.lon, i % 2]);
  await report({ reason: 'ride', moving: true, pts: desk }, T0 + sec(75));
  assert.equal((await snapshot(store, T0 + sec(75))).ride, null);
  await report({ reason: 'parked', fix: { ...START, spd: 0 } }, T0 + min(4));
  assert.deepEqual(await tripList(store), [], 'nothing in the history either');

  // A real start: 30 m at walking pace is not yet a ride, 50 m at 20 km/h is.
  await report({ reason: 'motion', moving: true }, T0 + min(10));
  await report({ reason: 'ride', moving: true, pts: northPoints(T0 + min(10), 3, 18) }, T0 + min(10) + sec(10));
  assert.equal((await snapshot(store, T0 + min(10) + sec(10))).ride, null, '30 m');
  await report({ reason: 'ride', moving: true, pts: northPoints(T0 + min(10) + sec(9), 3, 20, START.lat + 0.00027) }, T0 + min(10) + sec(20));
  const { ride } = await snapshot(store, T0 + min(10) + sec(20));
  assert.ok(ride && ride.m >= 50, `shown from 50 m, got ${ride?.m}`);
  assert.equal(ride.start, T0 + min(10), 'counted from where it started');
});

test('parked: the ride is kept with its summary and goes into the history', async () => {
  const { store, report } = setup();
  await report({ reason: 'motion', moving: true }, T0);
  // Ten minutes at 60 km/h, reported every 15 seconds.
  let lat = START.lat;
  for (let i = 0; i < 40; i++) {
    const pts = northPoints(T0 + sec(i * 15), 5, 60, lat);
    lat = pts[4][1] + (60 / 3.6 / 111_195) * 3;
    await report({ reason: 'ride', moving: true, pts }, T0 + sec(i * 15 + 14));
  }
  await report({ reason: 'parked', fix: { lat, lon: START.lon, spd: 0 } }, T0 + min(14));

  const { ride } = await snapshot(store, T0 + min(14));
  assert.equal(ride, null);
  const [trip] = await tripList(store);
  assert.equal(trip.start, T0);
  assert.ok(Math.abs(trip.m - 10_000) < 100, `about 10 km, got ${trip.m}`);
  assert.equal(trip.max, 60);
  assert.ok(Math.abs(trip.avg - 60) < 1);
  const events = await store.events(5);
  assert.ok(events.some((e) => e.type === 'ride' && e.data.m === trip.m));
});

test('pushing the bike around the garage is no ride', async () => {
  const { store, report } = setup();
  await report({ reason: 'motion', moving: true }, T0);
  await report({ reason: 'ride', pts: northPoints(T0, 5, 6) }, T0 + sec(15));
  await report({ reason: 'parked', fix: START }, T0 + min(4));
  assert.deepEqual(await tripList(store), []);
});

test('arming in the app ends the ride at once', async () => {
  const { store, report } = setup();
  await report({ reason: 'motion', moving: true }, T0);
  await report({ reason: 'ride', pts: northPoints(T0, 5, 50) }, T0 + sec(15));
  await report({ reason: 'ride', pts: northPoints(T0 + sec(15), 5, 50, START.lat + 0.002) }, T0 + sec(30));
  await setArmed({ store, armed: true, now: T0 + min(2) });
  assert.equal((await snapshot(store, T0 + min(2))).ride, null);
  assert.equal((await tripList(store)).length, 1);
});

test('armed: movement is an alarm, never a ride', async () => {
  const { store, report } = setup();
  await setArmed({ store, armed: true, now: T0 });
  const res = await report({ reason: 'motion', moving: true }, T0 + sec(5));
  assert.equal(res.track, true);
  assert.equal((await snapshot(store, T0 + sec(6))).ride, null);
});

test('a ride the board never closed ends after a quarter of an hour of silence', async () => {
  const { store, report } = setup();
  await report({ reason: 'motion', moving: true }, T0);
  await report({ reason: 'ride', pts: northPoints(T0, 5, 50) }, T0 + sec(15));
  await report({ reason: 'ride', pts: northPoints(T0 + sec(15), 5, 50, START.lat + 0.002) }, T0 + sec(30));
  const later = T0 + sec(30) + RIDE_GAP_MS + 1;
  assert.equal((await snapshot(store, later)).ride, null, 'no longer shown as riding');
  // The next report (a heartbeat hours later) files it.
  await report({ reason: 'heartbeat', fix: START }, later + min(60));
  assert.equal((await tripList(store)).length, 1);
});

test('an older board (one position every 5 minutes) still gets its rides counted', async () => {
  const { store, report } = setup();
  await report({ reason: 'motion', moving: true }, T0);
  await report({ reason: 'ride', moving: true, fix: { ...START, spd: 40 } }, T0 + min(5));
  await report({ reason: 'ride', moving: true, fix: { lat: START.lat + 0.03, lon: START.lon, spd: 55 } }, T0 + min(10));
  await report({ reason: 'parked', fix: { lat: START.lat + 0.03, lon: START.lon } }, T0 + min(14));
  const [trip] = await tripList(store);
  assert.ok(trip.m > 3000 && trip.m < 3500, `about 3.3 km in a straight line, got ${trip.m}`);
  assert.equal(trip.max, 55);
});

test('armed right after getting off: earlier movement in the ride report is no alarm, later movement is', async () => {
  const { store, report } = setup();
  await report({ reason: 'motion', moving: true }, T0);
  const t = Math.floor(T0 / 1000);
  // Got off at T0 + 60 s, armed at T0 + 70 s; the next live report still says "it moved".
  await setArmed({ store, armed: true, now: T0 + sec(70) });
  const quiet = await report({ reason: 'ride', moving: true, lastMove: t + 60 }, T0 + sec(75));
  assert.equal(quiet.track, false);
  assert.equal(quiet.armed, true, 'the board hears it is armed and parks');
  // Someone moves it after the arming: alarm as always.
  const loud = await report({ reason: 'ride', moving: true, lastMove: t + 80 }, T0 + sec(85));
  assert.equal(loud.track, true);
});
