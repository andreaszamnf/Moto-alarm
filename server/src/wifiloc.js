// A rough position from the Wi-Fi access points around the bike, for when the GPS cannot see the
// sky (a garage, a van). The device sends the access points it hears and a geolocation service
// turns them into a position. Google knows far more access points in Greece; beaconDB is free and
// needs no account, but did not know the owner's neighbourhood when we tried it.

const GOOGLE_URL = 'https://www.googleapis.com/geolocation/v1/geolocate';
const BEACONDB_URL = 'https://api.beacondb.net/v1/geolocate';
const USER_AGENT = 'HornetAlarm/1.0';
const TIMEOUT_MS = 5000;
// Vaguer than this is a guess from the server's IP address or a cell tower, not from Wi-Fi.
const MAX_ACCURACY_M = 1000;
export const MAX_ACCESS_POINTS = 15;
// Google gives 10,000 free lookups a month. We never ask more than this, whatever happens, so the
// owner is never charged. Google itself does not let this project cap the daily requests.
export const GOOGLE_PER_DAY = 300;
export const GOOGLE_PER_MONTH = 9000;

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const GOOGLE_KEY = /^AIza[0-9A-Za-z_-]{35}$/;

export const validGoogleKey = (key) => typeof key === 'string' && GOOGLE_KEY.test(key);

/**
 * The access points from a device report that a geolocation service can use, strongest first.
 * Device format: [{ m: "aa:bb:cc:dd:ee:ff", s: -71 }]. Service format: [{ macAddress, signalStrength }].
 */
export function normalizeWifi(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const ap of list.slice(0, 50)) {
    const mac = typeof ap?.m === 'string' ? ap.m.trim().toLowerCase().replaceAll('-', ':') : '';
    if (!MAC.test(mac) || seen.has(mac)) continue;
    // Multicast or locally administered: phone hotspots and random addresses, which say nothing about the place.
    if (parseInt(mac.slice(0, 2), 16) & 0x03) continue;
    seen.add(mac);
    const rssi = typeof ap.s === 'number' && Number.isFinite(ap.s) && ap.s < 0 && ap.s > -120 ? Math.round(ap.s) : null;
    out.push(rssi === null ? { macAddress: mac } : { macAddress: mac, signalStrength: rssi });
  }
  out.sort((a, b) => (b.signalStrength ?? -200) - (a.signalStrength ?? -200));
  return out.slice(0, MAX_ACCESS_POINTS);
}

async function ask(url, accessPoints, fetchFn) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    // No guessing from the IP address: the request comes from Cloudflare, not from the bike.
    body: JSON.stringify({ considerIp: false, fallbacks: { lacf: false, ipf: false }, wifiAccessPoints: accessPoints }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 404) return { found: null }; // these access points are not known
  if (!res.ok) {
    // Google explains itself in a few places: the old "reason", the newer "status" and details, and a message.
    const e = data?.error ?? {};
    const parts = [e.errors?.[0]?.reason, e.status, ...(e.details ?? []).map((d) => d?.reason), e.message];
    return { error: parts.filter(Boolean).join(' ') || `http_${res.status}` };
  }
  const lat = data?.location?.lat;
  const lon = data?.location?.lng;
  const acc = data?.accuracy;
  if (![lat, lon, acc].every(Number.isFinite) || data.fallback || acc > MAX_ACCURACY_M) return { found: null };
  return { found: { lat, lon, acc: Math.round(acc) } };
}

/**
 * Looks up a rough position. Uses Google when the owner added a key in the app, otherwise (or when
 * Google does not know the place) beaconDB. Returns { lat, lon, acc, by } or null; never throws.
 */
export async function wifiLocate(accessPoints, { googleKey = null, fetchFn = fetch } = {}) {
  if (accessPoints.length < 2) return null; // both services want at least two
  const services = [];
  if (googleKey) services.push({ by: 'google', url: `${GOOGLE_URL}?key=${encodeURIComponent(googleKey)}` });
  services.push({ by: 'beacondb', url: BEACONDB_URL });
  for (const service of services) {
    try {
      const { found, error } = await ask(service.url, accessPoints, fetchFn);
      if (found) return { ...found, by: service.by };
      if (error) console.warn('wifi locate refused', service.by, error);
    } catch (err) {
      console.warn('wifi locate failed', service.by, err?.message ?? err);
    }
  }
  return null;
}

// This month's Google lookups (UTC months, so the count never lags behind Google's own).
export async function googleUsage(store, now = Date.now()) {
  const month = new Date(now).toISOString().slice(0, 7);
  const usage = await store.get('wifiloc_usage');
  return usage?.month === month ? usage.monthCount ?? 0 : 0;
}

// Counts one Google lookup, or says no once today's or this month's allowance is used up.
export async function takeGoogleLookup(store, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const usage = (await store.get('wifiloc_usage')) ?? {};
  const dayCount = usage.day === day ? usage.dayCount ?? 0 : 0;
  const monthCount = usage.month === month ? usage.monthCount ?? 0 : 0;
  if (dayCount >= GOOGLE_PER_DAY || monthCount >= GOOGLE_PER_MONTH) return false;
  await store.set('wifiloc_usage', { day, dayCount: dayCount + 1, month, monthCount: monthCount + 1 });
  return true;
}

/**
 * Tries a Google key with two made-up access points. A working key gets "not found";
 * otherwise Google says what is wrong. Returns null when the key works, or a short reason.
 */
export async function checkGoogleKey(key, fetchFn = fetch) {
  const made = [{ macAddress: '00:11:22:33:44:55', signalStrength: -60 }, { macAddress: '00:11:22:33:44:56', signalStrength: -70 }];
  try {
    const { error } = await ask(`${GOOGLE_URL}?key=${encodeURIComponent(key)}`, made, fetchFn);
    if (!error) return null;
    if (/billing/i.test(error)) return 'billing';
    if (/keyInvalid|API_KEY_INVALID|key not valid/i.test(error)) return 'invalid';
    if (/accessNotConfigured|SERVICE_DISABLED|API_KEY_SERVICE_BLOCKED|PERMISSION_DENIED|forbidden|http_403/i.test(error)) {
      return 'not_enabled';
    }
    if (/limit|quota|RESOURCE_EXHAUSTED/i.test(error)) return 'quota';
    return 'other';
  } catch {
    return 'unreachable';
  }
}
