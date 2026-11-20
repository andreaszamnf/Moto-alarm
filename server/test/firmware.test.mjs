import assert from 'node:assert/strict';
import test from 'node:test';
import { FW_MAX_TRIES, FW_RETRY_MS, compareVersions, validVersion } from '../src/firmware.js';
import worker from '../src/index.js';
import { handleReport, setArmed, snapshot } from '../src/logic.js';
import { MemoryStore } from '../src/store.js';

const T0 = Date.UTC(2026, 10, 18, 10, 0, 0);
const min = (n) => n * 60_000;
const LATEST = { v: '1.2.0', size: 1000, sig: 'ab'.repeat(36) };

test('versions are compared as numbers', () => {
  assert.equal(validVersion('1.10.0'), true);
  assert.equal(validVersion('1.2'), false);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('1.2.0', '1.2.0') === 0);
  assert.ok(compareVersions('0.9.0', '1.0.0') < 0);
});

function setup() {
  const store = new MemoryStore();
  const report = (r, now, firmware = LATEST) => handleReport({ store, report: r, now, firmware });
  return { store, report };
}

test('new firmware is offered only to an older board, parked and calm, with enough battery', async () => {
  const { store, report } = setup();
  assert.equal((await report({ reason: 'heartbeat', fw: '1.2.0' }, T0)).update, undefined, 'already up to date');
  assert.equal((await report({ reason: 'heartbeat', fw: '1.3.0' }, T0)).update, undefined, 'newer than the published one');
  assert.equal((await report({ reason: 'ride', fw: '1.1.0' }, T0)).update, undefined, 'not while riding');
  assert.equal((await report({ reason: 'heartbeat', fw: '1.1.0', batt: { pct: 20 } }, T0)).update, undefined, 'not on a low battery');
  assert.equal((await report({ reason: 'heartbeat', fw: '1.1.0' }, T0, null)).update, undefined, 'nothing published');

  const res = await report({ reason: 'heartbeat', fw: '1.1.0', batt: { pct: 80 } }, T0);
  assert.deepEqual(res.update, LATEST);
  assert.equal((await snapshot(store, T0)).firmware.coming, '1.2.0');

  // Never during an alarm.
  const { store: armedStore, report: armedReport } = setup();
  await armedReport({ reason: 'heartbeat', fix: { lat: 37.98, lon: 23.72 }, fw: '1.1.0' }, T0 + FW_RETRY_MS * 9);
  await setArmed({ store: armedStore, armed: true, now: T0 });
  await armedStore.set('fw_offer', null);
  await armedReport({ reason: 'motion', fw: '1.1.0' }, T0 + min(1));
  assert.equal((await armedReport({ reason: 'heartbeat', fw: '1.1.0' }, T0 + min(2))).update, undefined);
});

test('a board that installs the update is noted in the history', async () => {
  const { store, report } = setup();
  await report({ reason: 'heartbeat', fw: '1.1.0' }, T0);
  const res = await report({ reason: 'boot', fw: '1.2.0' }, T0 + min(4));
  assert.equal(res.update, undefined);
  const events = await store.events(5);
  assert.deepEqual(events[0], { id: events[0].id, ts: T0 + min(4), type: 'fw_updated', data: { from: '1.1.0', to: '1.2.0' } });
  assert.equal((await snapshot(store, T0 + min(5))).firmware.running, '1.2.0');
  assert.equal((await snapshot(store, T0 + min(5))).firmware.coming, null);
});

test('an update that keeps failing is offered 3 times, 6 hours apart, then reported once', async () => {
  const { store, report } = setup();
  let now = T0;
  const offers = [];
  for (let i = 0; i < 20; i++) {
    const res = await report({ reason: i % 2 ? 'boot' : 'heartbeat', fw: '1.1.0' }, now);
    if (res.update) offers.push(now);
    now += 2 * 3_600_000;
  }
  assert.equal(offers.length, FW_MAX_TRIES);
  assert.ok(offers.every((t, i) => i === 0 || t - offers[i - 1] >= FW_RETRY_MS));
  const failed = (await store.events(50)).filter((e) => e.type === 'fw_failed');
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].data, { v: '1.2.0' });
  assert.equal((await snapshot(store, now)).firmware.coming, null);

  // A newer version starts afresh.
  const res = await report({ reason: 'heartbeat', fw: '1.1.0' }, now, { ...LATEST, v: '1.2.1' });
  assert.equal(res.update.v, '1.2.1');
});

test('the board downloads the image in parts, with its own key only', async () => {
  const image = new Uint8Array(70_000).map((_, i) => i % 251);
  const env = {
    APP_PASSWORD: 'p',
    TOKEN_SECRET: 's',
    DEVICE_KEY: 'device-secret',
    FIRMWARE: {
      async get(key, opts) {
        if (key === 'fw/1.2.0.bin' && opts?.type === 'arrayBuffer') return image.buffer.slice(0);
        return null;
      },
    },
  };
  const get = async (query, key = 'device-secret') => {
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    return worker.fetch(new Request(`http://localhost/api/device/firmware?${query}`, { headers }), env, { waitUntil: (p) => p });
  };
  assert.equal((await get('v=1.2.0&from=0&len=16', null)).status, 401);
  assert.equal((await get('v=1.2.0&from=0&len=16', 'wrong')).status, 401);
  assert.equal((await get('v=1.2.0&from=0&len=40000')).status, 400, 'parts are at most 32 KB');
  assert.equal((await get('v=1.3.0&from=0&len=16')).status, 404);
  assert.equal((await get('v=1.2.0&from=70000&len=16')).status, 416);

  const part = new Uint8Array(await (await get('v=1.2.0&from=65536&len=16384')).arrayBuffer());
  assert.equal(part.length, 70_000 - 65_536, 'the last part is shorter');
  assert.deepEqual([...part.slice(0, 4)], [...image.slice(65_536, 65_540)]);
});
