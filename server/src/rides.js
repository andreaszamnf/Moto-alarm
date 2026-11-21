// Rides: where the bike is and how fast it goes while the owner rides, and a summary of each ride
// afterwards. From firmware 1.6.0 the board takes a GPS point every 3 seconds while riding and
// sends them together every 15 seconds (`pts`). Older boards send one position every 5 minutes;
// their rides come out rougher (straight lines between points) but still count.
import { distanceM } from './logic.js';

export const RIDE_REPORT_SECONDS = 15; // sent to the board: how often to report while riding
export const LOW_POWER_RIDE_SECONDS = 60; // the same with «Χαμηλή κατανάλωση» on (the points stay every 3 s)
export const rideSeconds = (settings) => (settings?.lowPower ? LOW_POWER_RIDE_SECONDS : RIDE_REPORT_SECONDS);
export const RIDE_GAP_MS = 15 * 60_000; // nothing heard for this long: the ride is over
export const MOVING_KMH = 5; // slower than this is standing (a red light, GPS drift)
const MIN_RIDE_M = 300; // shorter: pushing the bike around the garage, not a ride
const MAX_POINTS = 60; // per report (the board keeps up to 40 while it has no signal)
const MAX_KMH = 300; // a GPS speed or a jump faster than this is a glitch
export const MAX_TRIPS = 200; // summaries kept (the points themselves go after 90 days)

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;

/** The board's points: [[unix seconds, lat, lon, km/h], ...] → [{ ts, lat, lon, acc, speed }], oldest first. */
export function normalizePoints(pts, now) {
  if (!Array.isArray(pts)) return [];
  const out = [];
  for (const p of pts.slice(0, MAX_POINTS)) {
    if (!Array.isArray(p)) continue;
    const [t, lat, lon, spd] = p.map(finite);
    if (t === null || lat === null || lon === null) continue;
    const ts = t * 1000;
    if (ts > now + 60_000 || ts < now - 86_400_000) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    const speed = spd !== null && spd >= 0 && spd <= MAX_KMH ? spd : null;
    out.push({ ts, lat, lon, acc: null, speed });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.filter((p, i) => i === 0 || p.ts !== out[i - 1].ts);
}

// Adds one point to the ride: distance and time only while moving, so a red light or the GPS
// wandering around a standing bike adds nothing.
function addPoint(ride, p) {
  const prev = ride.prev;
  if (prev && p.ts <= prev.ts) return;
  if (p.speed !== null && p.speed > ride.max) ride.max = p.speed;
  if (prev) {
    const dt = (p.ts - prev.ts) / 1000;
    const d = distanceM(prev, p);
    const kmh = (d / dt) * 3.6;
    // Points a few seconds apart: the GPS speed says best whether it moved. Further apart (an
    // older board, or the stop before "parked"), or without a speed: how far it went meanwhile.
    const close = dt <= 30 && p.speed !== null && prev.speed !== null;
    const moving = close ? Math.max(p.speed, prev.speed) >= MOVING_KMH : kmh >= MOVING_KMH;
    if (moving && kmh <= MAX_KMH) {
      ride.m += d;
      ride.movingS += Math.min(dt, 600);
    }
  }
  ride.prev = { ts: p.ts, lat: p.lat, lon: p.lon, speed: p.speed };
  ride.speed = p.speed;
  ride.n += 1;
}

export function rideSummary(ride) {
  return {
    start: ride.start,
    end: ride.prev?.ts ?? ride.last,
    m: Math.round(ride.m),
    movingS: Math.round(ride.movingS),
    max: round1(ride.max),
    avg: ride.movingS >= 10 ? round1((ride.m / ride.movingS) * 3.6) : null,
  };
}

/** Ends the ride under way, if any, and keeps its summary when it was a real ride. */
export async function endRide(store, now = Date.now()) {
  const ride = await store.get('ride');
  if (!ride) return null;
  await store.set('ride', null);
  if (ride.m < MIN_RIDE_M) return null;
  const summary = rideSummary(ride);
  // Ridden while lent out (a workshop's test ride, a friend): marked in the list.
  const loan = await store.get('loan');
  if (loan?.on && summary.end >= loan.since) summary.loan = true;
  const trips = (await store.get('trips')) ?? [];
  trips.push(summary);
  while (trips.length > MAX_TRIPS) trips.shift();
  await store.set('trips', trips);
  await store.addEvent('ride', { m: summary.m, s: summary.movingS }, now);
  return summary;
}

/** A ride nobody has heard from for a while is over (the board parked without saying so, or died). */
export async function endStaleRide(store, now = Date.now()) {
  const ride = await store.get('ride');
  if (ride && now - ride.last > RIDE_GAP_MS) return endRide(store, now);
  return null;
}

/**
 * Follows the ride from a device report. `points` are the report's GPS points (or its one fix).
 * A ride starts with movement while disarmed and ends with "parked", with arming, or after a
 * quarter of an hour without news.
 * Returns what changed: { started, ride (the one under way, or null), ended (summary of a ride kept
 * just now, or null) }.
 */
export async function trackRide({ store, reason, points, armed, now }) {
  const stale = await endStaleRide(store, now);
  let ride = await store.get('ride');
  const riding = !armed && (reason === 'ride' || reason === 'motion');
  if (!ride && !riding) return { started: false, ride: null, ended: stale };
  const started = !ride;
  if (!ride) ride = { start: points[0]?.ts ?? now, last: now, m: 0, movingS: 0, max: 0, n: 0, prev: null, speed: null };
  for (const p of points) {
    // Points taken before the report that started the ride got through still belong to it: the
    // ride's route and details are looked up from its start.
    if (p.ts < ride.start) ride.start = p.ts;
    addPoint(ride, p);
  }
  ride.last = now;
  await store.set('ride', ride);
  if (armed || reason === 'parked') return { started, ride: null, ended: await endRide(store, now) };
  return { started, ride, ended: stale };
}

/** The ride under way, for the app: null when there is none. `every`: seconds between the board's reports. */
export function rideView(ride, now = Date.now(), every = RIDE_REPORT_SECONDS) {
  if (!ride || now - ride.last > RIDE_GAP_MS) return null;
  return {
    ...rideSummary(ride),
    every,
    last: ride.last, // when the board last reported
    at: ride.prev?.ts ?? null, // when the newest point was taken
    speed: ride.speed ?? null,
    lat: ride.prev?.lat ?? null,
    lon: ride.prev?.lon ?? null,
  };
}

/** Past rides, newest first. */
export async function tripList(store, limit = 50) {
  const trips = (await store.get('trips')) ?? [];
  return trips.slice(-limit).reverse();
}
