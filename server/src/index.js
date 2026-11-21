// Cloudflare Worker: API for the phone app and the device. The app itself is served by the
// static-assets binding (see wrangler.toml); only /api/* reaches this code.
import { bearerToken, randomKey, secretsEqual, sha256Hex, signToken, verifyToken } from './auth.js';
import {
  SHARE_HOURS,
  SIGNAL_TEST_MINUTES,
  ackAlarm,
  checkOffline,
  handleReport,
  loadSettings,
  normalizePhone,
  quickStatus,
  removeWifiNetwork,
  requestLocate,
  saveWifiNetwork,
  runAutomation,
  setArmed,
  sharedView,
  signalView,
  snapshot,
  startShare,
  startSignalTest,
  stopShare,
  stopSignalTest,
  updateSettings,
} from './logic.js';
import { okCrash, startCrashTest } from './crash.js';
import { cancelEmergency, listSounds, sendEmergency, validKey, validSound, validateUser } from './pushover.js';
import { sendPush, vapidPublicKey } from './push.js';
import { endStaleRide, rideSeconds, rideView, tripList } from './rides.js';
import { FOLDER_DAYS, MAX_PHOTO_BYTES, bikeDetails, folderView, removePhoto, saveBike, savePhoto, startFolder, stopFolder } from './folder.js';
import { LOAN_SPEED_CHOICES, setLoan } from './loan.js';
import { morningSummary } from './morning.js';
import { getStore } from './store.js';
import { checkGoogleKey, takeGoogleLookup, validGoogleKey, wifiLocate } from './wifiloc.js';
import { FW_PART_MAX, validVersion } from './firmware.js';
import {
  ServiceError,
  checkServiceReminders,
  removeService,
  saveOdometer,
  saveService,
  saveServicePrefs,
  serviceView,
} from './service.js';

const TOKEN_DAYS = 365;
const MAX_BODY_BYTES = 8 * 1024;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILS = 10;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too_large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

function vapidConfig(env, origin) {
  if (!env.VAPID_PRIVATE_JWK) return null;
  const subject = env.VAPID_SUBJECT || (origin?.startsWith('https://') ? origin : 'mailto:moto-alarm@example.invalid');
  return { privateJwk: env.VAPID_PRIVATE_JWK, subject };
}

// Sends a notification to every subscribed phone in the background, dropping dead subscriptions.
function notifier(store, env, ctx, origin) {
  return async (payload) => {
    const vapid = vapidConfig(env, origin);
    if (!vapid) return;
    const work = (async () => {
      for (const sub of await store.subs()) {
        try {
          const result = await sendPush(sub, payload, vapid);
          if (result.gone) await store.removeSub(sub.endpoint);
          else if (!result.ok) console.warn('push rejected', result.status);
        } catch (err) {
          console.error('push failed', err);
        }
      }
    })();
    ctx.waitUntil(work);
  };
}

// The loud alarm through Pushover, when its keys are set in the app.
function pushoverHooks(store, origin) {
  return {
    async emergency({ title, message, lat, lon, replaces, retry, expire }) {
      const keys = await store.get('pushover');
      if (!keys?.token || !keys?.user) return null;
      try {
        if (replaces) await cancelEmergency(keys, replaces);
        const hasFix = lat !== null && lon !== null;
        return await sendEmergency(keys, {
          title,
          message,
          url: hasFix ? `https://maps.apple.com/?q=${lat},${lon}` : origin,
          urlTitle: hasFix ? 'Θέση στον χάρτη' : 'Άνοιγμα εφαρμογής',
          callback: `${origin}/api/pushover/callback?key=${keys.callbackKey}`,
          sound: keys.sound ?? 'siren',
          retry, // a fall repeats more often; undefined keeps Pushover's defaults here
          expire,
        });
      } catch (err) {
        console.error('pushover failed', err);
        return null;
      }
    },
    async cancel(receipt) {
      const keys = await store.get('pushover');
      if (!keys?.token || !receipt) return;
      try {
        await cancelEmergency(keys, receipt);
      } catch (err) {
        console.error('pushover cancel failed', err);
      }
    },
  };
}

// Position from the Wi-Fi around the bike: Google when the owner added a key in the app and the free
// allowance is not used up, else beaconDB. The local dev server passes its own stand-in as env.WIFI_LOCATE.
function geolocator(store, env) {
  if (typeof env.WIFI_LOCATE === 'function') return env.WIFI_LOCATE;
  return async (accessPoints) => {
    const key = (await store.get('wifiloc'))?.googleKey ?? null;
    const googleKey = key && (await takeGoogleLookup(store)) ? key : null;
    return wifiLocate(accessPoints, { googleKey });
  };
}

// The newest firmware published by tools/publish-firmware.mjs: { v, size, sig }, or null.
async function latestFirmware(env) {
  if (!env.FIRMWARE) return null;
  try {
    return await env.FIRMWARE.get('fw/latest', { type: 'json', cacheTtl: 60 });
  } catch (err) {
    console.error('firmware store', err);
    return null;
  }
}

// A part of a firmware image, for the board only. The image holds the device key, so it is never public.
async function firmwarePart(url, env) {
  const v = url.searchParams.get('v');
  const from = Number(url.searchParams.get('from'));
  const len = Number(url.searchParams.get('len'));
  if (!validVersion(v) || !Number.isInteger(from) || from < 0 || !Number.isInteger(len) || len < 1 || len > FW_PART_MAX) {
    throw new HttpError(400, 'bad_range');
  }
  const image = env.FIRMWARE ? await env.FIRMWARE.get(`fw/${v}.bin`, { type: 'arrayBuffer', cacheTtl: 300 }) : null;
  if (!image) throw new HttpError(404, 'no_firmware');
  if (from >= image.byteLength) throw new HttpError(416, 'bad_range');
  return new Response(image.slice(from, Math.min(from + len, image.byteLength)), {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
  });
}

async function login(request, env, store) {
  const now = Date.now();
  const fails = (await store.get('login_fails')) ?? { count: 0, since: now };
  const windowOpen = now - fails.since < LOGIN_WINDOW_MS;
  if (windowOpen && fails.count >= LOGIN_MAX_FAILS) throw new HttpError(429, 'too_many_attempts');

  const { password } = await readJson(request);
  // Spaces at either end are almost always a copy/paste or keyboard slip, never part of the password.
  const typed = typeof password === 'string' ? password.trim() : '';
  if (!(await secretsEqual(typed, String(env.APP_PASSWORD).trim()))) {
    await store.set('login_fails', windowOpen ? { count: fails.count + 1, since: fails.since } : { count: 1, since: now });
    throw new HttpError(401, 'wrong_password');
  }
  await store.set('login_fails', null);
  const token = await signToken(env.TOKEN_SECRET, { sub: 'owner', exp: Math.floor(now / 1000) + TOKEN_DAYS * 86_400 });
  return json({ token });
}

// Answers in plain text for iPhone Shortcuts ("Show notification" prints it as is), or JSON with format=json.
function quickReply(url, status, data) {
  if (url.searchParams.get('format') === 'json') return json(data, status);
  return new Response(data.text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Home-screen buttons (Shortcuts, Scriptable): authorised by a separate key that the app can replace at any time.
async function quick(request, url, store, notify, hooks) {
  const now = Date.now();
  const fails = (await store.get('quick_fails')) ?? { count: 0, since: now };
  const windowOpen = now - fails.since < LOGIN_WINDOW_MS;
  if (windowOpen && fails.count >= LOGIN_MAX_FAILS) {
    return quickReply(url, 429, { error: 'too_many_attempts', text: 'Πολλές λάθος προσπάθειες. Δοκίμασε ξανά σε 15 λεπτά.' });
  }

  const saved = await store.get('quick_key');
  const key = url.searchParams.get('key') || bearerToken(request);
  if (!saved?.hash || !key || !(await secretsEqual(await sha256Hex(key), saved.hash))) {
    await store.set('quick_fails', windowOpen ? { count: fails.count + 1, since: fails.since } : { count: 1, since: now });
    return quickReply(url, 401, { error: 'unauthorized', text: 'Λάθος ή παλιό κλειδί. Φτιάξε νέους συνδέσμους από την εφαρμογή.' });
  }

  const action = url.searchParams.get('action') || 'status';
  if (action === 'arm' || action === 'disarm') {
    if (request.method !== 'POST') {
      return quickReply(url, 405, { error: 'use_post', text: 'Στη Συντόμευση άλλαξε τη «Μέθοδο» σε POST.' });
    }
    await setArmed({ store, armed: action === 'arm', cancel: hooks.cancel });
  } else if (action !== 'status') {
    return quickReply(url, 400, { error: 'bad_action', text: 'Άγνωστη εντολή.' });
  } else {
    await runAutomation({ store, notify });
  }

  const status = quickStatus(await snapshot(store));
  const text =
    action === 'arm' ? 'Ο συναγερμός οπλίστηκε 🔒' : action === 'disarm' ? 'Ο συναγερμός αφοπλίστηκε 🔓' : status.text;
  return quickReply(url, 200, { ...status, text });
}

// The service book's own refusals (a wrong date, an unknown entry) become errors the app can explain.
async function serviceAction(work) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ServiceError) throw new HttpError(err.status, err.code);
    throw err;
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

async function route(request, env, ctx) {
  if (!env.APP_PASSWORD || !env.TOKEN_SECRET || !env.DEVICE_KEY) throw new HttpError(500, 'not_configured');

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const store = getStore(env);
  const notify = notifier(store, env, ctx, url.origin);
  const hooks = pushoverHooks(store, env.PUBLIC_ORIGIN || url.origin);

  if (request.method === 'POST' && path === '/api/device/report') {
    if (!(await secretsEqual(bearerToken(request), env.DEVICE_KEY))) throw new HttpError(401, 'unauthorized');
    const report = await readJson(request);
    const firmware = await latestFirmware(env);
    return json(
      await handleReport({
        store,
        report,
        notify,
        emergency: hooks.emergency,
        cancel: hooks.cancel,
        geolocate: geolocator(store, env),
        firmware,
        origin: env.PUBLIC_ORIGIN || url.origin,
      }),
    );
  }

  if (request.method === 'GET' && path === '/api/device/firmware') {
    if (!(await secretsEqual(bearerToken(request), env.DEVICE_KEY))) throw new HttpError(401, 'unauthorized');
    return firmwarePart(url, env);
  }

  if (request.method === 'POST' && path === '/api/login') return login(request, env, store);

  if (path === '/api/quick') return quick(request, url, store, notify, hooks);

  // Pushover calls this when an alert is acknowledged in its app: the alarm («Το είδα») or a fall
  // while riding («Είμαι καλά»).
  if (request.method === 'POST' && path === '/api/pushover/callback') {
    const keys = await store.get('pushover');
    if (!keys?.callbackKey || !(await secretsEqual(url.searchParams.get('key') ?? '', keys.callbackKey))) {
      throw new HttpError(401, 'unauthorized');
    }
    const form = await request.formData().catch(() => null);
    const receipt = form?.get('receipt');
    if (typeof receipt === 'string' && receipt && !(await okCrash({ store, receipt }))) await ackAlarm({ store, receipt });
    return json({ ok: true });
  }

  // Live location link: anyone with the link, until it expires. Only the position, nothing else.
  if (request.method === 'GET' && path.startsWith('/api/shared/')) {
    const share = await store.get('share');
    const now = Date.now();
    const token = decodeURIComponent(path.slice('/api/shared/'.length));
    if (!share || share.expires <= now || !(await secretsEqual(token, share.token))) throw new HttpError(404, 'expired');
    return json(await sharedView({ store, share, now }));
  }

  // Theft folder link (/f/<token>): the bike's details and its route since the alarm, until it expires.
  if (request.method === 'GET' && path.startsWith('/api/folder/')) {
    const share = await store.get('folder_share');
    const now = Date.now();
    const token = decodeURIComponent(path.slice('/api/folder/'.length));
    if (!share || share.expires <= now || !(await secretsEqual(token, share.token))) throw new HttpError(404, 'expired');
    return json(await folderView({ store, share, now }));
  }

  if (!(await verifyToken(env.TOKEN_SECRET, bearerToken(request)))) throw new HttpError(401, 'unauthorized');

  switch (`${request.method} ${path}`) {
    case 'GET /api/state':
      await runAutomation({ store, notify });
      return json(await snapshot(store));

    case 'POST /api/share': {
      const { hours } = await readJson(request);
      if (!SHARE_HOURS.includes(hours)) throw new HttpError(400, 'bad_hours');
      return json({ share: await startShare({ store, token: randomKey(18), hours }) });
    }

    case 'POST /api/pushover': {
      const { user = '', token = '' } = await readJson(request);
      if (user === '' && token === '') {
        await store.set('pushover', null); // turned off
        return json({ pushover: false });
      }
      if (!validKey(user) || !validKey(token)) throw new HttpError(400, 'bad_pushover_keys');
      if (!(await validateUser({ token, user }).catch(() => false))) throw new HttpError(400, 'pushover_rejected');
      const previous = await store.get('pushover');
      await store.set('pushover', { user, token, callbackKey: randomKey(18), sound: previous?.sound ?? 'siren' });
      return json({ pushover: true });
    }

    case 'GET /api/pushover/sounds': {
      const keys = await store.get('pushover');
      if (!keys?.token) throw new HttpError(404, 'pushover_not_configured');
      return json({ sounds: await listSounds(keys), current: keys.sound ?? 'siren' });
    }

    case 'POST /api/pushover/sound': {
      const { sound } = await readJson(request);
      if (!validSound(sound)) throw new HttpError(400, 'bad_sound');
      const keys = await store.get('pushover');
      if (!keys?.token) throw new HttpError(404, 'pushover_not_configured');
      await store.set('pushover', { ...keys, sound });
      return json({ sound });
    }

    case 'POST /api/pushover/test': {
      const keys = await store.get('pushover');
      if (!keys?.token) throw new HttpError(404, 'pushover_not_configured');
      const receipt = await sendEmergency(keys, {
        title: 'Δοκιμή συναγερμού',
        message: 'Έτσι θα χτυπάει ο συναγερμός. Πάτα «Acknowledge» για να σταματήσει.',
        sound: keys.sound ?? 'siren',
        retry: 30,
        expire: 90,
      }).catch(() => null);
      if (!receipt) throw new HttpError(502, 'pushover_failed');
      return json({ ok: true });
    }

    case 'POST /api/wifiloc': {
      const { googleKey = '' } = await readJson(request);
      if (googleKey === '') {
        await store.set('wifiloc', null); // back to the free service
        await store.set('wifi_last', null);
        return json({ google: false });
      }
      if (!validGoogleKey(googleKey)) throw new HttpError(400, 'bad_google_key');
      const problem = await checkGoogleKey(googleKey);
      if (problem) throw new HttpError(400, `google_key_${problem}`);
      await store.set('wifiloc', { googleKey });
      await store.set('wifi_last', null); // ask again: Google may know what the free service did not
      return json({ google: true });
    }

    // Wi-Fi networks for the board: { ssid, password } adds or changes one, { ssid, remove: true }
    // forgets it. The answer has the names only.
    case 'POST /api/wifi-nets': {
      const { ssid, password = '', remove = false } = await readJson(request);
      if (remove) return json(await removeWifiNetwork({ store, ssid }));
      try {
        return json(await saveWifiNetwork({ store, ssid, password }));
      } catch (err) {
        if (['bad_ssid', 'bad_wifi_password', 'too_many_wifi'].includes(err.message)) throw new HttpError(400, err.message);
        throw err;
      }
    }

    // Service book. Every change answers with the whole book, so the app shows it at once.
    case 'GET /api/service':
      return json(await serviceView({ store }));

    case 'POST /api/service': {
      // A new entry, or a change to one when the body has its id.
      const body = await readJson(request);
      const id = await serviceAction(() => saveService({ store, body }));
      return json({ id, ...(await serviceView({ store })) });
    }

    case 'POST /api/service/delete': {
      const { id } = await readJson(request);
      await serviceAction(() => removeService({ store, id }));
      return json(await serviceView({ store }));
    }

    case 'POST /api/service/odometer': {
      const { km } = await readJson(request);
      await serviceAction(() => saveOdometer({ store, km }));
      return json(await serviceView({ store }));
    }

    case 'POST /api/service/prefs': {
      const body = await readJson(request);
      await serviceAction(() => saveServicePrefs({ store, body }));
      return json(await serviceView({ store }));
    }

    case 'GET /api/signal':
      return json(await signalView({ store }));

    case 'POST /api/signal-test': {
      const { minutes } = await readJson(request);
      if (!SIGNAL_TEST_MINUTES.includes(minutes)) throw new HttpError(400, 'bad_minutes');
      await startSignalTest({ store, minutes });
      return json(await signalView({ store }));
    }

    case 'POST /api/signal-test/stop':
      await stopSignalTest({ store });
      return json(await signalView({ store }));

    case 'POST /api/share/stop':
      await stopShare({ store });
      return json({ ok: true });

    case 'POST /api/arm': {
      const { armed } = await readJson(request);
      if (typeof armed !== 'boolean') throw new HttpError(400, 'armed_must_be_boolean');
      await setArmed({ store, armed, cancel: hooks.cancel });
      return json(await snapshot(store));
    }

    case 'POST /api/alarm/ack':
      await ackAlarm({ store, cancel: hooks.cancel });
      return json(await snapshot(store));

    // A fall while riding: «Είμαι καλά» stops the SMS, or sends a second one if the first went out.
    case 'POST /api/crash/ok':
      await okCrash({ store, cancel: hooks.cancel });
      return json(await snapshot(store));

    // The whole chain as a test: the alert now, and the SMS to `to` at the board's next report.
    case 'POST /api/crash/test': {
      const { to } = await readJson(request);
      const phone = normalizePhone(to);
      if (!phone) throw new HttpError(400, 'bad_phone');
      try {
        await startCrashTest({ store, to: phone, settings: await loadSettings(store), notify, emergency: hooks.emergency });
      } catch (err) {
        if (err.message === 'crash_active') throw new HttpError(409, 'crash_active');
        throw err;
      }
      return json(await snapshot(store));
    }

    case 'POST /api/locate':
      await requestLocate({ store });
      return json(await snapshot(store));

    case 'GET /api/history': {
      const to = Number(url.searchParams.get('to')) || Date.now();
      const from = Number(url.searchParams.get('from')) || to - 24 * 3_600_000;
      return json({ positions: await store.positions(from, to) });
    }

    // The ride under way and the past rides, newest first. Each ride's route comes from /api/history.
    case 'GET /api/rides': {
      const now = Date.now();
      await endStaleRide(store, now);
      return json({ ride: rideView(await store.get('ride'), now, rideSeconds(await loadSettings(store))), trips: await tripList(store) });
    }

    // Lent out (workshop, friend): { on, speedLimit }. No alarm meanwhile; see loan.js.
    case 'POST /api/loan': {
      const { on, speedLimit } = await readJson(request);
      if (typeof on !== 'boolean') throw new HttpError(400, 'on_must_be_boolean');
      if (speedLimit !== undefined && !LOAN_SPEED_CHOICES.includes(speedLimit)) throw new HttpError(400, 'bad_speed_limit');
      await setLoan({ store, on, speedLimit, cancel: hooks.cancel });
      return json(await snapshot(store));
    }

    // The bike's details for the theft folder, and its photos (sent one at a time, as the raw image).
    case 'GET /api/bike':
      return json(await bikeDetails(store));

    case 'POST /api/bike':
      await saveBike(store, await readJson(request));
      return json(await bikeDetails(store));

    case 'POST /api/bike/photo': {
      const slot = Number(url.searchParams.get('slot'));
      const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim();
      if (Number(request.headers.get('Content-Length') ?? 0) > MAX_PHOTO_BYTES) throw new HttpError(413, 'photo_too_large');
      const bytes = new Uint8Array(await request.arrayBuffer());
      try {
        await savePhoto(store, slot, bytes, type);
      } catch (err) {
        if (['bad_slot', 'bad_photo', 'photo_too_large'].includes(err.message)) throw new HttpError(400, err.message);
        throw err;
      }
      return json(await bikeDetails(store));
    }

    case 'POST /api/bike/photo/remove': {
      const { slot } = await readJson(request);
      try {
        await removePhoto(store, slot);
      } catch {
        throw new HttpError(400, 'bad_slot');
      }
      return json(await bikeDetails(store));
    }

    case 'POST /api/folder': {
      const { days } = await readJson(request);
      if (!FOLDER_DAYS.includes(days)) throw new HttpError(400, 'bad_days');
      await startFolder({ store, token: randomKey(18), days });
      return json(await bikeDetails(store));
    }

    case 'POST /api/folder/stop':
      await stopFolder({ store });
      return json(await bikeDetails(store));

    case 'GET /api/events': {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      return json({ events: await store.events(limit) });
    }

    case 'POST /api/settings': {
      const patch = await readJson(request);
      if (typeof patch.callNumber === 'string' && normalizePhone(patch.callNumber) === null) {
        throw new HttpError(400, 'bad_phone');
      }
      if (typeof patch.crash?.phone === 'string' && normalizePhone(patch.crash.phone) === null) {
        throw new HttpError(400, 'bad_phone');
      }
      return json({ settings: await updateSettings(store, patch) });
    }

    case 'GET /api/quick-key':
      // Only when it was made, so the app can tell whether the key it remembers is still the current one.
      return json({ created: (await store.get('quick_key'))?.created ?? null });

    case 'POST /api/quick-key': {
      // A new key replaces the old one, so old shortcuts stop working.
      const key = randomKey();
      const created = Date.now();
      await store.set('quick_key', { hash: await sha256Hex(key), created });
      await store.set('quick_fails', null);
      return json({ key, created });
    }

    case 'POST /api/quick-key/revoke':
      await store.set('quick_key', null);
      return json({ ok: true });

    case 'GET /api/push/key':
      if (!env.VAPID_PRIVATE_JWK) throw new HttpError(404, 'push_not_configured');
      return json({ key: vapidPublicKey(env.VAPID_PRIVATE_JWK) });

    case 'POST /api/push/subscribe': {
      const body = await readJson(request);
      const sub = { endpoint: body.endpoint, p256dh: body.keys?.p256dh, auth: body.keys?.auth };
      if (!isHttpsUrl(sub.endpoint) || typeof sub.p256dh !== 'string' || typeof sub.auth !== 'string') {
        throw new HttpError(400, 'bad_subscription');
      }
      await store.addSub(sub);
      return json({ ok: true });
    }

    case 'POST /api/push/unsubscribe': {
      const { endpoint } = await readJson(request);
      if (typeof endpoint === 'string') await store.removeSub(endpoint);
      return json({ ok: true });
    }

    case 'POST /api/push/test':
      await notify({ title: 'Δοκιμή ειδοποίησης', body: 'Έτσι θα σου έρχεται ο συναγερμός.', tag: 'moto-test' });
      return json({ ok: true });

    default:
      throw new HttpError(404, 'not_found');
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      if (!env.ASSETS) return new Response('Not found', { status: 404 });
      // Live location links (/s/<token>) all show the same page, which reads the token from the address.
      if (url.pathname.startsWith('/s/')) return env.ASSETS.fetch(new Request(new URL('/share', url)));
      if (url.pathname.startsWith('/f/')) return env.ASSETS.fetch(new Request(new URL('/folder', url))); // theft folder links
      return env.ASSETS.fetch(request);
    }
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status);
      console.error(err);
      return json({ error: 'server_error' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    const store = getStore(env);
    const notify = notifier(store, env, ctx, env.PUBLIC_ORIGIN || '');
    ctx.waitUntil(
      (async () => {
        await runAutomation({ store, notify });
        await checkOffline({ store, notify });
        // Once a day: a reminder when a service is close or due. Never in the way of the rest.
        await checkServiceReminders({ store, notify }).catch((err) => console.error('service reminders', err));
        // Once a morning: a quiet summary of the night.
        await morningSummary({ store, notify }).catch((err) => console.error('morning summary', err));
        await store.prune(Date.now() - 90 * 86_400_000);
      })(),
    );
  },
};
