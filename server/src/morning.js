// Morning summary: one quiet notification a day, at a time the owner chooses (Greek time), about the
// night: alarms, touches, restarts, battery and contact. Anything wrong comes first.
import { contactWindowMs, lastOccurrence, loadSettings } from './logic.js';
import { tripList } from './rides.js';

const LATE_MS = 3 * 3_600_000; // the cron was down at the time: still send it within 3 hours, not later
const MAX_SPAN_MS = 24 * 3_600_000;

const clockFmt = new Intl.DateTimeFormat('el-GR', { timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const num1 = new Intl.NumberFormat('el-GR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The summary of what happened between `since` and `now`: { title, body, problems }. */
export async function morningText({ store, since, now = Date.now() }) {
  const [settings, device, alarm, armed, loan, tally, events, trips] = await Promise.all([
    loadSettings(store),
    store.get('device'),
    store.get('alarm'),
    store.get('armed'),
    store.get('loan'),
    store.get('touch_tally'),
    store.events(200),
    tripList(store, 50),
  ]);
  const night = events.filter((e) => e.ts >= since && e.ts <= now);
  const count = (type) => night.filter((e) => e.type === type).length;

  const problems = [];
  if (alarm?.active) problems.push('Ο συναγερμός χτυπάει τώρα');
  const inTouch = device?.lastSeen && now - device.lastSeen <= contactWindowMs(device, alarm, settings);
  if (!device?.lastSeen) problems.push('Η πλακέτα δεν έχει στείλει ποτέ');
  else if (!inTouch) problems.push(`Χωρίς επαφή από τις ${clockFmt.format(new Date(device.lastSeen))}`);
  const pct = device?.batt?.pct;
  if (typeof pct === 'number' && pct <= settings.lowBatteryPct) problems.push(`Χαμηλή μπαταρία ${pct}%`);

  const alarms = count('alarm');
  // Not the ones as the key went off (power on the key, `bikePower`): those come with every ride.
  const restarts = night.filter((e) => e.type === 'restart' && !e.data?.key).length;
  const touches = typeof tally === 'number' ? tally : 0;
  const parts = [...problems];
  if (!problems.length && !alarms) parts.push('Όλα καλά τη νύχτα');
  if (alarms) parts.push(plural(alarms, 'συναγερμός', 'συναγερμοί'));
  parts.push(plural(touches, 'άγγιγμα', 'αγγίγματα'));
  if (restarts) parts.push(plural(restarts, 'επανεκκίνηση πλακέτας', 'επανεκκινήσεις πλακέτας'));
  const rides = trips.filter((t) => t.end >= since);
  if (rides.length) {
    const m = rides.reduce((sum, t) => sum + t.m, 0);
    parts.push(`${plural(rides.length, 'διαδρομή', 'διαδρομές')} ${num1.format(m / 1000)} χλμ`);
  }
  // On USB the board cannot measure its battery, so just "charging" (firmware 1.7.0 on says so).
  if (device?.ext === true) parts.push('φορτίζει');
  else if (typeof pct === 'number' && pct > settings.lowBatteryPct) parts.push(`μπαταρία ${pct}%`);
  else if (device?.batt && pct == null) parts.push('στο ρεύμα');
  if (inTouch) parts.push(device.via === 'wifi' ? 'σε επαφή από Wi-Fi' : 'σε επαφή από 4G');
  parts.push(loan?.on ? 'δανεική' : armed?.armed ? 'οπλισμένος' : 'αφοπλισμένος');

  return {
    title: problems.length ? 'Η μηχανή θέλει προσοχή' : alarms ? 'Πρωινή σύνοψη: συναγερμός τη νύχτα' : 'Καλημέρα',
    body: parts.join(' · '),
    problems,
  };
}

/**
 * From the cron, every 5 minutes: sends the summary once, after the morning time has passed today.
 * Covers the time since the previous summary (at most a day).
 */
export async function morningSummary({ store, now = Date.now(), notify = async () => {} }) {
  const { morning } = await loadSettings(store);
  if (!morning?.on || !/^([01]\d|2[0-3]):[0-5]\d$/.test(morning.time ?? '')) return null;
  const due = lastOccurrence(morning.time, now);
  const sent = (await store.get('morning_sent')) ?? 0;
  if (sent >= due || now - due > LATE_MS) return null;
  await store.set('morning_sent', now);
  const since = Math.max(sent, now - MAX_SPAN_MS);
  const text = await morningText({ store, since, now });
  await store.set('touch_tally', null); // counted afresh until the next summary
  await notify({ title: text.title, body: text.body, tag: 'moto-morning', quiet: !text.problems.length });
  return text;
}
