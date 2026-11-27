import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ackAlarm,
  alarmSms,
  batteryForecast,
  checkOffline,
  handleReport,
  lastOccurrence,
  normalizePhone,
  quickStatus,
  requestLocate,
  runAutomation,
  setArmed,
  sharedView,
  signalQuality,
  signalView,
  snapshot,
  startShare,
  startSignalTest,
  stopShare,
  stopSignalTest,
  updateSettings,
} from '../src/logic.js';
import { morningText } from '../src/morning.js';
import { MemoryStore } from '../src/store.js';

const PARK = { lat: 37.9838, lon: 23.7275 };
const T0 = Date.UTC(2026, 10, 18, 10, 0, 0);
const min = (n) => n * 60_000;

function setup() {
  const store = new MemoryStore();
  const sent = [];
  const notify = async (payload) => sent.push(payload);
  const report = (r, now) => handleReport({ store, report: r, now, notify });
  return { store, sent, report };
}

test('disarmed: motion is recorded but never raises an alarm', async () => {
  const { store, sent, report } = setup();
  const res = await report({ reason: 'motion', fix: PARK, batt: { pct: 80 } }, T0);
  assert.equal(res.armed, false);
  assert.equal(res.track, false);
  assert.equal(sent.length, 0);
  assert.equal((await snapshot(store, T0)).alarm.active, false);
});

test('armed: motion raises one alarm, repeats after 5 minutes, stops after "seen"', async () => {
  const { store, sent, report } = setup();
  await report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 + min(1) });

  const first = await report({ reason: 'motion', tilt: 14 }, T0 + min(2));
  assert.equal(first.track, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /κουνάει/);

  await report({ reason: 'tracking', moving: true }, T0 + min(3));
  assert.equal(sent.length, 1, 'no repeat within 5 minutes');

  await report({ reason: 'tracking', moving: true }, T0 + min(8));
  assert.equal(sent.length, 2, 'repeats after 5 minutes');

  await ackAlarm({ store, now: T0 + min(9) });
  await report({ reason: 'tracking', moving: true }, T0 + min(20));
  assert.equal(sent.length, 2, 'silent after the owner saw it');
  assert.equal((await snapshot(store)).alarm.active, true, 'tracking continues');
});

test('armed: leaving the parking spot escalates to "moved" with the distance', async () => {
  const { store, sent, report } = setup();
  await report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 });

  await report({ reason: 'motion' }, T0 + min(1));
  const away = { lat: PARK.lat + 0.003, lon: PARK.lon }; // about 330 m north
  await report({ reason: 'tracking', fix: away, moving: true }, T0 + min(2));

  const state = await snapshot(store);
  assert.equal(state.alarm.reason, 'moved');
  assert.equal(sent.length, 2, 'escalation notifies again right away');
  assert.match(sent[1].body, /απομακρύνθηκε 33\d μ\./);
  assert.equal(sent[1].lat, away.lat);
});

test('a small GPS wobble near the parking spot is not a theft', async () => {
  const { store, sent, report } = setup();
  await report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 });
  await report({ reason: 'heartbeat', fix: { lat: PARK.lat + 0.0003, lon: PARK.lon } }, T0 + min(360)); // ~33 m
  assert.equal(sent.length, 0);
  assert.equal((await snapshot(store)).alarm.active, false);
});

test('moved threshold is 50 m by default and widens for inaccurate fixes', async () => {
  const sixtyMetresNorth = { lat: PARK.lat + 0.00054, lon: PARK.lon };

  const precise = setup();
  await precise.report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store: precise.store, armed: true, now: T0 });
  await precise.report({ reason: 'heartbeat', fix: { ...sixtyMetresNorth, acc: 5 } }, T0 + min(1));
  assert.equal((await snapshot(precise.store)).alarm.reason, 'moved', '60 m with ±5 m accuracy is a move');

  const fuzzy = setup();
  await fuzzy.report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store: fuzzy.store, armed: true, now: T0 });
  await fuzzy.report({ reason: 'heartbeat', fix: { ...sixtyMetresNorth, acc: 30 } }, T0 + min(1));
  assert.equal((await snapshot(fuzzy.store)).alarm.active, false, '60 m with ±30 m accuracy is not trusted');
});

test('the moved distance only accepts the offered choices', async () => {
  const { store } = setup();
  assert.equal((await updateSettings(store, { parkRadius: 75 })).parkRadius, 50);
  assert.equal((await updateSettings(store, { parkRadius: 100 })).parkRadius, 100);
  assert.equal((await updateSettings(store, { parkRadius: '30' })).parkRadius, 100, 'strings are ignored');
});

test('disarming ends the alarm and tracking', async () => {
  const { store, report } = setup();
  await report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 });
  await report({ reason: 'motion' }, T0 + min(1));
  await setArmed({ store, armed: false, now: T0 + min(2) });
  const res = await report({ reason: 'tracking', moving: true }, T0 + min(3));
  assert.equal(res.track, false);
  assert.equal((await snapshot(store)).alarm.active, false);
});

test('armed without a known position: the first quiet fix becomes the parking spot', async () => {
  const { store, report } = setup();
  await setArmed({ store, armed: true, now: T0 });
  assert.equal((await snapshot(store)).armed.park, null);
  assert.deepEqual((await snapshot(store)).pending, { locate: T0 }, 'the board is asked where it is');
  await report({ reason: 'heartbeat', fix: PARK }, T0 + min(5));
  assert.deepEqual((await snapshot(store)).armed.park, PARK);
});

test('arming with an old fix: it only stands in, and the fresh position replaces it (2026-11-23)', async () => {
  const { store, report } = setup();
  const spot = { lat: PARK.lat + 0.0008, lon: PARK.lon }; // about 89 m on: moved without a report
  await report({ reason: 'boot', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 + min(9) });
  let snap = await snapshot(store, T0 + min(9));
  assert.deepEqual([snap.armed.park, snap.armed.parkStale], [PARK, true]);
  const checkin = await report({ reason: 'checkin' }, T0 + min(16));
  assert.equal(checkin.locate, true, 'the board is asked where it is');
  const located = await report({ reason: 'locate', fix: { ...spot, acc: 3 } }, T0 + min(17));
  assert.equal(located.locate, false);
  snap = await snapshot(store, T0 + min(17));
  assert.equal(snap.alarm.active, false, 'no "moved" against the old fix');
  assert.deepEqual([snap.armed.park, snap.armed.parkStale], [spot, undefined]);
});

test('arming right after parking takes that fix as it is, without asking the board', async () => {
  const { store, report } = setup();
  await report({ reason: 'parked', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 + min(4) });
  const snap = await snapshot(store, T0 + min(4));
  assert.deepEqual([snap.armed.park, snap.armed.parkStale, snap.pending], [PARK, undefined, {}]);
  assert.equal((await report({ reason: 'checkin' }, T0 + min(10))).locate, false);
});

test('with an old fix standing in, a moving bike far from it is "moved", a still one is not', async () => {
  const { store, report } = setup();
  await report({ reason: 'parked', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 + min(30) });
  await report({ reason: 'motion' }, T0 + min(31));
  await report({ reason: 'track', moving: false, fix: { lat: PARK.lat + 0.0008, lon: PARK.lon, acc: 3 } }, T0 + min(32));
  assert.equal((await snapshot(store, T0 + min(32))).alarm.reason, 'motion', 'a still bike: not "moved"');
  await report({ reason: 'track', moving: true, fix: { lat: PARK.lat + 0.005, lon: PARK.lon, acc: 5 } }, T0 + min(33));
  assert.equal((await snapshot(store, T0 + min(33))).alarm.reason, 'moved');
});

test('"where is it now" stays pending until a newer fix arrives', async () => {
  const { store, report } = setup();
  await requestLocate({ store, now: T0 });
  const before = await report({ reason: 'heartbeat' }, T0 + min(1));
  assert.equal(before.locate, true);
  const after = await report({ reason: 'locate', fix: PARK }, T0 + min(2));
  assert.equal(after.locate, false);
  assert.deepEqual((await snapshot(store)).pending, {});
});

test('low battery warns once per discharge, when two reports in a row agree', async () => {
  const { sent, report } = setup();
  await report({ reason: 'heartbeat', batt: { pct: 14 } }, T0);
  assert.equal(sent.length, 0); // one reading alone may be a dip
  await report({ reason: 'heartbeat', batt: { pct: 12 } }, T0 + min(360));
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /14%/); // the higher of the two
  await report({ reason: 'heartbeat', batt: { pct: 11 } }, T0 + min(380));
  assert.equal(sent.length, 1); // once per discharge
  await report({ reason: 'heartbeat', batt: { pct: 95 } }, T0 + min(720)); // recharged
  await report({ reason: 'heartbeat', batt: { pct: 10 } }, T0 + min(1080));
  await report({ reason: 'heartbeat', batt: { pct: 9 } }, T0 + min(1095));
  assert.equal(sent.length, 2);
});

test('low battery: one low reading between normal ones (a busy modem) does not warn', async () => {
  const { store, sent, report } = setup();
  // 2026-11-20: 42% at a check-in, 9% as the board woke while the modem transmitted, 35% just after.
  await report({ reason: 'checkin', batt: { pct: 42 } }, T0);
  await report({ reason: 'touch', batt: { pct: 9 } }, T0 + min(30));
  await report({ reason: 'motion', batt: { pct: 35 } }, T0 + min(30) + 4000);
  assert.equal(sent.length, 0);
  assert.equal((await store.events(10)).filter((e) => e.type === 'low_battery').length, 0);
});

test('lost-contact warning is off by default and fires once when enabled', async () => {
  const { store, sent, report } = setup();
  await report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 });
  const notify = async (p) => sent.push(p);

  const late = T0 + min(360 + 61);
  assert.equal(await checkOffline({ store, now: late, notify }), false, 'disabled by default');

  await updateSettings(store, { offlineAlert: true });
  assert.equal(await checkOffline({ store, now: T0 + min(300), notify }), false, 'not late yet');
  assert.equal(await checkOffline({ store, now: late, notify }), true);
  assert.equal(await checkOffline({ store, now: late + min(30), notify }), false, 'only once');
  assert.equal(sent.length, 1);

  await report({ reason: 'heartbeat' }, late + min(40));
  assert.equal(await checkOffline({ store, now: late + min(40) + min(360 + 61), notify }), true, 're-armed after contact');
});

test('device clock in the future is ignored in favour of server time', async () => {
  const { store, report } = setup();
  await report({ reason: 'parked', fix: { ...PARK, t: (T0 + min(600)) / 1000 } }, T0);
  assert.equal((await snapshot(store)).position.ts, T0);
});

test('widget status reads naturally with and without contact', async () => {
  const { store, report } = setup();
  assert.equal(quickStatus(await snapshot(store, T0)).text, 'Αφοπλισμένος · καμία επαφή ακόμα');

  await report({ reason: 'parked', fix: PARK, batt: { pct: 82 } }, T0);
  await setArmed({ store, armed: true, now: T0 });
  assert.equal(quickStatus(await snapshot(store, T0 + min(5))).text, 'Οπλισμένος · μπαταρία 82% · επαφή πριν 5 λεπτά');
});

test('phone numbers are kept in international form', () => {
  assert.equal(normalizePhone('69 1234 5678'), '+306912345678');
  assert.equal(normalizePhone('0030 691 234 5678'), '+306912345678');
  assert.equal(normalizePhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone('12'), null);
  assert.equal(normalizePhone('call me'), null);
});

test('every answer tells the device the sensitivity and whether to report touches', async () => {
  const { store, report } = setup();
  let res = await report({ reason: 'heartbeat' }, T0);
  assert.equal(res.sens, 2);
  assert.equal(res.touch, false);
  await updateSettings(store, { sensitivity: 3, touchAlerts: true }, T0);
  res = await report({ reason: 'heartbeat' }, T0 + min(1));
  assert.equal(res.sens, 3);
  assert.equal(res.touch, true);
});

test('parked while disarmed: a reminder by default, nothing, or arming by itself', async () => {
  const { store, sent, report } = setup();
  let res = await report({ reason: 'parked', fix: PARK }, T0);
  assert.equal(res.armed, false);
  assert.equal(sent.at(-1).tag, 'moto-remind');

  await updateSettings(store, { parkAction: 'none' }, T0);
  await report({ reason: 'parked', fix: PARK }, T0 + min(10));
  assert.equal(sent.length, 1, 'no reminder');

  await updateSettings(store, { parkAction: 'arm' }, T0);
  res = await report({ reason: 'parked', fix: PARK }, T0 + min(30));
  assert.equal(res.armed, true);
  assert.equal(sent.at(-1).tag, 'moto-armed');
  assert.deepEqual((await snapshot(store, T0 + min(30))).armed.park, PARK);
  const events = await store.events(5);
  assert.deepEqual(events.map((e) => e.type).slice(0, 2), ['armed', 'parked']);
  assert.equal(events[0].data.by, 'park');
});

test('just parked: arming in the app reaches the board within 2 minutes (2026-11-24)', async () => {
  const { store, sent, report } = setup();
  const parked = await report({ reason: 'parked', fix: PARK, checkin: 900 }, T0);
  assert.equal(parked.checkin, 120, 'every 2 minutes while the owner may still arm');
  assert.equal((await report({ reason: 'checkin', checkin: 120 }, T0 + min(2))).checkin, 120);
  // Armed in the app 3 minutes after parking: the next check-in tells the board, then every 15 minutes.
  await setArmed({ store, armed: true, now: T0 + min(3) });
  const learned = await report({ reason: 'checkin', checkin: 120 }, T0 + min(4));
  assert.deepEqual([learned.armed, learned.checkin], [true, 900]);
  // That report still said "every 2 minutes": the next one 15 minutes later is no lost contact.
  const quiet = await checkOffline({ store, now: T0 + min(4) + min(16), notify: async (p) => sent.push(p) });
  assert.equal(quiet, false);
  assert.ok(!sent.some((p) => p.tag === 'moto-offline'));

  // Left disarmed: back to every 15 minutes, 10 minutes after parking.
  await setArmed({ store, armed: false, now: T0 + min(30) });
  await report({ reason: 'parked', fix: PARK }, T0 + min(40));
  assert.equal((await report({ reason: 'checkin', checkin: 120 }, T0 + min(48))).checkin, 120);
  assert.equal((await report({ reason: 'checkin', checkin: 120 }, T0 + min(50.5))).checkin, 900);

  // «Χαμηλή κατανάλωση»: no extra check-ins.
  await updateSettings(store, { lowPower: true }, T0 + min(60));
  assert.equal((await report({ reason: 'parked', fix: PARK }, T0 + min(70))).checkin, 1800);
});

test('light touches: a quiet notification only when asked, at most every 10 minutes', async () => {
  const { store, sent, report } = setup();
  await report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 });
  sent.length = 0;
  await report({ reason: 'touch' }, T0 + min(1));
  assert.equal(sent.length, 0, 'off by default');

  await updateSettings(store, { touchAlerts: true }, T0);
  const res = await report({ reason: 'touch' }, T0 + min(2));
  assert.equal(res.track, false, 'a touch is not an alarm');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].urgent, undefined);
  await report({ reason: 'touch' }, T0 + min(5));
  assert.equal(sent.length, 1, 'not again within 10 minutes');
  await report({ reason: 'touch' }, T0 + min(13));
  assert.equal(sent.length, 2);
});

test('the device texts the phone when the alarm starts, again every 10 minutes, until seen', async () => {
  const { store, report } = setup();
  await report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 });
  let res = await report({ reason: 'motion' }, T0 + min(1));
  assert.equal(res.sms, undefined, 'no number, no SMS');

  await setArmed({ store, armed: false, now: T0 + min(2) });
  await updateSettings(store, { callNumber: '6912345678' }, T0);
  await setArmed({ store, armed: true, now: T0 + min(3) });
  res = await report({ reason: 'motion' }, T0 + min(4));
  assert.deepEqual(res.sms, { to: '+306912345678', text: 'Συναγερμός μηχανής: κάποιος την κουνάει!' });
  res = await report({ reason: 'track', moving: true, fix: PARK }, T0 + min(5));
  assert.equal(res.sms, undefined, 'not again so soon');
  res = await report({ reason: 'track', moving: true, fix: { lat: 37.99, lon: 23.73 } }, T0 + min(15));
  assert.equal(res.sms.text, 'Συναγερμός: μετακινήθηκε! maps.apple.com/?q=37.99000,23.73000');
  await ackAlarm({ store, now: T0 + min(16) });
  res = await report({ reason: 'track', moving: true }, T0 + min(30));
  assert.equal(res.sms, undefined, 'seen: no more SMS');
  assert.equal(res.track, true, 'tracking goes on');
  assert.equal((await store.events(10)).filter((e) => e.type === 'sms').length, 2);
});

test('alarm SMS always fits in one Greek SMS (70 characters)', () => {
  for (const reason of ['motion', 'moved', 'tamper']) {
    for (const fix of [null, { lat: 37.98381, lon: 23.72754 }, { lat: -33.86882, lon: -151.20929 }]) {
      assert.ok(alarmSms(reason, fix).length <= 70, `${reason} ${JSON.stringify(fix)}`);
    }
  }
});
test('schedule times are Greek time, in winter and in summer', () => {
  // 18 Nov 2026 is winter time (UTC+2): 23:00 in Athens is 21:00 UTC.
  assert.equal(lastOccurrence('23:00', Date.UTC(2026, 10, 18, 22, 0)), Date.UTC(2026, 10, 18, 21, 0));
  assert.equal(lastOccurrence('23:00', Date.UTC(2026, 10, 18, 20, 0)), Date.UTC(2026, 10, 17, 21, 0));
  // 1 Jul 2026 is summer time (UTC+3).
  assert.equal(lastOccurrence('07:00', Date.UTC(2026, 6, 1, 5, 0)), Date.UTC(2026, 6, 1, 4, 0));
  // 29 Mar 2026: the clocks go forward at 03:00, so 07:00 is already summer time.
  assert.equal(lastOccurrence('07:00', Date.UTC(2026, 2, 29, 12, 0)), Date.UTC(2026, 2, 29, 4, 0));
});

test('the daily schedule arms and disarms once, at the set times', async () => {
  const { store, sent } = setup();
  const notify = async (p) => sent.push(p);
  const evening = Date.UTC(2026, 10, 18, 20, 0); // 22:00 in Athens
  await updateSettings(store, { schedule: { on: true, arm: '23:00', disarm: '07:00' } }, evening);
  assert.equal(await runAutomation({ store, now: evening + min(30), notify }), null, 'not 23:00 yet');
  assert.equal(await runAutomation({ store, now: evening + min(65), notify }), 'arm');
  assert.equal((await snapshot(store)).armed.armed, true);
  assert.equal(await runAutomation({ store, now: evening + min(70), notify }), null, 'only once');

  const morning = Date.UTC(2026, 10, 19, 5, 5); // 07:05 in Athens
  assert.equal(await runAutomation({ store, now: morning, notify }), 'disarm');
  assert.equal((await snapshot(store)).armed.armed, false);
  const events = await store.events(2);
  assert.deepEqual(events.map((e) => [e.type, e.data.by]), [['disarmed', 'schedule'], ['armed', 'schedule']]);
});

test('riding at arming time: it arms when you park', async () => {
  const { store, sent, report } = setup();
  const notify = async (p) => sent.push(p);
  const evening = Date.UTC(2026, 10, 18, 20, 0);
  await updateSettings(store, { schedule: { on: true, arm: '23:00', disarm: '' }, parkAction: 'none' }, evening);
  await report({ reason: 'ride', fix: PARK, moving: true }, evening + min(55));
  assert.equal(await runAutomation({ store, now: evening + min(62), notify }), 'arm');
  const snap = await snapshot(store);
  assert.equal(snap.armed.armed, false, 'not while riding');
  assert.equal(snap.armOnPark, true);
  assert.equal(sent.at(-1).body, 'Η μηχανή μόλις κουνήθηκε. Θα οπλίσει μόλις μείνει ακίνητη για 3 λεπτά.', 'the GPS saw it go nowhere');
  const res = await report({ reason: 'parked', fix: PARK }, evening + min(80));
  assert.equal(res.armed, true);
});

test('riding at arming time, and the GPS saw the bike go: «Οδηγείς τώρα»', async () => {
  const { store, sent, report } = setup();
  const notify = async (p) => sent.push(p);
  const evening = Date.UTC(2026, 10, 18, 20, 0);
  await updateSettings(store, { schedule: { on: true, arm: '23:00', disarm: '' }, parkAction: 'none' }, evening);
  const t = Math.floor((evening + min(55)) / 1000);
  const pts = [0, 1, 2, 3, 4].map((i) => [t + i * 3, PARK.lat + i * 0.00045, PARK.lon, 60]); // 50 m every 3 s
  await report({ reason: 'ride', moving: true, pts }, evening + min(55) + 15_000);
  assert.equal(await runAutomation({ store, now: evening + min(62), notify }), 'arm');
  assert.equal((await snapshot(store)).armed.armed, false);
  assert.equal(sent.at(-1).body, 'Οδηγείς τώρα. Θα οπλίσει μόλις παρκάρεις.');
});

test('the schedule never disarms during an alarm', async () => {
  const { store, sent, report } = setup();
  const notify = async (p) => sent.push(p);
  const night = Date.UTC(2026, 10, 18, 23, 0); // 01:00 in Athens
  await report({ reason: 'parked', fix: PARK }, night);
  await setArmed({ store, armed: true, now: night });
  await updateSettings(store, { schedule: { on: true, arm: '', disarm: '07:00' } }, night);
  await report({ reason: 'motion' }, night + min(5));
  assert.equal(await runAutomation({ store, now: Date.UTC(2026, 10, 19, 5, 1), notify }), 'disarm');
  assert.equal((await snapshot(store)).armed.armed, true);
  assert.equal(sent.at(-1).title, 'Δεν αφοπλίστηκε');
});

test('battery forecast uses the readings since the last charge', () => {
  const day = 86_400_000;
  const log = [[T0 - 10 * day, 40], [T0 - 6 * day, 100], [T0 - 4 * day, 96], [T0 - 2 * day, 92], [T0, 88]];
  const forecast = batteryForecast(log, T0); // 2% a day from 88%, and the board stops near 5%
  assert.equal(forecast.text, 'περίπου 6 εβδομάδες');
  assert.ok(Math.abs(forecast.days - 41.5) < 0.6);
  assert.equal(batteryForecast([[T0 - day, 90], [T0 - day / 2, 89], [T0, 88]], T0), null, 'needs two days');
});

test('a live location link shows where the bike is, until it expires', async () => {
  const { store, report } = setup();
  await report({ reason: 'parked', fix: PARK }, T0);
  const share = await startShare({ store, token: 'tok', hours: 1, now: T0 });
  await report({ reason: 'ride', fix: { lat: 37.99, lon: 23.73 } }, T0 + min(10));
  const view = await sharedView({ store, share, now: T0 + min(11) });
  assert.deepEqual([view.position.lat, view.position.lon], [37.99, 23.73]);
  assert.equal(view.trail.length, 2);
  assert.equal(view.settings, undefined, 'nothing else about the alarm');
  assert.equal((await snapshot(store, T0 + min(61))).share, null, 'expired');
  await stopShare({ store, now: T0 + min(62) });
  assert.equal((await store.events(1))[0].type, 'share_stop');
});

test('widget status carries the map position, signal and battery forecast', async () => {
  const { store, report } = setup();
  await report({ reason: 'parked', fix: PARK, rssi: -88, batt: { pct: 70 } }, T0);
  await setArmed({ store, armed: true, now: T0 });
  const status = quickStatus(await snapshot(store, T0 + min(1)));
  assert.deepEqual([status.position.lat, status.position.lon], [PARK.lat, PARK.lon]);
  assert.deepEqual(status.park, PARK);
  assert.equal(status.parkRadius, 50);
  assert.equal(status.signal, 'μέτριο');
  assert.equal(status.bars, 2);
  assert.equal(status.battery, 70);
  assert.equal(status.charging, false);
});

test('widget status on USB says "charging" instead of a percentage', async () => {
  const { store, report } = setup();
  await report({ reason: 'parked', fix: PARK, batt: { pct: 40, mv: 3740 }, ext: false }, T0);
  await report({ reason: 'checkin', batt: { mv: 3871, pct: 66, src: 'modem', adc: 284 }, ext: true }, T0 + min(5));
  const status = quickStatus(await snapshot(store, T0 + min(6)));
  assert.equal(status.charging, true);
  assert.equal(status.battery, null);
  assert.equal(status.forecast, null);
  assert.equal(status.text, 'Αφοπλισμένος · φορτίζει · επαφή πριν 1 λεπτό');
});

test('the loud Pushover alarm goes out once per alarm, again when the bike leaves, and stops when seen', async () => {
  const { store } = setup();
  const sent = [];
  const cancelled = [];
  const emergency = async (p) => {
    sent.push(p);
    return `r${sent.length}`;
  };
  const cancel = async (receipt) => cancelled.push(receipt);
  const report = (r, now) => handleReport({ store, report: r, now, emergency });

  await report({ reason: 'heartbeat', fix: PARK }, T0);
  await setArmed({ store, armed: true, now: T0 });
  await report({ reason: 'motion' }, T0 + min(1));
  await report({ reason: 'track', moving: true }, T0 + min(2));
  assert.equal(sent.length, 1, 'once, not on every report');
  assert.equal(sent[0].title, 'ΣΥΝΑΓΕΡΜΟΣ ΜΗΧΑΝΗΣ');
  assert.equal(sent[0].replaces, null);

  await report({ reason: 'track', fix: { lat: PARK.lat + 0.003, lon: PARK.lon } }, T0 + min(3));
  assert.equal(sent.length, 2, 'again when it leaves the parking spot');
  assert.equal(sent[1].replaces, 'r1', 'replacing the first one');
  assert.match(sent[1].message, /απομακρύνθηκε/);

  assert.equal(await ackAlarm({ store, receipt: 'r1', now: T0 + min(4) }), false, 'an old alert does not count');
  assert.equal(await ackAlarm({ store, cancel, now: T0 + min(5) }), true);
  assert.deepEqual(cancelled, ['r2'], 'seen in the app: Pushover stops repeating');
});

test('acknowledging in Pushover counts as seen, and disarming stops an unseen Pushover alarm', async () => {
  const { store } = setup();
  const cancelled = [];
  const emergency = async () => 'r1';
  await handleReport({ store, report: { reason: 'heartbeat', fix: PARK }, now: T0, emergency });
  await setArmed({ store, armed: true, now: T0 });
  await handleReport({ store, report: { reason: 'motion' }, now: T0 + min(1), emergency });
  assert.equal(await ackAlarm({ store, receipt: 'r1', now: T0 + min(2) }), true);
  assert.equal((await snapshot(store)).alarm.acked, true);
  assert.equal((await store.events(1))[0].data.via, 'pushover');

  await setArmed({ store, armed: true, now: T0 + min(3) });
  await handleReport({ store, report: { reason: 'motion' }, now: T0 + min(4), emergency });
  await setArmed({ store, armed: false, now: T0 + min(5), cancel: async (r) => cancelled.push(r) });
  assert.deepEqual(cancelled, ['r1']);
});

test('signal test: every report is logged, and during the test the device reports every 2 minutes', async () => {
  const { store, report } = setup();
  const net = { op: 'COSMOTE', tech: 'LTE', rsrp: -104, rsrq: -12, snr: 2, reg: 25 };
  let res = await report({ reason: 'heartbeat', fix: PARK, rssi: -95, net, fails: 2 }, T0);
  assert.equal(res.heartbeat, 6 * 3600);
  const last = (await snapshot(store, T0)).signal.last;
  assert.deepEqual([last.op, last.tech, last.rsrp, last.reg, last.fails], ['COSMOTE', 'LTE', -104, 25, 2]);

  await startSignalTest({ store, minutes: 60, now: T0 + min(1) });
  res = await report({ reason: 'heartbeat', rssi: -97 }, T0 + min(2));
  assert.equal(res.heartbeat, 120, 'every 2 minutes during the test');
  assert.equal((await snapshot(store, T0 + min(2))).signal.test, T0 + min(61));

  res = await report({ reason: 'heartbeat' }, T0 + min(62));
  assert.equal(res.heartbeat, 6 * 3600, 'back to normal when the hour is over');

  await startSignalTest({ store, minutes: 30, now: T0 + min(70) });
  await stopSignalTest({ store });
  res = await report({ reason: 'heartbeat' }, T0 + min(71));
  assert.equal(res.heartbeat, 6 * 3600, 'and when stopped');

  const view = await signalView({ store, now: T0 + min(72) });
  assert.equal(view.test, null);
  assert.equal(view.log.length, 4);
  assert.equal(view.log[0].ts, T0 + min(71), 'newest first');
});

test('on USB the modem voltage is kept for diagnosis, not as a charge, and a warm modem is logged', async () => {
  const { store, report } = setup();
  // 2026-11-20: a flat battery on a charger, and the modem said 3.871 V (66%) for over an hour.
  await report({ reason: 'motion', ext: true, batt: { mv: 3871, pct: 66, src: 'modem', adc: 284 }, net: { op: 'NOVA', reg: 0, warm: true } }, T0);
  const device = await store.get('device');
  assert.deepEqual(device.batt, { pct: null, mv: null, modemMv: 3871, adc: 284 });
  assert.equal((await store.get('batt_log')) ?? null, null, 'not a reading of the battery');
  assert.equal((await store.get('signal_last')).warm, true);
  await report({ reason: 'heartbeat', batt: { adc: 0 }, net: { op: 'NOVA', reg: 40 } }, T0 + min(5));
  assert.deepEqual((await store.get('device')).batt, { pct: null, mv: null, adc: 0 });
  assert.equal((await store.get('signal_last')).warm, false);
  await report({ reason: 'motion', via: 'wifi', batt: { adc: 0 } }, T0 + min(6));
  assert.equal((await store.get('signal_last')).via, 'wifi');
});

test('«Χαμηλή κατανάλωση»: a check-in every half hour, a ride report every minute, the modem off while parked', async () => {
  const { store, report } = setup();
  let res = await report({ reason: 'checkin', ext: false }, T0);
  assert.deepEqual([res.checkin, res.rideInterval, res.eco], [900, 15, false]);
  res = await report({ reason: 'checkin', ext: true }, T0 + min(1));
  assert.equal(res.checkin, 300, 'on the bike\'s power every 5 minutes');

  await updateSettings(store, { lowPower: true }, T0 + min(2));
  res = await report({ reason: 'checkin', ext: true }, T0 + min(3));
  assert.deepEqual([res.checkin, res.rideInterval, res.eco], [1800, 60, true], 'also on the bike\'s power');
  await report({ reason: 'checkin', ext: false, eco: true, checkin: 1800 }, T0 + min(4));
  let snap = await snapshot(store, T0 + min(5));
  assert.equal(snap.device.eco, true, 'the board says it keeps it');
  assert.equal(snap.contactMs, 1800 * 2000 + 5 * 60_000, 'lost contact counts after about an hour');

  await report({ reason: 'motion', moving: true, eco: true }, T0 + min(6));
  const t6 = Math.floor((T0 + min(6)) / 1000);
  const pts = [0, 1, 2, 3, 4].map((i) => [t6 + i * 3, 37.98 + i * 0.00045, 23.72, 60]); // 50 m every 3 s
  await report({ reason: 'ride', moving: true, eco: true, pts }, T0 + min(6) + 15_000);
  snap = await snapshot(store, T0 + min(6) + 15_000);
  assert.equal(snap.ride.every, 60, 'the ride card knows the board reports every minute');

  await updateSettings(store, { lowPower: 'yes' }, T0 + min(7));
  assert.equal((await snapshot(store, T0 + min(7))).settings.lowPower, true, 'only true or false changes it');
  await updateSettings(store, { lowPower: false }, T0 + min(8));
  res = await report({ reason: 'checkin', ext: false }, T0 + min(9));
  assert.deepEqual([res.checkin, res.rideInterval, res.eco], [900, 15, false], 'back to normal');
});

test('Wi-Fi: a 4G report says why the Wi-Fi did not work, a report over Wi-Fi clears it', async () => {
  const { store, report } = setup();
  await report({ reason: 'checkin', wfail: { k: 'password', n: 'Kafe', s: -61, c: 15, seen: 9 } }, T0);
  let wifi = (await snapshot(store, T0 + min(1))).wifi;
  assert.equal(wifi.via, '4g');
  assert.equal(wifi.at, T0);
  assert.deepEqual(wifi.fail, { k: 'password', n: 'Kafe', s: -61, c: 15, seen: 9 });
  await report({ reason: 'checkin', wfail: { k: 'nonsense', n: 'Kafe' } }, T0 + min(5));
  assert.equal((await snapshot(store, T0 + min(6))).wifi.fail, null, 'an unknown reason is dropped');
  await report({ reason: 'checkin', via: 'wifi', wnet: 'Kafe', wrssi: -60, wfail: { k: 'password' } }, T0 + min(10));
  wifi = (await snapshot(store, T0 + min(11))).wifi;
  assert.deepEqual([wifi.via, wifi.name, wifi.rssi, wifi.fail], ['wifi', 'Kafe', -60, null]);
});

test('Wi-Fi: the 4G report keeps what the networks of the last two times answered (firmware 1.8.7)', async () => {
  const { store, report } = setup();
  await report({ reason: 'checkin', wfail: { k: 'notfound', seen: 11, kr: [201, 0, 7] } }, T0);
  const fail = (await snapshot(store, T0 + min(1))).wifi.fail;
  assert.deepEqual(fail, { k: 'notfound', n: null, s: null, c: null, seen: 11, kr: [201, 0] });
});

test('4G signal: the cell power decides, a noisy network pulls it down, the plain strength stands in', () => {
  // The parking spot on 2026-11-23 at 21:19, where the plain strength alone said «καλό».
  assert.deepEqual(signalQuality({ rssi: -55, rsrp: -92.2, rsrq: -20, snr: 5 }), { word: 'αδύναμο', bars: 1, noisy: true });
  assert.deepEqual(signalQuality({ rssi: -51, rsrp: -70.1, rsrq: -14.1, snr: 9 }), { word: 'καλό', bars: 4, noisy: false });
  assert.deepEqual(signalQuality({ rsrp: -82, rsrq: -18.2 }), { word: 'μέτριο', bars: 2, noisy: true });
  assert.deepEqual(signalQuality({ rsrp: -99.4, rsrq: -14.9, snr: 9 }), { word: 'μέτριο', bars: 2, noisy: false });
  assert.deepEqual(signalQuality({ rsrp: -86, rsrq: -11, snr: -3 }), { word: 'αδύναμο', bars: 1, noisy: true });
  assert.deepEqual(signalQuality({ rsrp: -118 }), { word: 'πολύ αδύναμο', bars: 0, noisy: false });
  assert.deepEqual(signalQuality({ rssi: -88 }), { word: 'μέτριο', bars: 2, noisy: false });
  assert.equal(signalQuality({}), null);
  assert.equal(signalQuality(null), null);
});

test('widget status judges 4G by the modem reading of the last report', async () => {
  const { store, report } = setup();
  await report({ reason: 'checkin', rssi: -55, net: { op: 'vodafone GR iotsim.gr', tech: 'LTE', rsrp: -922, rsrq: -200, snr: 5 } }, T0);
  const snap = await snapshot(store, T0 + min(1));
  assert.deepEqual(snap.signal.last.quality, { word: 'αδύναμο', bars: 1, noisy: true });
  const status = quickStatus(snap);
  assert.deepEqual([status.signal, status.bars, status.rssi], ['αδύναμο', 1, -55]);
});

test('armed: movement that begins after "seen" sounds the alarm again, ongoing movement does not', async () => {
  const { store, sent } = setup();
  await setArmed({ store, armed: true, now: T0 });
  const pushover = [];
  const emergency = async (p) => (pushover.push(p), `r${pushover.length}`);
  const rep = (r, now) => handleReport({ store, report: r, now, notify: async (p) => sent.push(p), emergency });
  const sec = (ms) => Math.floor(ms / 1000);

  await rep({ reason: 'motion', moving: true, movingSince: sec(T0 + min(1)) }, T0 + min(1));
  assert.equal(pushover.length, 1);
  await ackAlarm({ store, now: T0 + min(2) });

  // The movement that was going on when "seen" was pressed: quiet.
  await rep({ reason: 'track', moving: true, movingSince: sec(T0 + min(1)) }, T0 + min(2) + 30_000);
  assert.equal(pushover.length, 1);
  assert.equal(sent.length, 1);

  // New movement 4 seconds after "seen", stamped by a board clock a second behind: alarm again.
  await rep({ reason: 'track', moving: true, movingSince: sec(T0 + min(2) + 3_000) }, T0 + min(2) + 40_000);
  assert.equal(pushover.length, 2);
  assert.equal(sent.length, 2);
  assert.equal((await snapshot(store, T0 + min(3))).alarm.acked, false);
  assert.equal((await store.events(1))[0].data.again, true);

  // Seen again; the same movement keeps going: no third alarm.
  await ackAlarm({ store, now: T0 + min(3) });
  await rep({ reason: 'track', moving: true, movingSince: sec(T0 + min(2) + 3_000) }, T0 + min(3) + 30_000);
  assert.equal(pushover.length, 2);
});

test('armed again while the board still tracks: the movement it already reported does not start a new alarm', async () => {
  const { store, sent } = setup();
  await setArmed({ store, armed: true, now: T0 });
  const pushover = [];
  const emergency = async (p) => (pushover.push(p), `r${pushover.length}`);
  const rep = (r, now) => handleReport({ store, report: r, now, notify: async (p) => sent.push(p), emergency });
  const sec = (ms) => Math.floor(ms / 1000);

  await rep({ reason: 'motion', moving: true, movingSince: sec(T0 + min(1)) }, T0 + min(1));
  assert.equal(pushover.length, 1);
  // Off and on again from the phone within seconds: the board has not heard and still tracks,
  // with movement from before the arming.
  await setArmed({ store, armed: false, now: T0 + min(2) });
  await setArmed({ store, armed: true, now: T0 + min(2) + 4_000 });
  const res = await rep({ reason: 'track', moving: true, movingSince: sec(T0 + min(1) + 50_000) }, T0 + min(2) + 15_000);
  assert.equal(pushover.length, 1, 'no new alarm');
  assert.equal((await snapshot(store, T0 + min(3))).alarm.active, false);
  assert.equal(res.track, false, 'the board stops tracking and watches the bike afresh');

  // Movement that begins after arming still does.
  await rep({ reason: 'track', moving: true, movingSince: sec(T0 + min(2) + 20_000) }, T0 + min(2) + 25_000);
  assert.equal(pushover.length, 2);
});

test('4G signal: the modem tenths become dBm, also in readings stored before the fix', async () => {
  const { store, report } = setup();
  await report({ reason: 'heartbeat', net: { op: 'COSMOTE', tech: 'LTE', rsrp: -1084, rsrq: -194, snr: 6 } }, T0);
  const last = (await snapshot(store, T0)).signal.last;
  assert.deepEqual([last.rsrp, last.rsrq, last.snr], [-108.4, -19.4, 6]);

  // An entry logged the old way, still in tenths.
  const log = await store.get('signal_log');
  log.push({ ...log[0], ts: T0 + min(1), rsrp: -914, rsrq: -200 });
  await store.set('signal_log', log);
  const view = await signalView({ store, now: T0 + min(2) });
  assert.deepEqual([view.log[0].rsrp, view.log[0].rsrq], [-91.4, -20]);
  assert.deepEqual([view.log[1].rsrp, view.log[1].rsrq], [-108.4, -19.4], 'already in dBm: left alone');
});

test('a board that started afresh is kept in the history with the reason', async () => {
  const { store, report } = setup();
  await report({ reason: 'boot', rst: 9 }, T0);
  assert.deepEqual((await store.events(1))[0].data, { rst: 9 });
  await report({ reason: 'heartbeat' }, T0 + min(1));
  assert.equal((await store.events(5)).filter((e) => e.type === 'restart').length, 1);
});

test('check-ins: how the board got through is kept, and silence counts from its check-in rhythm', async () => {
  const { store, report, sent } = setup();
  await setArmed({ store, armed: true, now: T0 });
  const reply = await report({ reason: 'checkin', via: 'wifi', wnet: 'Neighbour', wrssi: -71, checkin: 900 }, T0);
  assert.equal(reply.checkin, 15 * 60, 'the board is told how often to check in');
  const device = await store.get('device');
  assert.deepEqual([device.via, device.wifiName, device.wifiRssi, device.checkin], ['wifi', 'Neighbour', -71, 900]);
  assert.equal((await store.get('signal_log')) ?? null, null, 'check-ins stay out of the signal history');

  const snap = await snapshot(store, T0);
  assert.equal(snap.contactMs, 35 * 60_000);
  await updateSettings(store, { offlineAlert: true });
  assert.equal(await checkOffline({ store, now: T0 + min(34), notify: async (p) => sent.push(p) }), false);
  assert.equal(await checkOffline({ store, now: T0 + min(36), notify: async (p) => sent.push(p) }), true, 'two missed check-ins');

  await report({ reason: 'checkin', checkin: 900, rssi: -80 }, T0 + min(40));
  const over4g = await store.get('device');
  assert.deepEqual([over4g.via, over4g.wifiName, over4g.wifiRssi], ['4g', null, null]);
});

test('bike power: cut while armed sounds the alarm, cut while disarmed tells quietly, both logged', async () => {
  const { store, sent } = setup();
  const pushover = [];
  const emergency = async (p) => (pushover.push(p), `r${pushover.length}`);
  const rep = (r, now) => handleReport({ store, report: r, now, notify: async (p) => sent.push(p), emergency });

  // On the bike's power: check in more often.
  const first = await rep({ reason: 'checkin', ext: true, checkin: 900 }, T0);
  assert.equal(first.checkin, 5 * 60);

  await setArmed({ store, armed: true, now: T0 + min(1) });
  await rep({ reason: 'power_lost', ext: false }, T0 + min(2));
  assert.equal(pushover.length, 1, 'loud alarm');
  assert.match(pushover[0].message, /ρεύμα/);
  assert.equal((await snapshot(store, T0 + min(2))).alarm.reason, 'power');
  assert.ok((await store.events(5)).some((e) => e.type === 'power_lost'));

  await rep({ reason: 'checkin', ext: false }, T0 + min(3));
  assert.equal(pushover.length, 1, 'once');

  await rep({ reason: 'power_back', ext: true }, T0 + min(4));
  assert.ok((await store.events(5)).some((e) => e.type === 'power_back'));

  await setArmed({ store, armed: false, now: T0 + min(5) });
  const before = sent.length;
  await rep({ reason: 'power_lost', ext: false }, T0 + min(6));
  assert.equal(pushover.length, 1, 'no loud alarm when disarmed');
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).tag, 'moto-power');
});

test('bike power on the key: the key turned off is said nowhere, armed or not (2026-11-26)', async () => {
  const { store, sent } = setup();
  const pushover = [];
  const emergency = async (p) => (pushover.push(p), `r${pushover.length}`);
  const rep = (r, now) => handleReport({ store, report: r, now, notify: async (p) => sent.push(p), emergency });
  await updateSettings(store, { bikePower: 'key' });
  await updateSettings(store, { bikePower: 'sometimes' });
  assert.equal((await snapshot(store, T0)).settings.bikePower, 'key', 'only the two choices');

  // A ride with the key on, then the key off: the board starts afresh as the voltage dips.
  await rep({ reason: 'ride', ext: true }, T0);
  await rep({ reason: 'boot', ext: false, rst: 9 }, T0 + min(1));
  const events = await store.events(5);
  assert.deepEqual(events.find((e) => e.type === 'power_lost').data, { key: true });
  assert.deepEqual(events.find((e) => e.type === 'restart').data, { rst: 9, key: true });

  await rep({ reason: 'power_back', ext: true }, T0 + min(2));
  const back = (await store.events(1))[0];
  assert.deepEqual([back.type, back.data], ['power_back', { key: true }]);
  // Armed while the key is still on, then the key off: no alarm.
  await setArmed({ store, armed: true, now: T0 + min(3) });
  await rep({ reason: 'power_lost', ext: false }, T0 + min(4));
  assert.equal(pushover.length, 0, 'no loud alarm');
  assert.equal((await snapshot(store, T0 + min(4))).alarm.active, false);
  assert.equal(sent.filter((p) => p.tag === 'moto-power' || p.tag === 'moto-alarm').length, 0, 'no push either');

  // The morning summary counts restarts, but not the one at the key-off.
  assert.doesNotMatch((await morningText({ store, since: T0 - 1, now: T0 + min(5) })).body, /επανεκκίνηση/);
  await rep({ reason: 'boot', ext: false, rst: 1 }, T0 + min(6));
  assert.match((await morningText({ store, since: T0 - 1, now: T0 + min(7) })).body, /1 επανεκκίνηση πλακέτας/);
});

test('bike power: a board without the field (older firmware) never counts as a power cut', async () => {
  const { store, sent } = setup();
  await setArmed({ store, armed: true, now: T0 });
  await handleReport({ store, report: { reason: 'checkin' }, now: T0 + min(1), notify: async (p) => sent.push(p) });
  await handleReport({ store, report: { reason: 'checkin', ext: false }, now: T0 + min(2), notify: async (p) => sent.push(p) });
  assert.equal((await snapshot(store, T0 + min(2))).alarm.active, false);
});

test('no motion sensor: armed, every check-in asks for a position, every 5 minutes (2026-11-24)', async () => {
  const { store, sent, report } = setup();
  await report({ reason: 'heartbeat', fix: PARK }, T0);
  const ok = await report({ reason: 'checkin' }, T0 + min(1));
  assert.deepEqual([ok.locate, ok.checkin], [false, 900]);

  // Disarmed: a warning, but no positions asked for.
  const off = await report({ reason: 'checkin', sensor: 'missing' }, T0 + min(2));
  assert.deepEqual([off.locate, off.checkin], [false, 900]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /αισθητήρας κίνησης δεν απαντά/);
  assert.equal((await snapshot(store, T0 + min(2))).device.sensor, 'missing');

  await setArmed({ store, armed: true, now: T0 + min(3) });
  const armedCheckin = await report({ reason: 'checkin', sensor: 'missing' }, T0 + min(4));
  assert.deepEqual([armedCheckin.locate, armedCheckin.checkin], [true, 300]);
  // The position comes back where it was parked: nothing. Then 200 m away: "moved".
  const here = await report({ reason: 'locate', sensor: 'missing', fix: PARK }, T0 + min(4.5));
  assert.equal(here.locate, false);
  assert.equal((await snapshot(store, T0 + min(5))).alarm.active, false);
  await report({ reason: 'checkin', sensor: 'missing' }, T0 + min(9));
  const away = await report({ reason: 'locate', sensor: 'missing', fix: { lat: PARK.lat + 0.0018, lon: PARK.lon } }, T0 + min(9.5));
  assert.equal(away.track, true);
  assert.equal((await snapshot(store, T0 + min(10))).alarm.reason, 'moved');
  assert.equal(sent.filter((p) => /αισθητήρας/.test(p.title)).length, 1, 'warned once');
});

test('an old position at a bike standing still is no worry, one after it moved is (2026-11-24)', async () => {
  const { store, report } = setup();
  const doubt = async (at) => (await snapshot(store, at)).device.mayHaveMoved;
  // Parked at T0, then 45 minutes of check-ins and a touch: all without GPS, by design.
  await report({ reason: 'parked', fix: PARK }, T0);
  await report({ reason: 'checkin' }, T0 + min(15));
  await report({ reason: 'touch', tilt: 1 }, T0 + min(20));
  await report({ reason: 'checkin' }, T0 + min(30));
  // «Πού είναι τώρα» under a roof: no GPS, yet the board felt no movement.
  await report({ reason: 'locate' }, T0 + min(31));
  await report({ reason: 'checkin' }, T0 + min(45));
  assert.equal(await doubt(T0 + min(45)), null);

  // It felt the bike move: the old position may be wrong until a new one comes, check-ins or not.
  await report({ reason: 'motion' }, T0 + min(50));
  await report({ reason: 'checkin' }, T0 + min(65));
  assert.equal(await doubt(T0 + min(65)), T0 + min(50));
  await report({ reason: 'ride', pts: [[Math.floor((T0 + min(66)) / 1000), PARK.lat + 0.01, PARK.lon, 40]] }, T0 + min(66));
  assert.equal(await doubt(T0 + min(66)), null);

  // A restart (it was off) without a fix, and any report while the motion sensor is missing.
  await report({ reason: 'boot' }, T0 + min(70));
  assert.equal(await doubt(T0 + min(70)), T0 + min(70));
  await report({ reason: 'heartbeat', fix: PARK }, T0 + min(71));
  await report({ reason: 'checkin', sensor: 'missing' }, T0 + min(80));
  await report({ reason: 'checkin' }, T0 + min(95));
  assert.equal(await doubt(T0 + min(95)), T0 + min(80), 'the sensor back does not say where the bike went meanwhile');
});

test('a motion sensor that lost its settings goes in the history, with a push at most once a day (1.8.8)', async () => {
  const { store, sent, report } = setup();
  await report({ reason: 'checkin' }, T0);
  assert.equal((await store.events(5)).filter((e) => e.type === 'sensor_reset').length, 0);
  await report({ reason: 'checkin', ar: 2 }, T0 + min(15));
  await report({ reason: 'checkin', ar: 1 }, T0 + min(30));
  const resets = (await store.events(10)).filter((e) => e.type === 'sensor_reset');
  assert.deepEqual(resets.map((e) => e.data.n), [1, 2]);
  assert.deepEqual(sent.map((p) => p.title), ['Ο αισθητήρας κίνησης έχασε τη ρύθμισή του']);
  await report({ reason: 'checkin', ar: 1 }, T0 + min(15) + 24 * 3_600_000);
  assert.equal(sent.length, 2, 'again the next day');
});

test('the sensor\'s wake-up wire making poor contact goes in the history, with a push at most once a day (1.8.9)', async () => {
  const { store, sent, report } = setup();
  await report({ reason: 'checkin', ig: 1 }, T0);
  await report({ reason: 'checkin', im: 2 }, T0 + min(15));
  const wire = (await store.events(10)).filter((e) => e.type === 'sensor_wire');
  assert.deepEqual(wire.map((e) => e.data), [{ ghost: 0, missed: 2 }, { ghost: 1, missed: 0 }]);
  assert.deepEqual(sent.map((p) => p.tag), ['moto-sensor-wire']);
  await report({ reason: 'checkin' }, T0 + min(30));
  assert.equal((await store.events(10)).filter((e) => e.type === 'sensor_wire').length, 2, 'nothing when all is well');
});

test('the motion sensor answering again is told once', async () => {
  const { sent, report } = setup();
  await report({ reason: 'checkin' }, T0);
  await report({ reason: 'checkin', sensor: 'missing' }, T0 + min(15));
  await report({ reason: 'checkin', sensor: 'missing' }, T0 + min(30));
  await report({ reason: 'checkin' }, T0 + min(45));
  await report({ reason: 'checkin' }, T0 + min(60));
  assert.deepEqual(
    sent.map((p) => p.title),
    ['Ο αισθητήρας κίνησης δεν απαντά', 'Ο αισθητήρας κίνησης απαντά ξανά'],
  );
});
