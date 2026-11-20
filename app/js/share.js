// Live location page behind a shared link (/s/<token>): where the bike is and its recent trail.
// It shows nothing else and changes nothing. It stops working when the link expires.
const POLL_MS = 15_000;
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const token = location.pathname.split('/').filter(Boolean)[1] ?? '';
const $ = (id) => document.getElementById(id);
const expiryFmt = new Intl.DateTimeFormat('el-GR', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

let map = null;
let marker = null;
let mapReady = false;
let following = true;
let clockOffset = 0;
let last = null;

function ago(ts) {
  const seconds = Math.max(0, (Date.now() + clockOffset - ts) / 1000);
  if (seconds < 45) return 'μόλις τώρα';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `πριν ${minutes} λεπτ${minutes === 1 ? 'ό' : 'ά'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `πριν ${hours} ώρ${hours === 1 ? 'α' : 'ες'}`;
  const days = Math.round(hours / 24);
  return `πριν ${days} μέρ${days === 1 ? 'α' : 'ες'}`;
}

const trailFeature = (points) => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: points.map(([lat, lon]) => [lon, lat]) },
});

function initMap(position) {
  map = new maplibregl.Map({ container: 'map', style: MAP_STYLE, center: [position.lon, position.lat], zoom: 15 });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  const dot = document.createElement('div');
  dot.className = 'bike';
  marker = new maplibregl.Marker({ element: dot }).setLngLat([position.lon, position.lat]).addTo(map);
  map.on('dragstart', () => {
    following = false;
  });
  map.on('load', () => {
    map.addSource('trail', { type: 'geojson', data: trailFeature(last?.trail ?? []) });
    map.addLayer({ id: 'trail', type: 'line', source: 'trail', paint: { 'line-color': '#dc2626', 'line-width': 4, 'line-opacity': 0.8 } });
    mapReady = true;
  });
}

function show(data) {
  last = data;
  const p = data.position;
  if (!p) {
    $('status').textContent = 'Η συσκευή δεν έχει στείλει ακόμα θέση.';
    return;
  }
  if (!map) initMap(p);
  marker.setLngLat([p.lon, p.lat]);
  marker.getElement().classList.toggle('alarm', data.alarm);
  if (mapReady) map.getSource('trail').setData(trailFeature(data.trail));
  if (following) map.easeTo({ center: [p.lon, p.lat] });

  const speed = p.speed > 3 ? `, με ${Math.round(p.speed)} km/h` : '';
  $('status').innerHTML = '';
  if (data.alarm) {
    const alarm = document.createElement('span');
    alarm.className = 'alarm';
    alarm.textContent = 'Ο συναγερμός χτυπάει. ';
    $('status').append(alarm);
  }
  $('status').append(`Τελευταία θέση ${ago(p.ts)}${speed}.`);
  const where = p.src === 'wifi' ? `Θέση από τα Wi-Fi γύρω της, ακρίβεια περίπου ${Math.round(p.acc ?? 100)} μ.` : `Ακρίβεια περίπου ${Math.round(p.acc ?? 25)} μ.`;
  $('details').textContent = `${where} · Ο σύνδεσμος λήγει: ${expiryFmt.format(data.expires)}`;
  $('directions').href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
  $('buttons').hidden = false;
}

function expired() {
  $('status').textContent = 'Ο σύνδεσμος έληξε ή σταμάτησε.';
  $('details').textContent = 'Ζήτησε καινούριο σύνδεσμο από τον ιδιοκτήτη της μηχανής.';
  $('buttons').hidden = true;
}

async function refresh() {
  try {
    const res = await fetch(`/api/shared/${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (res.status === 404) {
      expired();
      return; // no more polling
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    clockOffset = data.now - Date.now();
    show(data);
  } catch {
    $('status').textContent = 'Δεν υπάρχει σύνδεση. Ξαναδοκιμάζω…';
  }
  setTimeout(refresh, POLL_MS);
}

$('recenter').addEventListener('click', () => {
  following = true;
  const p = last?.position;
  if (map && p) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15) });
});

if (token) refresh();
else expired();
