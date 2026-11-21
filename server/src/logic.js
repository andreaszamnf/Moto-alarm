// Alarm logic: what a device report means, what to tell the phone, and what the device does next.
// The server is the authority on armed/disarmed: the device always reports motion and the server
// decides whether it is a theft. That way a disarm sent while the bike had no signal still counts.
import { crashReply, crashView, shortName } from './crash.js';
import { compareVersions, firmwareEvents, firmwareOffer, validVersion } from './firmware.js';
import { endLoan, loanNews, loanView } from './loan.js';
import { endRide, normalizePoints, rideSeconds, rideView, trackRide } from './rides.js';
import { GOOGLE_PER_MONTH, googleUsage, normalizeWifi } from './wifiloc.js';

export const DEFAULTS = Object.freeze({
  heartbeatMinutes: 360, // parked: report every 6 hours, with a GPS position
  checkInMinutes: 15, // parked: a short "still here" in between, without GPS (firmware 1.5.0 and later)
  checkInPoweredMinutes: 5, // the same while the bike powers the board (firmware 1.7.0 and later)
  trackSeconds: 30, // during an alarm: report every 30 seconds
  parkRadius: 50, // metres the bike may be from where it was armed before it counts as moved (GPS backup to the motion sensor)
  pushRepeatMinutes: 5, // repeat the alarm notification while the alarm continues
  offlineAlert: false, // warn when the device stops reporting (off while the parking spot has no signal)
  offlineGraceMinutes: 60,
  lowBatteryPct: 15,
  sensitivity: 2, // motion sensor: 1 low, 2 medium, 3 high (sent to the device)
  touchAlerts: false, // quiet notification when someone only touches the armed bike
  parkAction: 'remind', // parked while disarmed: 'none', 'remind' or 'arm'
  schedule: Object.freeze({ on: false, arm: '23:00', disarm: '07:00' }), // every day, Greek time
  callNumber: '', // the device texts this phone when the alarm goes off ('' = off)
  morning: Object.freeze({ on: true, time: '08:00' }), // a quiet summary of the night, every morning (Greek time)
  // A fall while riding: SMS to an emergency contact unless the owner says «Είμαι καλά» (crash.js).
  // name: the owner, as the contact knows them; contact: the contact's name, for the app's texts.
  crash: Object.freeze({ on: false, name: '', contact: '', phone: '' }),
  // «Χαμηλή κατανάλωση»: a check-in every half hour (also on the bike's power), a ride report every
  // minute, and the modem off while parked (firmware 1.8.2 on). An alarm still tracks as usual.
  lowPower: false,
});

export const LOW_POWER_CHECKIN_MINUTES = 30;

export const TIME_ZONE = 'Europe/Athens';
export const PARK_RADIUS_CHOICES = Object.freeze([30, 50, 100, 200]);
export const PARK_ACTIONS = Object.freeze(['none', 'remind', 'arm']);
export const SHARE_HOURS = Object.freeze([1, 24, 72]);
export const SIGNAL_TEST_MINUTES = Object.freeze([30, 60, 120]);
const SIGNAL_TEST_HEARTBEAT_S = 120; // during a signal test the device reports every 2 minutes

const TOUCH_PUSH_GAP_MS = 10 * 60_000;
const SMS_REPEAT_MS = 10 * 60_000;
const MAX_SMS = 3; // per alarm: the SIM has 50 SMS a year
// The board's clock follows the server's in whole seconds and can be a little behind, so movement
// it stamps up to this much before "seen" may in fact have begun after it.
const CLOCK_SLACK_MS = 2_000;
const RIDING_RECENT_MS = 20 * 60_000;
const WIFI_REUSE_MS = 6 * 3_600_000; // same Wi-Fi around the bike within this time: same answer, no new lookup
const SCHEDULE_IDLE_WRITE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Device fix: { lat, lon, acc (m), spd (km/h), t (unix seconds, optional) }
export function normalizeFix(fix, now) {
  if (!fix || typeof fix !== 'object') return null;
  const lat = finite(fix.lat);
  const lon = finite(fix.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const t = finite(fix.t);
  const ts = t !== null && t > 1_600_000_000 && t * 1000 <= now + 60_000 ? t * 1000 : now;
  return { ts, lat, lon, acc: finite(fix.acc), speed: finite(fix.spd) };
}

// Only the board's own reading (its divider on GPIO35) shows the charge. On USB (a charger, the
// bike's power) LilyGO cuts that divider, and the modem's supply voltage the board sends instead
// (src 'modem') does not follow the cell: on 2026-11-20 it stayed at 3.871 V (66%) through more than
// an hour of charging a flat battery. So that one is kept as a voltage for diagnosis, not as a charge.
function normalizeBattery(batt) {
  if (!batt || typeof batt !== 'object') return null;
  const adc = finite(batt.adc); // the divider's own reading, for diagnosis
  if (batt.src === 'modem') {
    const out = { pct: null, mv: null };
    if (finite(batt.mv) !== null) out.modemMv = finite(batt.mv);
    if (adc !== null) out.adc = adc;
    return out;
  }
  const pct = finite(batt.pct);
  const out = { pct: pct === null || pct < 0 ? null : Math.max(0, Math.min(100, Math.round(pct))), mv: finite(batt.mv) };
  if (adc !== null) out.adc = adc;
  return out;
}

// Why the board's Wi-Fi did not work, sent with a 4G report (firmware 1.8.1 on): no known network
// in reach, the password refused, joined but no address, joined but the server not reached.
const WIFI_FAILS = new Set(['notfound', 'password', 'join', 'noip', 'noserver']);
function normalizeWifiFail(w) {
  if (!w || typeof w !== 'object' || !WIFI_FAILS.has(w.k)) return null;
  return {
    k: w.k,
    n: typeof w.n === 'string' && w.n ? w.n.slice(0, 32) : null, // the network it tried
    s: finite(w.s), // its signal, dBm
    c: finite(w.c), // the Wi-Fi reason or HTTP status, for diagnosis
    seen: finite(w.seen), // networks around in all
  };
}

export function alarmText(reason, metres) {
  switch (reason) {
    case 'moved':
      return metres ? `Η μηχανή απομακρύνθηκε ${Math.round(metres)} μ. από εκεί που την άφησες!` : 'Η μηχανή μετακινήθηκε!';
    case 'tamper':
      return 'Κάποιος πειράζει τη συσκευή!';
    case 'power':
      return 'Κόπηκε το ρεύμα της μηχανής! Η συσκευή συνεχίζει με την εφεδρική μπαταρία.';
    default:
      return 'Κάποιος κουνάει τη μηχανή!';
  }
}

// The alarm SMS: Greek needs UCS-2, so one SMS holds 70 characters. The link opens Apple Maps.
export function alarmSms(reason, fix) {
  const what = { moved: 'μετακινήθηκε', tamper: 'παραβίαση', power: 'κόπηκε το ρεύμα' }[reason] ?? 'κίνηση';
  if (!fix) return 'Συναγερμός μηχανής: κάποιος την κουνάει!';
  const link = `maps.apple.com/?q=${fix.lat.toFixed(5)},${fix.lon.toFixed(5)}`;
  const text = `Συναγερμός: ${what}! ${link}`;
  return text.length <= 70 ? text : `Συναγερμός! ${link}`.slice(0, 70);
}
// Phone number for the alarm SMS, in international form. '' turns SMS off; null means not valid.
export function normalizePhone(text) {
  if (typeof text !== 'string') return null;
  let n = text.replace(/[\s\-().]/g, '');
  if (n === '') return '';
  if (n.startsWith('00')) n = `+${n.slice(2)}`;
  if (/^69\d{8}$/.test(n)) n = `+30${n}`; // Greek mobile without the country code
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function loadSettings(store) {
  return { ...DEFAULTS, ...((await store.get('settings')) ?? {}) };
}

export async function updateSettings(store, patch, now = Date.now()) {
  const saved = (await store.get('settings')) ?? {};
  if (typeof patch?.offlineAlert === 'boolean') saved.offlineAlert = patch.offlineAlert;
  if (PARK_RADIUS_CHOICES.includes(patch?.parkRadius)) saved.parkRadius = patch.parkRadius;
  if ([1, 2, 3].includes(patch?.sensitivity)) saved.sensitivity = patch.sensitivity;
  if (typeof patch?.touchAlerts === 'boolean') saved.touchAlerts = patch.touchAlerts;
  if (typeof patch?.lowPower === 'boolean') saved.lowPower = patch.lowPower;
  if (PARK_ACTIONS.includes(patch?.parkAction)) saved.parkAction = patch.parkAction;
  const phone = normalizePhone(patch?.callNumber);
  if (phone !== null) saved.callNumber = phone;
  if (patch?.crash && typeof patch.crash === 'object') {
    const current = { ...DEFAULTS.crash, ...(saved.crash ?? {}) };
    const contactPhone = normalizePhone(patch.crash.phone);
    saved.crash = {
      on: typeof patch.crash.on === 'boolean' ? patch.crash.on : current.on,
      name: shortName(patch.crash.name) ?? current.name,
      contact: shortName(patch.crash.contact) ?? current.contact,
      phone: contactPhone !== null ? contactPhone : current.phone,
    };
  }
  if (patch?.morning && typeof patch.morning === 'object') {
    const current = { ...DEFAULTS.morning, ...(saved.morning ?? {}) };
    saved.morning = {
      on: typeof patch.morning.on === 'boolean' ? patch.morning.on : current.on,
      time: TIME_RE.test(patch.morning.time) ? patch.morning.time : current.time,
    };
  }
  if (patch?.schedule && typeof patch.schedule === 'object') {
    const current = { ...DEFAULTS.schedule, ...(saved.schedule ?? {}) };
    const time = (value, fallback) => (value === '' || TIME_RE.test(value) ? value : fallback);
    saved.schedule = {
      on: typeof patch.schedule.on === 'boolean' ? patch.schedule.on : current.on,
      arm: time(patch.schedule.arm, current.arm),
      disarm: time(patch.schedule.disarm, current.disarm),
    };
    // Times already past today do not count: the schedule acts from now on.
    await store.set('schedule_checked', now);
  }
  await store.set('settings', saved);
  return { ...DEFAULTS, ...saved };
}

async function loadState(store) {
  const [armed, alarm, pending, settings] = await Promise.all([
    store.get('armed'),
    store.get('alarm'),
    store.get('pending'),
    loadSettings(store),
  ]);
  return {
    armed: armed ?? { armed: false, since: null, park: null },
    alarm: alarm ?? { active: false },
    pending: pending ?? {},
    settings,
  };
}

// ---------- battery forecast ----------

// One sample an hour is plenty, unless the charge moved.
async function logBattery(store, pct, now) {
  const log = (await store.get('batt_log')) ?? [];
  const last = log[log.length - 1];
  if (last && now - last[0] < 3_600_000 && Math.abs(last[1] - pct) < 2) return;
  log.push([now, pct]);
  while (log.length > 300 || (log.length && now - log[0][0] > 60 * DAY_MS)) log.shift();
  await store.set('batt_log', log);
}

export function forecastText(days) {
  if (days > 60) return 'πάνω από 2 μήνες';
  if (days >= 14) return `περίπου ${Math.round(days / 7)} εβδομάδες`;
  if (days >= 2) return `περίπου ${Math.round(days)} μέρες`;
  if (days >= 1) return 'περίπου 1 μέρα';
  return 'λιγότερο από μία μέρα';
}

// How long the battery will last at the rate it has been dropping since the last charge.
// Needs two days of readings. log: [[timestamp, percent], ...] oldest first.
export function batteryForecast(log, now = Date.now()) {
  if (!Array.isArray(log) || log.length < 3) return null;
  let start = 0;
  for (let i = 1; i < log.length; i++) if (log[i][1] > log[i - 1][1] + 3) start = i; // charged here
  const samples = log.slice(start);
  if (samples.length < 3 || samples[samples.length - 1][0] - samples[0][0] < 2 * DAY_MS) return null;
  const xs = samples.map(([t]) => (t - samples[0][0]) / DAY_MS);
  const ys = samples.map(([, p]) => p);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (!den) return null;
  const perDay = num / den; // negative while draining
  const pct = ys[ys.length - 1];
  const days = perDay > -0.05 ? Infinity : Math.max(0, (pct - 5) / -perDay); // the board stops near 5%
  return { days: Number.isFinite(days) ? Math.round(days * 10) / 10 : null, text: forecastText(days) };
}

// ---------- signal ----------

export function signalText(rssi) {
  if (typeof rssi !== 'number') return null;
  if (rssi >= -85) return 'καλό';
  if (rssi >= -100) return 'μέτριο';
  return 'αδύναμο';
}

export function signalBars(rssi) {
  if (typeof rssi !== 'number') return 0;
  return rssi >= -75 ? 4 : rssi >= -85 ? 3 : rssi >= -95 ? 2 : rssi >= -105 ? 1 : 0;
}

// ---------- device reports ----------

// The device says "parked" a few minutes after the bike stops. Arm it, or remind the owner.
async function onParked({ store, armed, fix, settings, now, notify }) {
  await store.addEvent('parked', fix ? { lat: fix.lat, lon: fix.lon } : {}, now);
  if (armed.armed) return armed;
  if ((await store.get('loan'))?.on) return armed; // lent out: no reminder, never armed by itself
  const waiting = await store.get('arm_on_park'); // the schedule wanted to arm while you were riding
  if (waiting || settings.parkAction === 'arm') {
    await setArmed({ store, armed: true, now, by: waiting ? 'schedule' : 'park' });
    await notify({ title: 'Ο συναγερμός οπλίστηκε', body: 'Πάρκαρες, οπότε οπλίστηκε μόνος του.', tag: 'moto-armed' });
    return (await store.get('armed')) ?? armed;
  }
  if (settings.parkAction === 'remind') {
    await notify({
      title: 'Πάρκαρες;',
      body: 'Ο συναγερμός είναι αφοπλισμένος. Άνοιξε την εφαρμογή για να τον οπλίσεις.',
      tag: 'moto-remind',
    });
  }
  return armed;
}

// A light touch on the armed bike: a quiet notification at most every 10 minutes.
async function onTouch({ store, settings, now, notify }) {
  if (!settings.touchAlerts) return;
  await store.addEvent('touch', {}, now);
  const last = (await store.get('touch_push')) ?? 0;
  if (now - last < TOUCH_PUSH_GAP_MS) return;
  await store.set('touch_push', now);
  await notify({
    title: 'Ακούμπησαν τη μηχανή',
    body: 'Κάποιος ακούμπησε τη μηχανή χωρίς να την κουνήσει. Ο συναγερμός δεν χτύπησε.',
    tag: 'moto-touch',
  });
}

// Share of the access points heard now that were also heard at the last lookup.
function sharedShare(now, before) {
  if (!now.length || !before?.length) return 0;
  const earlier = new Set(before);
  return now.filter((mac) => earlier.has(mac)).length / Math.min(now.length, before.length);
}

// Asks the geolocation service only when the Wi-Fi around the bike has changed. A bike standing in a
// garage during an alarm reports every few minutes, and the answer (or "not known") is the same each
// time. This keeps Google well inside its free monthly lookups.
async function locateByWifi(store, accessPoints, geolocate, now) {
  if (accessPoints.length < 2) return null;
  const macs = accessPoints.slice(0, 8).map((ap) => ap.macAddress);
  const last = await store.get('wifi_last');
  if (last && now - last.ts < WIFI_REUSE_MS && sharedShare(macs, last.macs) >= 0.5) return last.found ?? null;
  const found = await geolocate(accessPoints).catch(() => null);
  await store.set('wifi_last', { ts: now, macs, found: found ? { lat: found.lat, lon: found.lon, acc: found.acc, by: found.by } : null });
  return found;
}

/**
 * Handles one report from the device and returns its instructions.
 * report: { reason, fix?, pts?: [[t, lat, lon, kmh]], wifi?: [{ m, s }], batt?: { pct, mv }, rssi?, tilt?, moving? }
 * notify(payload) sends a push notification to every subscribed phone.
 * emergency(payload) sends the loud Pushover alarm and returns its receipt (or null).
 * geolocate(accessPoints) turns nearby Wi-Fi into { lat, lon, acc, by }, or null.
 * firmware is the newest published firmware ({ v, size, sig }), offered to the board when it is quiet.
 */
export async function handleReport({
  store,
  report,
  now = Date.now(),
  notify = async () => {},
  emergency = async () => null,
  geolocate = async () => null,
  firmware = null,
  cancel = async () => {}, // stops a Pushover alert's repeats
  origin = '', // the app's address, for the live link in a crash SMS
}) {
  await runAutomation({ store, now, notify });
  const { armed: armedBefore, alarm, pending, settings } = await loadState(store);
  const reason = typeof report?.reason === 'string' ? report.reason.slice(0, 20) : 'report';
  let fix = normalizeFix(report?.fix, now);
  if (!fix) {
    // No GPS (a garage, a van): a rough position from the Wi-Fi around the bike, if a service knows it.
    const found = await locateByWifi(store, normalizeWifi(report?.wifi), geolocate, now);
    if (found) fix = { ts: now, lat: found.lat, lon: found.lon, acc: found.acc, speed: null, src: 'wifi' };
  }
  // While riding: GPS points every few seconds since the last report (the fix is the newest).
  const points = normalizePoints(report?.pts, now);
  const batt = normalizeBattery(report?.batt);
  const running = validVersion(report?.fw) ? report.fw : null;

  const deviceBefore = await store.get('device');
  await store.set('device', {
    lastSeen: now,
    reason,
    batt,
    rssi: finite(report?.rssi),
    tilt: finite(report?.tilt),
    fw: running,
    wifiv: finite(report?.wifiv), // which list of Wi-Fi networks the board has
    // How it got through this time: a known Wi-Fi (name and signal) or 4G (rssi above).
    via: report?.via === 'wifi' ? 'wifi' : '4g',
    wifiName: report?.via === 'wifi' && typeof report?.wnet === 'string' ? report.wnet.slice(0, 32) : null,
    wifiRssi: report?.via === 'wifi' ? finite(report?.wrssi) : null,
    wifiFail: report?.via === 'wifi' ? null : normalizeWifiFail(report?.wfail),
    checkin: finite(report?.checkin), // seconds between its check-ins, when it does them
    // Powered by the bike (its 12 V through a 5 V converter, seen by the board as USB), firmware 1.7.0 on.
    ext: typeof report?.ext === 'boolean' ? report.ext : null,
    eco: report?.eco === true, // the board keeps «Χαμηλή κατανάλωση» (firmware 1.8.2 on)
  });
  await firmwareEvents({ store, before: deviceBefore?.fw ?? null, running, now });
  // The board started afresh instead of waking from its sleep: power came back, the voltage
  // fell too low, a crash. Kept in the history so a battery that cuts out shows up.
  const rst = finite(report?.rst);
  if (rst !== null && rst > 0) await store.addEvent('restart', { rst }, now);
  // The bike's power going away (wires cut, battery taken out) or coming back. Both reports must
  // say: older firmware sends nothing, and a board that just started afresh still says ext false.
  const extBefore = deviceBefore?.ext ?? null;
  const extNow = typeof report?.ext === 'boolean' ? report.ext : null;
  const powerLost = extBefore === true && extNow === false;
  if (powerLost) await store.addEvent('power_lost', {}, now);
  if (extBefore === false && extNow === true) await store.addEvent('power_back', {}, now);
  await store.set('offline_warned', null);
  if (fix) {
    await store.set('last_fix', fix);
    if (!points.length) await store.addPosition(fix);
  }
  if (points.length) {
    await store.addPositions(points);
    if (!fix) await store.set('last_fix', points[points.length - 1]);
  }
  const signalTest = await store.get('signal_test');
  const testing = Boolean(signalTest && signalTest.until > now);
  // Check-ins come every few minutes: they update the latest signal but fill the history only
  // during a signal test.
  if (reason === 'checkin' && !testing) await store.set('signal_last', signalEntry(report, reason, fix, now));
  else await logSignal(store, signalEntry(report, reason, fix, now), now);

  if (batt?.pct !== null && batt?.pct !== undefined) {
    await logBattery(store, batt.pct, now);
    const warned = await store.get('lowbat_warned');
    // One low reading is not enough: the board measures as it wakes, and a modem busy at that moment
    // pulls the voltage down (9% on 2026-11-20, with the cell at about 40%). The report before has to
    // agree, and the warning gives the higher of the two.
    const before = deviceBefore?.batt?.pct;
    const low = Math.max(batt.pct, typeof before === 'number' ? before : Infinity);
    if (low <= settings.lowBatteryPct && !warned) {
      await store.set('lowbat_warned', now);
      await store.addEvent('low_battery', { pct: low }, now);
      await notify({ title: 'Χαμηλή μπαταρία', body: `Η μπαταρία της συσκευής είναι στο ${low}%. Φόρτισέ τη σύντομα.`, tag: 'moto-battery' });
    } else if (batt.pct >= settings.lowBatteryPct + 15 && warned) {
      await store.set('lowbat_warned', null);
    }
  }

  const armed = reason === 'parked' ? await onParked({ store, armed: armedBefore, fix, settings, now, notify }) : armedBefore;
  const rideNews = await trackRide({ store, reason, points: points.length ? points : fix && fix.src !== 'wifi' ? [fix] : [], armed: armed.armed, now });
  await loanNews({ store, news: rideNews, now, notify });
  // Light touches the board counted since its last report, for the morning summary.
  const touches = finite(report?.touches);
  if (touches !== null && touches > 0) await store.set('touch_tally', ((await store.get('touch_tally')) ?? 0) + Math.min(touches, 1000));

  let sms = null;
  if (armed.armed) {
    // Armed before the first fix arrived: the first quiet GPS fix becomes the parking spot.
    if (!armed.park && fix && fix.src !== 'wifi' && !alarm.active && reason !== 'motion') {
      armed.park = { lat: fix.lat, lon: fix.lon };
      await store.set('armed', armed);
    }
    if (reason === 'touch' && !alarm.active) await onTouch({ store, settings, now, notify });

    let trigger = null;
    let metres = null;
    // Movement from before the owner armed it is no theft. A live ride report (firmware 1.6.0) says
    // when the bike last moved: getting off and the side stand end the ride. A board still tracking
    // an alarm that the owner switched off and on again says when the movement it already reported
    // began: that one was dealt with, only movement that begins after arming counts.
    const lastMove = finite(report?.lastMove);
    const movingSince = finite(report?.movingSince);
    const beforeArming = (seconds) => seconds !== null && armed.since && seconds * 1000 + CLOCK_SLACK_MS < armed.since;
    const movedBeforeArming = reason === 'ride' ? beforeArming(lastMove) : reason !== 'motion' && beforeArming(movingSince);
    if (reason === 'motion' || (report?.moving === true && !movedBeforeArming)) trigger = 'motion';
    if (reason === 'tamper') trigger = 'tamper';
    if (powerLost) trigger = 'power';
    // Only GPS decides "moved": a position from Wi-Fi can be off by a street or more.
    if (fix && fix.src !== 'wifi' && armed.park) {
      metres = distanceM(armed.park, fix);
      // A fix with poor accuracy needs to be further out before we believe the bike really moved.
      if (metres > settings.parkRadius + (fix.acc ?? 0)) trigger = 'moved';
    }

    if (trigger) {
      const fresh = !alarm.active;
      const escalate = !fresh && trigger === 'moved' && alarm.reason !== 'moved';
      // "Seen" covers the movement going on until then. Movement that began afterwards (the board
      // says when, in seconds, after a few still seconds) is news: sound the alarm again.
      const again = !fresh && alarm.acked && movingSince !== null && movingSince * 1000 + CLOCK_SLACK_MS > (alarm.ackedAt ?? Infinity);
      // Power cut during an alarm that is already on: news too, said loudly.
      const powerNews = !fresh && trigger === 'power' && alarm.reason !== 'power';
      if (fresh || escalate || again || powerNews) {
        const reason = again && alarm.reason === 'moved' && trigger !== 'moved' ? 'moved' : trigger;
        Object.assign(alarm, { active: true, since: fresh ? now : alarm.since, reason, acked: false, ackedAt: null, lastPush: 0 });
        if (fresh) Object.assign(alarm, { texts: 0, lastText: 0 });
        await store.addEvent('alarm', { reason, metres: metres === null ? null : Math.round(metres), ...(again ? { again: true } : {}) }, now);
        // The loud alarm through Pushover: sounds through silent mode and repeats until acknowledged.
        alarm.pushover = await emergency({
          title: 'ΣΥΝΑΓΕΡΜΟΣ ΜΗΧΑΝΗΣ',
          message: alarmText(trigger, metres),
          lat: fix?.lat ?? null,
          lon: fix?.lon ?? null,
          replaces: alarm.pushover ?? null,
        });
      }
      if (!alarm.acked && now - (alarm.lastPush ?? 0) >= settings.pushRepeatMinutes * 60_000) {
        alarm.lastPush = now;
        await notify({
          title: 'Συναγερμός μηχανής',
          body: alarmText(alarm.reason, metres),
          tag: 'moto-alarm',
          urgent: true,
          lat: fix?.lat ?? null,
          lon: fix?.lon ?? null,
        });
      }
      // Text the owner's phone: at once, then every 10 minutes until "seen", at most 3 times.
      if (settings.callNumber && !alarm.acked && (alarm.texts ?? 0) < MAX_SMS && now - (alarm.lastText ?? 0) >= SMS_REPEAT_MS) {
        alarm.texts = (alarm.texts ?? 0) + 1;
        alarm.lastText = now;
        sms = { to: settings.callNumber, text: alarmSms(alarm.reason, fix) };
        await store.addEvent('sms', { n: alarm.texts }, now);
      }
      await store.set('alarm', alarm);
    }
  }

  // Disarmed: worth knowing, not an alarm (e.g. the battery taken out for the winter).
  if (powerLost && !armed.armed) {
    await notify({
      title: 'Κόπηκε το ρεύμα της μηχανής',
      body: 'Η συσκευή δουλεύει τώρα από την εφεδρική της μπαταρία.',
      tag: 'moto-power',
    });
  }

  let locate = Boolean(pending.locate);
  if (locate && fix && fix.ts >= pending.locate) {
    await store.set('pending', {});
    locate = false;
  }

  const update = await firmwareOffer({
    store,
    latest: firmware,
    running,
    reason,
    alarmActive: Boolean(alarm.active),
    battPct: batt?.pct ?? null,
    viaWifi: report?.via === 'wifi',
    now,
  });

  // A fall while riding: the wait for «Είμαι καλά», then the SMS to the emergency contact.
  const { sms: crashSms = null, ...crashOut } = await crashReply({ store, report, reason, fix, settings, now, notify, emergency, cancel, origin });
  if (crashSms) sms = crashSms; // an alarm SMS is for an armed bike: never both at once

  return {
    armed: armed.armed,
    track: Boolean(armed.armed && alarm.active),
    locate,
    heartbeat: testing ? SIGNAL_TEST_HEARTBEAT_S : settings.heartbeatMinutes * 60,
    // On the bike's power a check-in costs no battery, so more often; with «Χαμηλή κατανάλωση» every
    // half hour either way (also spares the bike's own battery when it stands for weeks).
    checkin: (settings.lowPower ? LOW_POWER_CHECKIN_MINUTES : extNow ? settings.checkInPoweredMinutes : settings.checkInMinutes) * 60,
    trackInterval: settings.trackSeconds,
    rideInterval: rideSeconds(settings), // firmware 1.6.0 and later
    eco: settings.lowPower === true, // the modem off while parked (firmware 1.8.2 and later)
    t: Math.floor(now / 1000),
    sens: settings.sensitivity,
    touch: settings.touchAlerts,
    ...(sms ? { sms } : {}),
    ...(update ? { update } : {}),
    ...(await wifiForBoard(store, report?.wifiv)),
    ...crashOut,
  };
}

// ---------- Wi-Fi networks the board reports over ----------
// Added in the app. The passwords go only to the board, never back to the app.
export const MAX_WIFI_NETWORKS = 5;
export const validSsid = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 32 && /^[\x20-\x7E]+$/.test(s);
export const validWifiPassword = (p) =>
  typeof p === 'string' && (p === '' || (p.length >= 8 && p.length <= 63)) && /^[\x20-\x7E]*$/.test(p);

async function loadWifiNets(store) {
  return (await store.get('wifi_nets')) ?? { v: 0, list: [] };
}

// The list goes with the reply until the board says it has this version.
async function wifiForBoard(store, boardVersion) {
  const nets = await loadWifiNets(store);
  if (!nets.v || finite(boardVersion) === nets.v) return {};
  return { wifi: { v: nets.v, nets: nets.list.map((n) => [n.ssid, n.password]) } };
}

export async function saveWifiNetwork({ store, ssid, password }) {
  if (!validSsid(ssid)) throw new Error('bad_ssid');
  if (!validWifiPassword(password)) throw new Error('bad_wifi_password');
  const nets = await loadWifiNets(store);
  const existing = nets.list.find((n) => n.ssid === ssid);
  if (existing) existing.password = password;
  else if (nets.list.length >= MAX_WIFI_NETWORKS) throw new Error('too_many_wifi');
  else nets.list.push({ ssid, password });
  nets.v += 1;
  await store.set('wifi_nets', nets);
  return wifiView(nets, await store.get('device'));
}

export async function removeWifiNetwork({ store, ssid }) {
  const nets = await loadWifiNets(store);
  const list = nets.list.filter((n) => n.ssid !== ssid);
  if (list.length !== nets.list.length) {
    nets.list = list;
    nets.v += 1;
    await store.set('wifi_nets', nets);
  }
  return wifiView(nets, await store.get('device'));
}

// For the app: the names, whether the board already has the latest list, and how its last report
// went: over which Wi-Fi, or over 4G and why the Wi-Fi did not work (firmware 1.8.1 on).
function wifiView(nets, device) {
  const viaWifi = device?.via === 'wifi';
  return {
    names: nets.list.map((n) => n.ssid),
    synced: !nets.v || device?.wifiv === nets.v,
    at: device?.lastSeen ?? null,
    via: device?.lastSeen ? (viaWifi ? 'wifi' : '4g') : null,
    name: viaWifi ? device?.wifiName ?? null : null,
    rssi: viaWifi ? device?.wifiRssi ?? null : null,
    fail: viaWifi ? null : device?.wifiFail ?? null,
  };
}

export async function setArmed({ store, armed, now = Date.now(), by = null, cancel = async () => {} }) {
  const previous = await store.get('alarm');
  if (armed) {
    const fix = await store.get('last_fix');
    // A rough Wi-Fi position is no parking spot: the next GPS fix sets it instead.
    const park = fix && fix.src !== 'wifi' ? { lat: fix.lat, lon: fix.lon } : null;
    await store.set('armed', { armed: true, since: now, park });
    await endRide(store, now); // armed: the ride is over, even before the board says "parked"
    await endLoan(store, now); // and the bike is back from the workshop or the friend
  } else {
    await store.set('armed', { armed: false, since: now, park: null });
  }
  await store.set('alarm', { active: false });
  await store.set('arm_on_park', null);
  await store.addEvent(armed ? 'armed' : 'disarmed', by ? { by } : {}, now);
  if (previous?.active && previous.pushover && !previous.acked) await cancel(previous.pushover); // stop its repeats
}

// "Seen", from the app, or from Pushover (then `receipt` says which alert was acknowledged).
export async function ackAlarm({ store, now = Date.now(), receipt = null, cancel = async () => {} }) {
  const alarm = await store.get('alarm');
  if (!alarm?.active || alarm.acked) return false;
  if (receipt !== null && alarm.pushover !== receipt) return false; // an older Pushover alert
  alarm.acked = true;
  alarm.ackedAt = now; // movement after this sounds the alarm again
  await store.set('alarm', alarm);
  await store.addEvent('acked', receipt !== null ? { via: 'pushover' } : {}, now);
  if (receipt === null && alarm.pushover) await cancel(alarm.pushover); // seen in the app: stop the Pushover repeats
  return true;
}

export async function requestLocate({ store, now = Date.now() }) {
  await store.set('pending', { locate: now });
}

// ---------- daily schedule (Greek time) ----------

const athensFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// Date in Greece at `ms`, and how far Greek time is ahead of UTC then.
function athens(ms) {
  const p = Object.fromEntries(athensFormat.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return { year: +p.year, month: +p.month, day: +p.day, offset: asUtc - Math.floor(ms / 1000) * 1000 };
}

// The latest moment at or before `now` when clocks in Greece showed `hhmm`.
export function lastOccurrence(hhmm, now = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const today = athens(now);
  const local = Date.UTC(today.year, today.month - 1, today.day, h, m);
  let t = local - today.offset;
  t = local - athens(t).offset; // right offset on the day summer time starts or ends
  if (t > now) {
    const yesterday = athens(t - DAY_MS);
    const localYesterday = Date.UTC(yesterday.year, yesterday.month - 1, yesterday.day, h, m);
    t = localYesterday - athens(localYesterday - yesterday.offset).offset;
  }
  return t;
}

// Arms or disarms when a time in the daily schedule has passed. Runs on every request and from cron.
export async function runAutomation({ store, now = Date.now(), notify = async () => {} }) {
  const { schedule } = await loadSettings(store);
  if (!schedule?.on || (!schedule.arm && !schedule.disarm)) return null;
  const checked = await store.get('schedule_checked');
  if (checked === null) {
    await store.set('schedule_checked', now); // first look: act from now on
    return null;
  }
  const due = [];
  if (schedule.arm) due.push({ at: lastOccurrence(schedule.arm, now), arm: true });
  if (schedule.disarm) due.push({ at: lastOccurrence(schedule.disarm, now), arm: false });
  const passed = due.filter((d) => d.at > checked && d.at <= now).sort((a, b) => a.at - b.at);
  if (!passed.length) {
    if (now - checked >= SCHEDULE_IDLE_WRITE_MS) await store.set('schedule_checked', now);
    return null;
  }
  await store.set('schedule_checked', now);
  const latest = passed[passed.length - 1]; // only the most recent change matters
  await applySchedule({ store, arm: latest.arm, now, notify });
  return latest.arm ? 'arm' : 'disarm';
}

async function applySchedule({ store, arm, now, notify }) {
  const [armed, alarm, device] = await Promise.all([store.get('armed'), store.get('alarm'), store.get('device')]);
  if (arm) {
    if (armed?.armed) return;
    if ((await store.get('loan'))?.on) {
      await notify({ title: 'Δεν οπλίστηκε', body: 'Η μηχανή είναι δανεική, οπότε το πρόγραμμα δεν την όπλισε.', tag: 'moto-schedule' });
      return;
    }
    const riding = device?.lastSeen && now - device.lastSeen < RIDING_RECENT_MS && ['motion', 'ride'].includes(device.reason);
    if (riding) {
      await store.set('arm_on_park', now);
      await notify({ title: 'Πρόγραμμα συναγερμού', body: 'Οδηγείς τώρα. Θα οπλίσει μόλις παρκάρεις.', tag: 'moto-schedule' });
      return;
    }
    await setArmed({ store, armed: true, now, by: 'schedule' });
    await notify({ title: 'Ο συναγερμός οπλίστηκε', body: 'Σύμφωνα με το πρόγραμμα.', tag: 'moto-schedule' });
    return;
  }
  await store.set('arm_on_park', null);
  if (!armed?.armed) return;
  if (alarm?.active) {
    await notify({ title: 'Δεν αφοπλίστηκε', body: 'Ο συναγερμός χτυπάει, οπότε το πρόγραμμα δεν τον αφόπλισε.', tag: 'moto-schedule' });
    return;
  }
  await setArmed({ store, armed: false, now, by: 'schedule' });
  await notify({ title: 'Ο συναγερμός αφοπλίστηκε', body: 'Σύμφωνα με το πρόγραμμα.', tag: 'moto-schedule' });
}

// ---------- live location link ----------

export async function startShare({ store, token, hours, now = Date.now() }) {
  const share = { token, created: now, expires: now + hours * 3_600_000 };
  await store.set('share', share);
  await store.addEvent('share', { hours }, now);
  return share;
}

export async function stopShare({ store, now = Date.now() }) {
  if (!(await store.get('share'))) return;
  await store.set('share', null);
  await store.addEvent('share_stop', {}, now);
}

// What someone with the link sees: only where the bike is and where it went, nothing else.
export async function sharedView({ store, share, now = Date.now() }) {
  const [position, device, alarm] = await Promise.all([store.get('last_fix'), store.get('device'), store.get('alarm')]);
  const trail = await store.positions(Math.max(share.created - 3_600_000, now - 12 * 3_600_000), now, 1000);
  return {
    now,
    expires: share.expires,
    lastSeen: device?.lastSeen ?? null,
    alarm: Boolean(alarm?.active),
    position: position
      ? {
          lat: position.lat,
          lon: position.lon,
          acc: position.acc ?? null,
          speed: position.speed ?? null,
          ts: position.ts,
          src: position.src ?? 'gps',
        }
      : null,
    trail: trail.map((p) => [p.lat, p.lon]),
  };
}

// ---------- state for the app and widgets ----------

export async function snapshot(store, now = Date.now()) {
  const [armed, alarm, device, position, pending, settings, battLog, share, armOnPark, pushover, signalTest, signalLast, wifiloc, fwOffer, wifiNets, ride, crash] =
    await Promise.all([
      store.get('armed'),
      store.get('alarm'),
      store.get('device'),
      store.get('last_fix'),
      store.get('pending'),
      loadSettings(store),
      store.get('batt_log'),
      store.get('share'),
      store.get('arm_on_park'),
      store.get('pushover'),
      store.get('signal_test'),
      store.get('signal_last'),
      store.get('wifiloc'),
      store.get('fw_offer'),
      loadWifiNets(store),
      store.get('ride'),
      store.get('crash'),
    ]);
  return {
    now,
    armed: armed ?? { armed: false, since: null, park: null },
    alarm: alarm ?? { active: false },
    device,
    position,
    pending: pending ?? {},
    settings,
    forecast: batteryForecast(battLog, now),
    share: share && share.expires > now ? share : null,
    armOnPark: Boolean(armOnPark),
    pushover: Boolean(pushover?.token),
    signal: { test: signalTest && signalTest.until > now ? signalTest.until : null, last: signalInDb(signalLast) },
    // Which service finds the position from Wi-Fi. The Google key itself never leaves the server.
    wifiloc: { google: Boolean(wifiloc?.googleKey), used: await googleUsage(store, now), limit: GOOGLE_PER_MONTH },
    // How long it may stay silent and still count as in touch (see contactWindowMs).
    contactMs: contactWindowMs(device, alarm, settings),
    // The ride under way: speed, distance and time so far (null when not riding).
    ride: rideView(ride, now, rideSeconds(settings)),
    // Lent out (workshop, friend): since when and its rides so far (null when not lent).
    loan: await loanView(store, now),
    // A fall while riding, waiting for «Είμαι καλά» or after the SMS (null when none is open).
    crash: crashView(crash, now),
    // The Wi-Fi networks the board reports over (names only: the passwords stay on the server).
    wifi: wifiView(wifiNets, device),
    // The board's program, and a newer one on its way (offered and not yet failed).
    firmware: {
      running: device?.fw ?? null,
      coming:
        fwOffer && !fwOffer.failed && validVersion(fwOffer.v) && validVersion(device?.fw) && compareVersions(fwOffer.v, device.fw) > 0
          ? fwOffer.v
          : null,
    },
  };
}

// ---------- signal test ----------

// AT+CPSI gives RSRP and RSRQ in tenths (-1084 = -108.4 dBm) and the board passes them on as they
// come, so the log held them that way until 2026-11-19. Real values never go below these floors:
// anything lower is still in tenths. Applied when storing and again when showing older entries.
const RSRP_FLOOR_DBM = -150;
const RSRQ_FLOOR_DB = -25;

function fromTenths(value, floor) {
  const v = finite(value);
  return v !== null && v < floor ? Math.round(v) / 10 : v;
}

export function signalInDb(entry) {
  if (!entry || typeof entry !== 'object') return entry ?? null;
  return { ...entry, rsrp: fromTenths(entry.rsrp, RSRP_FLOOR_DBM), rsrq: fromTenths(entry.rsrq, RSRQ_FLOOR_DB) };
}

// One measurement from a device report: which network, how strong, and how hard it was to get through.
function signalEntry(report, reason, fix, now) {
  const net = report?.net && typeof report.net === 'object' ? report.net : {};
  const text = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  return {
    ts: now,
    reason,
    op: text(net.op, 32),
    tech: text(net.tech, 8),
    rssi: finite(report?.rssi),
    rsrp: fromTenths(net.rsrp, RSRP_FLOOR_DBM),
    rsrq: fromTenths(net.rsrq, RSRQ_FLOOR_DB),
    snr: finite(net.snr),
    reg: finite(net.reg),
    warm: net.warm === true, // the modem had stayed on the network while the board slept
    via: report?.via === 'wifi' ? 'wifi' : '4g', // sent over a known Wi-Fi network instead of 4G
    fails: finite(report?.fails),
    lat: fix?.lat ?? null,
    lon: fix?.lon ?? null,
  };
}

async function logSignal(store, entry, now) {
  const log = (await store.get('signal_log')) ?? [];
  log.push(entry);
  while (log.length > 300 || (log.length && now - log[0].ts > 14 * DAY_MS)) log.shift();
  await store.set('signal_log', log);
  await store.set('signal_last', entry);
}

export async function startSignalTest({ store, minutes, now = Date.now() }) {
  await store.set('signal_test', { since: now, until: now + minutes * 60_000 });
  await store.addEvent('signal_test', { minutes }, now);
}

export async function stopSignalTest({ store }) {
  await store.set('signal_test', null);
}

export async function signalView({ store, now = Date.now() }) {
  const [test, log, device] = await Promise.all([store.get('signal_test'), store.get('signal_log'), store.get('device')]);
  return {
    now,
    test: test && test.until > now ? test : null,
    lastSeen: device?.lastSeen ?? null,
    log: (log ?? []).slice(-60).reverse().map(signalInDb), // newest first
  };
}

export function timeAgoText(ms, now = Date.now()) {
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 45) return 'μόλις τώρα';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `πριν ${minutes} λεπτ${minutes === 1 ? 'ό' : 'ά'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `πριν ${hours} ώρ${hours === 1 ? 'α' : 'ες'}`;
  const days = Math.round(hours / 24);
  return `πριν ${days} μέρ${days === 1 ? 'α' : 'ες'}`;
}

// Short status for home-screen widgets and shortcuts (iPhone Shortcuts, Scriptable).
export function quickStatus(snap) {
  const armed = Boolean(snap.armed?.armed);
  const alarm = Boolean(snap.alarm?.active);
  // On USB the board cannot measure its battery: just "charging", no percentage or forecast.
  const charging = snap.device?.ext === true;
  const battery = charging ? null : snap.device?.batt?.pct ?? null;
  const lastSeen = snap.device?.lastSeen ?? null;
  const lastSeenText = lastSeen ? `επαφή ${timeAgoText(lastSeen, snap.now)}` : 'καμία επαφή ακόμα';
  const rssi = snap.device?.rssi ?? null;
  const state = alarm ? 'ΣΥΝΑΓΕΡΜΟΣ' : armed ? 'Οπλισμένος' : 'Αφοπλισμένος';
  const parts = [state];
  if (charging) parts.push('φορτίζει');
  else if (battery !== null) parts.push(`μπαταρία ${battery}%`);
  parts.push(lastSeenText);
  const p = snap.position;
  return {
    armed,
    alarm,
    battery,
    charging,
    forecast: charging ? null : snap.forecast?.text ?? null,
    rssi,
    signal: signalText(rssi),
    bars: signalBars(rssi),
    lastSeen,
    lastSeenText,
    position: p ? { lat: p.lat, lon: p.lon, acc: p.acc ?? null, ts: p.ts, src: p.src ?? 'gps' } : null,
    park: armed && snap.armed?.park ? snap.armed.park : null,
    parkRadius: snap.settings?.parkRadius ?? DEFAULTS.parkRadius,
    text: parts.join(' · '),
  };
}

// Runs from the cron trigger: warns once when an armed device has gone quiet for too long.
// How long the board may stay silent before it counts as out of touch. A board that checks in
// every 15 minutes is allowed two missed check-ins and 5 minutes; an older one its 6-hour
// heartbeat plus the grace time; during an alarm ten tracking reports.
export function contactWindowMs(device, alarm, settings) {
  if (alarm?.active) return settings.trackSeconds * 10_000 + settings.offlineGraceMinutes * 60_000;
  if (device?.checkin > 0) return device.checkin * 2_000 + 5 * 60_000;
  return (settings.heartbeatMinutes + settings.offlineGraceMinutes) * 60_000;
}

export async function checkOffline({ store, now = Date.now(), notify = async () => {} }) {
  const [armed, alarm, device, warned, settings] = await Promise.all([
    store.get('armed'),
    store.get('alarm'),
    store.get('device'),
    store.get('offline_warned'),
    loadSettings(store),
  ]);
  if (!settings.offlineAlert || !armed?.armed || !device?.lastSeen || warned) return false;
  if (now - device.lastSeen <= contactWindowMs(device, alarm, settings)) return false;
  await store.set('offline_warned', now);
  await store.addEvent('offline', {}, now);
  await notify({ title: 'Χάθηκε η επαφή', body: 'Η συσκευή στη μηχανή δεν έχει στείλει τίποτα εδώ και ώρα.', tag: 'moto-offline', urgent: true });
  return true;
}
