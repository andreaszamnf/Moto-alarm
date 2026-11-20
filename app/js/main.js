import { api, AuthError, getToken, setToken } from './api.js';
import { crashEventText, initCrash, renderCrash } from './crash.js';
import { confirmArmWhileLent, extraEventText, initExtras, onSettingsPage, renderExtras } from './extras.js';
import { renderRideCard, rideEventText, setupRides, setupSpeedo } from './ride.js';
import { scriptableScript } from './scriptable.js';
import { initService, loadService } from './service.js';

const POLL_MS = 15_000;
const POLL_ALARM_MS = 4_000;
const POLL_RIDE_MS = 5_000; // the board reports every 15 seconds while riding
const FRESH_MS = 10 * 60_000;
const DEFAULT_VIEW = [37.9838, 23.7275];

const ERRORS = {
  push_not_configured: 'Οι ειδοποιήσεις δεν έχουν ρυθμιστεί ακόμα στον server.',
  too_many_attempts: 'Πολλές λάθος προσπάθειες. Δοκίμασε ξανά σε 15 λεπτά.',
  server_error: 'Σφάλμα στον server.',
  bad_ssid: 'Το όνομα του Wi-Fi θέλει 1 έως 32 λατινικούς χαρακτήρες.',
  bad_wifi_password: 'Ο κωδικός θέλει 8 έως 63 λατινικούς χαρακτήρες (ή κενό για ανοιχτό δίκτυο).',
  too_many_wifi: 'Χωράνε έως 5 δίκτυα. Αφαίρεσε πρώτα ένα.',
  bad_phone: 'Ο αριθμός δεν φαίνεται σωστός. Γράψε τον π.χ. 69xxxxxxxx.',
  crash_active: 'Υπάρχει ανοιχτή πτώση αυτή τη στιγμή. Πάτα πρώτα «Είμαι καλά».',
  bad_hours: 'Διάλεξε διάρκεια.',
  bad_pushover_keys: 'Το User Key και το API Token έχουν από 30 γράμματα και αριθμούς. Έλεγξέ τα.',
  pushover_rejected: 'Το Pushover δεν δέχτηκε τα κλειδιά. Έλεγξε το User Key και το API Token.',
  pushover_not_configured: 'Βάλε πρώτα τα κλειδιά του Pushover.',
  pushover_failed: 'Το Pushover δεν απάντησε. Δοκίμασε ξανά.',
  bad_sound: 'Αυτός ο ήχος δεν γίνεται.',
  bad_google_key: 'Το κλειδί της Google ξεκινάει με AIza και έχει 39 γράμματα και αριθμούς. Έλεγξέ το.',
  google_key_invalid: 'Η Google λέει ότι αυτό το κλειδί δεν ισχύει. Αντέγραψέ το ξανά.',
  google_key_not_enabled: 'Ενεργοποίησε το Geolocation API στο project σου στη Google και ξαναδοκίμασε.',
  google_key_billing: 'Η Google θέλει κάρτα στο Billing του project πριν απαντήσει.',
  google_key_quota: 'Το κλειδί έφτασε το όριο αναζητήσεων. Ξαναδοκίμασε αύριο.',
  google_key_other: 'Η Google δεν δέχτηκε το κλειδί. Έλεγξε τα βήματα και ξαναδοκίμασε.',
  google_key_unreachable: 'Η Google δεν απάντησε. Ξαναδοκίμασε σε λίγο.',
  'Failed to fetch': 'Δεν υπάρχει σύνδεση με τον server.',
};
const ALARM_REASON = { motion: 'κίνηση', moved: 'μετακίνηση', tamper: 'παραβίαση συσκευής', power: 'κόπηκε το ρεύμα' };
const SHARE_LABEL = { 1: '1 ώρα', 24: '24 ώρες', 72: '3 μέρες' };

const $ = (id) => document.getElementById(id);

const state = {
  snap: null,
  events: [],
  clockOffset: 0,
  following: false,
  lastAlarmSince: null,
  eventsOpen: false,
  timer: null,
  busy: false,
};

// ---------- formatting ----------
const clockFmt = new Intl.DateTimeFormat('el-GR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('el-GR', { day: 'numeric', month: 'short' });
const serverNow = () => Date.now() + state.clockOffset;

function formatTime(ts) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? clockFmt.format(d) : `${dayFmt.format(d)} ${clockFmt.format(d)}`;
}

function timeAgo(ts) {
  const seconds = Math.max(0, (serverNow() - ts) / 1000);
  if (seconds < 45) return 'μόλις τώρα';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `πριν ${minutes} λεπτ${minutes === 1 ? 'ό' : 'ά'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `πριν ${hours} ώρ${hours === 1 ? 'α' : 'ες'}`;
  const days = Math.round(hours / 24);
  return `πριν ${days} μέρ${days === 1 ? 'α' : 'ες'}`;
}

function batteryLabel(batt) {
  if (batt?.pct != null) return `${batt.pct}%`;
  if (batt?.mv != null) return `${(batt.mv / 1000).toFixed(2).replace('.', ',')} V`;
  return '—';
}

function signalLabel(rssi) {
  if (rssi == null) return '—';
  if (rssi >= -85) return 'Καλό';
  if (rssi >= -100) return 'Μέτριο';
  return 'Αδύναμο';
}

// Wi-Fi in dBm: about -50 is next to the router, -80 is where it starts to drop.
function wifiSignalLabel(rssi) {
  if (rssi == null) return '—';
  if (rssi >= -67) return 'Καλό';
  if (rssi >= -78) return 'Μέτριο';
  return 'Αδύναμο';
}

// How the board got through the last time: how well it heard the network, and which one.
function signalText(device) {
  if (!device?.lastSeen || !device.via) return signalLabel(device?.rssi);
  return device.via === 'wifi' ? wifiSignalLabel(device.wifiRssi) : signalLabel(device.rssi);
}

// Empty for reports from before the server kept the network (device.via missing).
function networkText(device) {
  if (!device?.lastSeen || !device.via) return '';
  if (device.via === 'wifi') return device.wifiName ? `Wi-Fi «${device.wifiName}»` : 'Wi-Fi';
  return '4G';
}

function eventText(e) {
  switch (e.type) {
    case 'alarm':
      return e.data?.reason === 'moved' && e.data?.metres
        ? `Συναγερμός: μετακίνηση ${e.data.metres} μ.`
        : `Συναγερμός: ${ALARM_REASON[e.data?.reason] ?? 'κίνηση'}`;
    case 'armed':
      if (e.data?.by === 'schedule') return 'Οπλίστηκε (πρόγραμμα)';
      if (e.data?.by === 'park') return 'Οπλίστηκε μόνος του (πάρκαρες)';
      return 'Οπλίστηκε';
    case 'disarmed':
      if (e.data?.by === 'loan') return 'Αφοπλίστηκε (δανεική)';
      return e.data?.by === 'schedule' ? 'Αφοπλίστηκε (πρόγραμμα)' : 'Αφοπλίστηκε';
    case 'acked': return e.data?.via === 'pushover' ? 'Είδες τον συναγερμό (Pushover)' : 'Είδες τον συναγερμό';
    case 'low_battery': return `Χαμηλή μπαταρία (${e.data?.pct}%)`;
    case 'offline': return 'Χάθηκε η επαφή με τη συσκευή';
    case 'parked': return 'Πάρκαρες';
    case 'touch': return 'Κάποιος ακούμπησε τη μηχανή';
    case 'sms': return 'Η συσκευή σού έστειλε SMS';
    case 'call': return 'Η συσκευή σε πήρε τηλέφωνο';
    case 'share': return `Κοινοποίηση θέσης για ${SHARE_LABEL[e.data?.hours] ?? `${e.data?.hours} ώρες`}`;
    case 'share_stop': return 'Σταμάτησε η κοινοποίηση θέσης';
    case 'signal_test': return `Δοκιμή σήματος για ${e.data?.minutes} λεπτά`;
    case 'fw_updated': return `Νέο πρόγραμμα στην πλακέτα: ${e.data?.to}`;
    case 'fw_failed': return `Το πρόγραμμα ${e.data?.v} δεν μπήκε, η πλακέτα κράτησε το παλιό`;
    case 'ride': return rideEventText(e.data);
    case 'restart': return `Η πλακέτα ξεκίνησε από την αρχή: ${RESTART_LABEL[e.data?.rst] ?? `κωδικός ${e.data?.rst}`}`;
    case 'power_lost': return 'Κόπηκε το ρεύμα της μηχανής: η συσκευή δουλεύει από την εφεδρική μπαταρία';
    case 'power_back': return 'Ήρθε πάλι ρεύμα από τη μηχανή';
    default: return extraEventText(e) ?? crashEventText(e) ?? e.type;
  }
}

function alarmBannerText(alarm) {
  if (alarm.reason === 'moved') return 'Η μηχανή μετακινήθηκε από εκεί που την άφησες.';
  if (alarm.reason === 'tamper') return 'Κάποιος πειράζει τη συσκευή.';
  if (alarm.reason === 'power') return 'Κόπηκε το ρεύμα της μηχανής. Η συσκευή συνεχίζει με την εφεδρική μπαταρία.';
  return 'Κάποιος κουνάει τη μηχανή.';
}

// esp_reset_reason() of the board, sent when it starts afresh.
const RESTART_LABEL = {
  1: 'ήρθε ρεύμα (διακόπτης, USB ή επαφή μπαταρίας)',
  2: 'πατήθηκε το κουμπί επανεκκίνησης',
  3: 'νέο πρόγραμμα ή επανεκκίνηση από το ίδιο',
  4: 'σφάλμα προγράμματος',
  5: 'κόλλησε το πρόγραμμα',
  6: 'κόλλησε το πρόγραμμα',
  7: 'κόλλησε το πρόγραμμα',
  9: 'έπεσε η τάση της μπαταρίας',
};

const errorText = (err) => ERRORS[err?.message] ?? err?.message ?? 'Άγνωστο σφάλμα';

// ---------- small UI helpers ----------
let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function setConn(text, tone) {
  const pill = $('conn');
  pill.textContent = text;
  pill.className = `pill pill-${tone}`;
}

function siren() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    gain.gain.value = 0.06;
    osc.connect(gain).connect(ctx.destination);
    for (let i = 0; i < 10; i++) osc.frequency.setValueAtTime(i % 2 ? 660 : 880, ctx.currentTime + i * 0.2);
    osc.start();
    osc.stop(ctx.currentTime + 2);
    osc.onended = () => ctx.close();
  } catch {
    // Audio is blocked until the user interacts with the page.
  }
}

function b64urlToBytes(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '==='.slice((base64.length + 3) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function sameBytes(buffer, bytes) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
}

// ---------- map ----------
let map;
let marker;
let accCircle; // around a rough position from Wi-Fi
let parkCircle;
let trailLine;
let routeLine = null;

// OpenFreeMap: clean vector maps (streets and names only), free and without an API key.
// Light by default; dark, or following the phone's theme, from the settings.
const MAP_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const MAP_PREF = 'moto-alarm.map'; // 'light', 'dark' or 'auto'
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
let baseLayer = null;

function mapPref() {
  try {
    return localStorage.getItem(MAP_PREF) || 'light';
  } catch {
    return 'light';
  }
}

function setBaseLayer() {
  const pref = mapPref();
  const dark = pref === 'dark' || (pref === 'auto' && darkScheme.matches);
  baseLayer?.remove();
  baseLayer = L.maplibreGL({
    style: dark ? MAP_STYLES.dark : MAP_STYLES.light,
    attribution:
      '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
}

function initMap() {
  map = L.map('map', { zoomControl: false }).setView(DEFAULT_VIEW, 13);
  setBaseLayer();
  darkScheme.addEventListener('change', setBaseLayer);
  marker = L.marker(DEFAULT_VIEW, {
    icon: L.divIcon({ className: 'bike-marker', html: '<span></span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
    keyboard: false,
  });
  parkCircle = L.circle(DEFAULT_VIEW, { radius: 100, className: 'park-circle', interactive: false });
  accCircle = L.circle(DEFAULT_VIEW, { radius: 50, className: 'acc-circle', interactive: false });
  trailLine = L.polyline([], { className: 'trail-line', interactive: false });
  map.on('dragstart', () => {
    state.following = false;
    render();
  });
}

function centerOnBike(zoom = 17) {
  const p = state.snap?.position;
  if (p) map.setView([p.lat, p.lon], zoom);
}

// ---------- views ----------
function showLogin(message = '') {
  clearTimeout(state.timer);
  $('main-view').hidden = true;
  $('login-view').hidden = false;
  $('login-msg').textContent = message;
}

function showMain() {
  $('login-view').hidden = true;
  $('main-view').hidden = false;
  if (!map) initMap();
  else map.invalidateSize();
}

function logout(message) {
  setToken(null);
  state.snap = null;
  showLogin(message);
}

// ---------- data ----------
// The ride under way, drawn as it goes: only the points newer than the last ones are fetched.
let rideTrail = { start: null, points: [], lastTs: 0 };

async function refreshTrail() {
  const alarm = state.snap?.alarm;
  const ride = state.snap?.ride;
  if (alarm?.active) {
    const { positions } = await api(`history?from=${alarm.since}`);
    trailLine.setLatLngs(positions.map((p) => [p.lat, p.lon]));
  } else if (ride) {
    if (rideTrail.start !== ride.start) {
      rideTrail = { start: ride.start, points: [], lastTs: ride.start - 1 };
      state.following = true; // a new ride: the map goes along with the bike
    }
    const { positions } = await api(`history?from=${rideTrail.lastTs + 1}`);
    for (const p of positions) rideTrail.points.push([p.lat, p.lon]);
    if (positions.length) rideTrail.lastTs = positions[positions.length - 1].ts;
    trailLine.setLatLngs(rideTrail.points);
  } else {
    rideTrail = { start: null, points: [], lastTs: 0 };
    trailLine.remove();
    return;
  }
  if (!map.hasLayer(trailLine)) trailLine.addTo(map);
}

function schedule() {
  clearTimeout(state.timer);
  if (document.hidden || !getToken()) return;
  const snap = state.snap;
  state.timer = setTimeout(refresh, snap?.alarm?.active || snap?.crash ? POLL_ALARM_MS : snap?.ride ? POLL_RIDE_MS : POLL_MS);
}

async function refresh() {
  try {
    const [snap, { events }] = await Promise.all([api('state'), api('events?limit=30')]);
    state.clockOffset = snap.now - Date.now();
    state.snap = snap;
    state.events = events;
    await refreshTrail();
    render();
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    setConn('Χωρίς σύνδεση', 'bad');
  }
  schedule();
}

async function act(request, okText) {
  state.busy = true;
  render();
  try {
    state.snap = await request();
    if (okText) toast(okText);
    await refresh();
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    toast(`Δεν έγινε: ${errorText(err)}`);
  } finally {
    state.busy = false;
    render();
  }
}

// ---------- rendering ----------
function render() {
  const snap = state.snap;
  if (!snap || !map) return;
  const { armed, alarm, device, position, settings } = snap;

  document.body.classList.toggle('is-armed', armed.armed);
  document.body.classList.toggle('alarm-live', alarm.active && !alarm.acked);

  // In touch = heard from within the time the board is expected to check in (15 minutes while
  // parked, every 30 seconds during an alarm), with some slack for one missed check-in.
  if (!device?.lastSeen) setConn('Καμία επαφή ακόμα', 'off');
  else if (serverNow() - device.lastSeen <= (snap.contactMs ?? FRESH_MS)) setConn(device.via ? `Σε επαφή · ${device.via === 'wifi' ? 'Wi-Fi' : '4G'}` : 'Σε επαφή', 'on');
  else setConn(`Χωρίς επαφή · τελευταία ${timeAgo(device.lastSeen)}`, 'off');

  $('alarm-banner').hidden = !alarm.active;
  if (alarm.active) {
    $('alarm-text').textContent = alarmBannerText(alarm) + (alarm.acked ? ' Το είδες, η παρακολούθηση συνεχίζει.' : '');
    $('btn-ack').hidden = Boolean(alarm.acked);
    if (state.lastAlarmSince !== alarm.since) {
      state.lastAlarmSince = alarm.since;
      if (!alarm.acked) {
        state.following = true;
        navigator.vibrate?.([400, 200, 400, 200, 800]);
        siren();
      }
    }
  } else {
    state.lastAlarmSince = null;
  }

  $('arm-state').textContent = armed.armed ? 'Οπλισμένος' : 'Αφοπλισμένος';
  $('arm-sub').textContent = armed.armed
    ? armed.park
      ? `Σε ειδοποιεί αν κουνηθεί ή απομακρυνθεί πάνω από ${settings.parkRadius} μ.`
      : 'Σε ειδοποιεί αν κουνηθεί. Το σημείο στάθμευσης ορίζεται με την επόμενη θέση της συσκευής.'
    : snap.armOnPark
      ? 'Θα οπλίσει μόλις παρκάρεις (πρόγραμμα).'
      : 'Όπλισέ τον όταν αφήνεις τη μηχανή.';
  $('btn-arm').textContent = armed.armed ? 'Αφοπλισμός' : 'Οπλισμός';
  $('btn-arm').disabled = state.busy;
  $('btn-disarm').disabled = state.busy;

  // On the bike's power (firmware 1.7.0 says so): the backup battery is kept full, so no forecast.
  const onPower = device?.ext === true;
  $('st-battery').textContent = onPower ? 'Στο ρεύμα' : batteryLabel(device?.batt);
  const batterySub = onPower
    ? device?.batt?.pct != null ? `εφεδρική ${device.batt.pct}%` : 'της μηχανής'
    : snap.forecast ? `διαρκεί ${snap.forecast.text}` : '';
  $('st-forecast').hidden = !batterySub;
  $('st-forecast').textContent = batterySub;
  $('share-label').textContent = snap.share ? 'Κοινοποιείται' : 'Κοινοποίηση';
  $('btn-share').setAttribute('aria-pressed', String(Boolean(snap.share)));
  $('st-seen').textContent = device?.lastSeen ? timeAgo(device.lastSeen) : '—';
  $('st-signal').textContent = signalText(device);
  $('st-net').textContent = networkText(device);
  $('st-net').hidden = !networkText(device);
  renderRideCard(snap.ride, serverNow());

  const nav = $('btn-navigate');
  $('map-empty').hidden = Boolean(position);
  if (position) {
    const latLng = [position.lat, position.lon];
    marker.setLatLng(latLng);
    if (!map.hasLayer(marker)) {
      marker.addTo(map);
      map.setView(latLng, 16);
    } else if (state.following) {
      map.panTo(latLng);
    }
    nav.href = `https://www.google.com/maps/dir/?api=1&destination=${position.lat},${position.lon}`;
    nav.setAttribute('aria-disabled', 'false');
  } else {
    marker.remove();
    nav.removeAttribute('href');
    nav.setAttribute('aria-disabled', 'true');
  }

  // A position from Wi-Fi is only roughly right: show how far off it may be.
  const rough = position?.src === 'wifi';
  marker.getElement()?.classList.toggle('is-rough', rough);
  $('map-note').hidden = !rough;
  if (rough) {
    const acc = Math.round(position.acc ?? 100);
    $('map-note').textContent = `Θέση από τα Wi-Fi γύρω της, ${timeAgo(position.ts)} · ακρίβεια περίπου ${acc} μ.`;
    accCircle.setLatLng([position.lat, position.lon]);
    accCircle.setRadius(acc);
    if (!map.hasLayer(accCircle)) accCircle.addTo(map);
  } else {
    accCircle.remove();
  }

  if (armed.armed && armed.park) {
    parkCircle.setLatLng([armed.park.lat, armed.park.lon]);
    parkCircle.setRadius(settings.parkRadius);
    if (!map.hasLayer(parkCircle)) parkCircle.addTo(map);
  } else {
    parkCircle.remove();
  }

  $('btn-follow').setAttribute('aria-pressed', String(state.following));
  $('btn-history').setAttribute('aria-pressed', String(Boolean(routeLine)));
  renderSettings(settings);
  renderPushover();
  renderWifiloc();
  renderWifi();
  renderSummaries();
  renderEvents();
  renderExtras(snap); // lent out, morning summary (after the status texts it may replace)
  renderCrash(snap); // a fall while riding: the red card, and its settings page
}

// Puts the saved settings into the controls, except the one being edited.
function renderSettings(settings) {
  const show = (id, value, prop = 'value') => {
    const el = $(id);
    if (document.activeElement !== el) el[prop] = value;
  };
  show('set-sensitivity', String(settings.sensitivity ?? 2));
  show('set-touch', Boolean(settings.touchAlerts), 'checked');
  show('set-radius', String(settings.parkRadius));
  show('set-offline', Boolean(settings.offlineAlert), 'checked');
  show('set-park', settings.parkAction ?? 'remind');
  show('set-schedule', Boolean(settings.schedule?.on), 'checked');
  show('set-arm-time', settings.schedule?.arm ?? '');
  show('set-disarm-time', settings.schedule?.disarm ?? '');
  $('set-arm-time').disabled = !settings.schedule?.on; // the times matter only with the schedule on
  $('set-disarm-time').disabled = !settings.schedule?.on;
  show('set-phone', settings.callNumber ?? '');
}

const EVENTS_SHOWN = 5; // the rest behind "Όλα"

function renderEvents() {
  const more = state.events.length > EVENTS_SHOWN;
  $('btn-events-more').hidden = !more;
  $('btn-events-more').textContent = state.eventsOpen ? 'Λιγότερα' : 'Όλα';
  const shown = state.eventsOpen ? state.events : state.events.slice(0, EVENTS_SHOWN);
  const items = shown.map((e) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = new Date(e.ts).toISOString();
    time.textContent = formatTime(e.ts);
    const text = document.createElement('span');
    text.textContent = eventText(e);
    if (e.type === 'alarm') text.className = 'is-alarm';
    li.append(time, text);
    return li;
  });
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Τίποτα ακόμα.';
    items.push(li);
  }
  $('events').replaceChildren(...items);
}

$('btn-events-more').addEventListener('click', () => {
  state.eventsOpen = !state.eventsOpen;
  renderEvents();
});

// ---------- notifications ----------
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function pushStatus() {
  if (!pushSupported) return isIos && !isStandalone ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

async function renderPushCard() {
  const status = await pushStatus().catch(() => 'unsupported');
  $('push-card').hidden = status === 'on';
  $('btn-push').hidden = status !== 'off';
  $('btn-push-settings').textContent = status === 'on' ? 'Οι ειδοποιήσεις είναι ενεργές' : 'Ενεργοποίηση ειδοποιήσεων';
  $('btn-push-settings').disabled = status !== 'off';
  $('btn-push-settings').hidden = status === 'on';
  $('sum-alerts').textContent = {
    on: 'Ενεργές',
    off: 'Κλειστές',
    denied: 'Μπλοκαρισμένες',
    'ios-install': 'Θέλει την εφαρμογή στην αρχική οθόνη',
    unsupported: 'Δεν υποστηρίζονται εδώ',
  }[status] ?? '';
  $('push-state').textContent = {
    on: 'Οι ειδοποιήσεις είναι ενεργές σε αυτό το κινητό.',
    off: 'Οι ειδοποιήσεις είναι κλειστές σε αυτό το κινητό.',
    denied: 'Οι ειδοποιήσεις είναι μπλοκαρισμένες. Επίτρεψέ τες από τις ρυθμίσεις του κινητού για αυτή την εφαρμογή.',
    'ios-install': 'Στο iPhone: πάτα Κοινοποίηση και «Προσθήκη στην οθόνη Αφετηρίας», και άνοιξε την εφαρμογή από εκεί.',
    unsupported: 'Αυτός ο browser δεν υποστηρίζει ειδοποιήσεις.',
  }[status] ?? '';
  $('push-text').textContent = {
    off: 'Ενεργοποίησε τις ειδοποιήσεις για να μαθαίνεις αμέσως αν κάποιος πειράξει τη μηχανή.',
    denied: 'Οι ειδοποιήσεις είναι μπλοκαρισμένες. Επίτρεψέ τες από τις ρυθμίσεις του browser για αυτή τη σελίδα.',
    'ios-install': 'Στο iPhone: πάτα Κοινοποίηση και «Προσθήκη στην οθόνη Αφετηρίας», μετά άνοιξε την εφαρμογή από εκεί για να ενεργοποιήσεις τις ειδοποιήσεις.',
    unsupported: 'Αυτός ο browser δεν υποστηρίζει ειδοποιήσεις.',
  }[status] ?? '';
}

async function enablePush() {
  try {
    if ((await Notification.requestPermission()) !== 'granted') {
      toast('Δεν δόθηκε άδεια για ειδοποιήσεις.');
      return;
    }
    const key = b64urlToBytes((await api('push/key')).key);
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameBytes(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('push/subscribe', { method: 'POST', body: sub.toJSON() });
    toast('Οι ειδοποιήσεις ενεργοποιήθηκαν.');
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    toast(`Δεν ενεργοποιήθηκαν οι ειδοποιήσεις: ${errorText(err)}`);
  } finally {
    renderPushCard();
  }
}

// ---------- events ----------
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  $('login-msg').textContent = 'Σύνδεση…';
  try {
    const { token } = await api('login', { method: 'POST', body: { password: form.elements.password.value } });
    setToken(token);
    form.reset();
    await start();
  } catch (err) {
    $('login-msg').textContent = err instanceof AuthError ? 'Λάθος κωδικός.' : errorText(err);
  } finally {
    button.disabled = false;
  }
});

$('btn-arm').addEventListener('click', () => {
  const armed = !state.snap?.armed?.armed;
  if (armed && !confirmArmWhileLent()) return;
  act(() => api('arm', { method: 'POST', body: { armed } }), armed ? 'Ο συναγερμός οπλίστηκε.' : 'Ο συναγερμός αφοπλίστηκε.');
});

$('btn-disarm').addEventListener('click', () => {
  act(() => api('arm', { method: 'POST', body: { armed: false } }), 'Ο συναγερμός αφοπλίστηκε.');
});

$('btn-ack').addEventListener('click', () => act(() => api('alarm/ack', { method: 'POST' })));

$('btn-locate').addEventListener('click', async () => {
  const tracking = state.snap?.armed?.armed && state.snap?.alarm?.active;
  await act(
    () => api('locate', { method: 'POST' }),
    tracking
      ? 'Η θέση ανανεώνεται κάθε 30 δευτερόλεπτα.'
      : 'Θα έρθει με την επόμενη επικοινωνία της συσκευής. Όταν είναι παρκαρισμένη μπορεί να αργήσει μερικές ώρες.',
  );
  centerOnBike();
});

$('btn-history').addEventListener('click', async () => {
  if (routeLine) {
    routeLine.remove();
    routeLine = null;
    render();
    return;
  }
  try {
    const { positions } = await api(`history?from=${serverNow() - 24 * 3_600_000}`);
    if (positions.length < 2) {
      toast('Δεν υπάρχουν διαδρομές το τελευταίο 24ωρο.');
      return;
    }
    routeLine = L.polyline(positions.map((p) => [p.lat, p.lon]), { className: 'route-line', interactive: false }).addTo(map);
    state.following = false;
    map.fitBounds(routeLine.getBounds(), { padding: [28, 28] });
    render();
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    toast(`Δεν φορτώθηκε το ιστορικό: ${errorText(err)}`);
  }
});

// One past ride on the map (the history button clears it, like the 24-hour routes).
async function showTrip(trip) {
  try {
    const { positions } = await api(`history?from=${trip.start}&to=${trip.end}`);
    if (positions.length < 2) {
      toast('Τα σημεία αυτής της διαδρομής δεν υπάρχουν πια (κρατιούνται 90 μέρες).');
      return;
    }
    routeLine?.remove();
    routeLine = L.polyline(positions.map((p) => [p.lat, p.lon]), { className: 'route-line', interactive: false }).addTo(map);
    state.following = false;
    map.fitBounds(routeLine.getBounds(), { padding: [28, 28] });
    render();
    $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    toast(`Δεν φορτώθηκε η διαδρομή: ${errorText(err)}`);
  }
}

setupRides({
  load: () => api('rides'),
  show: showTrip,
  onError: (err) => {
    if (err instanceof AuthError) logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    return `Δεν φορτώθηκαν: ${errorText(err)}`;
  },
});
setupSpeedo();

$('btn-follow').addEventListener('click', () => {
  state.following = !state.following;
  if (state.following) centerOnBike();
  render();
});

$('btn-recenter').addEventListener('click', () => centerOnBike());
$('btn-push').addEventListener('click', enablePush);
$('btn-push-settings').addEventListener('click', enablePush);

// ---------- settings: a list of topics, and one page for each ----------
const PAGE_TITLES = {
  alarm: 'Συναγερμός',
  auto: 'Αυτόματη όπλιση',
  alerts: 'Ειδοποιήσεις',
  pushover: 'Δυνατός συναγερμός',
  sms: 'SMS',
  crash: 'Ατύχημα',
  quick: 'Κουμπιά και widget',
  signal: 'Δοκιμή σήματος',
  map: 'Χάρτης',
  wifiloc: 'Θέση χωρίς GPS',
  wifi: 'Wi-Fi της πλακέτας',
  loan: 'Δανεική / συνεργείο',
  folder: 'Φάκελος κλοπής',
  morning: 'Πρωινή σύνοψη',
};
const SENSITIVITY_LABEL = { 1: 'Χαμηλή', 2: 'Μεσαία', 3: 'Υψηλή' };
const PARK_LABEL = { remind: 'Υπενθύμιση όταν παρκάρεις', arm: 'Οπλίζει μόλις παρκάρεις', none: 'Μόνο με το χέρι' };
const MAP_LABEL = { light: 'Ανοιχτός', dark: 'Σκούρος', auto: 'Όπως το κινητό' };

function showSettingsPage(page = null) {
  for (const section of document.querySelectorAll('.settings-page')) section.hidden = section.dataset.page !== page;
  $('settings-menu').hidden = Boolean(page);
  $('settings-back').hidden = !page;
  $('settings-title').textContent = page ? PAGE_TITLES[page] : 'Ρυθμίσεις';
  $('settings-msg').textContent = '';
  $('settings').scrollTop = 0;
  if (page === 'pushover') loadSounds();
  if (page === 'quick') renderQuick();
  watchSignal(page === 'signal');
  onSettingsPage(page);
}

// One line under each topic, so the list shows what is set without opening it.
function renderSummaries() {
  const s = state.snap?.settings;
  if (!s) return;
  $('sum-alarm').textContent = `${SENSITIVITY_LABEL[s.sensitivity] ?? 'Μεσαία'} ευαισθησία · ${s.parkRadius} μ.${s.touchAlerts ? ' · ακουμπήματα' : ''}`;
  const times = [s.schedule?.arm, s.schedule?.disarm].filter(Boolean).join('–');
  $('sum-auto').textContent = `${PARK_LABEL[s.parkAction] ?? PARK_LABEL.remind}${s.schedule?.on ? ` · πρόγραμμα ${times}` : ''}`;
  $('sum-pushover').textContent = state.snap.pushover ? 'Ενεργός, με Pushover' : 'Κλειστός';
  $('sum-sms').textContent = s.callNumber ? `Στο ${s.callNumber}` : 'Κλειστά';
  $('sum-quick').textContent = loadQuick() ? 'Έτοιμα' : 'Δεν έχουν φτιαχτεί';
  $('sum-map').textContent = MAP_LABEL[mapPref()] ?? MAP_LABEL.light;
  $('sum-wifiloc').textContent = state.snap.wifiloc?.google ? 'Από Wi-Fi, με Google' : 'Από Wi-Fi, δωρεάν υπηρεσία';
  const nets = state.snap.wifi?.names ?? [];
  $('sum-wifi').textContent = nets.length ? nets.join(', ') : 'Μόνο όσα μπήκαν από τον υπολογιστή';
  const fw = state.snap.firmware;
  $('fw-line').hidden = !fw?.running;
  $('fw-line').textContent = fw?.running
    ? `Πρόγραμμα πλακέτας ${fw.running}${fw.coming ? ` · το ${fw.coming} μπαίνει στην επόμενη ήσυχη επικοινωνία` : ''}`
    : '';
  const signal = state.snap.signal;
  $('sum-signal').textContent = signal?.test
    ? `Σε εξέλιξη ως ${clockFmt.format(new Date(signal.test))}`
    : signal?.last
      ? signalLine(signal.last)
      : 'Καμία μέτρηση ακόμα';
}

// ---------- signal test ----------
const TECH_LABEL = { LTE: '4G', '3G': '3G', GSM: '2G' };

// LTE signal power (RSRP) if the device sent it, otherwise the plain signal strength.
function signalQuality(entry) {
  if (typeof entry.rsrp === 'number') {
    const v = entry.rsrp; // dBm: the server turns the modem's tenths into dBm
    return { word: v >= -90 ? 'καλό' : v >= -105 ? 'μέτριο' : v >= -115 ? 'αδύναμο' : 'πολύ αδύναμο', dbm: Math.round(v) };
  }
  if (typeof entry.rssi === 'number') {
    const v = entry.rssi;
    return { word: v >= -85 ? 'καλό' : v >= -100 ? 'μέτριο' : 'αδύναμο', dbm: v };
  }
  return null;
}

function signalLine(entry) {
  const network = [entry.op, TECH_LABEL[entry.tech] ?? entry.tech].filter(Boolean).join(' ') || 'Δίκτυο άγνωστο';
  const quality = signalQuality(entry);
  const parts = [network];
  if (quality) parts.push(`${quality.word} (${quality.dbm} dBm)`);
  if (entry.reg > 30) parts.push(`βρήκε δίκτυο σε ${entry.reg}″`);
  if (entry.fails) parts.push(`${entry.fails} αποτυχίες πριν`);
  return parts.join(' · ');
}

function renderSignal(view) {
  const test = view.test;
  $('btn-signal-start').hidden = Boolean(test);
  $('btn-signal-stop').hidden = !test;
  const quietMinutes = view.lastSeen ? Math.round((view.now - view.lastSeen) / 60_000) : null;
  let status = 'Δεν τρέχει δοκιμή.';
  if (test) {
    status = `Η δοκιμή τρέχει μέχρι ${clockFmt.format(new Date(test.until))}.`;
    const heardSinceStart = view.lastSeen && view.lastSeen >= test.since;
    if (!heardSinceStart) status += ' Η συσκευή δεν έχει στείλει ακόμα: άναψε ή κούνησε την πλακέτα.';
    else if (quietMinutes >= 6) status += ` ⚠ Καμία αναφορά εδώ και ${quietMinutes} λεπτά: αν είναι αναμμένη, μάλλον δεν πιάνει σήμα εκεί.`;
    else status += ` Τελευταία αναφορά ${timeAgo(view.lastSeen)}.`;
  }
  $('signal-status').textContent = status;
  const items = view.log.map((entry) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = new Date(entry.ts).toISOString();
    time.textContent = formatTime(entry.ts);
    const text = document.createElement('span');
    text.textContent = signalLine(entry);
    li.append(time, text);
    return li;
  });
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Καμία μέτρηση ακόμα.';
    items.push(li);
  }
  $('signal-log').replaceChildren(...items);
}

async function loadSignal() {
  try {
    const view = await api('signal');
    renderSignal(view);
    if (state.snap) state.snap.signal = { test: view.test?.until ?? null, last: view.log[0] ?? null };
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
  }
}

// While the page is open it refreshes by itself, so new measurements show up.
let signalTimer = null;
function watchSignal(on) {
  clearInterval(signalTimer);
  signalTimer = null;
  if (!on) return;
  loadSignal();
  signalTimer = setInterval(loadSignal, 20_000);
}
$('settings').addEventListener('close', () => watchSignal(false));

$('btn-signal-start').addEventListener('click', async () => {
  try {
    renderSignal(await api('signal-test', { method: 'POST', body: { minutes: 60 } }));
    $('settings-msg').textContent = 'Η δοκιμή ξεκίνησε. Άναψε ή κούνησε την πλακέτα.';
    loadSignal();
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('settings-msg').textContent = `Δεν ξεκίνησε: ${errorText(err)}`;
  }
});

$('btn-signal-stop').addEventListener('click', async () => {
  try {
    renderSignal(await api('signal-test/stop', { method: 'POST' }));
    $('settings-msg').textContent = 'Η δοκιμή σταμάτησε. Η συσκευή γυρνάει στο κανονικό στην επόμενη αναφορά της.';
    loadSignal();
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('settings-msg').textContent = `Δεν σταμάτησε: ${errorText(err)}`;
  }
});

for (const row of document.querySelectorAll('.menu-row[data-page]')) {
  row.addEventListener('click', () => showSettingsPage(row.dataset.page));
}
$('settings-back').addEventListener('click', () => showSettingsPage());

$('btn-settings').addEventListener('click', () => {
  $('set-map').value = mapPref();
  showSettingsPage();
  renderSummaries();
  renderPushCard();
  $('settings').showModal();
});

async function saveSettings(patch) {
  try {
    const { settings } = await api('settings', { method: 'POST', body: patch });
    if (state.snap) state.snap.settings = settings;
    $('settings-msg').textContent = 'Αποθηκεύτηκε.';
    render();
  } catch (err) {
    $('settings-msg').textContent = `Δεν αποθηκεύτηκε: ${errorText(err)}`;
    render(); // puts the controls back to the saved values
  }
}

$('set-offline').addEventListener('change', (event) => saveSettings({ offlineAlert: event.currentTarget.checked }));
$('set-radius').addEventListener('change', (event) => saveSettings({ parkRadius: Number(event.currentTarget.value) }));
$('set-sensitivity').addEventListener('change', (event) => saveSettings({ sensitivity: Number(event.currentTarget.value) }));
$('set-touch').addEventListener('change', (event) => saveSettings({ touchAlerts: event.currentTarget.checked }));
$('set-park').addEventListener('change', (event) => saveSettings({ parkAction: event.currentTarget.value }));
for (const id of ['set-schedule', 'set-arm-time', 'set-disarm-time']) {
  $(id).addEventListener('change', () =>
    saveSettings({ schedule: { on: $('set-schedule').checked, arm: $('set-arm-time').value, disarm: $('set-disarm-time').value } }),
  );
}
$('btn-phone').addEventListener('click', () => saveSettings({ callNumber: $('set-phone').value }));
$('set-map').addEventListener('change', (event) => {
  try {
    localStorage.setItem(MAP_PREF, event.currentTarget.value);
  } catch {
    // Private mode: the choice lasts until the app is closed.
  }
  setBaseLayer();
  renderSummaries();
});

$('btn-push-test').addEventListener('click', async () => {
  try {
    await api('push/test', { method: 'POST' });
    $('settings-msg').textContent = 'Στάλθηκε. Θα έρθει σε λίγα δευτερόλεπτα αν οι ειδοποιήσεις είναι ενεργές.';
  } catch (err) {
    $('settings-msg').textContent = errorText(err);
  }
});

// ---------- home-screen buttons (Shortcuts / Scriptable) ----------
// The key is remembered on this phone, because iOS often reloads the app while you are
// in the Shortcuts app, and making a new key would break the shortcuts already made.
const QUICK_STORE = 'moto-alarm.quick';
let quick = null; // { key, created }

function loadQuick() {
  try {
    return JSON.parse(localStorage.getItem(QUICK_STORE)) ?? null;
  } catch {
    return null;
  }
}

function saveQuick(value) {
  quick = value;
  try {
    if (value) localStorage.setItem(QUICK_STORE, JSON.stringify(value));
    else localStorage.removeItem(QUICK_STORE);
  } catch {
    // Private mode: the links still work until the app is closed.
  }
}

const quickUrl = (action) => `${location.origin}/api/quick?key=${quick.key}&action=${action}`;

function showQuick(text = '') {
  $('quick-links').hidden = !quick;
  $('btn-quick').textContent = quick ? 'Φτιάξε καινούριους συνδέσμους' : 'Φτιάξε συνδέσμους';
  $('quick-msg').textContent = text;
  $('quick-fallback').hidden = true;
  renderSummaries();
}

async function renderQuick() {
  quick = loadQuick();
  try {
    const { created } = await api('quick-key');
    if (quick && quick.created !== created) saveQuick(null);
    showQuick(!quick && created ? 'Υπάρχουν σύνδεσμοι από άλλη συσκευή. Δουλεύουν, αλλά δεν φαίνονται εδώ.' : '');
  } catch {
    showQuick();
  }
}

// Copies text; if the browser refuses, shows it in `fallback` selected, for copying by hand.
async function copyText(text, button, fallback = $('quick-fallback')) {
  button.dataset.label ??= button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    if (fallback.tagName === 'TEXTAREA') fallback.hidden = true;
    button.textContent = 'Αντιγράφηκε ✓';
    setTimeout(() => { button.textContent = button.dataset.label; }, 2000);
  } catch {
    // Clipboard blocked: show the text so it can be copied by hand.
    fallback.value = text;
    fallback.hidden = false;
    fallback.select();
  }
}

$('btn-quick').addEventListener('click', async () => {
  if (quick && !confirm('Τα κουμπιά που έφτιαξες με τους παλιούς συνδέσμους θα σταματήσουν να δουλεύουν. Συνέχεια;')) return;
  try {
    saveQuick(await api('quick-key', { method: 'POST' }));
    showQuick('Οι σύνδεσμοι είναι έτοιμοι.');
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('quick-msg').textContent = `Δεν έγινε: ${errorText(err)}`;
  }
});

$('btn-quick-revoke').addEventListener('click', async () => {
  if (!confirm('Τα κουμπιά στην αρχική οθόνη θα σταματήσουν να δουλεύουν. Συνέχεια;')) return;
  try {
    await api('quick-key/revoke', { method: 'POST' });
    saveQuick(null);
    showQuick('Οι σύνδεσμοι σβήστηκαν. Τα κουμπιά δεν δουλεύουν πια.');
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('quick-msg').textContent = `Δεν έγινε: ${errorText(err)}`;
  }
});

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', () => copyText(quickUrl(button.dataset.copy), button));
}

$('btn-scriptable').addEventListener('click', (event) => {
  copyText(scriptableScript(location.origin, quick.key), event.currentTarget);
});

// ---------- loud alarm through Pushover ----------
function renderPushover() {
  const on = Boolean(state.snap?.pushover);
  $('pushover-state').innerHTML = on ? '<strong>Ενεργό ✓</strong>' : '<strong>Ανενεργό</strong>';
  $('btn-po-test').disabled = !on;
  $('btn-po-off').hidden = !on;
  $('po-sound-row').hidden = !on;
}

// The sounds Pushover offers, including any the user uploaded there.
async function loadSounds() {
  if (!state.snap?.pushover) return;
  try {
    const { sounds, current } = await api('pushover/sounds');
    $('po-sound').replaceChildren(...sounds.map(({ id, name }) => new Option(name, id, false, id === current)));
    $('po-sound').value = current;
  } catch {
    // leave the list as it was
  }
}

$('po-sound').addEventListener('change', async (event) => {
  try {
    await api('pushover/sound', { method: 'POST', body: { sound: event.currentTarget.value } });
    $('settings-msg').textContent = 'Αποθηκεύτηκε. Πάτα «Δοκιμή» για να τον ακούσεις.';
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('settings-msg').textContent = `Δεν αποθηκεύτηκε: ${errorText(err)}`;
  }
});

async function savePushover(user, token, doneText) {
  try {
    const { pushover } = await api('pushover', { method: 'POST', body: { user, token } });
    if (state.snap) state.snap.pushover = pushover;
    $('po-user').value = '';
    $('po-token').value = '';
    renderPushover();
    renderSummaries();
    loadSounds();
    $('settings-msg').textContent = doneText;
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('settings-msg').textContent = `Δεν αποθηκεύτηκε: ${errorText(err)}`;
  }
}

$('btn-po-save').addEventListener('click', () =>
  savePushover($('po-user').value.trim(), $('po-token').value.trim(), 'Αποθηκεύτηκε. Πάτα «Δοκιμή» για να ακούσεις πώς χτυπάει.'),
);

$('btn-po-off').addEventListener('click', () => {
  if (confirm('Να σταματήσει ο δυνατός συναγερμός μέσω Pushover;')) savePushover('', '', 'Το Pushover απενεργοποιήθηκε.');
});

$('btn-po-test').addEventListener('click', async () => {
  try {
    await api('pushover/test', { method: 'POST' });
    $('settings-msg').textContent = 'Στάλθηκε. Χτυπάει σε λίγα δευτερόλεπτα, μέχρι 3 φορές αν δεν πατήσεις «Acknowledge».';
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('settings-msg').textContent = errorText(err);
  }
});

// ---------- position from Wi-Fi when there is no GPS ----------
function renderWifiloc() {
  const wifiloc = state.snap?.wifiloc;
  const google = Boolean(wifiloc?.google);
  $('wifiloc-state').innerHTML = google ? '<strong>Με την υπηρεσία της Google ✓</strong>' : '<strong>Δωρεάν υπηρεσία (beaconDB)</strong>';
  $('wifiloc-usage').hidden = !google;
  if (google) {
    const used = (wifiloc.used ?? 0).toLocaleString('el-GR');
    const limit = (wifiloc.limit ?? 9000).toLocaleString('el-GR');
    $('wifiloc-usage').textContent = `Αναζητήσεις στη Google αυτόν τον μήνα: ${used} από ${limit}. Η Google χρεώνει μόνο πάνω από 10.000.`;
  }
  $('btn-wl-off').hidden = !google;
}

async function saveWifiloc(googleKey, doneText) {
  try {
    const { google } = await api('wifiloc', { method: 'POST', body: { googleKey } });
    if (state.snap) state.snap.wifiloc = { google };
    $('wl-key').value = '';
    renderWifiloc();
    renderSummaries();
    $('settings-msg').textContent = doneText;
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('settings-msg').textContent = `Δεν αποθηκεύτηκε: ${errorText(err)}`;
  }
}

$('btn-wl-save').addEventListener('click', () => {
  const key = $('wl-key').value.trim();
  if (!key) {
    $('settings-msg').textContent = 'Βάλε πρώτα το κλειδί.';
    return;
  }
  $('settings-msg').textContent = 'Ελέγχω το κλειδί με τη Google…';
  saveWifiloc(key, 'Το κλειδί δουλεύει και αποθηκεύτηκε. Από τώρα η θέση χωρίς GPS βγαίνει από τη Google.');
});

$('btn-wl-off').addEventListener('click', () => {
  if (confirm('Να σταματήσει η χρήση της Google και να γυρίσει στη δωρεάν υπηρεσία;')) {
    saveWifiloc('', 'Το κλειδί αφαιρέθηκε. Η θέση χωρίς GPS βγαίνει πάλι από τη δωρεάν υπηρεσία.');
  }
});

// ---------- Wi-Fi networks of the board ----------
function renderWifi() {
  const wifi = state.snap?.wifi ?? { names: [], synced: true };
  const list = $('wifi-list');
  list.replaceChildren(
    ...wifi.names.map((name) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Αφαίρεση';
      remove.addEventListener('click', () => {
        if (confirm(`Να ξεχάσει η πλακέτα το «${name}»;`)) saveWifi({ ssid: name, remove: true }, `Το «${name}» αφαιρέθηκε.`);
      });
      item.append(label, remove);
      return item;
    }),
  );
  list.hidden = !wifi.names.length;
  $('wifi-sync').hidden = wifi.synced;
  $('wifi-sync').textContent = 'Η πλακέτα θα πάρει τις αλλαγές με την επόμενη αναφορά της.';
}

async function saveWifi(body, doneText) {
  try {
    const wifi = await api('wifi-nets', { method: 'POST', body });
    if (state.snap) state.snap.wifi = wifi;
    renderWifi();
    renderSummaries();
    $('settings-msg').textContent = doneText;
    return true;
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('settings-msg').textContent = `Δεν αποθηκεύτηκε: ${errorText(err)}`;
    return false;
  }
}

$('btn-wifi-add').addEventListener('click', async () => {
  const ssid = $('wifi-ssid').value.trim();
  const password = $('wifi-pass').value;
  if (!ssid) {
    $('settings-msg').textContent = 'Γράψε πρώτα το όνομα του Wi-Fi.';
    return;
  }
  const done = await saveWifi({ ssid, password }, `Το «${ssid}» αποθηκεύτηκε. Η πλακέτα θα το μάθει με την επόμενη αναφορά της.`);
  if (done) {
    $('wifi-ssid').value = '';
    $('wifi-pass').value = '';
  }
});

// ---------- live location link ----------
const shareUrl = (share) => `${location.origin}/s/${share.token}`;

function renderShare() {
  const share = state.snap?.share;
  const active = Boolean(share && share.expires > serverNow());
  $('share-new').hidden = active;
  $('share-active').hidden = !active;
  if (active) {
    $('share-url').value = shareUrl(share);
    $('share-expires').textContent = formatTime(share.expires);
  }
}

$('btn-share').addEventListener('click', () => {
  $('share-msg').textContent = '';
  renderShare();
  $('share-dialog').showModal();
});

$('btn-share-start').addEventListener('click', async () => {
  try {
    const { share } = await api('share', { method: 'POST', body: { hours: Number($('share-hours').value) } });
    if (state.snap) state.snap.share = share;
    renderShare();
    render();
    $('share-msg').textContent = 'Ο σύνδεσμος είναι έτοιμος.';
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('share-msg').textContent = `Δεν έγινε: ${errorText(err)}`;
  }
});

$('btn-share-send').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const url = $('share-url').value;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Θέση της μηχανής', text: 'Πού είναι τώρα η μηχανή μου:', url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // closed the share sheet
    }
  }
  copyText(url, button, $('share-url'));
});

$('btn-share-copy').addEventListener('click', (event) => copyText($('share-url').value, event.currentTarget, $('share-url')));

$('btn-share-stop').addEventListener('click', async () => {
  try {
    await api('share/stop', { method: 'POST' });
    if (state.snap) state.snap.share = null;
    renderShare();
    render();
    $('share-msg').textContent = 'Η κοινοποίηση σταμάτησε. Ο σύνδεσμος δεν δουλεύει πια.';
  } catch (err) {
    if (err instanceof AuthError) return logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.');
    $('share-msg').textContent = `Δεν έγινε: ${errorText(err)}`;
  }
});

$('btn-logout').addEventListener('click', () => {
  $('settings').close();
  saveQuick(null); // forget the links on this phone; the buttons already made keep working
  logout();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(state.timer);
  else if (getToken() && state.snap) refresh();
});

// ---------- lent out, theft folder, morning summary (app/js/extras.js) ----------
initExtras({
  act,
  saveSettings,
  errorText,
  copyText,
  onAuthError: () => logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.'),
  openSettingsPage: (page) => {
    if (!$('settings').open) $('settings').showModal();
    showSettingsPage(page);
  },
});

// ---------- a fall while riding (app/js/crash.js) ----------
initCrash({ act, saveSettings, serverNow });

// ---------- service book (app/js/service.js) ----------
initService({ errorText, onAuthError: () => logout('Η σύνδεση έληξε. Βάλε ξανά τον κωδικό.') });

// ---------- start ----------
async function start() {
  if (!getToken()) {
    showLogin();
    return;
  }
  showMain();
  renderPushCard();
  loadService(); // its own request: the alarm state does not wait for it
  await refresh();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
setInterval(render, 30_000);
start();
