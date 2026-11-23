// Runs a Python file inside Autodesk Fusion and prints what it printed.
//
// Needs a folder-watching add-in running in Fusion: it runs every .py that appears in
// <base>/inbox on Fusion's main thread. <base> comes from FUSION_BRIDGE, or from the
// first line of .dev/fusion-bridge.txt (local, not in git).
// This script drops a small wrapper there. The wrapper runs the given file, catches its
// output and writes it to cad/out/run-<id>.txt, which this script then prints. The
// add-in can start the same wrapper a second time while Fusion is busy (a STEP import
// lets it in); that nested call is skipped, so it cannot close the first one's design.
//
// Usage: node tools/fusion-run.mjs <file.py> [seconds to wait, default 300]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [file, secs = '300'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/fusion-run.mjs <file.py> [seconds]');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(root, '.dev', 'fusion-bridge.txt');
const base = process.env.FUSION_BRIDGE || (existsSync(local) && readFileSync(local, 'utf8').split(/\r?\n/)[0].trim());
if (!base) {
  console.error('Set FUSION_BRIDGE, or put the watcher folder in .dev/fusion-bridge.txt');
  process.exit(2);
}
const out = join(root, 'cad', 'out');
mkdirSync(out, { recursive: true });
const id = `${basename(file, '.py')}-${Date.now().toString(36)}`;
const result = join(out, `run-${id}.txt`);
const job = join(base, 'inbox', `${id}.py`);
const py = (p) => JSON.stringify(p.replaceAll('\\', '/'));

writeFileSync(job, `# Written by hornet-alarm tools/fusion-run.mjs
import contextlib, io, os, sys, traceback
src, result = ${py(resolve(file))}, ${py(result)}
if getattr(sys, '_hornet_job', None):
    print('skipped: %s is still running' % sys._hornet_job)
else:
    sys._hornet_job = src
    buf, ok = io.StringIO(), True
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            code = compile(open(src, encoding='utf-8').read(), src, 'exec')
            exec(code, {'__name__': '__main__', '__file__': src})
    except BaseException:
        ok = False
        buf.write(traceback.format_exc())
    finally:
        sys._hornet_job = None
    with open(result + '.tmp', 'w', encoding='utf-8') as f:
        f.write(('OK' if ok else 'ERROR') + '\\n' + buf.getvalue())
    os.replace(result + '.tmp', result)
`, 'utf8');

const until = Date.now() + Number(secs) * 1000;
while (!existsSync(result)) {
  if (Date.now() > until) {
    rmSync(job, { force: true });
    console.error(`Fusion did not answer in ${secs} s. Is the watcher add-in running?`);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 300));
}
const text = readFileSync(result, 'utf8');
rmSync(result);
process.stdout.write(text.slice(text.indexOf('\n') + 1));
process.exit(text.startsWith('OK') ? 0 : 1);
