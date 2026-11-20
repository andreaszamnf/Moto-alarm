// Riding: the live ride from the board, the list of past rides, and a speedometer that uses the
// phone's own GPS. The board reports every 15 seconds while riding, so its speed is a few seconds
// old; the speedometer changes every second but needs the phone on the handlebars.

const $ = (id) => document.getElementById(id);

const num1 = new Intl.NumberFormat('el-GR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('el-GR', { weekday: 'short', day: 'numeric', month: 'short' });
const clockFmt = new Intl.DateTimeFormat('el-GR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const kmText = (m) => `${num1.format((m ?? 0) / 1000)} χλμ`;
export const speedText = (kmh) => (kmh == null ? '—' : String(Math.round(kmh)));

// 0:42 under an hour, 1 ώ 05′ above.
export function durationText(seconds) {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} ώ ${String(m).padStart(2, '0')}′`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `πριν από ${s} δευτ.`;
  const m = Math.round(s / 60);
  return `πριν από ${m} λεπτ${m === 1 ? 'ό' : 'ά'}`;
}

// The board stops reporting a minute after the bike stops: older news means it stands (or has no signal).
const STALE_MS = 50_000;

/** The card on the main screen while the board says the owner is riding. */
export function renderRideCard(ride, now) {
  $('ride-card').hidden = !ride;
  if (!ride) return;
  const age = now - ride.last;
  const stale = age > STALE_MS;
  $('ride-speed').textContent = stale ? '—' : speedText(ride.speed);
  $('ride-km').textContent = kmText(ride.m);
  $('ride-time').textContent = durationText(ride.movingS);
  $('ride-max').textContent = ride.max ? `${speedText(ride.max)} χλμ/ώ` : '—';
  $('ride-avg').textContent = ride.avg ? `${speedText(ride.avg)} χλμ/ώ` : '—';
  $('ride-age').textContent = stale
    ? `Τελευταία ενημέρωση ${agoText(age)}: σταμάτησε ή δεν έχει σήμα.`
    : `Από την πλακέτα, ${agoText(age)} · ανανεώνεται κάθε 15 δευτ.`;
}

export function rideEventText(data) {
  return `Διαδρομή ${kmText(data?.m)}, ${durationText(data?.s)}`;
}

// ---------- past rides ----------

function tripTitle(trip) {
  return `${dateFmt.format(new Date(trip.start))}, ${clockFmt.format(new Date(trip.start))}–${clockFmt.format(new Date(trip.end))}`;
}

function tripLine(trip) {
  const parts = [kmText(trip.m), durationText(trip.movingS)];
  if (trip.avg) parts.push(`μέση ${speedText(trip.avg)}`);
  if (trip.max) parts.push(`μέγ. ${speedText(trip.max)} χλμ/ώ`);
  if (trip.loan) parts.push('δανεική');
  return parts.join(' · ');
}

/**
 * The "Διαδρομές" window. `load()` fetches { trips }; `show(trip)` draws one on the map.
 */
export function setupRides({ load, show, onError }) {
  const dialog = $('rides-dialog');

  async function open() {
    $('trips').replaceChildren();
    $('trips-empty').hidden = true;
    $('rides-msg').textContent = 'Φορτώνει…';
    dialog.showModal();
    try {
      const { trips } = await load();
      $('rides-msg').textContent = '';
      $('trips-empty').hidden = trips.length > 0;
      for (const trip of trips) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'trip';
        const title = document.createElement('strong');
        title.textContent = tripTitle(trip);
        const line = document.createElement('small');
        line.textContent = tripLine(trip);
        button.append(title, line);
        button.addEventListener('click', () => {
          dialog.close();
          show(trip);
        });
        li.append(button);
        $('trips').append(li);
      }
    } catch (err) {
      $('rides-msg').textContent = onError(err);
    }
  }

  $('btn-rides').addEventListener('click', open);
  $('btn-speedo').addEventListener('click', () => {
    dialog.close();
    openSpeedo();
  });
}

// ---------- speedometer with the phone's GPS ----------

const GOOD_ACCURACY_M = 30; // worse than this: shown, but not counted in distance or top speed
const MOVING_KMH = 4;

const speedo = { watch: null, lock: null, prev: null, m: 0, movingS: 0, max: 0 };

function renderSpeedo(kmh, note) {
  $('sp-speed').textContent = kmh == null ? '—' : String(Math.round(kmh < MOVING_KMH ? 0 : kmh));
  $('sp-max').textContent = speedText(speedo.max);
  $('sp-km').textContent = kmText(speedo.m);
  $('sp-time').textContent = durationText(speedo.movingS);
  $('sp-avg').textContent = speedo.movingS >= 10 ? speedText((speedo.m / speedo.movingS) * 3.6) : '—';
  if (note !== undefined) $('sp-status').textContent = note;
}

function distanceM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy, speed } = pos.coords;
  const here = { lat, lon, ts: pos.timestamp };
  const prev = speedo.prev;
  const dt = prev ? (here.ts - prev.ts) / 1000 : 0;
  const d = prev ? distanceM(prev, here) : 0;
  // The phone's own speed (from the satellites' Doppler) is the best; some phones leave it out.
  let kmh = speed != null && speed >= 0 ? speed * 3.6 : prev && dt > 0 ? (d / dt) * 3.6 : null;
  const good = accuracy <= GOOD_ACCURACY_M;
  if (good && kmh != null && kmh <= 300) {
    if (kmh > speedo.max) speedo.max = kmh;
    if (prev && dt > 0 && dt <= 30 && kmh >= MOVING_KMH) {
      speedo.m += d;
      speedo.movingS += dt;
    }
  }
  if (good || !prev) speedo.prev = here;
  if (kmh != null && kmh > 300) kmh = null;
  renderSpeedo(kmh, good ? `GPS κινητού · ακρίβεια ${Math.round(accuracy)} μ.` : `Αδύναμο GPS (±${Math.round(accuracy)} μ.): δεν μετράει απόσταση.`);
}

function onPositionError(err) {
  const text =
    err.code === err.PERMISSION_DENIED
      ? 'Το κινητό δεν δίνει τη θέση του στην εφαρμογή. Επίτρεψε την τοποθεσία για την εφαρμογή στις ρυθμίσεις του κινητού.'
      : err.code === err.TIMEOUT
        ? 'Ψάχνει GPS… Στο ύπαιθρο βρίσκει πιο γρήγορα.'
        : 'Δεν βρίσκει τη θέση του κινητού.';
  renderSpeedo(null, text);
}

// Keeps the screen on while the speedometer shows (where the phone allows it). The phone lets go
// of it when the page is hidden; it is asked for again when the page comes back.
async function keepScreenOn() {
  try {
    speedo.lock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    speedo.lock = null;
  }
}

function onVisible() {
  if (!document.hidden && speedo.watch !== null && !speedo.lock) keepScreenOn();
}

function openSpeedo() {
  const dialog = $('speedo');
  dialog.showModal();
  renderSpeedo(null, 'Ψάχνει GPS…');
  if (!('geolocation' in navigator)) {
    renderSpeedo(null, 'Αυτό το κινητό δεν δίνει θέση στις εφαρμογές.');
    return;
  }
  speedo.prev = null; // a pause between opening it: no straight line across
  speedo.watch = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 20_000,
  });
  keepScreenOn();
  document.addEventListener('visibilitychange', onVisible);
}

function closeSpeedo() {
  if (speedo.watch !== null) navigator.geolocation.clearWatch(speedo.watch);
  speedo.watch = null;
  speedo.lock?.release().catch(() => {});
  speedo.lock = null;
  document.removeEventListener('visibilitychange', onVisible);
}

export function setupSpeedo() {
  const dialog = $('speedo');
  dialog.addEventListener('close', closeSpeedo);
  $('sp-close').addEventListener('click', () => dialog.close());
  $('sp-reset').addEventListener('click', () => {
    Object.assign(speedo, { prev: null, m: 0, movingS: 0, max: 0 });
    renderSpeedo(null);
  });
}
