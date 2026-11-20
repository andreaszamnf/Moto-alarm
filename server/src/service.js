// Service book of the bike: what was done, when, at how many kilometres, where and for how much,
// and when each regular job is due again. Kept for good: the 90-day cleanup never touches it.
import { TIME_ZONE } from './logic.js';

// The jobs the app offers as quick choices. km/months: the suggested "next time" the app fills in
// for a new entry (the owner can change it in each entry). The starting values follow
// Honda's maintenance schedule for the Hornet 750 (European model); null means no suggestion
// (parts that wear, like tyres and pads). The owner can change the suggestions in the app.
export const SERVICE_ITEMS = Object.freeze([
  { id: 'oil', label: 'Λάδια κινητήρα', group: 'Λάδια και φίλτρα', km: 12000, months: 12 },
  { id: 'oil_filter', label: 'Φίλτρο λαδιού', group: 'Λάδια και φίλτρα', km: 24000, months: null },
  { id: 'air_filter', label: 'Φίλτρο αέρα', group: 'Λάδια και φίλτρα', km: 24000, months: null },
  { id: 'fork_oil', label: 'Λάδια πιρουνιού', group: 'Λάδια και φίλτρα', km: null, months: null },
  { id: 'pads_front', label: 'Τακάκια εμπρός', group: 'Φρένα', km: null, months: null },
  { id: 'pads_rear', label: 'Τακάκια πίσω', group: 'Φρένα', km: null, months: null },
  { id: 'brake_fluid', label: 'Υγρό φρένων', group: 'Φρένα', km: null, months: 24 },
  { id: 'chain_lube', label: 'Λίπανση αλυσίδας', group: 'Αλυσίδα', km: 1000, months: null },
  { id: 'chain_kit', label: 'Κιτ αλυσίδας', group: 'Αλυσίδα', km: null, months: null },
  { id: 'tyre_front', label: 'Λάστιχο εμπρός', group: 'Λάστιχα', km: null, months: null },
  { id: 'tyre_rear', label: 'Λάστιχο πίσω', group: 'Λάστιχα', km: null, months: null },
  { id: 'spark_plugs', label: 'Μπουζί', group: 'Κινητήρας και ηλεκτρικά', km: 48000, months: null },
  { id: 'valves', label: 'Βαλβίδες (διάκενα)', group: 'Κινητήρας και ηλεκτρικά', km: 24000, months: null },
  { id: 'coolant', label: 'Αντιψυκτικό', group: 'Κινητήρας και ηλεκτρικά', km: null, months: 36 },
  { id: 'battery', label: 'Μπαταρία', group: 'Κινητήρας και ηλεκτρικά', km: null, months: null },
]);

const ITEMS = new Map(SERVICE_ITEMS.map((item, order) => [item.id, { ...item, order }]));
const MAX_ENTRIES = 1000;
const MAX_KM = 999_999;
const MAX_COST = 100_000;
const MAX_INTERVAL_KM = 200_000;
const MAX_INTERVAL_MONTHS = 120;
const TEXT_MAX = { other: 120, shop: 80, notes: 2000 };
// "Soon": within 300 km or two weeks of the next time, and never more than 30% of the way
// (a chain lubed every 500 km is "soon" at 350, not at once).
const SOON_KM = 300;
const SOON_DAYS = 14;
const SOON_SHARE = 0.3;
const MAX_NEXT_DATE = '2100-01-01';
const REMIND_HOUR = 10; // the daily look for due jobs, after 10:00 Greek time
const DAY_MS = 86_400_000;
const STATUS_ORDER = { due: 0, soon: 1, ok: 2, unknown: 3, none: 4 };

// A refusal the app can explain (the code maps to a Greek message there).
export class ServiceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// ---------- dates (YYYY-MM-DD, as written in the service book) ----------
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function validDate(text) {
  const m = typeof text === 'string' ? DATE_RE.exec(text) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const fromDayNumber = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);
const addDays = (date, n) => fromDayNumber(dayNumber(date) + n);

// The same day n months later, or the month's last day (31 January + 1 month = 28 or 29 February).
export function addMonths(date, n) {
  const [, y, m, d] = DATE_RE.exec(date);
  const total = Number(y) * 12 + Number(m) - 1 + n;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(Number(d), last))).toISOString().slice(0, 10);
}

const athensFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

// Today's date and the hour in Greece.
export function athensToday(now = Date.now()) {
  const p = Object.fromEntries(athensFormat.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// The moment a day ends in Greece (midnight before the next day, winter or summer time).
function athensDayEnd(date) {
  const next = addDays(date, 1);
  const midnight = Date.parse(`${next}T00:00:00Z`);
  for (const hours of [3, 2]) {
    const t = midnight - hours * 3_600_000;
    const { day, hour } = athensToday(t);
    if (day === next && hour === 0) return t;
  }
  return midnight - 2 * 3_600_000;
}

// ---------- checking what the app sends ----------
function optionalInt(value, max, code) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || value < 0 || value > max) throw new ServiceError(code);
  return value;
}

function cleanText(value, max, multiline = false) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ServiceError('bad_text');
  const text = multiline
    ? value
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : value.replace(/[\u0000-\u001F\u007F\s]+/g, ' ').trim();
  if (text.length > max) throw new ServiceError('too_long');
  return text;
}

/**
 * One entry of the service book, checked and tidied:
 * { date: 'YYYY-MM-DD', km, items: [ids in the order of SERVICE_ITEMS], other, shop, cost (€), notes }.
 * `today` is the date in Greece; a day ahead is allowed for a phone in another time zone.
 */
export function normalizeService(input, today) {
  const body = input && typeof input === 'object' ? input : {};
  if (!validDate(body.date) || body.date < '1980-01-01' || body.date > addDays(today, 1)) throw new ServiceError('bad_date');
  const km = optionalInt(body.km, MAX_KM, 'bad_km');
  const ids = body.items ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !ITEMS.has(id))) throw new ServiceError('bad_items');
  const items = [...new Set(ids)].sort((a, b) => ITEMS.get(a).order - ITEMS.get(b).order);
  const other = cleanText(body.other, TEXT_MAX.other);
  if (!items.length && !other) throw new ServiceError('no_items');
  let cost = null;
  if (body.cost !== undefined && body.cost !== null && body.cost !== '') {
    if (typeof body.cost !== 'number' || !Number.isFinite(body.cost) || body.cost < 0 || body.cost > MAX_COST) {
      throw new ServiceError('bad_cost');
    }
    cost = Math.round(body.cost * 100) / 100;
  }
  const entry = {
    date: body.date,
    km,
    items,
    other,
    shop: cleanText(body.shop, TEXT_MAX.shop),
    cost,
    notes: cleanText(body.notes, TEXT_MAX.notes, true),
  };
  if (body.next !== undefined && body.next !== null) entry.next = normalizeNext(body.next, entry);
  return entry;
}

/**
 * When each job of the entry is due again, as the owner set it: { oil: { km, date } }, where km is
 * the odometer reading (not a distance) and either may be null. A job with both null has no reminder.
 */
function normalizeNext(input, entry) {
  if (typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('bad_next');
  const next = {};
  for (const [id, value] of Object.entries(input)) {
    if (!entry.items.includes(id) || !value || typeof value !== 'object') throw new ServiceError('bad_next');
    const km = optionalInt(value.km, MAX_KM, 'bad_next');
    if (km !== null && entry.km !== null && km <= entry.km) throw new ServiceError('bad_next');
    const date = value.date === undefined || value.date === null || value.date === '' ? null : value.date;
    if (date !== null && (!validDate(date) || date <= entry.date || date > MAX_NEXT_DATE)) throw new ServiceError('bad_next');
    next[id] = { km, date };
  }
  return next;
}

// ---------- reminders ----------
async function loadPrefs(store) {
  const saved = (await store.get('service_prefs')) ?? {};
  return { notify: saved.notify !== false, intervals: { ...(saved.intervals ?? {}) } };
}

// The owner's own intervals where set, Honda's elsewhere.
function effectiveIntervals(prefs) {
  return Object.fromEntries(
    SERVICE_ITEMS.map((item) => {
      const own = Object.hasOwn(prefs.intervals, item.id) ? prefs.intervals[item.id] : null;
      return [item.id, own ? { km: own.km ?? null, months: own.months ?? null } : { km: item.km, months: item.months }];
    }),
  );
}

/**
 * The kilometres on the dashboard: the latest count the owner wrote (a reading, or a service with
 * more km), plus the rides measured by GPS since then. The GPS part is an estimate; the next
 * reading the owner writes replaces it.
 * trips: past ride summaries ({ start, m }); ride: the ride under way, if any.
 */
function odometerView(entries, reading, trips, ride) {
  let anchor = null;
  if (reading && Number.isInteger(reading.km)) {
    anchor = { km: reading.km, date: reading.date, src: 'reading', since: reading.ts ?? athensDayEnd(reading.date) };
  }
  for (const e of entries) {
    if (e.km === null) continue;
    if (!anchor || e.km > anchor.km || (e.km === anchor.km && e.date > anchor.date)) {
      anchor = { km: e.km, date: e.date, src: 'service', since: athensDayEnd(e.date) }; // the rides of that day may be before it
    }
  }
  if (!anchor) return null;
  let metres = 0;
  for (const trip of Array.isArray(trips) ? trips : []) if (trip?.start >= anchor.since) metres += trip.m ?? 0;
  if (ride?.start >= anchor.since) metres += ride.m ?? 0;
  const gps = Math.round(metres / 1000);
  return { km: anchor.km + gps, measured: anchor.km, gps, date: anchor.date, src: anchor.src };
}

const newestFirst = (a, b) => b.date.localeCompare(a.date) || (b.km ?? -1) - (a.km ?? -1) || b.id - a.id;
const soonKm = (span) => (span > 0 ? Math.min(SOON_KM, span * SOON_SHARE) : SOON_KM);
const soonDays = (span) => (span > 0 ? Math.min(SOON_DAYS, span * SOON_SHARE) : SOON_DAYS);

/**
 * Where one job stands: when it was last done and when it is due again. The owner sets "next time"
 * in each entry; entries saved before that had no such field and follow the intervals.
 */
function reminderFor(item, entry, interval, odometer, today) {
  const out = {
    item: item.id,
    label: item.label,
    last: { id: entry.id, date: entry.date, km: entry.km },
    ago: { days: Math.max(0, daysBetween(entry.date, today)), km: entry.km !== null && odometer ? Math.max(0, odometer.km - entry.km) : null },
    own: false, // "next time" set by the owner, not worked out from an interval
    next: null,
    span: null,
    left: null,
    progress: null,
    status: 'none',
  };
  let next;
  if (entry.next && Object.hasOwn(entry.next, item.id)) {
    next = { km: entry.next[item.id].km ?? null, date: entry.next[item.id].date ?? null };
    out.own = true;
  } else {
    next = {
      km: interval.km && entry.km !== null ? entry.km + interval.km : null,
      date: interval.months ? addMonths(entry.date, interval.months) : null,
    };
  }
  if (next.km === null && next.date === null) return out;
  const span = {
    km: next.km !== null && entry.km !== null ? next.km - entry.km : null,
    days: next.date ? daysBetween(entry.date, next.date) : null,
  };
  const left = {
    km: next.km !== null && odometer ? next.km - odometer.km : null,
    days: next.date ? daysBetween(today, next.date) : null,
  };
  if (left.km === null && left.days === null) return { ...out, next, span, status: 'unknown' }; // km, but no km known yet
  // How much of the way is behind, by kilometres or by time, whichever is further along.
  const used = [];
  if (left.km !== null && span.km > 0) used.push((span.km - left.km) / span.km);
  if (left.days !== null && span.days > 0) used.push(daysBetween(entry.date, today) / span.days);
  const due = (left.km !== null && left.km <= 0) || (left.days !== null && left.days <= 0);
  const soon = (left.km !== null && left.km <= soonKm(span.km)) || (left.days !== null && left.days <= soonDays(span.days));
  return {
    ...out,
    next,
    span,
    left,
    progress: used.length ? Math.round(Math.max(0, ...used) * 1000) / 1000 : null,
    status: due ? 'due' : soon ? 'soon' : 'ok',
  };
}

function remindersFor(entries, intervals, odometer, today) {
  const last = new Map();
  for (const entry of entries) for (const id of entry.items) if (!last.has(id)) last.set(id, entry);
  const reminders = [];
  const untracked = []; // jobs with an interval that are not in the book yet
  for (const item of SERVICE_ITEMS) {
    const interval = intervals[item.id];
    const entry = last.get(item.id);
    if (entry) reminders.push(reminderFor(item, entry, interval, odometer, today));
    else if (interval.km || interval.months) untracked.push(item.id);
  }
  // Most urgent first, then the nearest: kilometres count as days at about 30 km a day.
  const nearness = (r) => Math.min(r.left?.km != null ? r.left.km / 30 : Infinity, r.left?.days ?? Infinity);
  reminders.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (nearness(a) === nearness(b) ? 0 : nearness(a) < nearness(b) ? -1 : 1) ||
      (b.progress ?? 0) - (a.progress ?? 0) ||
      b.last.date.localeCompare(a.last.date) ||
      ITEMS.get(a.item).order - ITEMS.get(b.item).order,
  );
  return { reminders, untracked };
}

/**
 * Everything the app shows: the entries (newest first), the list of jobs, the kilometres,
 * where each job stands (most urgent first) and the cost per year.
 */
export async function serviceView({ store, now = Date.now() }) {
  const today = athensToday(now).day;
  const [rows, reading, prefs, trips, ride] = await Promise.all([
    store.services(),
    store.get('odometer'),
    loadPrefs(store),
    store.get('trips'),
    store.get('ride'),
  ]);
  const entries = rows
    .map((e) => ({
      id: e.id,
      date: e.date,
      km: e.km ?? null,
      items: e.items ?? [],
      other: e.other ?? '',
      shop: e.shop ?? '',
      cost: e.cost ?? null,
      notes: e.notes ?? '',
      ...(e.next ? { next: e.next } : {}),
    }))
    .sort(newestFirst);
  const odometer = odometerView(entries, reading, trips, ride);
  const intervals = effectiveIntervals(prefs);
  const { reminders, untracked } = remindersFor(entries, intervals, odometer, today);

  const byYear = new Map();
  let cents = 0;
  for (const e of entries) {
    const year = Number(e.date.slice(0, 4));
    const row = byYear.get(year) ?? { year, count: 0, cents: 0 };
    row.count += 1;
    row.cents += Math.round((e.cost ?? 0) * 100);
    cents += Math.round((e.cost ?? 0) * 100);
    byYear.set(year, row);
  }

  return {
    today,
    items: SERVICE_ITEMS.map(({ id, label, group, km, months }) => ({ id, label, group, km, months })),
    entries,
    odometer,
    intervals,
    notify: prefs.notify,
    reminders,
    untracked,
    years: [...byYear.values()].sort((a, b) => b.year - a.year).map((y) => ({ year: y.year, count: y.count, cost: y.cents / 100 })),
    total: { count: entries.length, cost: cents / 100 },
    shops: [...new Set(entries.map((e) => e.shop).filter(Boolean))].slice(0, 20), // most recent first
  };
}

// ---------- changes from the app ----------
// Adds an entry, or changes one when body.id is given. Returns its id.
export async function saveService({ store, body, now = Date.now() }) {
  const entry = normalizeService(body, athensToday(now).day);
  if (body.id !== undefined && body.id !== null) {
    if (!Number.isInteger(body.id) || !(await store.updateService(body.id, entry, now))) throw new ServiceError('service_not_found', 404);
    return body.id;
  }
  if ((await store.services()).length >= MAX_ENTRIES) throw new ServiceError('too_many_services');
  return store.addService(entry, now);
}

export async function removeService({ store, id }) {
  if (!Number.isInteger(id) || !(await store.removeService(id))) throw new ServiceError('service_not_found', 404);
}

// The kilometres on the dashboard today. Never fewer than a service already had: one of the two is a typo.
export async function saveOdometer({ store, km, now = Date.now() }) {
  if (!Number.isInteger(km) || km < 0 || km > MAX_KM) throw new ServiceError('bad_km');
  const highest = Math.max(-1, ...(await store.services()).map((e) => e.km ?? -1));
  if (km < highest) throw new ServiceError('km_below_service');
  await store.set('odometer', { km, date: athensToday(now).day, ts: now }); // rides after `ts` add to it
}

/**
 * Reminder settings: { notify: boolean } turns the phone notification on or off,
 * { intervals: { oil: { km, months } } } changes intervals (null = none), { reset: true } goes back to Honda's.
 */
export async function saveServicePrefs({ store, body }) {
  const prefs = await loadPrefs(store);
  if (body?.reset === true) prefs.intervals = {};
  if (typeof body?.notify === 'boolean') prefs.notify = body.notify;
  if (body?.intervals !== undefined) {
    if (!body.intervals || typeof body.intervals !== 'object' || Array.isArray(body.intervals)) throw new ServiceError('bad_interval');
    for (const [id, value] of Object.entries(body.intervals)) {
      const item = ITEMS.get(id);
      if (!item || !value || typeof value !== 'object') throw new ServiceError('bad_interval');
      const km = optionalInt(value.km, MAX_INTERVAL_KM, 'bad_interval');
      const months = optionalInt(value.months, MAX_INTERVAL_MONTHS, 'bad_interval');
      if ((km !== null && km < 100) || months === 0) throw new ServiceError('bad_interval');
      if (km === item.km && months === item.months) delete prefs.intervals[id]; // back to Honda's
      else prefs.intervals[id] = { km, months };
    }
  }
  await store.set('service_prefs', prefs);
}

// ---------- the daily reminder ----------
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const lowerFirst = (text) => text.charAt(0).toLocaleLowerCase('el') + text.slice(1);

function timeLeftText(days) {
  if (days < 45) return `${days} μέρ${days === 1 ? 'α' : 'ες'}`;
  const months = Math.round(days / 30.44);
  return `${months} μήν${months === 1 ? 'α' : 'ες'}`;
}

// What makes a job "soon": the kilometres, the time, or both.
function soonText(r) {
  const parts = [];
  if (r.left.km !== null && r.left.km <= soonKm(r.span.km)) parts.push(`${thousands(r.left.km)} χλμ`);
  if (r.left.days !== null && r.left.days <= soonDays(r.span.days)) parts.push(timeLeftText(r.left.days));
  return `σε ${parts.join(' ή ')}`;
}

export function reminderText(list) {
  const due = list.filter((r) => r.status === 'due').map((r) => lowerFirst(r.label));
  const soon = list.filter((r) => r.status === 'soon').map((r) => `${lowerFirst(r.label)} (${soonText(r)})`);
  const parts = [];
  if (due.length) parts.push(`Ήρθε η ώρα: ${due.join(', ')}.`);
  if (soon.length) parts.push(`Πλησιάζει: ${soon.join(', ')}.`);
  return parts.join(' ');
}

// A new entry, or a new "next time", starts the count again.
const toldKey = (r) => `${r.last.id}:${r.last.date}:${r.next?.km}:${r.next?.date}:${r.status}`;

/**
 * Runs from the cron trigger. Once a day, after 10:00 Greek time, tells the phone about jobs that
 * are due or close to due: once when a job gets close and once more when it is due. A new entry
 * for the job starts its count again.
 */
export async function checkServiceReminders({ store, now = Date.now(), notify = async () => {} }) {
  const { day, hour } = athensToday(now);
  if (hour < REMIND_HOUR || (await store.get('service_checked')) === day) return null;
  await store.set('service_checked', day);
  const view = await serviceView({ store, now });
  if (!view.notify) return null;
  const told = (await store.get('service_told')) ?? {};
  const fresh = view.reminders.filter((r) => (r.status === 'due' || r.status === 'soon') && told[r.item] !== toldKey(r));
  if (!fresh.length) return null;
  for (const r of fresh) told[r.item] = toldKey(r);
  await store.set('service_told', told);
  await notify({ title: 'Σέρβις μηχανής', body: reminderText(fresh), tag: 'moto-service' });
  return fresh.map((r) => r.item);
}
