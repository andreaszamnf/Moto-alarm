import assert from 'node:assert/strict';
import test from 'node:test';
import { addGps, addRotation, createLean, leanText, trackLean } from '../../app/js/lean.js';

const DEG = 180 / Math.PI;

// Rides for `seconds`: the gyroscope at 60 readings a second (a steady turn of `turnDegS` about the
// axis `axis` of the phone, plus vibration), the GPS once a second with the heading turning with it.
function ride(s, { seconds, kmh, turnDegS, axis = [0, 0, 1], shake = 0, from = 0, heading = 90, every = 6 }) {
  const n = Math.hypot(...axis);
  let lean = null;
  let h = heading;
  for (let i = 0; i <= seconds * 60; i++) {
    const t = from + (i * 1000) / 60;
    const buzz = shake * Math.sin(2 * Math.PI * 30 * (t / 1000)); // engine and road, 30 Hz
    const swing = (shake / 2) * Math.sin(2 * Math.PI * 13 * (t / 1000));
    addRotation(s, [(axis[0] / n) * turnDegS + buzz, (axis[1] / n) * turnDegS + swing, (axis[2] / n) * turnDegS], t);
    if (i % 60 === 0) {
      addGps(s, kmh, ((h % 360) + 360) % 360, t);
      h += turnDegS; // degrees in a second; clockwise is +, a right-hand turn
    }
    if (i % every === 0) lean = trackLean(s, t);
  }
  return { lean, heading: h, end: from + seconds * 1000 };
}

test('a steady right-hand turn: tan(lean) = v·ω/g, whichever way the phone sits', () => {
  const omega = 0.5; // rad/s
  const expected = Math.atan(((60 / 3.6) * omega) / 9.81) * DEG; // 40.4°
  for (const axis of [[0, 0, 1], [1, 0, 0], [0.3, 0.8, 0.5]]) {
    const s = createLean();
    const { lean } = ride(s, { seconds: 4, kmh: 60, turnDegS: omega * DEG, axis });
    assert.equal(lean.side, 'right');
    assert.ok(Math.abs(lean.deg - expected) < 0.5, `${lean.deg} for ${axis}`);
    assert.ok(Math.abs(s.maxRight - expected) < 0.5);
    assert.equal(s.maxLeft, 0);
  }
});

test('a left-hand turn with the engine shaking the phone', () => {
  const s = createLean();
  const omega = -0.3; // the heading turns anticlockwise
  const expected = Math.atan(((80 / 3.6) * 0.3) / 9.81) * DEG; // 34.2°
  const { lean } = ride(s, { seconds: 4, kmh: 80, turnDegS: omega * DEG, axis: [0.2, 0.1, 1], shake: 20 });
  assert.equal(lean.side, 'left');
  assert.ok(Math.abs(lean.deg - expected) < 2, String(lean.deg));
  assert.ok(Math.abs(s.maxLeft - expected) < 2);
  assert.equal(leanText(lean), `← ${Math.round(lean.deg)}°`);
});

test('straight at 100 km/h with vibration: upright', () => {
  const s = createLean();
  const { lean } = ride(s, { seconds: 4, kmh: 100, turnDegS: 0, shake: 20 });
  assert.deepEqual(lean, { deg: 0, side: null });
  assert.equal(leanText(lean), '0°');
  assert.deepEqual([s.maxLeft, s.maxRight], [0, 0]);
});

test('a pothole after a turn is no record', () => {
  const s = createLean();
  const turn = ride(s, { seconds: 4, kmh: 50, turnDegS: 4 }); // a gentle right-hand bend, about 6°
  const before = s.maxRight;
  assert.ok(before > 5 && before < 7, String(before));
  const straight = ride(s, { seconds: 3, kmh: 60, turnDegS: 0, from: turn.end, heading: turn.heading });
  // 0.1 s of a hard knock (100°/s), then straight on.
  for (let i = 0; i < 6; i++) addRotation(s, [100, 0, 0], straight.end + i * 16);
  ride(s, { seconds: 3, kmh: 60, turnDegS: 0, from: straight.end + 100, heading: straight.heading });
  assert.ok(s.maxRight - before < 1, `${before} → ${s.maxRight}`);
});

test('too slow, or the heading across north', () => {
  const s = createLean();
  const { lean } = ride(s, { seconds: 3, kmh: 10, turnDegS: 30 });
  assert.equal(lean, null);
  assert.equal(leanText(lean), '—');

  const north = createLean();
  addRotation(north, [0, 0, 20], 0);
  addGps(north, 40, 350, 0);
  addGps(north, 40, 5, 1000); // 15° clockwise across north: right
  assert.equal(north.side, 1);
});

test('the maxima also with the readings 117 ms apart', () => {
  const s = createLean();
  const expected = Math.atan(((60 / 3.6) * 0.5) / 9.81) * DEG;
  ride(s, { seconds: 4, kmh: 60, turnDegS: 0.5 * DEG, every: 7 });
  assert.ok(Math.abs(s.maxRight - expected) < 0.5, String(s.maxRight));
});
