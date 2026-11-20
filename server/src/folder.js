// Theft folder: what the police or the insurer need, on one page. The bike's details (plate, frame
// number, model, colour, a few photos) are kept once; the page adds where the bike went from the
// moment of the alarm, with times. It is shown behind a link that expires (/f/<token>), like the
// live location link, and shows nothing else.

export const FOLDER_DAYS = Object.freeze([3, 7, 30]);
export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 700 * 1024; // the app shrinks photos to well under this
const PHOTO_TYPES = Object.freeze({ 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] });
const FIELDS = Object.freeze({ plate: 16, vin: 24, model: 60, color: 40, notes: 500 });
const ALARM_LOOKBACK_MS = 30 * 86_400_000;
const MAX_TRAIL = 3000;

/** The details as typed in the app: trimmed, cut to size, nothing else kept. */
export function normalizeBike(input) {
  const bike = {};
  for (const [key, max] of Object.entries(FIELDS)) {
    const value = typeof input?.[key] === 'string' ? input[key].trim().slice(0, max) : '';
    bike[key] = key === 'plate' || key === 'vin' ? value.toUpperCase() : value;
  }
  return bike;
}

export async function saveBike(store, input, now = Date.now()) {
  const bike = { ...normalizeBike(input), updated: now };
  await store.set('bike', bike);
  return bike;
}

const photoKey = (slot) => `bike_photo_${slot}`;
const validSlot = (slot) => Number.isInteger(slot) && slot >= 0 && slot < MAX_PHOTOS;

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Keeps one photo (JPEG, PNG or WebP, checked by its first bytes) in slot 0–2. */
export async function savePhoto(store, slot, bytes, type) {
  if (!validSlot(slot)) throw new Error('bad_slot');
  const magic = PHOTO_TYPES[type];
  if (!magic || !magic.every((b, i) => bytes[i] === b)) throw new Error('bad_photo');
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error('photo_too_large');
  await store.set(photoKey(slot), `data:${type};base64,${toBase64(bytes)}`);
}

export async function removePhoto(store, slot) {
  if (!validSlot(slot)) throw new Error('bad_slot');
  await store.set(photoKey(slot), null);
}

async function photos(store) {
  return Promise.all(Array.from({ length: MAX_PHOTOS }, (_, slot) => store.get(photoKey(slot))));
}

/** For the app: the details and the three photo slots (null where empty). */
export async function bikeDetails(store) {
  const [bike, slots, share] = await Promise.all([store.get('bike'), photos(store), store.get('folder_share')]);
  return {
    bike: bike ?? { ...normalizeBike({ model: 'Honda Hornet 750' }), updated: null },
    photos: slots,
    share: share && share.expires > Date.now() ? share : null,
  };
}

// When the latest alarm began: the one going on, else the latest in the last 30 days.
async function alarmStart(store, now) {
  const alarm = await store.get('alarm');
  if (alarm?.active && alarm.since) return alarm.since;
  const events = await store.events(200);
  const latest = events.find((e) => e.type === 'alarm' && e.ts >= now - ALARM_LOOKBACK_MS);
  return latest?.ts ?? null;
}

/** A link to the folder, for `days` days. The route starts at the alarm known now (or the next one). */
export async function startFolder({ store, token, days, now = Date.now() }) {
  const share = { token, created: now, expires: now + days * 86_400_000, from: await alarmStart(store, now) };
  await store.set('folder_share', share);
  await store.addEvent('folder', { days }, now);
  return share;
}

export async function stopFolder({ store, now = Date.now() }) {
  if (!(await store.get('folder_share'))) return;
  await store.set('folder_share', null);
  await store.addEvent('folder_stop', {}, now);
}

/** What the link shows: the bike, its photos, the alarms and the route since the alarm, with times. */
export async function folderView({ store, share, now = Date.now() }) {
  const from = share.from ?? (await alarmStart(store, now));
  const [bike, slots, position, events] = await Promise.all([store.get('bike'), photos(store), store.get('last_fix'), store.events(200)]);
  const trail = from ? await store.positions(from, now, MAX_TRAIL) : [];
  return {
    now,
    expires: share.expires,
    bike: bike ? normalizeBike(bike) : normalizeBike({ model: 'Honda Hornet 750' }),
    photos: slots.filter(Boolean),
    alarmAt: from,
    alarms: from
      ? events
          .filter((e) => e.type === 'alarm' && e.ts >= from)
          .map((e) => ({ ts: e.ts, reason: e.data?.reason ?? 'motion' }))
          .reverse()
      : [],
    trail: trail.map((p) => [p.ts, p.lat, p.lon, p.speed ?? null]),
    position: position ? { ts: position.ts, lat: position.lat, lon: position.lon, acc: position.acc ?? null, src: position.src ?? 'gps' } : null,
  };
}
