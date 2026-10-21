import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalIPCError } from '../main/local-ipc';
import { CLI_CATALOG, catalogCommand } from './catalog';
import type { OutputFormat } from './output';

export const DEFAULT_WEB_PORT = 4737;
export function defaultDataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'weaver');
}
export interface CLIOptions {
  command?: string;
  commandId?: string;
  input?: string;
  taskId?: string;
  scheduleId?: string;
  dataDir: string;
  output: OutputFormat;
  forSeconds?: number;
  engine?: string;
  worker?: string;
  cancel?: boolean;
  refresh?: boolean;
  field?: string;
  expectedRevision?: number;
  manifestDigest?: string;
  decision?: string;
  comment?: string;
  commentFile?: string;
}
/** The only commands --engine names; anything else is a wrong-command error. */
const ENGINE_FLAG_COMMANDS = ['engines.penalty', 'engines.unblock', 'engines.models'];
/** The only command the optional --worker names. */
const WORKER_FLAG_COMMANDS = ['workers.probe'];
export function positionals(argv: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    if (['--input', '--command-id', '--data-dir', '--task-id', '--schedule-id', '--port', '--output', '--for', '--agent', '--dir', '--timeout', '--engine', '--worker', '--field', '--expected-revision', '--manifest-digest', '--decision', '--comment', '--comment-file'].includes(arg)) i++;
  }
  return words;
}
export function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new LocalIPCError('INVALID_ARGUMENT', 'Port must be an integer from 0 through 65535');
  const port = Number(value);
  if (port > 65535) throw new LocalIPCError('INVALID_ARGUMENT', 'Port must be an integer from 0 through 65535');
  return port;
}
export function takeOutput(argv: string[], index: number): { format: OutputFormat; next: number } {
  const value = argv[index];
  if (value !== 'json' && value !== 'jsonl' && value !== 'text') throw new LocalIPCError('INVALID_ARGUMENT', '--output must be json, jsonl, or text');
  return { format: value, next: index };
}
export function parseCLI(argv: string[]): CLIOptions {
  const options: CLIOptions = { dataDir: defaultDataDir(), output: 'json' };
  const words: string[] = [];
  const seen = new Set<string>();
  let output: OutputFormat | undefined;
  let jsonAlias = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    if (seen.has(arg)) throw new LocalIPCError('INVALID_ARGUMENT', `Duplicate option ${arg}`);
    seen.add(arg);
    if (arg === '--json') { jsonAlias = true; continue; }
    if (arg === '--cancel') { options.cancel = true; continue; }
 if (arg === '--refresh') { options.refresh = true; continue; }
    if (arg === '--output') { output = takeOutput(argv, ++i).format; continue; }
    if (arg === '--for') {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 600) throw new LocalIPCError('INVALID_ARGUMENT', '--for must be a whole number of seconds from 1 through 600');
      options.forSeconds = Number(value);
      continue;
    }
    if (arg === '--expected-revision') {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new LocalIPCError('INVALID_ARGUMENT', '--expected-revision must be a nonnegative safe integer');
      options.expectedRevision = Number(value);
      continue;
    }
    const key = ({ '--field': 'field', '--manifest-digest': 'manifestDigest', '--decision': 'decision', '--comment': 'comment', '--comment-file': 'commentFile', '--input': 'input', '--command-id': 'commandId', '--data-dir': 'dataDir', '--task-id': 'taskId', '--schedule-id': 'scheduleId', '--engine': 'engine', '--worker': 'worker' } as const)[arg as '--input'];
    if (!key) throw new LocalIPCError('INVALID_ARGUMENT', `Unknown option ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new LocalIPCError('INVALID_ARGUMENT', `Missing value for ${arg}`);
    options[key] = value;
  }
  if (jsonAlias && output) throw new LocalIPCError('INVALID_ARGUMENT', '--json cannot be combined with --output');
  options.output = output ?? 'json';
  if (words.length) {
    const item = catalogCommand(words);
    if (!item) throw new LocalIPCError('INVALID_ARGUMENT', 'Unknown command. Run weaver --help for the catalog.');
    options.command = item.command;
  }
  if (!options.command && !options.input) throw new LocalIPCError('INVALID_ARGUMENT', 'A command or --input envelope is required');
  if (options.input && CLI_CATALOG.find(item => item.command === options.command)?.local) throw new LocalIPCError('INVALID_ARGUMENT', 'tasks wait/watch do not accept --input; use --task-id and --for');
  if (options.forSeconds !== undefined && !CLI_CATALOG.find(item => item.command === options.command)?.local) throw new LocalIPCError('INVALID_ARGUMENT', '--for is only valid for tasks wait and tasks watch');
  if (options.scheduleId !== undefined) {
    if (!['schedules.get', 'schedules.update', 'schedules.delete', 'schedules.enable', 'schedules.disable', 'schedules.run', 'schedules.cancel', 'schedules.runs'].includes(options.command ?? '')) throw new LocalIPCError('INVALID_ARGUMENT', '--schedule-id is only valid for schedules get/update/delete/enable/disable/run/cancel/runs');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.scheduleId)) throw new LocalIPCError('INVALID_ARGUMENT', '--schedule-id must be a UUID');
  }
  if (options.engine !== undefined && !ENGINE_FLAG_COMMANDS.includes(options.command ?? '')) throw new LocalIPCError('INVALID_ARGUMENT', '--engine is only valid for engines penalty, engines unblock and engines models');
  if (options.worker !== undefined && !WORKER_FLAG_COMMANDS.includes(options.command ?? '')) throw new LocalIPCError('INVALID_ARGUMENT', '--worker is only valid for workers probe');
  if (options.cancel && options.command !== 'tasks.retry') throw new LocalIPCError('INVALID_ARGUMENT', '--cancel is only valid for tasks retry');
 if (options.refresh && options.command !== 'engines.models') throw new LocalIPCError('INVALID_ARGUMENT', '--refresh is only valid for engines models');
  const item = CLI_CATALOG.find(entry => entry.command === options.command);
  for (const [key, flag] of [['expectedRevision', '--expected-revision'], ['manifestDigest', '--manifest-digest'], ['decision', '--decision'], ['comment', '--comment'], ['commentFile', '--comment-file']] as const) {
    const field = key === 'commentFile' ? 'comment' : key;
    if (options[key] !== undefined && !(field in (item?.inputFields?.required ?? {}) || field in (item?.inputFields?.optional ?? {}))) throw new LocalIPCError('INVALID_ARGUMENT', `${flag} is only valid for commands with input field ${field}`);
  }
  if (options.decision !== undefined && !['accepted', 'rejected'].includes(options.decision)) throw new LocalIPCError('INVALID_ARGUMENT', '--decision must be accepted or rejected');
  if (options.comment !== undefined && options.commentFile !== undefined) throw new LocalIPCError('INVALID_ARGUMENT', '--comment and --comment-file cannot be combined');
  if (options.field !== undefined) {
    if (!item || item.mutation || item.local) throw new LocalIPCError('INVALID_ARGUMENT', '--field is only valid for non-streaming read commands');
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(options.field)) throw new LocalIPCError('INVALID_ARGUMENT', '--field must be a dot-separated response path, e.g. data.revision');
    if (output || jsonAlias) throw new LocalIPCError('INVALID_ARGUMENT', '--field cannot be combined with --output or --json');
  }
  options.dataDir = resolve(options.dataDir);
  return options;
}
