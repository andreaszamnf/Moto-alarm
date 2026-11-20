// The Wi-Fi networks the board reports over when one is in reach (home, or a network near where
// the bike is parked). Keeps them in .secrets/wifi-networks.json and writes firmware/moto-alarm/wifi.h.
// Passwords are typed here, never shown or printed.
// Usage: node tools/set-wifi.mjs                  add a network, or change the password of one
//        node tools/set-wifi.mjs --list           show the network names
//        node tools/set-wifi.mjs --remove "name"  forget one
// Then compile and upload the firmware again (USB, or tools/publish-firmware.mjs).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const store = new URL('../.secrets/wifi-networks.json', import.meta.url);
const header = new URL('../firmware/moto-alarm/wifi.h', import.meta.url);
const MAX = 5;

// C string literal: only printable ASCII is safe in the firmware; quotes and backslashes escaped.
const literal = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const printable = (s) => /^[\x20-\x7E]*$/.test(s);
const unescape = (s) => s.replace(/\\(.)/g, '$1');

function load() {
  if (existsSync(store)) return JSON.parse(readFileSync(store, 'utf8'));
  // The first version of this tool wrote one network straight into wifi.h.
  if (existsSync(header)) {
    const text = readFileSync(header, 'utf8');
    const ssid = text.match(/#define WIFI_SSID "((?:[^"\\]|\\.)*)"/)?.[1];
    const password = text.match(/#define WIFI_PASSWORD "((?:[^"\\]|\\.)*)"/)?.[1];
    if (ssid !== undefined && password !== undefined) return [{ ssid: unescape(ssid), password: unescape(password) }];
  }
  return [];
}

function save(networks) {
  mkdirSync(new URL('../.secrets/', import.meta.url), { recursive: true });
  writeFileSync(store, `${JSON.stringify(networks, null, 2)}\n`);
  if (!networks.length) {
    if (existsSync(header)) rmSync(header);
    return;
  }
  const list = networks.map((n) => `  {${literal(n.ssid)}, ${literal(n.password)}}`).join(', \\\n');
  writeFileSync(
    header,
    `// Made by tools/set-wifi.mjs from .secrets/wifi-networks.json. Private: not in git.
#pragma once
#define WIFI_NETWORKS { \\
${list} \\
}
`,
  );
}

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(text);
        else if (!text.includes('\n') && !text.includes('\r')) rl.output.write('*'.repeat(text.length));
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const show = (networks) =>
  console.log(networks.length ? `Δίκτυα Wi-Fi της πλακέτας: ${networks.map((n) => `«${n.ssid}»`).join(', ')}` : 'Η πλακέτα δεν ξέρει κανένα Wi-Fi.');

const networks = load();
const args = process.argv.slice(2);

if (args[0] === '--list') {
  show(networks);
  process.exit(0);
}

if (args[0] === '--remove') {
  const name = args[1] ?? '';
  const left = networks.filter((n) => n.ssid !== name);
  if (left.length === networks.length) {
    console.error(`Δεν υπάρχει δίκτυο «${name}».`);
    show(networks);
    process.exit(1);
  }
  save(left);
  console.log(`Το «${name}» αφαιρέθηκε.`);
  show(left);
  process.exit(0);
}

show(networks);
const ssid = (await ask('Όνομα του Wi-Fi που θα προστεθεί (όπως φαίνεται στο κινητό): ')).trim();
if (!ssid || ssid.length > 32 || !printable(ssid)) {
  console.error('Το όνομα πρέπει να έχει 1 έως 32 λατινικούς χαρακτήρες.');
  process.exit(1);
}
const existing = networks.find((n) => n.ssid === ssid);
if (!existing && networks.length >= MAX) {
  console.error(`Χωράνε έως ${MAX} δίκτυα. Αφαίρεσε πρώτα ένα με --remove.`);
  process.exit(1);
}
const password = await ask('Κωδικός του Wi-Fi (δεν φαίνεται όσο γράφεις): ', true);
if (password.length > 63 || (password.length > 0 && password.length < 8) || !printable(password)) {
  console.error('Ο κωδικός πρέπει να έχει 8 έως 63 λατινικούς χαρακτήρες (ή να είναι κενός για ανοιχτό δίκτυο).');
  process.exit(1);
}
if (existing) existing.password = password;
else networks.push({ ssid, password });
save(networks);
console.log(existing ? `Ο κωδικός του «${ssid}» άλλαξε.` : `Προστέθηκε το «${ssid}».`);
show(networks);
