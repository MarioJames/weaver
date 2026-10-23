#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export { cleanup, cutoffTime } from '../src/shared/opencode-cleanup-core.mjs';
import { cleanup } from '../src/shared/opencode-cleanup-core.mjs';
function main() {
  const options = { db: join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'opencode/opencode.db') };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return { usage: 'node scripts/cleanup-opencode.mjs [--db PATH] [--keep-days POSITIVE_INTEGER] [--apply] [--vacuum] [--prune-events] [--event-idle-minutes NON_NEGATIVE_INTEGER]', default: 'preview; retain Shanghai calendar today' };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--vacuum') options.vacuum = true;
    else if (arg === '--prune-events') options.pruneEvents = true;
    else if (arg === '--db' || arg === '--keep-days' || arg === '--event-idle-minutes') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--db') options.db = resolve(value);
      else if (arg === '--event-idle-minutes') { if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('--event-idle-minutes must be a non-negative integer'); options.eventIdleMinutes = Number(value); }
      else { if (!/^[1-9]\d*$/.test(value)) throw new Error('--keep-days must be a positive integer'); options.keepDays = Number(value); }
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  process.stderr.write('Checking OpenCode database cleanup eligibility…\n');
  return cleanup(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.stdout.write(`${JSON.stringify({ status: 'error', error: error.message })}\n`); process.exitCode = 1; }
}
