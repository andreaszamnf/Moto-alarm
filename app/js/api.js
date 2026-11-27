// Talks to the server. The login token lives in localStorage so the app stays signed in.
const TOKEN_KEY = 'moto-alarm.token';

export class AuthError extends Error {}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): the user will log in again next time.
  }
}

// Every request gives up after `timeoutMs`: on a weak signal one used to hang for minutes, with the
// buttons locked meanwhile. A failed connection comes out as "offline", a request with no answer in
// time as "timeout". `keepalive` lets a request go on when the phone is locked right after a tap.
export async function api(path, { method = 'GET', body, timeoutMs = 20_000, keepalive = false } = {}) {
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(`api/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        keepalive,
        signal: controller.signal,
      });
    } catch {
      throw new Error(controller.signal.aborted ? 'timeout' : 'offline');
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      if (controller.signal.aborted) throw new Error('timeout');
      // Non-JSON error page; fall through to the status check.
    }
    if (res.status === 401) throw new AuthError(data.error || 'unauthorized');
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}
