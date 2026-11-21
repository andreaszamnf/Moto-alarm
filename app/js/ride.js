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
  const every = ride.every ?? 15; // seconds between the board's reports (60 with «Χαμηλή κατανάλωση»)
  const age = now - ride.last;
  const stale = age > Math.max(STALE_MS, every * 1000 + 35_000);
  $('ride-speed').textContent = stale ? '—' : speedText(ride.speed);
  $('ride-km').textContent = kmText(ride.m);
  $('ride-time').textContent = durationText(ride.movingS);
  $('ride-max').textContent = ride.max ? `${speedText(ride.max)} χλμ/ώ` : '—';
  $('ride-avg').textContent = ride.avg ? `${speedText(ride.avg)} χλμ/ώ` : '—';
  $('ride-age').textContent = stale
    ? `Τελευταία ενημέρωση ${agoText(age)}: σταμάτησε ή δεν έχει σήμα.`
    : `Από την πλακέτα, ${agoText(age)} · ανανεώνεται ${every >= 60 ? 'κάθε λεπτό' : `κάθε ${every} δευτ.`}`;
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

// ---------- one past ride in detail ----------

// Speed bands as the Greek limits go: town, open road, motorway, above it. On the map the route
// takes the band's blue, light for slow and dark for fast (styles.css, --speed-0..3).
export const SPEED_BANDS = [
  { upTo: 50, label: 'έως 50' },
  { upTo: 90, label: '50–90' },
  { upTo: 130, label: '90–130' },
  { upTo: Infinity, label: 'πάνω από 130' },
];
export const speedBand = (kmh) => SPEED_BANDS.findIndex((b) => kmh < b.upTo);

const TRIP_MOVING_KMH = 5; // as the server counts a ride (server/src/rides.js)
const TRIP_MAX_KMH = 300; // faster is a GPS glitch
const STOP_MIN_S = 60; // standing longer than a red light: a stop

/**
 * What one ride's points ([{ ts, lat, lon, speed }]) say: distance and moving time counted as the
 * server counts them, the fastest point, the stops between moving parts (not the wait before
 * "parked" at the end), the time in each speed band, and the route cut into stretches by band.
 * Null with fewer than two points.
 */
export function tripDetails(positions) {
  const pts = (positions ?? [])
    .filter((p) => Number.isFinite(p?.ts) && Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
    .sort((a, b) => a.ts - b.ts);
  if (pts.length < 2) return null;
  const kmhOf = (p) => (Number.isFinite(p.speed) && p.speed >= 0 && p.speed <= TRIP_MAX_KMH ? p.speed : null);
  let m = 0;
  let movingS = 0;
  let firstMove = null;
  let lastMove = null;
  let max = null;
  let still = null; // the standing stretch under way: { from, to, lat, lon }
  const stops = [];
  const bandS = SPEED_BANDS.map(() => 0);
  const segments = []; // [{ band, latlngs }], in order along the route
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const speed = kmhOf(p);
    if (speed !== null && (!max || speed > max.kmh)) max = { kmh: speed, ts: p.ts, lat: p.lat, lon: p.lon };
    if (i === 0) continue;
    const prev = pts[i - 1];
    const dt = (p.ts - prev.ts) / 1000;
    if (dt <= 0) continue;
    const prevSpeed = kmhOf(prev);
    const d = distanceM(prev, p);
    const kmh = (d / dt) * 3.6;
    // Points a few seconds apart: the GPS speed says best whether it moved; further apart (an older
    // board, a stop), how far it went meanwhile. Same rule as the server.
    const close = dt <= 30 && speed !== null && prevSpeed !== null;
    const moving = (close ? Math.max(speed, prevSpeed) >= TRIP_MOVING_KMH : kmh >= TRIP_MOVING_KMH) && kmh <= TRIP_MAX_KMH;
    const band = moving ? speedBand(close ? (speed + prevSpeed) / 2 : kmh) : 0;
    if (moving) {
      const t = Math.min(dt, 600);
      m += d;
      movingS += t;
      bandS[band] += t;
      if (still && firstMove !== null && still.to - still.from >= STOP_MIN_S * 1000) stops.push(still);
      still = null;
      if (firstMove === null) firstMove = prev.ts;
      lastMove = p.ts;
    } else if (still) {
      still.to = p.ts;
    } else {
      still = { from: prev.ts, to: p.ts, lat: prev.lat, lon: prev.lon };
    }
    const last = segments[segments.length - 1];
    if (last && last.band === band) last.latlngs.push([p.lat, p.lon]);
    else segments.push({ band, latlngs: [[prev.lat, prev.lon], [p.lat, p.lon]] });
  }
  const totalS = firstMove !== null ? (lastMove - firstMove) / 1000 : 0;
  return {
    start: pts[0].ts,
    end: pts[pts.length - 1].ts,
    m,
    movingS,
    totalS,
    stoppedS: Math.max(0, totalS - movingS),
    avg: movingS >= 10 ? (m / movingS) * 3.6 : null,
    max,
    stops: stops.map((s) => ({ ...s, s: (s.to - s.from) / 1000 })),
    bandS,
    segments,
    points: pts.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, kmh: kmhOf(p) })),
  };
}

// 3′ under an hour, 1 ώ 05′ above: for stops and the time in each band.
export function minutesText(seconds) {
  const total = Math.max(1, Math.round((seconds ?? 0) / 60));
  const h = Math.floor(total / 60);
  return h ? `${h} ώ ${String(total % 60).padStart(2, '0')}′` : `${total}′`;
}

const timeFmt = new Intl.DateTimeFormat('el-GR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// The speed over the whole ride: one line, gridlines every 50 (or 25, 10 for slow rides), the top
// speed marked, and a crosshair that follows the finger or the mouse (or the arrow keys).
function drawSpeedChart(svg, details) {
  const pts = details.points.filter((p) => p.kmh !== null);
  svg.replaceChildren();
  if (pts.length < 2) return null;
  const W = Math.max(240, Math.round(svg.getBoundingClientRect().width || 320));
  const H = 196;
  const pad = { l: 34, r: 12, t: 50, b: 24 }; // room on top for the readout of the crosshair
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const top = Math.max(details.max?.kmh ?? 0, 10);
  const step = top > 120 ? 50 : top > 60 ? 25 : 10;
  const yMax = Math.ceil(top / step) * step;
  const x = (ts) => pad.l + ((ts - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (kmh) => H - pad.b - (kmh / yMax) * (H - pad.t - pad.b);
  for (let v = 0; v <= yMax; v += step) {
    svg.append(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
    const label = svgEl('text', { x: pad.l - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' });
    label.textContent = String(v);
    svg.append(label);
  }
  for (const [ts, anchor] of [[t0, 'start'], [(t0 + t1) / 2, 'middle'], [t1, 'end']]) {
    const label = svgEl('text', { x: x(ts), y: H - 6, class: 'tick', 'text-anchor': anchor });
    label.textContent = clockFmt.format(new Date(ts));
    svg.append(label);
  }
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.kmh).toFixed(1)}`).join('');
  svg.append(svgEl('path', { d: `${line}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`, class: 'area' }));
  svg.append(svgEl('path', { d: line, class: 'line' }));
  if (details.max) {
    const mx = x(details.max.ts);
    const my = y(details.max.kmh);
    svg.append(svgEl('circle', { cx: mx, cy: my, r: 4, class: 'peak' }));
    const label = svgEl('text', {
      x: mx,
      y: Math.max(12, my - 8),
      class: 'peak-label',
      'text-anchor': mx > W - 40 ? 'end' : mx < pad.l + 30 ? 'start' : 'middle',
    });
    label.textContent = `μέγ. ${Math.round(details.max.kmh)}`;
    svg.append(label);
  }
  const cross = svgEl('line', { x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, class: 'cross', visibility: 'hidden' });
  const dot = svgEl('circle', { cx: 0, cy: 0, r: 5, class: 'cross-dot', visibility: 'hidden' });
  svg.append(cross, dot);
  return { pts, x, y, W, cross, dot };
}

// The ride whose card is open, its drawn chart, and where the crosshair stands (-1: nowhere).
const shown = { current: null, chart: null, index: -1, onScrub: () => {} };

function scrubShow(i) {
  const chart = shown.chart;
  if (!chart) return;
  shown.index = Math.max(0, Math.min(chart.pts.length - 1, i));
  const p = chart.pts[shown.index];
  const cx = chart.x(p.ts);
  const cy = chart.y(p.kmh);
  chart.cross.setAttribute('x1', cx.toFixed(1));
  chart.cross.setAttribute('x2', cx.toFixed(1));
  chart.dot.setAttribute('cx', cx.toFixed(1));
  chart.dot.setAttribute('cy', cy.toFixed(1));
  chart.cross.setAttribute('visibility', 'visible');
  chart.dot.setAttribute('visibility', 'visible');
  const tip = $('trip-tip');
  tip.querySelector('strong').textContent = `${Math.round(p.kmh)} χλμ/ώ`;
  tip.querySelector('span').textContent = timeFmt.format(new Date(p.ts));
  tip.hidden = false;
  const width = $('trip-chart').getBoundingClientRect().width;
  const px = (cx / chart.W) * width;
  tip.style.left = `${Math.min(Math.max(px, 52), width - 52)}px`;
  shown.onScrub(p);
}

function scrubHide() {
  const chart = shown.chart;
  shown.index = -1;
  if (chart) {
    chart.cross.setAttribute('visibility', 'hidden');
    chart.dot.setAttribute('visibility', 'hidden');
  }
  $('trip-tip').hidden = true;
  shown.onScrub(null);
}

// The point of the line closest to the pointer, left to right.
function nearestIndex(clientX) {
  const chart = shown.chart;
  const box = $('trip-chart').getBoundingClientRect();
  const vx = ((clientX - box.left) / box.width) * chart.W;
  let lo = 0;
  let hi = chart.pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chart.x(chart.pts[mid].ts) < vx) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(chart.x(chart.pts[lo - 1].ts) - vx) < Math.abs(chart.x(chart.pts[lo].ts) - vx)) lo -= 1;
  return lo;
}

function drawTripChart() {
  if (!shown.current) return;
  const svg = $('trip-chart');
  shown.chart = drawSpeedChart(svg, shown.current.details);
  $('trip-chart-wrap').hidden = !shown.chart;
  shown.index = -1;
  $('trip-tip').hidden = true;
}

function renderBands(details) {
  const total = details.bandS.reduce((a, b) => a + b, 0);
  const bar = $('trip-bands-bar');
  const legend = $('trip-bands-legend');
  bar.replaceChildren();
  legend.replaceChildren();
  $('trip-bands').hidden = total < 60;
  if (total < 60) return;
  details.bandS.forEach((s, i) => {
    if (s <= 0) return;
    const share = Math.round((s / total) * 100);
    const text = `${SPEED_BANDS[i].label} χλμ/ώ: ${minutesText(s)} (${share}%)`;
    const seg = document.createElement('span');
    seg.className = `band b${i}`;
    seg.style.flexGrow = String(s);
    seg.title = text;
    bar.append(seg);
    const item = document.createElement('li');
    const key = document.createElement('i');
    key.className = `band b${i}`;
    key.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = SPEED_BANDS[i].label;
    const value = document.createElement('strong');
    value.textContent = `${minutesText(s)} · ${share}%`;
    item.append(key, label, value);
    legend.append(item);
  });
}

/**
 * The card under the map for the ride drawn on it. `onScrub(point | null)` moves a marker on the
 * map along with the finger on the speed line; `onClose()` takes the ride off the map.
 */
export function showTripCard(summary, details, { onScrub, onClose }) {
  shown.current = { summary, details };
  shown.onScrub = onScrub ?? (() => {});
  $('trip-card').hidden = false;
  $('trip-title').textContent = tripTitle(summary);
  $('trip-km').textContent = kmText(summary.m ?? details.m);
  $('trip-moving').textContent = durationText(summary.movingS ?? details.movingS);
  $('trip-total').textContent = durationText(details.totalS);
  $('trip-stopped').textContent = details.stoppedS >= 60 ? `${minutesText(details.stoppedS)} σταματημένη` : '';
  const avg = summary.avg ?? details.avg;
  $('trip-avg').textContent = avg ? `${speedText(avg)} χλμ/ώ` : '—';
  const top = summary.max ?? details.max?.kmh;
  $('trip-max').textContent = top ? `${speedText(top)} χλμ/ώ` : '—';
  $('trip-max-at').textContent = details.max ? `στις ${clockFmt.format(new Date(details.max.ts))}` : '';
  $('trip-stops').textContent = details.stops.length ? String(details.stops.length) : 'καμία';
  $('trip-stops-list').textContent = details.stops.length
    ? `Στάσεις πάνω από ένα λεπτό: ${details.stops
        .slice(0, 8)
        .map((s) => `${clockFmt.format(new Date(s.from))} για ${minutesText(s.s)}`)
        .join(', ')}${details.stops.length > 8 ? ' και άλλες' : ''}. Στον χάρτη είναι οι λευκές κουκκίδες.`
    : 'Καμία στάση πάνω από ένα λεπτό (τα φανάρια δεν μετράνε).';
  $('trip-chart').setAttribute(
    'aria-label',
    `Η ταχύτητα σε όλη τη διαδρομή${details.max ? `, μέγιστη ${Math.round(details.max.kmh)} χλμ/ώ στις ${clockFmt.format(new Date(details.max.ts))}` : ''}. Με τα βελάκια μετακινείσαι πάνω της.`,
  );
  renderBands(details);
  drawTripChart();
  $('btn-trip-close').onclick = onClose;
}

export function hideTripCard() {
  shown.current = null;
  shown.chart = null;
  shown.index = -1;
  $('trip-card').hidden = true;
}

export function setupTripCard() {
  const svg = $('trip-chart');
  svg.addEventListener('pointerdown', (e) => shown.chart && scrubShow(nearestIndex(e.clientX)));
  svg.addEventListener('pointermove', (e) => shown.chart && scrubShow(nearestIndex(e.clientX)));
  // A finger lifted leaves the marker where it was; the mouse leaving the line takes it away.
  svg.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && scrubHide());
  svg.addEventListener('blur', () => scrubHide());
  svg.addEventListener('keydown', (e) => {
    const chart = shown.chart;
    if (!chart) return;
    const step = Math.max(1, Math.round(chart.pts.length / 60));
    if (e.key === 'ArrowRight') scrubShow(shown.index < 0 ? 0 : shown.index + step);
    else if (e.key === 'ArrowLeft') scrubShow(shown.index < 0 ? chart.pts.length - 1 : shown.index - step);
    else if (e.key === 'Home') scrubShow(0);
    else if (e.key === 'End') scrubShow(chart.pts.length - 1);
    else if (e.key === 'Escape') scrubHide();
    else return;
    e.preventDefault();
  });
  let pending = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      if (shown.current && shown.index >= 0) scrubHide();
      drawTripChart();
    });
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
