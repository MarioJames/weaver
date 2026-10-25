import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep real development accounts and databases private and persistent.
process.umask(0o077);
const repo = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const defaults = [];
// Let the real web parser reject duplicates, unknown flags and unsupported --flag=value.
// In particular, do not append a default after a malformed user-supplied data-dir.
if (!args.some(arg => arg === '--data-dir' || arg.startsWith('--data-dir='))) {
  defaults.push('--data-dir', join(homedir(), '.local', 'share', 'weaver-real-test'));
}
if (!args.some(arg => arg === '--port' || arg.startsWith('--port='))) defaults.push('--port', '4738');
const { tsImport } = await import('tsx/esm/api');
const { parseWeb } = await tsImport('../src/cli/commands/web.ts', import.meta.url);
const { defaultDataDir } = await tsImport('../src/cli/parse.ts', import.meta.url);
const inside = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
function canonical(path) {
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) ancestor = resolve(ancestor, '..');
  return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)));
}
try {
  const web = parseWeb(['web', '--dev', '--no-open', ...defaults, ...args]);
  const target = canonical(web.dataDir);
  const productionRoots = [join(homedir(), '.local/share/weaver'), defaultDataDir()];
  if (web.port === 4737 || productionRoots.some(root => {
    const production = canonical(root);
    return inside(production, target) || inside(target, production);
  })) throw Object.assign(new Error('dev:real refuses production data directories and port 4737'), { code: 'UNSAFE_TARGET' });
} catch (error) {
  console.error(`${error.code ?? 'INVALID_ARGUMENT'}: ${error.message}`);
  process.exit(1);
}
const child = spawn(process.execPath, [
  join(repo, 'node_modules/tsx/dist/cli.mjs'), 'watch', '--clear-screen=false',
  'src/cli/main.ts', 'web', '--dev', '--no-open', ...defaults, ...args,
], { cwd: repo, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
