// Over-the-air updates for the board. A signed firmware image sits in the FIRMWARE key-value store
// (uploaded by tools/publish-firmware.mjs). The server offers it to the board at a quiet moment and
// serves it in parts; the board checks the signature before it installs anything, and goes back to
// its old program by itself if the new one cannot reach the server.

const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
export const FW_MAX_TRIES = 3;
export const FW_RETRY_MS = 6 * 3_600_000;
export const FW_PART_MAX = 32 * 1024;
const FW_MIN_BATTERY = 30;
// The first board program that can download over 4G. Up to 1.8.5 it read the SIM7600's
// "+HTTPREAD: DATA,<n>" as the end of the data: on 2026-11-21 it asked six times for the first part
// of 1.8.4 over 4G, the server answered 200 each time, and it gave up.
export const FW_OVER_4G = '1.8.6';
// Only while parked and calm: never during an alarm or a ride.
const QUIET_REASONS = new Set(['heartbeat', 'checkin', 'boot', 'parked', 'locate']);

export const validVersion = (v) => typeof v === 'string' && VERSION.test(v);

export function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * New firmware to offer in the answer to a report: { v, size, sig } or null.
 * latest is what tools/publish-firmware.mjs published: { v, size, sig }.
 * At most 3 tries per version, 6 hours apart: a board that keeps its old version went back by itself.
 * Over 4G only to a board that can download there (FW_OVER_4G); an older one waits for a report over Wi-Fi.
 */
export async function firmwareOffer({ store, latest, running, reason, alarmActive, battPct, viaWifi = true, now }) {
  if (!latest || !validVersion(latest.v) || !(latest.size > 0) || typeof latest.sig !== 'string') return null;
  if (!validVersion(running) || compareVersions(latest.v, running) <= 0) return null;
  if (alarmActive || !QUIET_REASONS.has(reason)) return null;
  if (!viaWifi && compareVersions(running, FW_OVER_4G) < 0) return null;
  if (typeof battPct === 'number' && battPct < FW_MIN_BATTERY) return null;
  const offer = await store.get('fw_offer');
  const same = offer?.v === latest.v;
  const tries = same ? offer.tries ?? 0 : 0;
  if (tries >= FW_MAX_TRIES) return null;
  if (same && now - (offer.last ?? 0) < FW_RETRY_MS) return null;
  await store.set('fw_offer', { v: latest.v, tries: tries + 1, last: now, failed: false });
  return { v: latest.v, size: latest.size, sig: latest.sig };
}

/**
 * Notes in the history what happened to an update: the board now runs the new version, or it kept
 * the old one after every try.
 */
export async function firmwareEvents({ store, before, running, now }) {
  if (!validVersion(running)) return;
  if (validVersion(before) && before !== running) {
    await store.addEvent('fw_updated', { from: before, to: running }, now);
  }
  const offer = await store.get('fw_offer');
  if (!offer || offer.failed || !validVersion(offer.v)) return;
  if (offer.tries >= FW_MAX_TRIES && compareVersions(offer.v, running) > 0 && now - offer.last >= FW_RETRY_MS) {
    await store.set('fw_offer', { ...offer, failed: true });
    await store.addEvent('fw_failed', { v: offer.v }, now);
  }
}
