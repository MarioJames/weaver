import { chmodSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A fake `opencode` executable for tests. `--version` prints the given text (and exits with `exit`);
 * any other invocation reads stdin and emits one OpenCode-shaped JSON event stream whose text part
 * reports the argv and cwd it was started with, so a test sees exactly what a launcher produced.
 * `countFile` receives one line per `--version` call.
 */
export function writeFakeOpencode(dir: string, options: { version: string; exit?: number; countFile?: string }): string {
  const file = join(dir, 'opencode');
  const script = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  ${options.countFile ? `fs.appendFileSync(${JSON.stringify(options.countFile)}, 'probe\\n');` : ''}
  process.stdout.write(${JSON.stringify(options.version)} + '\\n');
  process.exit(${options.exit ?? 0});
}
const stdin = fs.readFileSync(0, 'utf8');
const base = { sessionID: 'ses_fake' };
const lines = [
  { type: 'step_start', ...base, part: { type: 'step-start' } },
  { type: 'text', ...base, part: { type: 'text', text: JSON.stringify({ argv: args, cwd: process.cwd(), pwd: process.env.PWD, stdin }) } },
  { type: 'step_finish', ...base, part: { type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1 } } },
];
process.stdout.write(lines.map(line => JSON.stringify(line)).join('\\n') + '\\n');
`;
  writeFileSync(file, script, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

/** Move the file's mtime so a path-and-mtime cache key sees a different binary. */
export function touchLater(file: string, seconds = 5): void {
  const when = new Date(Date.now() + seconds * 1000);
  utimesSync(file, when, when);
}
