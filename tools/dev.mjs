// Local test server: the real Worker code with an in-memory store, the phone app, and a
// device simulator at /dev/sim. Nothing here is used in production.
//   node tools/dev.mjs            then open http://localhost:5173  (password: dev)
import http from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVapidKeys } from '../server/src/push.js';
import { getStore } from '../server/src/store.js';
import worker from '../server/src/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_DIR = join(ROOT, 'app');
const SIM_PAGE = join(ROOT, 'tools', 'sim.html');
const VAPID_FILE = join(ROOT, '.dev', 'vapid.json');
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Keep the dev VAPID keys between restarts so browser push subscriptions stay valid.
async function devVapidKeys() {
  try {
    return JSON.parse(await readFile(VAPID_FILE, 'utf8'));
  } catch {
    const keys = await generateVapidKeys();
    await mkdir(dirname(VAPID_FILE), { recursive: true });
    await writeFile(VAPID_FILE, JSON.stringify(keys, null, 2));
    return keys;
  }
}

const env = {
  APP_PASSWORD: process.env.APP_PASSWORD || 'dev',
  TOKEN_SECRET: 'dev-only-token-secret',
  DEVICE_KEY: 'dev-device-key',
  VAPID_PRIVATE_JWK: JSON.stringify((await devVapidKeys()).privateJwk),
  // Stand-in for Google/beaconDB, which do not know the simulator's made-up access points:
  // a rough position a little off the last GPS one.
  WIFI_LOCATE: async () => {
    const last = await getStore(env).get('last_fix');
    if (!last) return null;
    if (last.src === 'wifi') return { lat: last.lat, lon: last.lon, acc: last.acc, by: 'dev' };
    return { lat: last.lat + 0.0003, lon: last.lon + 0.0004, acc: 80, by: 'dev' };
  },
};
const ctx = { waitUntil: (promise) => Promise.resolve(promise).catch((err) => console.error(err)) };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleApi(req, res) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body });
  const response = await worker.fetch(request, env, ctx);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function sendFile(res, file) {
  const body = await readFile(file);
  res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = normalize(join(APP_DIR, pathname));
  if (file !== APP_DIR && !file.startsWith(APP_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    await sendFile(res, file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) return await handleApi(req, res);
    if (req.url === '/dev/sim') return await sendFile(res, SIM_PAGE);
    if (req.url.startsWith('/s/')) return await sendFile(res, join(APP_DIR, 'share.html')); // live location links
    if (req.url.startsWith('/f/')) return await sendFile(res, join(APP_DIR, 'folder.html')); // theft folder links
    if (req.url === '/dev/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deviceKey: env.DEVICE_KEY }));
      return;
    }
    return await handleStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// Stand-in for the Cloudflare cron trigger.
setInterval(() => worker.scheduled({ cron: 'dev', scheduledTime: Date.now() }, env, ctx), 60_000);

server.listen(PORT, () => {
  console.log(`Εφαρμογή:     http://localhost:${PORT}/   (κωδικός: ${env.APP_PASSWORD})`);
  console.log(`Προσομοιωτής: http://localhost:${PORT}/dev/sim`);
});
