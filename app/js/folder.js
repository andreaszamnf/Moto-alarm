// Theft folder behind a link (/f/<token>): the bike's details and photos, and where it went from the
// moment of the alarm, with times. For the police or the insurer. It shows nothing else, changes
// nothing, and stops working when the link expires. It refreshes every minute while open.
const POLL_MS = 60_000;
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const ROW_GAP_MS = 60_000; // the table keeps a row a minute (or every 300 m), the map every point
const ROW_GAP_M = 300;

const token = location.pathname.split('/').filter(Boolean)[1] ?? '';
const $ = (id) => document.getElementById(id);
const timeFmt = new Intl.DateTimeFormat('el-GR', { timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const dateFmt = new Intl.DateTimeFormat('el-GR', {
  timeZone: 'Europe/Athens',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const REASON = { motion: 'κίνηση', moved: 'μετακίνηση από το σημείο στάθμευσης', tamper: 'παραβίαση συσκευής' };
const LABELS = { plate: 'Πινακίδα', vin: 'Αριθμός πλαισίου', model: 'Μοντέλο', color: 'Χρώμα', notes: 'Σημάδια, αξεσουάρ' };

let map = null;
let mapReady = false;
let marker = null;
let startMarker = null;
let fitted = false;
let latest = null;

function distanceM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[2] - a[2]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const line = (trail) => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: trail.map((p) => [p[2], p[1]]) },
});

function showBike(data) {
  const dl = $('bike');
  dl.replaceChildren();
  for (const [key, label] of Object.entries(LABELS)) {
    const value = data.bike?.[key];
    if (!value) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
  $('bike-card').hidden = !dl.children.length;
  const plate = data.bike?.plate;
  document.title = plate ? `Φάκελος κλοπής: ${plate}` : 'Φάκελος κλοπής μοτοσυκλέτας';

  const photos = $('photos');
  if (photos.children.length !== data.photos.length) {
    photos.replaceChildren(
      ...data.photos.map((src, i) => {
        const img = document.createElement('img');
        img.src = src;
        img.alt = `Φωτογραφία ${i + 1} της μοτοσυκλέτας`;
        return img;
      }),
    );
  }
  $('photos-card').hidden = !data.photos.length;
}

// The whole route in view, once (afterwards the reader may move the map as they like).
const FIT = { padding: { top: 40, right: 56, bottom: 56, left: 40 }, maxZoom: 16, duration: 0 };

function trailBounds(trail) {
  const bounds = new maplibregl.LngLatBounds();
  for (const p of trail) bounds.extend([p[2], p[1]]);
  return bounds;
}

function fitTrail() {
  const trail = latest?.trail ?? [];
  if (fitted || !map || trail.length < 2) return;
  fitted = true;
  map.fitBounds(trailBounds(trail), FIT);
}

function showMap(data) {
  const trail = data.trail;
  const last = trail.at(-1) ?? (data.position ? [data.position.ts, data.position.lat, data.position.lon, null] : null);
  if (!last) return;
  $('map').hidden = false;
  if (!map) {
    // Starts with the whole route in view (the map may take a while to load its streets).
    const view = trail.length > 1 ? { bounds: trailBounds(trail), fitBoundsOptions: FIT } : { center: [last[2], last[1]], zoom: 14 };
    fitted = trail.length > 1;
    map = new maplibregl.Map({ container: 'map', style: MAP_STYLE, ...view, preserveDrawingBuffer: true, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    const dot = document.createElement('div');
    dot.className = 'bike';
    marker = new maplibregl.Marker({ element: dot }).setLngLat([last[2], last[1]]).addTo(map);
    map.on('load', () => {
      map.addSource('trail', { type: 'geojson', data: line(latest?.trail ?? []) });
      map.addLayer({ id: 'trail', type: 'line', source: 'trail', paint: { 'line-color': '#dc2626', 'line-width': 4, 'line-opacity': 0.85 } });
      mapReady = true;
    });
  }
  marker.setLngLat([last[2], last[1]]);
  if (trail.length) {
    // Where it was when the alarm began (green). A marker needs its place before it joins the map.
    if (!startMarker) {
      const dot = document.createElement('div');
      dot.className = 'start';
      startMarker = new maplibregl.Marker({ element: dot }).setLngLat([trail[0][2], trail[0][1]]).addTo(map);
    }
    startMarker.setLngLat([trail[0][2], trail[0][1]]);
  }
  if (mapReady) map.getSource('trail').setData(line(trail));
  fitTrail();
  $('directions').href = `https://www.google.com/maps/search/?api=1&query=${last[1]},${last[2]}`;
  $('directions').hidden = false;
}

// One row a minute (or every 300 m), with the first and the last always there.
function rows(trail) {
  const kept = [];
  for (const [i, p] of trail.entries()) {
    const prev = kept.at(-1);
    if (!prev || i === trail.length - 1 || p[0] - prev[0] >= ROW_GAP_MS || distanceM(prev, p) >= ROW_GAP_M) kept.push(p);
  }
  return kept;
}

function showTimes(data) {
  const body = $('times');
  body.replaceChildren();
  for (const p of rows(data.trail)) {
    const tr = document.createElement('tr');
    const time = document.createElement('td');
    time.textContent = timeFmt.format(new Date(p[0]));
    const where = document.createElement('td');
    const a = document.createElement('a');
    a.href = `https://www.google.com/maps/search/?api=1&query=${p[1]},${p[2]}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `${p[1].toFixed(5)}, ${p[2].toFixed(5)}`;
    where.append(a);
    const speed = document.createElement('td');
    speed.textContent = p[3] == null ? '—' : `${Math.round(p[3])} χλμ/ώ`;
    tr.append(time, where, speed);
    body.append(tr);
  }
  $('times-card').hidden = !data.trail.length;
}

function show(data) {
  latest = data;
  $('status').textContent = data.bike?.plate ? `Πινακίδα ${data.bike.plate}` : 'Στοιχεία της μοτοσυκλέτας και η διαδρομή της.';
  showBike(data);

  $('alarm-card').hidden = false;
  $('alarm-text').replaceChildren();
  if (data.alarmAt) {
    const first = data.alarms[0];
    const strong = document.createElement('span');
    strong.className = 'alarm';
    strong.textContent = `Συναγερμός: ${dateFmt.format(new Date(data.alarmAt))}`;
    $('alarm-text').append(strong, first ? ` (${REASON[first.reason] ?? 'κίνηση'}).` : '.');
  } else {
    $('alarm-text').textContent = 'Δεν έχει χτυπήσει συναγερμός· φαίνεται μόνο η τελευταία θέση.';
  }
  const p = data.position;
  $('last-text').textContent = p
    ? `Τελευταία θέση: ${dateFmt.format(new Date(p.ts))}${p.src === 'wifi' ? `, από τα Wi-Fi γύρω της (ακρίβεια περίπου ${Math.round(p.acc ?? 100)} μ.)` : ''}.`
    : 'Η συσκευή δεν έχει στείλει θέση.';
  showMap(data);
  showTimes(data);
  $('expires').textContent = `Ο σύνδεσμος λήγει: ${dateFmt.format(new Date(data.expires))}. Η σελίδα ανανεώνεται κάθε λεπτό.`;
}

function expired() {
  $('status').textContent = 'Ο σύνδεσμος έληξε ή σταμάτησε. Ζήτησε καινούριο από τον ιδιοκτήτη της μηχανής.';
  for (const id of ['bike-card', 'photos-card', 'alarm-card', 'times-card']) $(id).hidden = true;
  $('expires').textContent = '';
}

async function refresh() {
  try {
    const res = await fetch(`/api/folder/${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (res.status === 404) return expired();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    show(await res.json());
  } catch {
    if (!latest) $('status').textContent = 'Δεν υπάρχει σύνδεση. Ξαναδοκιμάζω…';
  }
  setTimeout(refresh, POLL_MS);
}

$('print').addEventListener('click', () => window.print());

if (token) refresh();
else expired();
