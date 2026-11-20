// Makes the key pair that signs firmware updates. The private key stays in .secrets/ (not in git; keep
// a copy somewhere safe); the public key goes into firmware/moto-alarm/firmware_key.h, so the board
// only installs firmware that we signed. Run once; later runs only rewrite the header.
// Losing the private key means the next update has to go over the USB cable with a new key.
// Usage: node tools/make-firmware-signing-key.mjs
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const file = (path) => new URL(`../${path}`, import.meta.url);
const PRIVATE = file('.secrets/firmware-signing.pem');

let privateKey;
if (existsSync(PRIVATE)) {
  privateKey = createPrivateKey(readFileSync(PRIVATE));
} else {
  ({ privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }));
  mkdirSync(file('.secrets'), { recursive: true });
  writeFileSync(PRIVATE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('New signing key in .secrets/firmware-signing.pem (not shown).');
}

const pem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).trim();
const lines = pem
  .split('\n')
  .map((line) => `    "${line}\\n"`)
  .join('\n');
writeFileSync(
  file('firmware/moto-alarm/firmware_key.h'),
  `// Public key that firmware updates must be signed with. Made by tools/make-firmware-signing-key.mjs;
// the private half is in .secrets/firmware-signing.pem.
#pragma once

static const char FIRMWARE_PUBLIC_KEY[] =
${lines};
`,
);
console.log('firmware/moto-alarm/firmware_key.h written.');
