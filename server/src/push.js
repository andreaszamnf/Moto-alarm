// Web Push without dependencies: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291).
// Uses only WebCrypto, so it runs unchanged on Cloudflare Workers and on Node.
import { b64urlDecode, b64urlEncode, concatBytes } from './b64.js';

const encoder = new TextEncoder();

async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// Derives the content key and nonce shared by the sender and the browser.
export async function deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt }) {
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concatBytes(encoder.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hmacSha256(prkKey, concatBytes(keyInfo, Uint8Array.of(1)));
  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concatBytes(encoder.encode('Content-Encoding: aes128gcm\0'), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concatBytes(encoder.encode('Content-Encoding: nonce\0'), Uint8Array.of(1)))).slice(0, 12);
  return { cek, nonce };
}

// Encrypts one push message. `asKeyPair` and `salt` are only passed in by tests.
export async function encryptPayload({ uaPublic, authSecret, plaintext, asKeyPair, salt, recordSize = 4096 }) {
  const keyPair = asKeyPair ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const saltBytes = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, keyPair.privateKey, 256));
  const { cek, nonce } = await deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt: saltBytes });

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const record = concatBytes(plaintext, Uint8Array.of(2)); // 0x02 = last record, no padding
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  const header = new Uint8Array(21);
  header.set(saltBytes, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = asPublic.length;
  return concatBytes(header, asPublic, ciphertext);
}

function vapidJwk(privateJwk) {
  const { kty, crv, d, x, y } = typeof privateJwk === 'string' ? JSON.parse(privateJwk) : privateJwk;
  return { kty, crv, d, x, y };
}

export function vapidPublicKey(privateJwk) {
  const { x, y } = vapidJwk(privateJwk);
  return b64urlEncode(concatBytes(Uint8Array.of(4), b64urlDecode(x), b64urlDecode(y)));
}

export async function vapidAuthorization(endpoint, { privateJwk, subject }) {
  const { protocol, host } = new URL(endpoint);
  const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    encoder.encode(JSON.stringify({ aud: `${protocol}//${host}`, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })),
  );
  const key = await crypto.subtle.importKey('jwk', vapidJwk(privateJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64urlEncode(new Uint8Array(signature))}, k=${vapidPublicKey(privateJwk)}`;
}

export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = vapidJwk(await crypto.subtle.exportKey('jwk', pair.privateKey));
  return { privateJwk, publicKey: vapidPublicKey(privateJwk) };
}

// Sends one notification. `gone` means the browser unsubscribed and the subscription should be deleted.
export async function sendPush(subscription, payload, vapid, fetchImpl = fetch) {
  const body = await encryptPayload({
    uaPublic: b64urlDecode(subscription.p256dh),
    authSecret: b64urlDecode(subscription.auth),
    plaintext: encoder.encode(JSON.stringify(payload)),
  });
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: payload.urgent ? 'high' : 'normal',
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
