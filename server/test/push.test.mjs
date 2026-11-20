import assert from 'node:assert/strict';
import test from 'node:test';
import { b64urlDecode, b64urlEncode } from '../src/b64.js';
import { deriveKeys, encryptPayload, generateVapidKeys, sendPush, vapidAuthorization } from '../src/push.js';

// RFC 8291, Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_' +
    'yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

async function importEcdhPair(publicB64, privateB64) {
  const raw = b64urlDecode(publicB64);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)), d: privateB64 };
  return {
    privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
}

// What the browser does on receipt, so we can check our encryption end to end.
async function decryptAsBrowser(body, uaPair, authSecret) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaPair.publicKey));
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPair.privateKey, 256));
  const { cek, nonce } = await deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt });
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ciphertext));
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  assert.equal(record[end], 2, 'record must end with the last-record delimiter');
  return new TextDecoder().decode(record.slice(0, end));
}

test('encryption matches the RFC 8291 test vector byte for byte', async () => {
  const body = await encryptPayload({
    uaPublic: b64urlDecode(RFC.uaPublic),
    authSecret: b64urlDecode(RFC.authSecret),
    plaintext: new TextEncoder().encode(RFC.plaintext),
    asKeyPair: await importEcdhPair(RFC.asPublic, RFC.asPrivate),
    salt: b64urlDecode(RFC.salt),
  });
  assert.equal(b64urlEncode(body), RFC.body);
});

test('a fresh message decrypts back to the original text', async () => {
  const uaPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const text = JSON.stringify({ title: 'Συναγερμός μηχανής', body: 'Κάποιος κουνάει τη μηχανή!' });
  const body = await encryptPayload({
    uaPublic: new Uint8Array(await crypto.subtle.exportKey('raw', uaPair.publicKey)),
    authSecret,
    plaintext: new TextEncoder().encode(text),
  });
  assert.equal(await decryptAsBrowser(body, uaPair, authSecret), text);
});

test('VAPID header carries a valid ES256 token for the push service origin', async () => {
  const { privateJwk, publicKey } = await generateVapidKeys();
  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { privateJwk, subject: 'https://example.com' });
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, header);
  const [, jwt, key] = match;
  assert.equal(key, publicKey);

  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://example.com');
  assert.ok(claims.exp > Date.now() / 1000);

  const verifyKey = await crypto.subtle.importKey('raw', b64urlDecode(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    b64urlDecode(s),
    new TextEncoder().encode(`${h}.${c}`),
  );
  assert.ok(valid, 'signature must verify');
});

test('sendPush posts an encrypted body and reports dead subscriptions', async () => {
  const uaPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const subscription = {
    endpoint: 'https://push.example.com/send/123',
    p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', uaPair.publicKey))),
    auth: b64urlEncode(authSecret),
  };
  const vapid = { ...(await generateVapidKeys()), subject: 'https://example.com' };

  let seen;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return new Response(null, { status: 410 });
  };
  const result = await sendPush(subscription, { title: 'Δοκιμή', urgent: true }, vapid, fakeFetch);

  assert.equal(seen.url, subscription.endpoint);
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.init.headers.Urgency, 'high');
  assert.equal(JSON.parse(await decryptAsBrowser(seen.init.body, uaPair, authSecret)).title, 'Δοκιμή');
  assert.deepEqual(result, { ok: false, status: 410, gone: true });
});
