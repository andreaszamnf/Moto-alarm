// The details of one past ride, as the app works them out from its points (app/js/ride.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { minutesText, speedBand, tripDetails } from '../../app/js/ride.js';

const T0 = Date.UTC(2026, 10, 20, 19, 0, 0);
const M_PER_DEG = 111195; // one degree of latitude, in metres

// A ride straight north, one point every 3 seconds as the board sends them: legs of [seconds, km/h].
function ride(legs) {
  let ts = T0;
  let lat = 37.9;
  const pts = [{ ts, lat, lon: 23.7, speed: legs[0][1] }];
  for (const [seconds, kmh] of legs) {
    for (let s = 0; s < seconds; s += 3) {
      ts += 3000;
      lat += ((kmh / 3.6) * 3) / M_PER_DEG;
      pts.push({ ts, lat, lon: 23.7, speed: kmh });
    }
  }
  return pts;
}

const near = (actual, expected, slack, what) =>
  assert.ok(Math.abs(actual - expected) <= slack, `${what}: ${actual}, expected about ${expected}`);

test('a ride in detail: top speed, stops between moving parts, time in each speed band', () => {
  // 3 minutes at 40, a 2-minute stop, 2 minutes at 100, a red light, 1 minute at 140, then the
  // 3 minutes the board stands still before it says "parked".
  const d = tripDetails(ride([[180, 40], [120, 0], [120, 100], [30, 0], [60, 140], [180, 0]]));
  assert.equal(d.max.kmh, 140);
  assert.ok(d.max.ts > T0 + 450_000 && d.max.ts <= T0 + 510_000, 'the top speed is in the last leg');
  assert.equal(d.stops.length, 1, 'the red light and the wait before "parked" are no stops');
  near(d.stops[0].s, 120, 6, 'the stop');
  near(d.stops[0].from, T0 + 183_000, 3000, 'the stop begins after the first leg');
  near(d.bandS[0], 180, 9, 'up to 50');
  near(d.bandS[2], 120, 6, '90 to 130');
  near(d.bandS[3], 60, 6, 'above 130');
  near(d.movingS, 360, 12, 'moving time');
  near(d.totalS, 510, 6, 'from moving off to the last movement');
  near(d.stoppedS, 150, 12, 'standing in between');
  near(d.m, 2000 + 3333 + 2333, 60, 'distance');
  near(d.avg, (d.m / d.movingS) * 3.6, 0.01, 'average while moving');
});

test('the route comes in stretches by speed band, joined end to end', () => {
  const d = tripDetails(ride([[60, 30], [60, 70], [60, 110], [60, 150]]));
  const bands = d.segments.map((s) => s.band);
  assert.deepEqual([...new Set(bands)], [0, 1, 2, 3]);
  for (let i = 1; i < d.segments.length; i++) {
    assert.deepEqual(d.segments[i].latlngs[0], d.segments[i - 1].latlngs.at(-1), 'no gap between stretches');
  }
  assert.equal(d.points.length, 81);
});

test('speed bands, minutes, and too few points', () => {
  assert.deepEqual([0, 49.9, 50, 89, 90, 129, 130, 200].map(speedBand), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(minutesText(125), '2′');
  assert.equal(minutesText(20), '1′');
  assert.equal(minutesText(3900), '1 ώ 05′');
  assert.equal(tripDetails([{ ts: T0, lat: 37.9, lon: 23.7, speed: 10 }]), null);
  assert.equal(tripDetails(null), null);
  const glitch = tripDetails([
    { ts: T0, lat: 37.9, lon: 23.7, speed: 50 },
    { ts: T0 + 3000, lat: 37.9004, lon: 23.7, speed: 999 },
    { ts: T0 + 6000, lat: 37.9008, lon: 23.7, speed: 52 },
  ]);
  assert.equal(glitch.max.kmh, 52, 'a GPS speed over 300 is a glitch');
});
