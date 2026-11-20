// Publishes the compiled firmware as an over-the-air update. Signs firmware/build/moto-alarm.ino.bin
// with .secrets/firmware-signing.pem and uploads it to the Worker's FIRMWARE store. The board takes
// it at its next calm report (heartbeat, boot, parked, locate) and goes back to its old program by
// itself if the new one cannot reach the server.
// Usage, after compiling:  node tools/publish-firmware.mjs [--dry-run]
// --dry-run checks the image and the signature without uploading anything.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = (path) => new URL(`../${path}`, import.meta.url);
const SERVER_DIR = fileURLToPath(file('server/'));

const version = readFileSync(file('firmware/moto-alarm/config.h'), 'utf8').match(/#define FIRMWARE_VERSION "(\d+\.\d+\.\d+)"/)?.[1];
if (!version) throw new Error('FIRMWARE_VERSION not found in firmware/moto-alarm/config.h');

const image = readFileSync(file('firmware/build/moto-alarm.ino.bin'));
if (image[0] !== 0xe9) throw new Error('firmware/build/moto-alarm.ino.bin is not an ESP32 program');
if (image.length > 0x1e0000) throw new Error('The program is bigger than a program slot (1.875 MB, PartitionScheme=min_spiffs)');

// The board checks the signature with the public key built into it.
const privateKey = createPrivateKey(readFileSync(file('.secrets/firmware-signing.pem')));
const signature = sign('sha256', image, privateKey);
const builtIn = readFileSync(file('firmware/moto-alarm/firmware_key.h'), 'utf8');
const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).trim();
const publicLines = publicPem.split('\n').map((line) => `"${line}\\n"`);
if (!publicLines.every((line) => builtIn.includes(line))) {
  throw new Error('firmware_key.h does not match the signing key: run tools/make-firmware-signing-key.mjs and compile again');
}
if (!verify('sha256', image, createPublicKey(privateKey), signature)) throw new Error('Signature check failed');

const latest = {
  v: version,
  size: image.length,
  sig: signature.toString('hex'),
  sha256: createHash('sha256').update(image).digest('hex'),
  published: new Date().toISOString(),
};

if (process.argv.includes('--dry-run')) {
  console.log(`Ready to publish firmware ${version}: ${image.length} bytes, signature checked. Nothing uploaded.`);
  process.exit(0);
}

const wrangler = (args) =>
  execFileSync('npx', ['wrangler', ...args], { cwd: SERVER_DIR, stdio: 'inherit', shell: process.platform === 'win32' });

const dir = mkdtempSync(join(tmpdir(), 'fw-'));
try {
  const imagePath = join(dir, 'image.bin');
  const metaPath = join(dir, 'latest.json');
  writeFileSync(imagePath, image);
  writeFileSync(metaPath, JSON.stringify(latest));
  // The image first, then the pointer to it, so the board never hears of a version that is not there.
  wrangler(['kv', 'key', 'put', `fw/${version}.bin`, '--path', imagePath, '--binding', 'FIRMWARE', '--remote']);
  wrangler(['kv', 'key', 'put', 'fw/latest', '--path', metaPath, '--binding', 'FIRMWARE', '--remote']);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Published firmware ${version} (${image.length} bytes). The board installs it at its next calm report.`);
