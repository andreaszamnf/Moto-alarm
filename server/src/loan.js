// Lent out: the bike is at a workshop or with a friend. No alarm, but the owner sees where it goes,
// how fast and how far: a quiet notification when it starts moving, the live ride in the app, a
// summary when it stops, and an optional notification above a speed the owner chooses. It lasts
// until the owner ends it (or arms the alarm).
import { setArmed } from './logic.js';
import { rideView, tripList } from './rides.js';

export const LOAN_SPEED_CHOICES = Object.freeze([0, 50, 80, 100, 130]); // km/h, 0 = no speed notification

const num1 = new Intl.NumberFormat('el-GR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const km = (m) => `${num1.format(m / 1000)} χλμ`;
const minutes = (s) => {
  const total = Math.round(s / 60);
  return total < 60 ? `${total}′` : `${Math.floor(total / 60)} ώ ${String(total % 60).padStart(2, '0')}′`;
};

/** Starts lending (disarms the alarm), changes its speed limit, or ends it. */
export async function setLoan({ store, on, speedLimit, now = Date.now(), cancel = async () => {} }) {
  const loan = await store.get('loan');
  const limit = LOAN_SPEED_CHOICES.includes(speedLimit) ? speedLimit : null;
  if (on) {
    if (loan?.on) {
      if (limit !== null) await store.set('loan', { ...loan, speedLimit: limit });
      return;
    }
    const armed = await store.get('armed');
    if (armed?.armed) await setArmed({ store, armed: false, now, by: 'loan', cancel });
    await store.set('loan', { on: true, since: now, speedLimit: limit ?? 0, told: null });
    await store.set('arm_on_park', null); // the schedule must not arm it while it is away
    await store.addEvent('loan', { on: true }, now);
    return;
  }
  await endLoan(store, now);
}

/** Ends lending, with its totals in the history. */
export async function endLoan(store, now = Date.now()) {
  const view = await loanView(store, now);
  if (!view) return null;
  await store.set('loan', null);
  await store.addEvent('loan', { on: false, rides: view.rides, m: view.m }, now);
  return view;
}

/** For the app: since when, and the rides since then (with the one under way). */
export async function loanView(store, now = Date.now()) {
  const loan = await store.get('loan');
  if (!loan?.on) return null;
  const trips = (await tripList(store, 200)).filter((t) => t.end >= loan.since);
  const ride = rideView(await store.get('ride'), now);
  const all = ride && ride.start >= loan.since - 60_000 ? [...trips, ride] : trips;
  return {
    since: loan.since,
    speedLimit: loan.speedLimit ?? 0,
    rides: all.length,
    m: all.reduce((sum, t) => sum + (t.m ?? 0), 0),
    movingS: all.reduce((sum, t) => sum + (t.movingS ?? 0), 0),
    max: all.reduce((top, t) => Math.max(top, t.max ?? 0), 0),
    riding: Boolean(ride),
  };
}

/**
 * Called with every device report, after the ride was followed (`news` from trackRide). While lent
 * out: tells the owner when it starts moving, when it goes faster than the limit, and how the ride
 * went once it stops.
 */
export async function loanNews({ store, news, now = Date.now(), notify = async () => {} }) {
  const loan = await store.get('loan');
  if (!loan?.on || !news) return;
  if (news.started) {
    await notify({
      title: 'Η μηχανή ξεκίνησε',
      body: 'Είναι δανεική: δεν χτυπάει συναγερμός. Στην εφαρμογή βλέπεις πού πάει και πόσο γρήγορα.',
      tag: 'moto-loan',
      quiet: true,
    });
  }
  const ride = news.ride;
  if (ride && loan.speedLimit > 0 && ride.max > loan.speedLimit && loan.told !== ride.start) {
    await store.set('loan', { ...loan, told: ride.start }); // once per ride
    await notify({
      title: `Πάνω από ${loan.speedLimit} χλμ/ώ`,
      body: `Η δανεική μηχανή έφτασε τα ${Math.round(ride.max)} χλμ/ώ.`,
      tag: 'moto-loan-speed',
    });
  }
  const done = news.ended;
  if (done?.loan) {
    await notify({
      title: 'Η μηχανή σταμάτησε',
      body: `Διαδρομή ${km(done.m)} σε ${minutes(done.movingS)}, μέγιστη ${Math.round(done.max)} χλμ/ώ.`,
      tag: 'moto-loan',
      quiet: true,
    });
  }
}
