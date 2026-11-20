// Fall while riding (firmware 1.8.0). The board, in riding mode, reports "crash" when the bike lies on
// its side and stays still shortly after moving at speed. The owner then has CRASH_WAIT_S seconds to
// answer «Είμαι καλά» in the app or acknowledge the loud Pushover alert; otherwise the board texts the
// emergency contact where the bike is. Riding on cancels too. If the contact already got the SMS, a
// cancellation sends a second one saying all is well. A test from the app runs the same steps, with
// the SMS going to a number typed for the test.
import { randomKey } from './auth.js';
import { compareVersions, validVersion } from './firmware.js';

export const CRASH_WAIT_S = 90;
// The first board program that sends a fall's SMS (several texts, modem on first). An older one
// got the order of a test on 2026-11-20 and sent nothing, so the order waits for this one.
const SMS_FIRMWARE = '1.8.0';
const SMS_TRIES = 3; // an SMS that did not go out (no network) is ordered again, this many times in all
const WATCH_AFTER_SMS_MS = 10 * 60_000; // the board keeps reporting this long after the SMS, then stops
const EPISODE_MAX_MS = 24 * 3_600_000; // an episode nobody closed ends by itself
const SHARE_MS = 24 * 3_600_000; // the live link in the SMS works this long
const SAME_FALL_S = 5; // the board stamps each fall with its time: the same stamp is the same fall
export const SMS_MAX = 70; // Greek needs UCS-2: 70 characters in one SMS
const NAME_MAX = 20;

const clockFmt = new Intl.DateTimeFormat('el-GR', { timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fit = (text) => (text.length <= SMS_MAX ? text : text.slice(0, SMS_MAX));

/** A name for the SMS or the app: trimmed, one line, at most 20 characters. null when not a string. */
export function shortName(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

export const crashEnabled = (settings) => Boolean(settings.crash?.on && settings.crash.phone);

// "στην επαφή σου (Μαρία)": Greek needs the gender for anything shorter.
const contactPhrase = (settings) => (settings.crash?.contact ? `στην επαφή σου (${settings.crash.contact})` : 'στην επαφή σου');

/**
 * The start of the SMS the board sends by itself when it cannot reach the server. The board adds
 * " maps.google.com/?q=<lat>,<lon>" (up to 40 characters), so this stays within 30.
 */
export function boardSmsText(settings) {
  const tail = ': πιθανό ατύχημα!';
  const name = (settings.crash?.name || 'Μηχανή').slice(0, 30 - tail.length);
  return `${name}${tail}`;
}

/** What the contact gets: who and when, where (with a word about 112), and the live position. */
export function crashSmsTexts({ crash, settings, shareUrl = null }) {
  const name = settings.crash?.name || 'Μηχανή';
  const test = crash.test ? 'ΔΟΚΙΜΗ. ' : '';
  const at = clockFmt.format(new Date(crash.since));
  const kmh = finite(crash.kmh);
  let first = `${test}${name}: πιθανό ατύχημα με τη μηχανή, ${at}${kmh ? ` (${Math.round(kmh)} χλμ/ώ)` : ''}.`;
  if (first.length > SMS_MAX) first = `${test}${name}: πιθανό ατύχημα με τη μηχανή, ${at}.`;
  const texts = [fit(first)];
  const p = crash.fix;
  texts.push(
    p
      ? fit(`${p.rough ? 'Περίπου' : 'Σημείο'}: maps.google.com/?q=${p.lat.toFixed(5)},${p.lon.toFixed(5)} Αν δεν απαντά: 112`)
      : 'Η θέση δεν είναι γνωστή. Αν δεν απαντά στο κινητό: 112',
  );
  const live = shareUrl ? `Θέση τώρα: ${shareUrl}` : '';
  if (live && live.length <= SMS_MAX) texts.push(live);
  return texts;
}

/** After a cancellation, when the contact already got the SMS. */
export function okSmsText({ crash, settings }) {
  const name = settings.crash?.name || 'Μηχανή';
  return fit(`${crash.test ? 'ΔΟΚΙΜΗ. ' : ''}${name}: είναι καλά, ακύρωση της ειδοποίησης ατυχήματος.`);
}

// The live position for the contact: the owner's own link if one is running, else a new one for a day.
async function liveLink(store, origin, now) {
  if (!origin) return null;
  let share = await store.get('share');
  if (!share || share.expires <= now) {
    share = { token: randomKey(12), created: now, expires: now + SHARE_MS };
    await store.addEvent('share', { hours: 24, by: 'crash' }, now);
  } else if (share.expires < now + SHARE_MS) {
    share = { ...share, expires: now + SHARE_MS };
  }
  await store.set('share', share);
  return `${origin.replace(/^https?:\/\//, '')}/s/${share.token}`;
}

// A position for the contact. One from Wi-Fi (no GPS) can be a street off: the SMS says "περίπου".
function position(fix) {
  if (!fix) return null;
  return { lat: fix.lat, lon: fix.lon, acc: fix.acc ?? null, ts: fix.ts ?? null, ...(fix.src === 'wifi' ? { rough: true } : {}) };
}

// GPS beats Wi-Fi; between two of the same kind the newer wins.
function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (Boolean(a.rough) !== Boolean(b.rough)) return a.rough ? b : a;
  return (a.ts ?? 0) >= (b.ts ?? 0) ? a : b;
}

// The loud alert repeats every 30 seconds: until acknowledged for a real fall, only during the wait
// for a test (acknowledging is «Είμαι καλά», which would end the test).
async function alertOwner({ crash, settings, notify, emergency }) {
  const then = `Αλλιώς σε ${CRASH_WAIT_S} δευτερόλεπτα στέλνεται SMS ${contactPhrase(settings)} με το σημείο.`;
  await notify({
    title: crash.test ? 'Δοκιμή: έπεσες;' : 'Έπεσες;',
    body: `Η μηχανή έπεσε. Αν είσαι καλά, πάτα «Είμαι καλά» στην εφαρμογή. ${then}`,
    tag: 'moto-crash',
    urgent: true,
  });
  return emergency({
    title: crash.test ? 'ΔΟΚΙΜΗ: ΠΤΩΣΗ ΜΗΧΑΝΗΣ' : 'ΠΤΩΣΗ ΜΗΧΑΝΗΣ',
    message: `Η μηχανή έπεσε. Αν είσαι καλά, πάτα «Acknowledge». ${then}`,
    lat: crash.fix?.lat ?? null,
    lon: crash.fix?.lon ?? null,
    replaces: null,
    retry: 30,
    ...(crash.test ? { expire: CRASH_WAIT_S } : {}),
  });
}

async function openCrash({ store, info, fix, settings, now, notify, emergency }) {
  const crash = {
    active: true,
    test: false,
    since: now,
    at: finite(info?.at), // the board's stamp for this fall (unix seconds)
    deadline: now + CRASH_WAIT_S * 1000,
    to: settings.crash.phone,
    kmh: finite(info?.kmh),
    tilt: finite(info?.tilt),
    fix: better(position(fix), position(await store.get('last_fix'))),
    pushover: null,
    smsAt: null,
    smsOk: null,
    okAt: null,
    okBy: null,
    okSmsAt: null,
    endAt: null,
  };
  await store.addEvent('crash', { kmh: crash.kmh === null ? null : Math.round(crash.kmh), tilt: crash.tilt === null ? null : Math.round(crash.tilt) }, now);
  crash.pushover = await alertOwner({ crash, settings, notify, emergency });
  await store.set('crash', crash);
  return crash;
}

/**
 * Every report: a fall the board reports, the wait, the SMS when nobody said «Είμαι καλά», the
 * cancellation. Returns what goes into the reply: `cr` (the contact, for the board's own SMS when
 * it cannot reach the server), and while a fall is open `crash` ({ wait } or { end }) and `sms`.
 */
export async function crashReply({
  store,
  report,
  reason,
  fix,
  settings,
  now,
  notify = async () => {},
  emergency = async () => null,
  cancel = async () => {},
  origin = '',
}) {
  const out = { cr: crashEnabled(settings) ? { to: settings.crash.phone, text: boardSmsText(settings) } : { to: '' } };
  const info = report?.crash && typeof report.crash === 'object' ? report.crash : null;
  const canText = validVersion(report?.fw) && compareVersions(report.fw, SMS_FIRMWARE) >= 0;
  let crash = await store.get('crash');

  if (crash?.active && now - crash.since > EPISODE_MAX_MS) {
    crash = { ...crash, active: false, endAt: now };
    await store.set('crash', crash);
  }

  if (reason === 'crash') {
    const at = finite(info?.at);
    const known = Boolean(crash && !crash.test && at !== null && crash.at !== null && Math.abs(crash.at - at) <= SAME_FALL_S);
    if (known && !crash.active) return { ...out, crash: { end: true } }; // cancelled or over: the board can stop
    if (!known) {
      if (!crashEnabled(settings)) {
        await store.addEvent('crash', { kmh: finite(info?.kmh) === null ? null : Math.round(info.kmh), off: true }, now);
        return { ...out, crash: { end: true } };
      }
      if (crash?.active && crash.pushover && !crash.okAt) await cancel(crash.pushover); // a test or an older fall gives way
      crash = await openCrash({ store, info, fix, settings, now, notify, emergency });
      return { ...out, crash: { wait: CRASH_WAIT_S } };
    }
  }
  if (!crash?.active) return out;

  let changed = false;
  // A better position before the SMS goes: the contact gets the best one.
  const p = position(fix);
  if (!crash.smsAt && p && better(p, crash.fix) === p) {
    crash.fix = p;
    changed = true;
  }
  if (typeof report?.smsOk === 'boolean' && crash.smsAt && crash.smsOk === null) {
    crash.smsOk = report.smsOk;
    // It did not go out (no network): ordered again with this report, up to SMS_TRIES in all.
    if (!report.smsOk && !crash.okAt && (crash.smsTries ?? 1) < SMS_TRIES) {
      crash.smsAt = null;
      crash.smsOk = null;
    }
    changed = true;
  }
  // No server for a while: the board texted the contact itself.
  if (info?.local && !crash.smsAt) {
    crash.smsAt = now;
    crash.smsOk = true;
    await store.addEvent('crash_sms', { local: true }, now);
    changed = true;
  }
  // The board saw the bike ride on: the owner is fine.
  if (info?.over && !crash.okAt) {
    crash.okAt = now;
    crash.okBy = 'ride';
    await store.addEvent('crash_ok', { by: 'ride' }, now);
    if (crash.pushover) await cancel(crash.pushover);
    changed = true;
  }

  if (crash.okAt) {
    if (crash.smsAt && !crash.okSmsAt && !canText) {
      if (changed) await store.set('crash', crash);
      return out; // the second SMS waits for a board that can send it
    }
    let sms = null;
    if (crash.smsAt && !crash.okSmsAt) {
      crash.okSmsAt = now;
      sms = { to: crash.to, texts: [okSmsText({ crash, settings })] };
      await store.addEvent('crash_sms', { ok: true }, now);
    }
    crash.active = false;
    crash.endAt = now;
    await store.set('crash', crash);
    return { ...out, crash: { end: true }, ...(sms ? { sms } : {}) };
  }

  if (!crash.smsAt && now >= crash.deadline && canText) {
    // Nobody answered: text the contact where the bike is.
    crash.smsAt = now;
    crash.smsTries = (crash.smsTries ?? 0) + 1;
    const texts = crashSmsTexts({ crash, settings, shareUrl: await liveLink(store, origin, now) });
    await store.set('crash', crash);
    await store.addEvent('crash_sms', { ...(crash.test ? { test: true } : {}), ...(crash.smsTries > 1 ? { try: crash.smsTries } : {}) }, now);
    if (crash.smsTries > 1) return { ...out, crash: { wait: 0 }, sms: { to: crash.to, texts } }; // the owner already knows
    await notify({
      title: crash.test ? 'Δοκιμή: στέλνεται SMS' : 'Στέλνεται SMS ατυχήματος',
      body: `Δεν απάντησες, οπότε η συσκευή στέλνει SMS ${contactPhrase(settings)} με το σημείο. Αν είσαι καλά, πάτα «Είμαι καλά» και θα πάει δεύτερο SMS ότι είσαι καλά.`,
      tag: 'moto-crash',
      urgent: true,
    });
    return { ...out, crash: { wait: 0 }, sms: { to: crash.to, texts } };
  }

  if (changed) await store.set('crash', crash);
  // After the SMS the board reports a while longer (the live link follows it), then goes back to normal.
  if (crash.smsAt && now - crash.smsAt >= WATCH_AFTER_SMS_MS) return { ...out, crash: { end: true } };
  return { ...out, crash: { wait: Math.max(0, Math.ceil((crash.deadline - now) / 1000)) } };
}

/**
 * «Είμαι καλά»: from the app, or Pushover's acknowledge (then `receipt` says which alert). Before
 * the SMS the episode ends here; after it, the board's next report carries the "all is well" SMS.
 */
export async function okCrash({ store, now = Date.now(), receipt = null, cancel = async () => {} }) {
  const crash = await store.get('crash');
  if (!crash?.active || crash.okAt) return false;
  if (receipt !== null && crash.pushover !== receipt) return false;
  crash.okAt = now;
  crash.okBy = receipt !== null ? 'pushover' : 'app';
  if (!crash.smsAt) {
    crash.active = false;
    crash.endAt = now;
  }
  await store.set('crash', crash);
  await store.addEvent('crash_ok', { by: crash.okBy, ...(crash.test ? { test: true } : {}) }, now);
  if (receipt === null && crash.pushover) await cancel(crash.pushover);
  return true;
}

/** The whole chain from the app: the alert, the wait, and the SMS to `to` at the board's next report. */
export async function startCrashTest({ store, to, settings, now = Date.now(), notify = async () => {}, emergency = async () => null }) {
  const current = await store.get('crash');
  if (current?.active && !current.test) throw new Error('crash_active');
  const crash = {
    active: true,
    test: true,
    since: now,
    at: null,
    deadline: now + CRASH_WAIT_S * 1000,
    to,
    kmh: null,
    tilt: null,
    fix: position(await store.get('last_fix')),
    pushover: null, // set below
    smsAt: null,
    smsOk: null,
    okAt: null,
    okBy: null,
    okSmsAt: null,
    endAt: null,
  };
  await store.addEvent('crash_test', {}, now);
  crash.pushover = await alertOwner({ crash, settings, notify, emergency });
  await store.set('crash', crash);
  return crash;
}

/** For the app: the open fall, or null. */
export function crashView(crash, now = Date.now()) {
  if (!crash?.active) return null;
  return {
    since: crash.since,
    test: Boolean(crash.test),
    kmh: crash.kmh,
    wait: crash.smsAt ? 0 : Math.max(0, Math.ceil((crash.deadline - now) / 1000)),
    deadline: crash.deadline,
    smsAt: crash.smsAt,
    smsOk: crash.smsOk,
    okAt: crash.okAt,
    position: crash.fix,
  };
}
