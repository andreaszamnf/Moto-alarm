// Signed app tokens (HMAC-SHA256) and constant-time secret comparison.
import { b64urlDecode, b64urlEncode } from './b64.js';

const encoder = new TextEncoder();

function hmacKey(secret, usages) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function signToken(secret, claims) {
  const body = b64urlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), encoder.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(signature))}`;
}

export async function verifyToken(secret, token, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, ['verify']),
      b64urlDecode(signature),
      encoder.encode(body),
    );
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (typeof claims.exp === 'number' && nowSeconds > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

// Compares two secrets without leaking how many leading characters matched.
export async function secretsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.sign('HMAC', key, encoder.encode(v))));
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

export async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomKey(bytes = 24) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}
