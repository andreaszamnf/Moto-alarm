// Service worker: keeps the app shell available offline and shows push notifications.
const CACHE = 'moto-alarm-v21';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'js/main.js',
  'js/api.js',
  'js/scriptable.js',
  'js/service.js',
  'js/ride.js',
  'js/extras.js',
  'js/crash.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first so updates show up immediately; the cache is only a fallback when offline.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() ?? '' };
  }
  const urgent = Boolean(data.urgent);
  const quiet = !urgent && Boolean(data.quiet); // the morning summary, a lent bike moving off: no sound
  event.waitUntil(
    self.registration.showNotification(data.title || 'Συναγερμός μηχανής', {
      body: data.body || '',
      tag: data.tag || 'moto-alarm',
      renotify: true,
      requireInteraction: urgent,
      vibrate: urgent ? [500, 200, 500, 200, 900] : quiet ? [] : [200],
      silent: quiet,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w);
      return open ? open.focus() : self.clients.openWindow(event.notification.data?.url || './');
    }),
  );
});
