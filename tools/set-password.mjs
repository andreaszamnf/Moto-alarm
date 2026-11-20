// Sets the app password on Cloudflare. Unlike `wrangler secret put`, the password is visible
// while you type it, and Greek letters (which look like Latin ones) are refused.
//   node tools/set-password.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = fileURLToPath(new URL('../server/', import.meta.url));

function problem(password) {
  if (password.length < 8) return 'Θέλει τουλάχιστον 8 χαρακτήρες.';
  if (/[^\x20-\x7e]/.test(password)) {
    return 'Έχει ελληνικά ή άλλα ειδικά γράμματα. Γύρνα το πληκτρολόγιο στα αγγλικά (Alt+Shift) και γράψ\' τον ξανά.';
  }
  return null;
}

function run(command, input) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: SERVER_DIR, shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
let password;
for (;;) {
  password = (await rl.question('\nΓράψε τον κωδικό της εφαρμογής (θα φαίνεται, για να τον ελέγξεις): ')).trim();
  const issue = problem(password);
  if (issue) {
    console.log(`  ${issue}`);
    continue;
  }
  const answer = (await rl.question(`  Θα μπει ο κωδικός: ${password}\n  Σωστός; (ν/ο): `)).trim().toLowerCase();
  if (['ν', 'n', 'y', 'ναι', 'yes'].includes(answer)) break;
}
rl.close();
console.clear?.();

console.log('\nΑνέβασμα στην Cloudflare...');
const ok = await run('npx wrangler secret put APP_PASSWORD', password);
if (!ok) {
  console.log('Κάτι πήγε στραβά με το ανέβασμα. Δες το μήνυμα παραπάνω.');
  process.exit(1);
}
await run(`npx wrangler d1 execute moto-alarm --remote --command "DELETE FROM kv WHERE k = 'login_fails'" --yes`, '');
console.log('\nΈτοιμο. Ο νέος κωδικός ισχύει και ο μετρητής λάθος προσπαθειών μηδενίστηκε.');
