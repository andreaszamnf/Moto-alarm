import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import { getStore } from '../src/store.js';

const env = { APP_PASSWORD: 'correct horse', TOKEN_SECRET: 'test-token-secret', DEVICE_KEY: 'device-secret' };
const ctx = { waitUntil: (p) => p };

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    ctx,
  );
  return { status: res.status, data: await res.json() };
}

let token;

test('app endpoints need a login', async () => {
  assert.equal((await call('/api/state')).status, 401);
  assert.equal((await call('/api/state', { token: 'forged.token' })).status, 401);
});

test('wrong password is refused, right password returns a working token', async () => {
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  const ok = await call('/api/login', { method: 'POST', body: { password: 'correct horse' } });
  assert.equal(ok.status, 200);
  token = ok.data.token;
  const state = await call('/api/state', { token });
  assert.equal(state.status, 200);
  assert.equal(state.data.armed.armed, false);
});

test('spaces around the password are forgiven', async () => {
  const ok = await call('/api/login', { method: 'POST', body: { password: '  correct horse ' } });
  assert.equal(ok.status, 200);
});

test('the device must present its key', async () => {
  const body = { reason: 'parked', fix: { lat: 37.98, lon: 23.72 } };
  assert.equal((await call('/api/device/report', { method: 'POST', body })).status, 401);
  assert.equal((await call('/api/device/report', { method: 'POST', body, token: token })).status, 401, 'an app token is not a device key');
  const ok = await call('/api/device/report', { method: 'POST', body, token: env.DEVICE_KEY });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.armed, false);
  assert.equal(ok.data.heartbeat, 6 * 3600);
});

test('arming from the app reaches the device, and the alarm shows up in events', async () => {
  const armed = await call('/api/arm', { method: 'POST', body: { armed: true }, token });
  assert.equal(armed.data.armed.armed, true);
  assert.deepEqual(armed.data.armed.park, { lat: 37.98, lon: 23.72 });

  const res = await call('/api/device/report', { method: 'POST', body: { reason: 'motion' }, token: env.DEVICE_KEY });
  assert.equal(res.data.track, true);

  const { data } = await call('/api/events?limit=5', { token });
  assert.deepEqual(data.events.map((e) => e.type), ['alarm', 'armed', 'parked']);

  const history = await call('/api/history', { token });
  assert.equal(history.data.positions.length, 1);
});

test('bad input is rejected cleanly', async () => {
  assert.equal((await call('/api/arm', { method: 'POST', body: { armed: 'yes' }, token })).status, 400);
  assert.equal((await call('/api/push/subscribe', { method: 'POST', body: { endpoint: 'http://insecure' }, token })).status, 400);
  assert.equal((await call('/api/nothing', { token })).status, 404);
});

async function quickCall(query, method = 'POST') {
  const res = await worker.fetch(new Request(`http://localhost/api/quick?${query}`, { method }), env, ctx);
  return { status: res.status, text: await res.text() };
}

test('home-screen buttons need their own key, and a new key retires the old one', async () => {
  assert.equal((await quickCall('action=status', 'GET')).status, 401);
  assert.equal((await quickCall('key=guess&action=arm')).status, 401);

  const first = (await call('/api/quick-key', { method: 'POST', token })).data.key;
  const second = (await call('/api/quick-key', { method: 'POST', token })).data.key;
  assert.notEqual(first, second);
  assert.equal((await quickCall(`key=${first}&action=status`, 'GET')).status, 401, 'old key no longer works');

  const status = await quickCall(`key=${second}&action=status`, 'GET');
  assert.equal(status.status, 200);
  assert.match(status.text, /επαφή/);
});

test('home-screen buttons arm and disarm, and only with POST', async () => {
  const key = (await call('/api/quick-key', { method: 'POST', token })).data.key;

  const viaGet = await quickCall(`key=${key}&action=arm`, 'GET');
  assert.equal(viaGet.status, 405);
  assert.match(viaGet.text, /POST/);

  const armed = await quickCall(`key=${key}&action=arm`);
  assert.equal(armed.status, 200);
  assert.match(armed.text, /οπλίστηκε/);
  assert.equal((await call('/api/state', { token })).data.armed.armed, true);

  const res = await worker.fetch(new Request(`http://localhost/api/quick?key=${key}&action=disarm&format=json`, { method: 'POST' }), env, ctx);
  const data = await res.json();
  assert.equal(data.armed, false);
  assert.match(data.text, /αφοπλίστηκε/);
});

test('the app can tell whether its saved key is current, and revoking stops the buttons', async () => {
  const made = (await call('/api/quick-key', { method: 'POST', token })).data;
  assert.equal((await call('/api/quick-key', { token })).data.created, made.created);

  assert.equal((await call('/api/quick-key/revoke', { method: 'POST', token })).status, 200);
  assert.equal((await call('/api/quick-key', { token })).data.created, null);
  assert.equal((await quickCall(`key=${made.key}&action=status`, 'GET')).status, 401);
});

test('live location link over the API, and the phone number check', async () => {
  const bad = await call('/api/settings', { method: 'POST', body: { callNumber: '12' }, token });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'bad_phone');
  const good = await call('/api/settings', { method: 'POST', body: { callNumber: '691 234 5678' }, token });
  assert.equal(good.data.settings.callNumber, '+306912345678');

  const { data } = await call('/api/share', { method: 'POST', body: { hours: 24 }, token });
  const view = await call(`/api/shared/${data.share.token}`);
  assert.equal(view.status, 200);
  assert.ok(view.data.position);
  assert.equal((await call('/api/shared/wrong-token')).status, 404);
  await call('/api/share/stop', { method: 'POST', token });
  assert.equal((await call(`/api/shared/${data.share.token}`)).status, 404);
  assert.equal((await call('/api/share', { method: 'POST', body: { hours: 5 }, token })).status, 400);
});

test('Pushover: keys are checked, the alarm goes out with a callback, and acknowledging there counts', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const params = init?.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    calls.push({ url: String(url), params });
    let body = { status: 1 };
    if (String(url).endsWith('messages.json')) body = { status: 1, receipt: 'rcpt1' };
    if (String(url).includes('sounds.json')) {
      body = { status: 1, sounds: { siren: 'Siren', persistent: 'Persistent (long)', none: 'None (silent)', my_siren: 'My siren' } };
    }
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const key = (c) => c.repeat(30);
    assert.equal((await call('/api/pushover', { method: 'POST', body: { user: 'short', token: 'x' }, token })).status, 400);
    const saved = await call('/api/pushover', { method: 'POST', body: { user: key('u'), token: key('t') }, token });
    assert.equal(saved.data.pushover, true);
    assert.equal((await call('/api/state', { token })).data.pushover, true);
    assert.ok(!JSON.stringify((await call('/api/state', { token })).data).includes(key('t')), 'the token never goes back to the app');

    const sounds = await call('/api/pushover/sounds', { token });
    assert.deepEqual(sounds.data.sounds.map((s) => s.id), ['siren', 'persistent', 'my_siren'], 'no silent sound, uploaded ones included');
    assert.equal(sounds.data.current, 'siren');
    assert.equal((await call('/api/pushover/sound', { method: 'POST', body: { sound: 'none' }, token })).status, 400);
    assert.equal((await call('/api/pushover/sound', { method: 'POST', body: { sound: 'my_siren' }, token })).data.sound, 'my_siren');

    await call('/api/arm', { method: 'POST', body: { armed: true }, token });
    await call('/api/device/report', { method: 'POST', body: { reason: 'motion' }, token: env.DEVICE_KEY });
    const alert = calls.find((c) => c.url.endsWith('messages.json'));
    assert.equal(alert.params.priority, '2');
    assert.equal(alert.params.sound, 'my_siren');
    const callback = new URL(alert.params.callback);

    const forged = await worker.fetch(new Request(`http://localhost/api/pushover/callback?key=wrong`, { method: 'POST', body: new URLSearchParams({ receipt: 'rcpt1' }) }), env, ctx);
    assert.equal(forged.status, 401);
    const acked = await worker.fetch(new Request(`http://localhost${callback.pathname}${callback.search}`, { method: 'POST', body: new URLSearchParams({ receipt: 'rcpt1', acknowledged: '1' }) }), env, ctx);
    assert.equal(acked.status, 200);
    assert.equal((await call('/api/state', { token })).data.alarm.acked, true);

    assert.equal((await call('/api/pushover/test', { method: 'POST', token })).status, 200);
    await call('/api/arm', { method: 'POST', body: { armed: false }, token });
    assert.equal((await call('/api/pushover', { method: 'POST', body: { user: '', token: '' }, token })).data.pushover, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('signal test over the API', async () => {
  assert.equal((await call('/api/signal-test', { method: 'POST', body: { minutes: 7 }, token })).status, 400);
  const started = await call('/api/signal-test', { method: 'POST', body: { minutes: 60 }, token });
  assert.equal(started.status, 200);
  assert.ok(started.data.test.until > Date.now());
  const res = await call('/api/device/report', { method: 'POST', body: { reason: 'heartbeat', net: { op: 'NOVA', tech: 'LTE', rsrp: -110 } }, token: env.DEVICE_KEY });
  assert.equal(res.data.heartbeat, 120);
  const view = await call('/api/signal', { token });
  assert.equal(view.data.log[0].op, 'NOVA');
  assert.equal((await call('/api/signal-test/stop', { method: 'POST', token })).data.test, null);
});

test('Wi-Fi position: the Google key is checked, kept on the server, and used for reports without GPS', async () => {
  const realFetch = globalThis.fetch;
  let googleAnswer = { status: 400, body: { error: { errors: [{ reason: 'keyInvalid' }] } } };
  globalThis.fetch = async (url) => {
    const { status, body } = String(url).includes('googleapis')
      ? googleAnswer
      : { status: 404, body: { error: { errors: [{ reason: 'notFound' }] } } };
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const key = `AIza${'k'.repeat(35)}`;
    assert.equal((await call('/api/wifiloc', { method: 'POST', body: { googleKey: 'nope' }, token })).data.error, 'bad_google_key');
    assert.equal((await call('/api/wifiloc', { method: 'POST', body: { googleKey: key }, token })).data.error, 'google_key_invalid');

    googleAnswer = { status: 404, body: { error: { errors: [{ reason: 'notFound' }] } } };
    assert.equal((await call('/api/wifiloc', { method: 'POST', body: { googleKey: key }, token })).data.google, true);
    const state = await call('/api/state', { token });
    assert.equal(state.data.wifiloc.google, true);
    assert.ok(!JSON.stringify(state.data).includes(key), 'the key never goes back to the app');

    googleAnswer = { status: 200, body: { location: { lat: 37.97, lng: 23.74 }, accuracy: 35 } };
    const wifi = [
      { m: '10:20:30:40:50:61', s: -61 },
      { m: '10:20:30:40:50:62', s: -75 },
    ];
    await call('/api/device/report', { method: 'POST', body: { reason: 'heartbeat', wifi }, token: env.DEVICE_KEY });
    const position = (await call('/api/state', { token })).data.position;
    assert.deepEqual([position.lat, position.lon, position.acc, position.src], [37.97, 23.74, 35, 'wifi']);

    assert.equal((await call('/api/state', { token })).data.wifiloc.used, 1, 'the lookup is counted');

    // Once the free allowance for the day is used up, Google is not asked any more.
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ error: { errors: [{ reason: 'notFound' }] } }), { status: 404 });
    };
    const today = new Date().toISOString().slice(0, 10);
    await getStore(env).set('wifiloc_usage', { day: today, dayCount: 300, month: today.slice(0, 7), monthCount: 300 });
    const elsewhere = [
      { m: '70:80:90:a0:b0:c1', s: -58 },
      { m: '70:80:90:a0:b0:c2', s: -66 },
    ];
    await call('/api/device/report', { method: 'POST', body: { reason: 'heartbeat', wifi: elsewhere }, token: env.DEVICE_KEY });
    assert.equal(asked.filter((u) => u.includes('googleapis')).length, 0);
    assert.equal(asked.filter((u) => u.includes('beacondb')).length, 1, 'the free service is still asked');

    assert.equal((await call('/api/wifiloc', { method: 'POST', body: { googleKey: '' }, token })).data.google, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ten wrong passwords lock the login for a while', async () => {
  for (let i = 0; i < 10; i++) await call('/api/login', { method: 'POST', body: { password: 'guess' } });
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'correct horse' } })).status, 429);
});

test('Wi-Fi networks: added in the app, sent to the board once, passwords never back to the app', async () => {
  const add = await call('/api/wifi-nets', { method: 'POST', token, body: { ssid: 'Neighbour', password: 'secret-pass-1' } });
  assert.equal(add.status, 200);
  assert.deepEqual(add.data, { names: ['Neighbour'], synced: false });
  assert.equal((await call('/api/wifi-nets', { method: 'POST', token, body: { ssid: 'Bad', password: 'short' } })).status, 400);

  const state = await call('/api/state', { token });
  assert.deepEqual(state.data.wifi.names, ['Neighbour']);
  assert.ok(!JSON.stringify(state.data).includes('secret-pass-1'), 'the password never reaches the app');

  const first = await call('/api/device/report', { method: 'POST', token: env.DEVICE_KEY, body: { reason: 'heartbeat', wifiv: 0 } });
  assert.deepEqual(first.data.wifi.nets, [['Neighbour', 'secret-pass-1']]);
  const v = first.data.wifi.v;
  const next = await call('/api/device/report', { method: 'POST', token: env.DEVICE_KEY, body: { reason: 'heartbeat', wifiv: v } });
  assert.equal(next.data.wifi, undefined, 'not again once the board has it');
  assert.equal((await call('/api/state', { token })).data.wifi.synced, true);

  const removed = await call('/api/wifi-nets', { method: 'POST', token, body: { ssid: 'Neighbour', remove: true } });
  assert.deepEqual(removed.data, { names: [], synced: false });
  const after = await call('/api/device/report', { method: 'POST', token: env.DEVICE_KEY, body: { reason: 'heartbeat', wifiv: v } });
  assert.deepEqual(after.data.wifi.nets, [], 'an empty list tells the board to forget');
});
