// Pushover (pushover.net): the loud alarm. With "critical alerts" turned on in the Pushover app,
// an emergency-priority message sounds on the iPhone even in silent mode and Do Not Disturb, at
// the volume chosen in the app, and repeats until it is acknowledged there.
const API = 'https://api.pushover.net/1';
const KEY_RE = /^[A-Za-z0-9]{30}$/;

// User keys and API tokens are both 30 letters and digits.
export const validKey = (key) => typeof key === 'string' && KEY_RE.test(key);

// A sound name: Pushover's own, or one the user uploaded. Silent ones make no sense for an alarm.
export const validSound = (sound) =>
  typeof sound === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(sound) && sound !== 'none' && sound !== 'vibrate';

// Used when Pushover cannot be asked for the list: its own alarm-like sounds.
const ALARM_SOUNDS = {
  siren: 'Siren',
  persistent: 'Persistent (long)',
  alien: 'Alien Alarm (long)',
  echo: 'Pushover Echo (long)',
  updown: 'Up Down (long)',
  climb: 'Climb (long)',
  spacealarm: 'Space Alarm',
  mechanical: 'Mechanical',
  tugboat: 'Tug Boat',
  bugle: 'Bugle',
};

// Every sound the alarm can use, including ones the user uploaded to pushover.net.
export async function listSounds({ token }) {
  try {
    const res = await fetch(`${API}/sounds.json?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (data.status === 1 && data.sounds) {
      return Object.entries(data.sounds)
        .filter(([id]) => validSound(id))
        .map(([id, name]) => ({ id, name }));
    }
  } catch {
    // fall back to the built-in list below
  }
  return Object.entries(ALARM_SOUNDS).map(([id, name]) => ({ id, name }));
}

async function call(path, params) {
  const res = await fetch(`${API}/${path}`, { method: 'POST', body: new URLSearchParams(params) });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // not JSON: treated as a failure below
  }
  return { ok: res.ok && data.status === 1, data };
}

export async function validateUser({ token, user }) {
  return (await call('users/validate.json', { token, user })).ok;
}

// Emergency priority: repeats every `retry` seconds until acknowledged or until `expire` passes.
// Returns the receipt that identifies it (for cancelling), or null if Pushover refused it.
export async function sendEmergency({ token, user }, { title, message, url, urlTitle, callback, sound = 'siren', retry = 60, expire = 10800 }) {
  const params = { token, user, title, message, priority: '2', retry: String(retry), expire: String(expire), sound };
  if (url) Object.assign(params, { url, url_title: urlTitle ?? '' });
  if (callback) params.callback = callback;
  const { ok, data } = await call('messages.json', params);
  return ok ? (data.receipt ?? null) : null;
}

export async function cancelEmergency({ token }, receipt) {
  if (!receipt) return false;
  return (await call(`receipts/${encodeURIComponent(receipt)}/cancel.json`, { token })).ok;
}
