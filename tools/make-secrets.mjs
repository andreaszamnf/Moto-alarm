// Generates the production secrets (except the app password, which you choose yourself).
//   node tools/make-secrets.mjs <secrets.json> <device-key.txt>
// Upload with `npx wrangler secret bulk <secrets.json>` and delete the JSON afterwards.
// The device key is also kept in <device-key.txt> because the board's firmware needs it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateVapidKeys } from '../server/src/push.js';

const [secretsFile, deviceKeyFile] = process.argv.slice(2);
if (!secretsFile || !deviceKeyFile) {
  console.error('usage: node tools/make-secrets.mjs <secrets.json> <device-key.txt>');
  process.exit(1);
}

const random = (bytes) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
const { privateJwk } = await generateVapidKeys();
const deviceKey = random(32);

writeFileSync(secretsFile, JSON.stringify({ TOKEN_SECRET: random(48), DEVICE_KEY: deviceKey, VAPID_PRIVATE_JWK: JSON.stringify(privateJwk) }));
mkdirSync(dirname(deviceKeyFile), { recursive: true });
writeFileSync(deviceKeyFile, `${deviceKey}\n`);
console.log('Τα μυστικά γράφτηκαν (οι τιμές δεν εμφανίζονται εδώ).');
