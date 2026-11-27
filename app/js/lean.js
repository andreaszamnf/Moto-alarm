// Lean angle in turns, for the speedometer: from the phone's gyroscope and its GPS speed.
//
// In a steady turn the bike turns about the vertical at a rate ω and leans so that
// tan(lean) = v·ω/g. A phone fixed to the handlebars turns with it, so the length of its rotation
// vector is ω whichever way the phone sits in its holder. Vibration swings that vector back and
// forth: each axis is smoothed first, and only then is the length taken. The side comes from the GPS
// heading (turning clockwise is a right-hand turn). This is the lean of the line through the centre
// of mass; with the width of the tyres the bike itself leans a few degrees more.
// The board cannot do this: its ADXL345 has no gyroscope, and in a turn it feels the bike upright.

export const G = 9.81;
export const LEAN_MIN_KMH = 15; // slower: no lean (walking pace, a car park)
export const LEAN_FLOOR_DEG = 3; // less: upright (what the smoothing leaves of the vibration)
const SMOOTH_S = 0.4; // smoothing of the gyroscope
const HOLD_MS = 1000; // a lean counts towards the maxima only once it has lasted this long (not a pothole)
const SIDE_MIN_DEG_S = 2; // the heading turning slower than this leaves the side as it was
const SIDE_GAP_MS = 5000; // GPS headings further apart than this say nothing about the side

export function createLean() {
  return { w: [0, 0, 0], wt: null, kmh: null, heading: null, headingAt: null, side: 0, recent: [], maxLeft: 0, maxRight: 0 };
}

// One gyroscope reading: degrees per second about the phone's three axes, at `t` ms.
export function addRotation(s, rate, t) {
  if (!rate.every(Number.isFinite) || (s.wt !== null && t <= s.wt)) return; // out of order: dropped
  if (s.wt === null || t - s.wt > 1000) {
    // The first reading, or the first after a pause (the screen was off): start from still, since a
    // single reading is mostly vibration.
    s.w = [0, 0, 0];
  } else {
    const k = 1 - Math.exp(-(t - s.wt) / 1000 / SMOOTH_S);
    for (let i = 0; i < 3; i++) s.w[i] += (rate[i] - s.w[i]) * k;
  }
  s.wt = t;
}

// One GPS reading: speed in km/h (or null), heading in degrees clockwise from north (or null),
// at `t` ms.
export function addGps(s, kmh, heading, t) {
  s.kmh = kmh;
  if (kmh == null || kmh < LEAN_MIN_KMH) {
    s.heading = null;
    s.side = 0;
    return;
  }
  if (heading == null || !Number.isFinite(heading)) return; // the last one stands (SIDE_GAP_MS)
  if (s.heading !== null && t > s.headingAt && t - s.headingAt <= SIDE_GAP_MS) {
    const turn = ((((heading - s.heading) % 360) + 540) % 360) - 180; // -180..180, + clockwise
    const rate = turn / ((t - s.headingAt) / 1000);
    if (Math.abs(rate) >= SIDE_MIN_DEG_S) s.side = rate > 0 ? 1 : -1;
  }
  s.heading = heading;
  s.headingAt = t;
}

// The lean now: { deg, side: 'left' | 'right' | null }, deg 0 when upright, or null when too slow
// or not yet known.
export function leanNow(s) {
  if (s.kmh == null || s.kmh < LEAN_MIN_KMH || s.wt === null) return null;
  const w = (Math.hypot(s.w[0], s.w[1], s.w[2]) * Math.PI) / 180;
  const deg = (Math.atan(((s.kmh / 3.6) * w) / G) * 180) / Math.PI;
  if (deg < LEAN_FLOOR_DEG) return { deg: 0, side: null };
  return { deg, side: s.side > 0 ? 'right' : s.side < 0 ? 'left' : null };
}

// Called a few times a second: the lean now, and the maxima updated with what has lasted HOLD_MS
// on one side (the smallest lean of that stretch), so a pothole or a braking dive is not a record.
export function trackLean(s, t) {
  const now = leanNow(s);
  s.recent.push({ t, deg: now?.deg ?? 0, side: now?.side ?? null });
  // One reading from before the stretch stays, so that it covers HOLD_MS whatever the spacing (the
  // phone's readings come every 112 ms, not 100).
  while (s.recent.length > 1 && s.recent[1].t <= t - HOLD_MS) s.recent.shift();
  if (t - s.recent[0].t < HOLD_MS) return now;
  const side = s.recent[0].side;
  if (!side || s.recent.some((r) => r.side !== side)) return now;
  const held = Math.min(...s.recent.map((r) => r.deg));
  if (side === 'left' && held > s.maxLeft) s.maxLeft = held;
  if (side === 'right' && held > s.maxRight) s.maxRight = held;
  return now;
}

// Bearing from one GPS point to the next, for phones that give no heading of their own.
export function bearingDeg(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// "← 23°" for left, "23° →" for right, "0°" upright, "—" too slow.
export function leanText(lean) {
  if (!lean) return '—';
  const deg = `${Math.round(lean.deg)}°`;
  return lean.side === 'left' ? `← ${deg}` : lean.side === 'right' ? `${deg} →` : deg;
}
