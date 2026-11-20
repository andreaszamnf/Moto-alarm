import assert from 'node:assert/strict';
import test from 'node:test';
import { CRASH_WAIT_S, SMS_MAX, boardSmsText, crashSmsTexts, okCrash, startCrashTest } from '../src/crash.js';
import { handleReport, loadSettings, snapshot, updateSettings } from '../src/logic.js';
import { MemoryStore } from '../src/store.js';

const T0 = Date.UTC(2026, 10, 20, 7, 41, 0); // 09:41 Greek time
const sec = (n) => n * 1000;
const FIX = { lat: 37.9715, lon: 23.7257, acc: 6, spd: 0 };

function setup() {
  const store = new MemoryStore();
  const sent = []; // web push
  const alerts = []; // Pushover
  const cancelled = [];
  const notify = async (p) => sent.push(p);
  const emergency = async (p) => {
    alerts.push(p);
    return `r${alerts.length}`;
  };
  const cancel = async (receipt) => cancelled.push(receipt);
  const report = (r, now) => handleReport({ store, report: r, now, notify, emergency, cancel, origin: 'https://moto.example' });
  return { store, sent, alerts, cancelled, notify, emergency, cancel, report };
}

const withContact = (store) => updateSettings(store, { crash: { on: true, name: 'Γιώργος', contact: 'Μαρία', phone: '6912345678' } });
const FW = '1.8.0';
const fall = (extra = {}) => ({ reason: 'crash', fw: FW, fix: FIX, crash: { at: T0 / 1000, kmh: 58, tilt: 74, ...extra } });
const events = async (store, type) => (await store.events(50)).filter((e) => e.type === type);

test('crash: off by default, the board stops at once and nothing is sent', async () => {
  const { store, sent, alerts, report } = setup();
  const res = await report(fall(), T0);
  assert.deepEqual(res.crash, { end: true });
  assert.deepEqual(res.cr, { to: '' });
  assert.equal(res.sms, undefined);
  assert.equal(sent.length + alerts.length, 0);
  assert.equal((await events(store, 'crash'))[0].data.off, true); // in the history, to see what it would have done
});

test('crash: the owner is alerted at once, the contact gets the place, the time and a live link after 90 s', async () => {
  const { store, sent, alerts, report } = setup();
  await withContact(store);
  const first = await report(fall(), T0);
  assert.deepEqual(first.crash, { wait: CRASH_WAIT_S });
  assert.deepEqual(first.cr, { to: '+306912345678', text: 'Γιώργος: πιθανό ατύχημα!' });
  assert.equal(first.sms, undefined);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /Acknowledge.*90 δευτερόλεπτα.*Μαρία/);
  assert.equal(sent[0].urgent, true);
  assert.equal((await snapshot(store, T0 + sec(10))).crash.wait, 80);

  assert.deepEqual((await report(fall(), T0 + sec(45))).crash, { wait: 45 });
  const due = await report(fall(), T0 + sec(91));
  assert.equal(due.sms.to, '+306912345678');
  const [who, where, live] = due.sms.texts;
  assert.equal(who, 'Γιώργος: πιθανό ατύχημα με τη μηχανή, 09:41 (58 χλμ/ώ).');
  assert.equal(where, 'Σημείο: maps.google.com/?q=37.97150,23.72570 Αν δεν απαντά: 112');
  assert.match(live, /^Θέση τώρα: moto\.example\/s\/[\w-]{16}$/);
  for (const text of due.sms.texts) assert.ok(text.length <= SMS_MAX, text);
  assert.ok((await snapshot(store, T0 + sec(91))).share, 'the live link works');

  const after = await report({ ...fall(), smsOk: true }, T0 + sec(106));
  assert.equal(after.sms, undefined); // once
  const view = (await snapshot(store, T0 + sec(106))).crash;
  assert.equal(view.smsOk, true);
  assert.equal(view.wait, 0);
  // Ten minutes after the SMS the board goes back to normal; the app still shows it until «Είμαι καλά».
  assert.deepEqual((await report(fall(), T0 + sec(91 + 600))).crash, { end: true });
  assert.ok((await snapshot(store, T0 + sec(91 + 600))).crash);
});

test('crash: «Είμαι καλά» in time stops the SMS, the Pushover repeats and the board', async () => {
  const { store, cancelled, report, cancel } = setup();
  await withContact(store);
  await report(fall(), T0);
  assert.equal(await okCrash({ store, now: T0 + sec(30), cancel }), true);
  assert.deepEqual(cancelled, ['r1']);
  assert.equal((await snapshot(store, T0 + sec(30))).crash, null);
  const res = await report(fall(), T0 + sec(40));
  assert.deepEqual(res.crash, { end: true });
  assert.equal(res.sms, undefined);
  assert.equal((await report(fall(), T0 + sec(120))).sms, undefined);
  assert.equal((await events(store, 'crash_ok'))[0].data.by, 'app');
});

test('crash: «Είμαι καλά» after the SMS sends a second one saying all is well', async () => {
  const { store, report, cancel } = setup();
  await withContact(store);
  await report(fall(), T0);
  await report(fall(), T0 + sec(91));
  await okCrash({ store, now: T0 + sec(120), cancel });
  assert.ok((await snapshot(store, T0 + sec(120))).crash.okAt, 'waits for the board to send it');
  const res = await report(fall(), T0 + sec(135));
  assert.deepEqual(res.crash, { end: true });
  assert.deepEqual(res.sms, { to: '+306912345678', texts: ['Γιώργος: είναι καλά, ακύρωση της ειδοποίησης ατυχήματος.'] });
  assert.equal((await snapshot(store, T0 + sec(135))).crash, null);
});

test('crash: riding on cancels; the same fall is not reported twice, a new one is', async () => {
  const { store, alerts, cancelled, report } = setup();
  await withContact(store);
  await report(fall(), T0);
  const res = await report(fall({ over: true }), T0 + sec(20));
  assert.deepEqual(res.crash, { end: true });
  assert.equal(res.sms, undefined);
  assert.deepEqual(cancelled, ['r1']);
  assert.equal((await events(store, 'crash_ok'))[0].data.by, 'ride');
  // The board's next report about the same fall: still over.
  assert.deepEqual((await report(fall(), T0 + sec(35))).crash, { end: true });
  assert.equal(alerts.length, 1);
  // A new fall later on.
  assert.deepEqual((await report(fall({ at: T0 / 1000 + 600 }), T0 + sec(600))).crash, { wait: CRASH_WAIT_S });
  assert.equal(alerts.length, 2);
});

test('crash: Pushover acknowledge says «Είμαι καλά» only for the fall it was sent for', async () => {
  const { store, report } = setup();
  await withContact(store);
  await report(fall(), T0);
  assert.equal(await okCrash({ store, now: T0 + sec(5), receipt: 'other' }), false);
  assert.equal(await okCrash({ store, now: T0 + sec(6), receipt: 'r1' }), true);
  assert.equal((await events(store, 'crash_ok'))[0].data.by, 'pushover');
});

test('crash: without the server the board texted the contact itself, and the server takes note', async () => {
  const { store, report } = setup();
  await withContact(store);
  await report(fall(), T0);
  const res = await report(fall({ local: true }), T0 + sec(200));
  assert.equal(res.sms, undefined); // already sent
  assert.equal((await events(store, 'crash_sms'))[0].data.local, true);
  assert.ok((await snapshot(store, T0 + sec(200))).crash.smsAt);
});

test('crash: no GPS at the fall, the last known position goes, marked rough when it came from Wi-Fi', async () => {
  const { store, report } = setup();
  await withContact(store);
  await report({ reason: 'ride', fw: FW, fix: { lat: 38.1, lon: 23.8, acc: 8, spd: 40 } }, T0 - sec(20));
  await report({ reason: 'crash', fw: FW, crash: { at: T0 / 1000, kmh: 40 } }, T0);
  const due = await report({ reason: 'crash', fw: FW, crash: { at: T0 / 1000 } }, T0 + sec(95));
  assert.equal(due.sms.texts[1], 'Σημείο: maps.google.com/?q=38.10000,23.80000 Αν δεν απαντά: 112');
  const texts = crashSmsTexts({ crash: { since: T0, fix: { lat: 38, lon: 23.7, rough: true } }, settings: { crash: {} } });
  assert.match(texts[1], /^Περίπου: /);
  assert.equal(texts[0], 'Μηχανή: πιθανό ατύχημα με τη μηχανή, 09:41.');
});

test('crash test: the alert now, the SMS to the typed number at the next report, marked ΔΟΚΙΜΗ', async () => {
  const { store, alerts, notify, emergency, report } = setup();
  await withContact(store);
  await report({ reason: 'checkin', fw: FW, fix: FIX }, T0 - sec(60));
  await startCrashTest({ store, to: '+306900000000', settings: await loadSettings(store), now: T0, notify, emergency });
  assert.match(alerts[0].title, /ΔΟΚΙΜΗ/);
  assert.equal(alerts[0].expire, CRASH_WAIT_S); // the siren of a test stops when the wait ends
  assert.equal((await report({ reason: 'checkin', fw: FW }, T0 + sec(60))).sms, undefined);
  const due = await report({ reason: 'checkin', fw: FW }, T0 + sec(900)); // the board's next check-in
  assert.equal(due.sms.to, '+306900000000');
  assert.match(due.sms.texts[0], /^ΔΟΚΙΜΗ\. Γιώργος: πιθανό ατύχημα/);
  assert.equal(due.crash.wait, 0); // a parked board ignores it
  // A real fall during a test takes over.
  const real = await report(fall({ at: T0 / 1000 + 950 }), T0 + sec(950));
  assert.deepEqual(real.crash, { wait: CRASH_WAIT_S });
  await assert.rejects(startCrashTest({ store, to: '+306900000000', settings: await loadSettings(store), now: T0 + sec(960), notify, emergency }), /crash_active/);
});

test('crash: the SMS waits for a board program that can send it (1.8.0)', async () => {
  // 2026-11-20: a test began while the board still ran 1.7.2, which got the order and sent nothing.
  const { store, notify, emergency, report } = setup();
  await withContact(store);
  await startCrashTest({ store, to: '+306900000000', settings: await loadSettings(store), now: T0, notify, emergency });
  const old = await report({ reason: 'checkin', fw: '1.7.2' }, T0 + sec(127));
  assert.equal(old.sms, undefined);
  assert.equal((await snapshot(store, T0 + sec(127))).crash.smsAt, null);
  const updated = await report({ reason: 'boot', fw: FW }, T0 + sec(281));
  assert.equal(updated.sms.to, '+306900000000');
});

test('crash: an SMS that did not go out is ordered again, three times in all', async () => {
  const { store, sent, report } = setup();
  await withContact(store);
  await report(fall(), T0);
  assert.equal((await report(fall(), T0 + sec(91))).sms.texts.length, 3);
  const pushes = sent.length;
  assert.equal((await report({ ...fall(), smsOk: false }, T0 + sec(106))).sms.texts.length, 3);
  assert.equal((await report({ ...fall(), smsOk: false }, T0 + sec(121))).sms.texts.length, 3);
  assert.equal(sent.length, pushes); // no new notification for each try
  assert.equal((await report({ ...fall(), smsOk: false }, T0 + sec(136))).sms, undefined);
  assert.equal((await snapshot(store, T0 + sec(136))).crash.smsOk, false); // the app says it did not go
  assert.deepEqual((await events(store, 'crash_sms')).map((e) => e.data.try ?? 1).sort(), [1, 2, 3]);
});

test('crash settings: the phone in international form, names on one line and short', async () => {
  const store = new MemoryStore();
  const saved = await updateSettings(store, { crash: { on: true, name: '  Γιώργος \n Π. ', contact: 'Μαρία', phone: '69 1234 5678' } });
  assert.deepEqual(saved.crash, { on: true, name: 'Γιώργος Π.', contact: 'Μαρία', phone: '+306912345678' });
  const kept = await updateSettings(store, { crash: { on: false, phone: 'not a phone' } });
  assert.deepEqual(kept.crash, { on: false, name: 'Γιώργος Π.', contact: 'Μαρία', phone: '+306912345678' });
});

test('crash SMS: every part fits one Greek SMS, even with a long name', async () => {
  const settings = { crash: { name: 'Κωνσταντίνος Παπαδόπ' } }; // 20 characters, the most a name can have
  const texts = crashSmsTexts({
    crash: { since: T0, kmh: 123.4, test: true, fix: { lat: -33.123456, lon: -151.123456 } },
    settings,
    shareUrl: 'moto-alarm.example-name.workers.dev/s/abcdefghijklmnop',
  });
  assert.equal(texts.length, 3);
  for (const text of texts) assert.ok(text.length <= SMS_MAX, `${text.length}: ${text}`);
  const board = boardSmsText(settings);
  assert.ok(board.length <= 30, board); // the board adds the map link
  assert.ok(`${board} maps.google.com/?q=-33.12346,-151.12346`.length <= SMS_MAX);
});
