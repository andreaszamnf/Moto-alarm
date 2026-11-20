// Writes firmware/moto-alarm/secrets.h with the server address (from server/wrangler.toml) and
// the device key (from .secrets/device-key.txt). The key is not printed.
// Usage: node tools/make-firmware-secrets.mjs [APN]   (no APN: the network's default)
import { readFileSync, writeFileSync } from 'node:fs';

const file = (path) => new URL(`../${path}`, import.meta.url);

const key = readFileSync(file('.secrets/device-key.txt'), 'utf8').trim();
if (!/^[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error('.secrets/device-key.txt does not look like a device key');

const origin = readFileSync(file('server/wrangler.toml'), 'utf8').match(/^PUBLIC_ORIGIN\s*=\s*"(https:\/\/[^"]+)"/m)?.[1];
if (!origin) throw new Error('PUBLIC_ORIGIN not found in server/wrangler.toml');
if (origin.includes('YOUR-SUBDOMAIN')) {
  throw new Error('Put your own address in PUBLIC_ORIGIN in server/wrangler.toml (npx wrangler deploy prints it)');
}

const apn = (process.argv[2] ?? '').trim();
if (!/^[A-Za-z0-9._-]*$/.test(apn)) throw new Error('The APN may only have letters, digits, dots and dashes');

writeFileSync(
  file('firmware/moto-alarm/secrets.h'),
  `// Made by tools/make-firmware-secrets.mjs. Keep it private: the key lets anyone post device reports.
#pragma once
#define SERVER_URL "${origin}/api/device/report"
#define DEVICE_KEY "${key}"
#define SIM_APN "${apn}"  // empty: the network's default
`,
);
console.log(`firmware/moto-alarm/secrets.h: ${origin}, APN ${apn ? `"${apn}"` : '(network default)'}, device key included (not shown).`);
