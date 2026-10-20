#!/usr/bin/env node
import { constants, realpathSync, writeSync } from 'node:fs';
import { connect } from 'node:net';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { failure, LocalIPCError, MAX_FRAME_BYTES, readDiscovery, TRANSPORT_TIMEOUT_MS, requestTimeoutMs } from '../main/local-ipc';
import { openBrowser, startRuntime } from '../main/runtime';
import { VERSION } from '../shared/version';
import { installSkill, SKILL_AGENTS, SKILL_NAME, sourceSkill, type SkillAgent } from './skills';
import { runServer, SERVER_HELP, serverEnv, type Envelope } from './server';

export const DEFAULT_WEB_PORT = 4737;
export type OutputFormat = 'json' | 'jsonl' | 'text';
export interface CatalogCommand {
  command: string;
  mutation: boolean;
  usage: string;
  inputFields?: { required: Record<string,string>; optional?: Record<string,string>; notes?: string };
  rpc?: { method: string; arity: 0 | 1 };
  local?: 'wait' | 'watch';
}

/** One known catalog. Words join with dots; `engines set-enabled` stays hyphenated. */
export const CLI_CATALOG: CatalogCommand[] = [
  { command: 'capabilities.get', mutation: false, usage: 'capabilities | capabilities get' },
  { command: 'sync.snapshot', mutation: false, usage: 'sync snapshot' },
  { command: 'sync.status', inputFields: {"required": {}, "optional": {"after": "integer"}}, mutation: false, usage: 'sync status [--input <json>]' },
  { command: 'owners.list', mutation: false, usage: 'owners list' },
  { command: 'owners.get', inputFields: {"required": {"ownerId": "UUID"}, "optional": {}}, mutation: false, usage: 'owners get --input <json>' },
  { command: 'owners.continuation.get', inputFields: {"required": {"taskId": "UUID"}, "optional": {}}, mutation: false, usage: 'owners continuation get --task-id <id>' },
  { command: 'owners.attach', inputFields: {"required": {"name": "string (1–120)", "profileId": "available owner profile ID"}, "optional": {"session": "unverified reference string", "pane": "unverified reference string"}}, mutation: true, usage: 'owners attach --input <json> --command-id <id>    json: name, profileId, optional session, optional pane. Metadata only; verified stays false.' },
  { command: 'owners.spawn', inputFields: {"required": {"name": "string (1–120)", "profileId": "available owner profile ID"}, "optional": {"provider": "mock (explicit fixture only); omitted registers manual external owner", "session": "unverified reference string (manual only)", "pane": "unverified reference string (manual only)"}}, mutation: true, usage: 'owners spawn --input <json> --command-id <id>    json: name, profileId. Logical registration; no owner model and no session.' },
  { command: 'owners.switch', inputFields: {"required": {"taskId": "UUID", "expectedRevision": "integer"}, "optional": {"expectedEpoch": "integer", "reason": "manual | idle", "profileId": "available owner profile ID", "launch": "boolean (also start the Herdr owner for the new profile; a failed start is reported in launch, the switch stays)"}}, mutation: true, usage: 'owners switch --task-id <id> --input <json> --command-id <id>' },
  { command: 'owners.launch', inputFields: {"required": {"taskId": "UUID", "expectedRevision": "integer (JSON body or --expected-revision)"}, "optional": {}}, mutation: true, usage: 'owners launch --task-id <id> --input <json> --command-id <id>    json: expectedRevision. Starts the owner host from the task context pack and returns the handoff prompt.' },
  { command: 'owners.continuation.configure', inputFields: {"required": {"taskId": "UUID", "expectedRevision": "integer", "idleRotationMinutes": "integer 1–10080 | null"}, "optional": {}}, mutation: true, usage: 'owners continuation configure --task-id <id> --input <json> --command-id <id>' },
  { command: 'tasks.create', inputFields: {"required": {"instruction | goal": "string (1–16000)", "ownerId | ownerProfileId | owner | parentTaskId": "one existing logical owner UUID, profile ID, legacy OwnerRef, or running owner root UUID"}, "optional": {"title": "agent-generated string (1–160); omitted waits for owner naming", "workspace": "nonempty path; omitted uses caller cwd", "ownerName": "string (1–120)", "ownerProvider": "mock only when intentionally using mock Owner", "acceptanceCriteria": "string[] (≤30; each ≤1000)", "constraints": "string[] (≤30; each ≤1000)", "parentTaskId": "running owner root UUID; inherits ownerId, workspace and constraints"}}, mutation: true, usage: 'tasks create --input <json> --command-id <id>' },
  { command: 'tasks.start', inputFields: {required: {taskId: 'UUID'}, optional: {expectedRevision: 'integer'}, notes: 'Starts the root owner asynchronously in Herdr using its claude/codex profile. Returns a running owner root immediately; tasks get/events report host success or launch failure. A failed launch without a host can be retried with a new command ID.'}, mutation: true, usage: 'tasks start --task-id <id> [--input <json>] --command-id <id>' },
  { command: 'tasks.complete', inputFields: {required: {taskId: 'UUID', outcome: 'completed | failed', summary: 'string (1–8000)'}, optional: {expectedRevision: 'integer', artifacts: '≤20 plain text/markdown/JSON files'}, notes: 'Owner root only. Success requires a described root and at least one final subtask, all final subtasks completed and accepted through reviews submit; the parent Agent does not implement itself, indivisible goals still dispatch to one sub-Agent, and superseded retries remain history.'}, mutation: true, usage: 'tasks complete --task-id <id> --input <report.json> --command-id <id>' },
  { command: 'tasks.describe', inputFields: {required: {taskId: 'UUID', expectedRevision: 'integer', title: 'agent-generated string (1–160)', acceptanceCriteria: 'string[1–30] (each ≤1000)'}, optional: {}}, mutation: true, usage: 'tasks describe --task-id <id> --input <json> --command-id <id>    Owner fills title and acceptance criteria before freezing or dispatching; running owner roots allow this until their first child is created.' },
  { command: 'workspaces.list', inputFields: {required: {}, optional: {path: 'absolute existing directory; omitted starts at server cwd'}}, mutation: false, usage: 'workspaces list [--input <json>]' },
  { command: 'tasks.retry', inputFields: {"required": {"taskId": "UUID"}, "optional": {"cancel": "boolean (set by --cancel)", "expectedRevision": "integer"}}, mutation: true, usage: 'tasks retry --task-id <id> [--cancel] --command-id <id>    The server cancels first when cancel is true, copies the frozen package into the linked task, prepends the continuation instructions, dispatches and returns next.' },
  { command: 'tasks.cancel', inputFields: {"required": {"taskId": "UUID"}, "optional": {"expectedRevision": "integer"}}, mutation: true, usage: 'tasks cancel --task-id <id> --command-id <id>' },
  { command: 'tasks.health', inputFields: {"required": {"taskId": "UUID"}, "optional": {}}, mutation: false, usage: 'tasks health --task-id <id>' },
  { command: 'tasks.get', inputFields: {"required": {"taskId": "UUID"}, "optional": {}}, mutation: false, usage: 'tasks get --task-id <id> [--field data.revision]' },
  { command: 'tasks.list', inputFields: {"required": {}, "optional": {"offset": "integer ≥0 (default 0)", "limit": "integer 1–100 (default 25)", "ownerId": "UUID", "parentTaskId": "UUID (filters child tasks, including retry history)"}}, mutation: false, usage: 'tasks list [--input <json>]' },
  { command: 'tasks.events', inputFields: {"required": {"taskId": "UUID"}, "optional": {"after": "event cursor UUID", "limit": "integer 1–100 (default 50)"}}, mutation: false, usage: 'tasks events --task-id <id> [--input <json>]' },
  { command: 'tasks.results', inputFields: {"required": {"taskId": "UUID"}, "optional": {}}, mutation: false, usage: 'tasks results --task-id <id> [--field data.manifestDigest]' },
  { command: 'tasks.wait', inputFields: {"required": {"--task-id": "UUID"}, "optional": {"--for": "seconds 1–600 (default min(600, herdr.max_wait_minutes×60), else 30)"}}, mutation: false, local: 'wait', usage: 'tasks wait --task-id <id> [--for <seconds>]    Returns on terminal state, timeout, or stalled worker; includes reason and stalled health with a retry/cancel hint.' },
  { command: 'tasks.watch', inputFields: {"required": {"--task-id": "UUID"}, "optional": {"--for": "seconds 1–600 (default min(600, herdr.max_wait_minutes×60), else 30)"}}, mutation: false, local: 'watch', usage: 'tasks watch --task-id <id> [--for <seconds>]    Reports stalled transitions in text/jsonl and continues watching.' },
  { command: 'packages.create', inputFields: {"required": {"taskId": "UUID", "scope": "string[1–30] (each ≤1000)"}, "optional": {"acceptanceCriteria": "string[1–30] (each ≤1000); omitted = this child task's own acceptanceCriteria; explicit values win and never overwrite the task", "expectedRevision": "integer"}, "notes": "The package is the only source of the sub-agent's goal and acceptance criteria. The root task is a meta task: do not point at it; write the scope, interface contracts, forbidden areas and concrete criteria into the package."}, mutation: true, usage: 'packages create --task-id <id> --input <json> --command-id <id>' },
  { command: 'packages.get', inputFields: {"required": {"packageId": "UUID"}, "optional": {}}, mutation: false, usage: 'packages get --input <json>' },
  { command: 'workers.spawn', inputFields: {"required": {"taskId": "UUID"}, "optional": {"expectedRevision": "integer", "packageId": "frozen package UUID", "owner": "profile ID (must match task owner)", "worker": "explicit worker ID (omitted picks the owner's least-loaded worker relative to its weight 0-10, default 5, 0 = never: lowest (running+1)/weight wins, ties go to higher weight, then list order)", "provider": "mock-jsonl only for explicit fixture execution"}}, mutation: true, usage: 'workers spawn --task-id <id> [--input <json>] --command-id <id>' },
  { command: 'workers.complete', inputFields: {"required": {"taskId": "UUID", "outcome": "completed | failed", "summary": "result or failure reason (≤8000 chars)"}, "optional": {"expectedRevision": "integer", "artifacts": "≤20 of {name, mediaType: text/plain|text/markdown|application/json, content ≤32000 chars}"}, "notes": "Only for a running task whose dispatch.execution is native: the owner ran that same-engine worker with its built-in subagent tool and reports the outcome here."}, mutation: true, usage: 'workers complete --input <report.json> --command-id <id>' },
  { command: 'workers.probe', inputFields: {"required": {}, "optional": {"worker": "worker ID (set by --worker); omitted probes every eligible free_channel worker"}, notes: 'Probes free_channel workers immediately: one light greeting each, serially. Vendor quota exhaustion writes a weaver-free-probe ban on that engine+model (with the vendor reset time when given); rate limits walk the vendor ladder and other failures the stall ladder. Does not probe paid channels and does not accept commandId or taskId.'}, mutation: true, rpc: { method: 'workerProbe', arity: 1 }, usage: 'workers probe [--worker <id>] [--input <json>]' },
  { command: 'workers.probe-status', mutation: false, rpc: { method: 'workerProbeStatus', arity: 0 }, usage: 'workers probe-status    Probe schedule and per free_channel worker ladder state, block info and recent probe history.' },
  { command: 'results.deliver', inputFields: {"required": {"taskId": "UUID"}, "optional": {}}, mutation: true, usage: 'results deliver --task-id <id> --command-id <id>' },
  { command: 'results.ack', inputFields: {"required": {"taskId": "UUID", "expectedRevision": "integer", "manifestDigest": "current manifest SHA-256"}, "optional": {}}, mutation: true, usage: 'results ack --task-id <id> --expected-revision <integer> --manifest-digest <digest> --command-id <id>    --input <json> also supported.' },
  { command: 'reviews.submit', inputFields: {"required": {"taskId": "UUID", "expectedRevision": "integer", "manifestDigest": "current manifest SHA-256", "decision": "accepted | rejected"}, "optional": {"comment": "string (≤4000)"}}, mutation: true, usage: 'reviews submit --task-id <id> --expected-revision <integer> --manifest-digest <digest> --decision accepted|rejected [--comment <text> | --comment-file <path>] --command-id <id>    --input <json> also supported.' },
  { command: 'artifacts.read', inputFields: {"required": {"taskId": "UUID", "artifactId": "UUID"}, "optional": {}}, mutation: false, usage: 'artifacts read --task-id <id> --input <json>' },
  { command: 'operations.get', inputFields: {"required": {"commandId": "stable mutation command ID"}, "optional": {}}, mutation: false, usage: 'operations get --command-id <id>' },
  { command: 'observability.get', inputFields: {"required": {"taskId": "UUID"}, "optional": {"kind": "event kind"}}, mutation: false, usage: 'observability get --task-id <id>' },
  { command: 'observability.export', inputFields: {"required": {"taskId": "UUID"}, "optional": {"kind": "event kind"}}, mutation: false, usage: 'observability export --task-id <id>' },
  { command: 'policy.get', inputFields: {"required": {}, "optional": {}, "notes": "Policy is stored in weaver.db. Returns revision, config (including the optional display.timezone IANA name), blocks and per-role availability."}, mutation: false, rpc: { method: 'getPolicy', arity: 0 }, usage: 'policy get' },
  { command: 'policy.validate', inputFields: {"required": {"engines": "engine map", "owners": "owner profile map", "workers": "worker profile map", "herdr": "runtime wait settings"}, "optional": {}, "notes": "Body is the full policy config; inspect policy get and src/main/policy/config.schema.json for exact schema."}, mutation: false, rpc: { method: 'validatePolicy', arity: 1 }, usage: 'policy validate --input <config.json>' },
  { command: 'policy.save', inputFields: {"required": {"revision": "current policy revision integer", "config": "full policy config", "blocks": "block array (≤500); a block with worker affects only that worker"}, "optional": {}}, mutation: true, rpc: { method: 'savePolicy', arity: 1 }, usage: 'policy save --input <save.json>' },
 { command: 'policy.preview', inputFields: {"required": {"owner": "owner profile ID"}, "optional": {"worker": "explicit worker ID", "runningCount": "integer ≥0"}}, mutation: false, rpc: { method: 'previewRoute', arity: 1 }, usage: 'policy preview --input <preview.json>' },
 { command: 'policy.history', inputFields: {"required": {}, "optional": {}, "notes": "Every saved policy revision, newest first: revision, savedAt, source (save, import or rollback:<n>). Each holds a full snapshot that policy rollback can restore."}, mutation: false, rpc: { method: 'policyHistory', arity: 0 }, usage: 'policy history' },
 { command: 'policy.rollback', inputFields: {"required": {"revision": "already-saved policy revision integer to restore"}, "optional": {}, "notes": "Restores the stored snapshot of that revision as a NEW revision (history is never rewritten). Needs the user's consent."}, mutation: true, rpc: { method: 'policyRollback', arity: 1 }, usage: 'policy rollback --input <rollback.json>' },
 { command: 'engines.scan', mutation: false, rpc: { method: 'scanEngines', arity: 0 }, usage: 'engines scan' },
 { command: 'engines.models', inputFields: {"required": {"engine": "engine ID (set by --engine)"}, "optional": {"refresh": "boolean, bypass the cache"}, "notes": "Lists the model IDs the engine CLI accepts; unknown until the CLI answers. Cache is per engine+refresh combination."}, mutation: false, rpc: { method: 'listEngineModels', arity: 1 }, usage: 'engines models --engine <id> [--refresh]' },
  { command: 'engines.health', inputFields: {"required": {}, "optional": {}}, mutation: false, usage: 'engines health' },
  { command: 'engines.penalty', inputFields: {"required": {"engine": "engine ID (set by --engine)"}, "optional": {}, "notes": "Stall ladder state and retained history from weaver.db, plus vendorLimit ({level,lastTriggerAt} of the vendor rate-limit ladder, null when none)."}, mutation: false, usage: 'engines penalty --engine <id>' },
  { command: 'engines.unblock', inputFields: {"required": {"engine": "engine ID (set by --engine)"}, "optional": {}}, mutation: true, usage: 'engines unblock --engine <id> --command-id <id>' },
  { command: 'quota.get', mutation: false, rpc: { method: 'getQuota', arity: 0 }, usage: 'quota get' },
  { command: 'quota.refresh', inputFields: { required: {}, optional: { engine: 'codex | claude | grok (omitted refreshes all three)' }, notes: 'Refreshes native account quota without inference and synchronizes Weaver-owned policy blocks. Manual blocks are retained. Does not accept commandId, taskId, --command-id, or --task-id.' }, mutation: true, rpc: { method: 'refreshQuota', arity: 1 }, usage: 'quota refresh [--input <refresh.json>]' },
  { command: 'engines.set-enabled', inputFields: {"required": {"id": "engine ID", "enabled": "boolean", "revision": "current policy revision integer"}, "optional": {}}, mutation: true, rpc: { method: 'setEngineEnabled', arity: 1 }, usage: 'engines set-enabled --input <toggle.json>' },
];

for (const item of CLI_CATALOG) item.inputFields ??= { required: {} };

const CLI_VALUE_OPTIONS = {
  '--field': 'Scalar response path; non-streaming read commands only; exclusive with --output/--json',
  '--expected-revision': 'Nonnegative safe integer; only commands with expectedRevision input',
  '--manifest-digest': 'Result digest; results ack and reviews submit',
  '--decision': 'accepted | rejected; reviews submit',
  '--comment': 'Literal text; reviews submit',
  '--comment-file': 'UTF-8 text file, up to 4000 characters; reviews submit; exclusive with --comment',
};

const catalogHelp = CLI_CATALOG.map(item => `  ${item.usage}`).join('\n');
export const CLI_HELP = `Weaver

  weaver web [--port <0-65535>] [--data-dir <path>] [--no-open] [--dev] [--output json|jsonl|text]
  weaver <command> [--data-dir <path>] [--output json|jsonl|text] [--input <file|->] [--command-id <id>] [--task-id <id>] [--for <seconds>] [--engine <id>] [--worker <id>] [--cancel]
  weaver skills install [--agent claude-code,codex] [--dir <skills-root>] [--link] [--force] [--output json|text]
  weaver server <status|start|stop|install|uninstall> [--port <0-65535>] [--data-dir <path>] [--output json|text] [--force] [--timeout <seconds>]
  weaver --skill prints the bundled agents-weaver SKILL.md

weaver web runs the Weaver service in the foreground: loopback HTTP on 127.0.0.1 and the authenticated Unix CLI socket. Closing a browser does not stop tasks. Ctrl+C stops new work and cancels workers this process started. Task and policy data in weaver.db is kept. Default data directory: $XDG_DATA_HOME/weaver or ~/.local/share/weaver.

If a client command reports APP_NOT_RUNNING, start: weaver server start

--field <response.path> reads one scalar from a successful non-streaming read response, e.g. tasks get --field data.revision or tasks results --field data.manifestDigest. Strings are written literally; numbers, booleans and null use JSON spelling, followed by one newline. Missing or non-scalar fields fail. It cannot be combined with --output/--json. Failed commands keep the error envelope and nonzero exit code. Always check exit status before using a captured field.

--expected-revision <integer>, --manifest-digest <digest>, --decision accepted|rejected and --comment <text> fill the same-named input fields on commands that support them. --comment-file <path> reads review text literally (UTF-8, up to 4000 characters); it cannot be combined with --comment. Conflicting --input fields are rejected. Read a fresh revision after results ack; these flags do not fetch state or weaken revision/digest checks.

--input accepts a JSON file, - for stdin, or an inline JSON object. Prefer a file or a quoted heredoc with --input - for Chinese text, newlines and quotes. Never pipe captured JSON through echo: zsh echo can expand backslash escapes. Use printf '%s\\n' "$response" if you need to forward existing JSON.

--output json writes one weaver.v1 envelope and is the default. jsonl writes one JSON object per line. text writes a short status line. --json is an alias of --output json. --json together with --output is rejected. Errors use the same format. The command does not write extra stdout.

tasks create: an omitted workspace becomes this CLI process's working directory before the request is sent. An explicit path wins. A relative explicit path is resolved against that same caller directory. The server does not fill a workspace from its own directory. Real dispatch still requires the directory to exist.

tasks wait and tasks watch poll tasks get and tasks events. They check tasks health initially, every 30 seconds, and just before timeout; older servers without tasks health keep polling silently. tasks wait returns early with exit code 0 when health is stalled, including health and a retry/cancel hint. Snapshot data includes reason: terminal, timeout, or stalled. Timeout keeps exit code 1 and TIMEOUT. tasks watch reports each transition to stalled in text/jsonl and continues. --for is 1 through 600 seconds; omitted, it defaults to min(600, herdr.max_wait_minutes × 60) from the policy, or 30 seconds when the policy cannot be read. They do not start a second scheduler.

--engine <id> is the engine argument of engines penalty, engines unblock and engines models. --worker <id> is the optional worker argument of workers probe. --cancel is a valueless flag that sets cancel on tasks retry. --refresh is a valueless flag that bypasses the model-list cache on engines models. All of these are rejected on any other command, repeated, missing their value, or when the --input body already carries a different one. tasks retry returns the linked task already dispatched, together with the one thing to do next.

Mutations need --command-id, except policy save, policy rollback, engines set-enabled, quota refresh, and workers probe, which send the JSON body shown in their usage. quota refresh defaults to {} and synchronizes Weaver-owned policy blocks without inference; workers probe defaults to {} and probes every eligible free_channel worker; neither accepts command or task IDs. operations get reads that same --command-id. owners attach stores a name and profile plus optional caller labels. It does not contact a host. owners spawn does not start an owner model. capabilities.realExecution means the worker launcher is loaded, not that a model ran or a login was proven. mock-jsonl is an explicit provider. A real route does not fall back to mock.

${catalogHelp}

Engine scan is PATH plus --version. It does not call a model.`;

const SKILLS_HELP = `weaver skills install [--agent claude-code,codex] [--dir <skills-root>] [--link] [--force] [--output json|text]

Installs the ${SKILL_NAME} skill this executable carries. It does not need a running control plane.

  --agent  Agents to link: claude-code (~/.claude/skills), codex (~/.codex/skills), comma-separated. Default both.
  --dir    Install into <skills-root>/${SKILL_NAME} instead of ~/.agents/skills, with no agent links.
  --link   Link to this source checkout's skills/${SKILL_NAME} instead of copying, so edits apply at once.
  --force  Replace a skill or agent link at those paths that weaver did not install.

The copy goes to ~/.agents/skills/${SKILL_NAME} and each agent path links to it. Rerunning updates a copy weaver installed.`;

const WEB_HELP = `weaver web [--port <0-65535>] [--data-dir <path>] [--no-open] [--dev] [--output json|jsonl|text]

  --port      Loopback port from 0 through 65535. 0 picks a free port. Default ${DEFAULT_WEB_PORT}.
  --data-dir  State directory. Default $XDG_DATA_HOME/weaver or ~/.local/share/weaver.
  --no-open   Do not open a browser.
  --dev       Serve the UI with Vite on the same loopback origin.
  --output    json or jsonl prints one weaver.v1 envelope with the ready URL. The default is one URL line.
  --json      Alias of --output json. Rejected together with --output.

Binds 127.0.0.1 only. Prints the URL after stores and endpoints are ready.`;

export function defaultDataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'weaver');
}
export interface CLIOptions {
  command?: string;
  commandId?: string;
  input?: string;
  taskId?: string;
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
function positionals(argv: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    if (['--input', '--command-id', '--data-dir', '--task-id', '--port', '--output', '--for', '--agent', '--dir', '--timeout', '--engine', '--worker', '--field', '--expected-revision', '--manifest-digest', '--decision', '--comment', '--comment-file'].includes(arg)) i++;
  }
  return words;
}
function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new LocalIPCError('INVALID_ARGUMENT', 'Port must be an integer from 0 through 65535');
  const port = Number(value);
  if (port > 65535) throw new LocalIPCError('INVALID_ARGUMENT', 'Port must be an integer from 0 through 65535');
  return port;
}
function takeOutput(argv: string[], index: number): { format: OutputFormat; next: number } {
  const value = argv[index];
  if (value !== 'json' && value !== 'jsonl' && value !== 'text') throw new LocalIPCError('INVALID_ARGUMENT', '--output must be json, jsonl, or text');
  return { format: value, next: index };
}
function parseWeb(argv: string[]): { port: number; portExplicit: boolean; dataDir: string; open: boolean; dev: boolean; output: OutputFormat; outputExplicit: boolean } {
  let port = DEFAULT_WEB_PORT;
  let portExplicit = false;
  let dataDir = defaultDataDir();
  let open = true;
  let dev = false;
  let output: OutputFormat = 'text';
  let outputExplicit = false;
  let jsonAlias = false;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'web') continue;
    if (!arg.startsWith('--')) throw new LocalIPCError('INVALID_ARGUMENT', `Unexpected argument ${arg}`);
    if (seen.has(arg)) throw new LocalIPCError('INVALID_ARGUMENT', `Duplicate option ${arg}`);
    seen.add(arg);
    if (arg === '--no-open') { open = false; continue; }
    if (arg === '--dev') { dev = true; continue; }
    if (arg === '--json') { jsonAlias = true; outputExplicit = true; continue; }
    if (arg === '--output') {
      output = takeOutput(argv, ++i).format;
      outputExplicit = true;
      continue;
    }
    if (arg !== '--port' && arg !== '--data-dir') throw new LocalIPCError('INVALID_ARGUMENT', `Unknown option ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new LocalIPCError('INVALID_ARGUMENT', `Missing value for ${arg}`);
    if (arg === '--port') { port = parsePort(value); portExplicit = true; }
    else dataDir = resolve(value);
  }
  if (jsonAlias && seen.has('--output')) throw new LocalIPCError('INVALID_ARGUMENT', '--json cannot be combined with --output');
  if (jsonAlias) output = 'json';
  return { port, portExplicit, dataDir, open, dev, output, outputExplicit };
}
function catalogCommand(words: string[]): CatalogCommand | undefined {
  if (words.length === 1 && words[0] === 'capabilities') return CLI_CATALOG.find(item => item.command === 'capabilities.get');
  const joined = words.join('.');
  return CLI_CATALOG.find(item => item.command === joined || (words.length === 1 && item.command === words[0]));
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
    const key = ({ '--field': 'field', '--manifest-digest': 'manifestDigest', '--decision': 'decision', '--comment': 'comment', '--comment-file': 'commentFile', '--input': 'input', '--command-id': 'commandId', '--data-dir': 'dataDir', '--task-id': 'taskId', '--engine': 'engine', '--worker': 'worker' } as const)[arg as '--input'];
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
/** --input is a JSON file, "-" for stdin, or the JSON object itself when it starts with "{". */
export async function readInput(path: string): Promise<unknown> {
  if (path.trimStart().startsWith('{')) {
    if (Buffer.byteLength(path) > MAX_FRAME_BYTES - 1024) throw new LocalIPCError('INVALID_ARGUMENT', 'Input exceeds transport limit');
    try { return JSON.parse(path); } catch { throw new LocalIPCError('INVALID_ARGUMENT', 'Inline --input must be valid JSON'); }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const add = (chunk: Buffer) => { size += chunk.length; if (size > MAX_FRAME_BYTES - 1024) throw new LocalIPCError('INVALID_ARGUMENT', 'Input exceeds transport limit'); chunks.push(chunk); };
  if (path === '-') {
    for await (const chunk of process.stdin) add(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  } else {
    let file;
    try { file = await open(path, 'r'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new LocalIPCError('INVALID_ARGUMENT', code === 'ENOENT' ? `Input file not found: ${path}. Pass a JSON file, - for stdin, or the JSON object itself.` : `Input file could not be read (${code ?? 'error'}): ${path}`);
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_FRAME_BYTES - 1024) throw new LocalIPCError('INVALID_ARGUMENT', 'Input must be a regular JSON file within transport limit');
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) { const { bytesRead } = await file.read(buffer); if (!bytesRead) break; add(Buffer.from(buffer.subarray(0, bytesRead))); }
    } finally { await file.close(); }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LocalIPCError('INVALID_ARGUMENT', 'Input must contain valid JSON'); }
}
/** Read review text literally; never parse it as JSON or expand shell escapes. */
async function readCommentFile(path: string): Promise<string> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { throw new LocalIPCError('INVALID_ARGUMENT', `Comment file could not be read: ${path}`); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16000) throw new LocalIPCError('INVALID_ARGUMENT', 'Comment file must be a regular UTF-8 text file of at most 4000 characters');
    // Bound the read even if another process grows the file after stat.
    const buffer = Buffer.alloc(16001);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    let comment: string;
    try { comment = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
    catch { throw new LocalIPCError('INVALID_ARGUMENT', 'Comment file must contain valid UTF-8 text'); }
    if (length > 16000 || comment.length > 4000) throw new LocalIPCError('INVALID_ARGUMENT', 'Comment file exceeds 4000 characters');
    return comment;
  } finally { await file.close(); }
}
function responseField(response: unknown, path: string): string {
  let value = response;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new LocalIPCError('INVALID_ARGUMENT', `Response field not found: ${path}`);
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return JSON.stringify(value);
  throw new LocalIPCError('INVALID_ARGUMENT', `Response field must be a scalar: ${path}`);
}
/** Put one convenience flag into request args, refusing to overwrite a different --input value. */
function mergeArg(envelope: Record<string, unknown>, key: string, value: unknown, label: string): void {
  const args = envelope.args ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new LocalIPCError('INVALID_ARGUMENT', 'Request args must be an object');
  const record = args as Record<string, unknown>;
  if (key in record && record[key] !== value) throw new LocalIPCError('INVALID_ARGUMENT', `Input ${label} does not match CLI ${label}`);
  envelope.args = { ...record, [key]: value };
}
export function makeRequest(options: CLIOptions, input: unknown = {}): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LocalIPCError('INVALID_ARGUMENT', 'Input must be a JSON object');
  const object = input as Record<string, unknown>;
  const isEnvelope = 'apiVersion' in object || 'command' in object;
  const envelope: Record<string, unknown> = isEnvelope ? { ...object } : { apiVersion: 'weaver.v1', command: options.command, args: object };
  if (options.command && isEnvelope && envelope.command !== options.command) throw new LocalIPCError('INVALID_ARGUMENT', 'Input command does not match CLI command');
  if (options.commandId && envelope.commandId && envelope.commandId !== options.commandId) throw new LocalIPCError('INVALID_ARGUMENT', 'Input command ID does not match CLI command ID');
  envelope.commandId = options.commandId || envelope.commandId || randomUUID();
  if (options.taskId) mergeArg(envelope, 'taskId', options.taskId, 'task ID');
  if (options.engine !== undefined) mergeArg(envelope, 'engine', options.engine, 'engine');
  if (options.cancel) mergeArg(envelope, 'cancel', true, 'cancel');
 if (options.refresh) mergeArg(envelope, 'refresh', true, 'refresh');
  for (const key of ['expectedRevision', 'manifestDigest', 'decision', 'comment'] as const) {
    if (options[key] !== undefined) mergeArg(envelope, key, options[key], key);
  }
  return envelope;
}
/** Fill tasks create workspace from the CLI caller cwd before the request is submitted. */
export function applyCallerWorkspace(request: Record<string, unknown>, cwd: string): void {
  if (request.command !== 'tasks.create') return;
  const args = request.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const record = args as Record<string, unknown>;
  const workspace = record.workspace;
  if (workspace === undefined) { if (record.parentTaskId === undefined) record.workspace = cwd; }
  else if (typeof workspace !== 'string' || workspace.trim() === '') throw new LocalIPCError('INVALID_ARGUMENT', 'Explicit workspace must be a nonempty path string');
  else if (!isAbsolute(workspace)) record.workspace = resolve(cwd, workspace);
}
/** Text carries the same handoff the json next field does: the wait command, or the exact subagent run. */
function renderNext(next: Record<string, unknown>): string[] {
  if (next.action === 'run_subagent') {
    return [`next: run a subagent on model ${next.model}, effort ${next.effort}`, String(next.prompt ?? ''), `then: ${next.then ?? ''}`].filter(Boolean);
  }
  return [`next: ${next.command ?? next.action ?? ''}`];
}
function renderData(data: unknown): string {
  if (!data || typeof data !== 'object') return data === undefined ? '' : String(data);
  const record = data as Record<string, unknown>;
  if (record.reason === 'stalled' && record.health && typeof record.health === 'object') {
    const health = record.health as Record<string, unknown>;
    return [`${record.id ?? ''} stalled (task status: ${record.status ?? 'unknown'})`,
      `health: silenceMs=${health.silenceMs ?? 'unknown'} cpuIdleMs=${health.cpuIdleMs ?? 'unknown'} cpuActive=${health.cpuActive ?? 'unknown'} engine=${health.engine ?? 'unknown'}`,
      `hint: ${record.hint ?? ''}`].join('\n');
  }
  if (typeof record.status === 'string' && typeof record.title === 'string') {
    const lines = [`${record.id ?? ''} ${record.status} ${record.title}`.trim()];
    if (record.next && typeof record.next === 'object') lines.push(...renderNext(record.next as Record<string, unknown>));
    if (Array.isArray(record.excludedEngines) && record.excludedEngines.length) lines.push(`excluded engines: ${record.excludedEngines.join(', ')}`);
    return lines.join('\n');
  }
  if (Array.isArray(record.tasks)) return record.tasks.map(item => renderData(item)).join('\n') || 'No tasks';
  if (Array.isArray(record.owners)) return record.owners.map(item => { const owner = item as Record<string, unknown>; return `${owner.id ?? ''} ${owner.name ?? ''} ${owner.state ?? ''}`.trim(); }).join('\n') || 'No owners';
  if (Array.isArray(record.events)) return record.events.map(item => { const event = item as Record<string, unknown>; return `${event.kind ?? 'event'}: ${event.message ?? ''}`; }).join('\n') || 'No events';
  return JSON.stringify(data);
}
export function renderEnvelope(format: OutputFormat, envelope: { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown; apiVersion?: string; commandId?: string | null }): string {
  if (format !== 'text') return JSON.stringify(envelope);
  if (envelope.ok === false) return `${envelope.error?.code ?? 'ERROR'}: ${envelope.error?.message ?? 'Command failed'}`;
  return renderData(envelope.data);
}
function writeEnvelope(format: OutputFormat, envelope: { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown; apiVersion?: string; commandId?: string | null }): void {
  process.stdout.write(renderEnvelope(format, envelope) + '\n');
}
export async function sendRequest(dataDir: string, request: unknown, timeoutMs = requestTimeoutMs(request)): Promise<unknown> {
  const deadline = Date.now() + Math.min(requestTimeoutMs(request), timeoutMs);
  if(timeoutMs <= 0) throw new LocalIPCError('TIMEOUT', 'Bounded wait deadline reached');
  let endpoint: Awaited<ReturnType<typeof readDiscovery>>;
  try { endpoint = await readDiscovery(dataDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; run weaver server start');
    if (error instanceof LocalIPCError) throw error;
    throw new LocalIPCError('UNSAFE_ENDPOINT', 'Could not safely read the app endpoint');
  }
  const remaining = deadline - Date.now();
  if(remaining <= 0) throw new LocalIPCError('TIMEOUT', 'Bounded wait deadline reached');
  const frame = JSON.stringify({ version: 1, token: endpoint.token, request }) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new LocalIPCError('INVALID_ARGUMENT', 'Request exceeds transport limit');
  return new Promise((resolvePromise, reject) => {
    const socket = connect(endpoint.discovery.socketPath);
    let bytes = Buffer.alloc(0);
    let settled = false;
    const done = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolvePromise(value); };
    const timer = setTimeout(() => done(new LocalIPCError('TIMEOUT', 'App did not respond; a submitted command may still be running. Retry with the same command ID')), remaining);
    socket.once('connect', () => socket.write(frame));
    socket.on('error', error => done(new LocalIPCError(['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '') ? 'APP_NOT_RUNNING' : 'TRANSPORT_ERROR', 'Weaver is not running; run weaver server start')));
    socket.on('data', raw => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (bytes.length + chunk.length > MAX_FRAME_BYTES) return done(new LocalIPCError('INVALID_RESPONSE', 'App response exceeds transport limit'));
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(bytes.subarray(0, end).toString('utf8'));
        if (end !== bytes.length - 1 || response.apiVersion !== 'weaver.v1' || typeof response.ok !== 'boolean') throw new Error();
        done(undefined, response);
      } catch { done(new LocalIPCError('INVALID_RESPONSE', 'App returned an invalid response')); }
    });
    socket.once('close', () => { if (!settled) done(new LocalIPCError('TRANSPORT_ERROR', 'App disconnected; a submitted command may still be running')); });
  });
}
/** The omitted --for deadline: min(600, herdr.max_wait_minutes×60) from the policy, or 30 when it cannot be read. */
export async function defaultForSeconds(dataDir: string): Promise<number> {
  try {
    const policy = await sendRequest(dataDir, { method: 'getPolicy', args: [] }, 2000) as { ok?: boolean; data?: { config?: { herdr?: { max_wait_minutes?: unknown } } } };
    const minutes = policy.data?.config?.herdr?.max_wait_minutes;
    if (policy.ok === true && typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) return Math.min(600, minutes * 60);
  } catch { /* keep the fallback below */ }
  return 30;
}
export interface PollRuntime {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  request: typeof sendRequest;
}

async function pollTask(options: CLIOptions, mode: 'wait' | 'watch', runtime: Partial<PollRuntime> = {}): Promise<number> {
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const send = runtime.request ?? sendRequest;
  const deadline = now() + (options.forSeconds ?? await defaultForSeconds(options.dataDir)) * 1000;
  const request = (command:string,args:Record<string,unknown>) => send(options.dataDir, makeRequest({...options,command},args), deadline-now());
  let after: string | undefined;
  let snapshot: { ok: boolean; data?: { status?: string; [key: string]: unknown } } | undefined;
  let health: Record<string, unknown> | undefined;
  let healthSupported = true;
  let nextHealthAt = 0;
  let wasStalled = false;
  const hint = `weaver tasks retry --task-id ${options.taskId} --cancel or weaver tasks cancel --task-id ${options.taskId}`;
  const finish = (reason: 'terminal' | 'timeout' | 'stalled') => {
    const data = { ...snapshot?.data, reason, ...(reason === 'stalled' ? { health, hint } : {}) };
    writeEnvelope(options.output, reason === 'timeout'
      ? { ...failure('TIMEOUT', 'Stopped polling before the task reached a terminal state'), data }
      : { ...snapshot, data });
    return reason === 'timeout' ? 1 : 0;
  };
  try {
    for (;;) {
      snapshot = await request('tasks.get', {}) as NonNullable<typeof snapshot>;
      if (!snapshot.ok) { writeEnvelope(options.output, snapshot); return 1; }
      if (mode === 'watch') {
        let more: boolean;
        do {
          const events = await request('tasks.events', {limit:100,...(after?{after}:{})}) as {ok:boolean;data?:{events?:{id?:string;kind?:string;message?:string}[];nextCursor?:string|null;hasMore?:boolean}};
          if (!events.ok) { writeEnvelope(options.output, events); return 1; }
          for (const item of events.data?.events ?? []) {
            if (options.output === 'jsonl') writeEnvelope('jsonl', {apiVersion:'weaver.v1',commandId:null,ok:true,data:item});
            else if (options.output === 'text') process.stdout.write(`${item.kind ?? 'event'}: ${item.message ?? ''}\n`);
          }
          more = events.data?.hasMore === true;
          const next = events.data?.nextCursor ?? events.data?.events?.at(-1)?.id;
          if(more && (!next || next===after)) throw new LocalIPCError('INVALID_RESPONSE','Event pagination did not advance');
          if(next) after=next;
        } while(more);
      }
      if (['completed','failed','cancelled'].includes(snapshot.data?.status ?? '')) {
        return finish('terminal');
      }
      // Reserve the last polling interval for a final health read inside the same deadline.
      const finalInterval = deadline - now() <= 250;
      if (healthSupported && (now() >= nextHealthAt || finalInterval)) {
        nextHealthAt = now() + 30_000;
        const response = await request('tasks.health', {}) as { ok: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } };
        if (!response.ok) {
          const code = response.error?.code;
          if (code === 'COMMAND_UNKNOWN' || code === 'UNKNOWN_METHOD' || code === 'METHOD_NOT_FOUND' ||
            (code === 'INVALID_REQUEST' && /^unknown method\b/i.test(response.error?.message ?? ''))) healthSupported = false;
          else { writeEnvelope(options.output, response); return 1; }
        } else {
          health = response.data;
          const stalled = health?.state === 'stalled';
          if (stalled && mode === 'wait') return finish('stalled');
          if (stalled && !wasStalled && options.output !== 'json') {
            writeEnvelope(options.output, { apiVersion: 'weaver.v1', ok: true, data: { ...snapshot.data, reason: 'stalled', health, hint } });
          }
          wasStalled = stalled;
        }
      }
      const remaining=deadline-now();
      if(remaining<=0)return finish('timeout');
      await sleep(Math.min(250,remaining));
      if(finalInterval || now() >= deadline)return finish('timeout');
    }
  } catch (error) {
    if (snapshot?.ok && error instanceof LocalIPCError && error.code === 'TIMEOUT') return finish('timeout');
    throw error;
  }
}
/** Read a valid requested format before parsing can fail, independent of flag ordering. */
function requestedOutput(argv:string[]):OutputFormat {
  const values=argv.flatMap((arg,index)=>arg==='--output'?[argv[index+1]]:[]);
  if(values.some(value=>!['json','jsonl','text'].includes(value)))return 'json';
  return values.at(-1) as OutputFormat ?? 'json';
}
function startupFailure(error: unknown, port: number): LocalIPCError {
  if (error instanceof LocalIPCError) return error;
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return new LocalIPCError('EADDRINUSE', `127.0.0.1:${port} is already in use. Stop the other process or choose a free port with --port.`);
  const raw = error instanceof Error ? error.message : 'Weaver could not start';
  const message = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 400);
  return new LocalIPCError('STARTUP_FAILED', message || 'Weaver could not start');
}
function readyLine(url: string, port: number, format: OutputFormat, extra: Record<string, unknown> = {}): string {
  if (format === 'text') return url + '\n';
  return JSON.stringify({ apiVersion: 'weaver.v1', commandId: null, ok: true, data: { url, port, ...extra } }) + '\n';
}
type RunningInfo = { data: { url: string; port: number } & Record<string, unknown> };
async function checkRunning(dataDir: string): Promise<RunningInfo | undefined> {
  try {
    const response = await sendRequest(dataDir, { method: 'serverInfo', args: [] }, 2000) as { ok?: boolean; data?: unknown };
    const info = response.ok === true && response.data && typeof response.data === 'object' ? response.data as RunningInfo['data'] : undefined;
    if (typeof info?.url === 'string' && info.url && typeof info.port === 'number' && Number.isInteger(info.port) && info.port > 0) return { data: info };
  } catch { /* unreadable endpoints fall through to a normal start */ }
  return undefined;
}
function runSkills(argv: string[], words: string[]): number {
  if (words.length !== 2 || words[1] !== 'install') throw new LocalIPCError('INVALID_ARGUMENT', 'Usage: weaver skills install [--agent claude-code,codex] [--dir <skills-root>] [--link] [--force]');
  let agents: SkillAgent[] = [...SKILL_AGENTS];
  let dir: string | undefined;
  let link = false;
  let force = false;
  let output: OutputFormat = 'text';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === 'skills' || arg === 'install') continue;
    if (arg === '--link') link = true;
    else if (arg === '--force') force = true;
    else if (arg === '--json') output = 'json';
    else if (arg === '--output') { const value = argv[++i]; if (value !== 'json' && value !== 'text') throw new LocalIPCError('INVALID_ARGUMENT', '--output must be json or text'); output = value; }
    else if (arg === '--agent') {
      const value = argv[++i] ?? '';
      const chosen = value.split(',').map(item => item.trim()).filter(Boolean);
      if (!chosen.length || chosen.some(item => !(SKILL_AGENTS as readonly string[]).includes(item))) throw new LocalIPCError('INVALID_ARGUMENT', '--agent takes claude-code, codex, or claude-code,codex');
      agents = chosen as SkillAgent[];
    } else if (arg === '--dir') {
      const value = argv[++i];
      if (!value || !isAbsolute(value)) throw new LocalIPCError('INVALID_ARGUMENT', '--dir must be an absolute path');
      dir = value;
    } else throw new LocalIPCError('INVALID_ARGUMENT', `Unknown skills argument: ${arg}`);
  }
  const source = sourceSkill();
  if (link && !source.dir) throw new LocalIPCError('INVALID_ARGUMENT', '--link needs a source checkout; this executable carries its own copy');
  let result;
  try { result = installSkill({ home: homedir(), files: source.files, agents, dir, force, version: VERSION, linkTo: link ? source.dir : undefined }); }
  catch (error) { throw new LocalIPCError(String((error as Error).message).split(':')[0] || 'SKILL_INSTALL_FAILED', (error as Error).message); }
  if (output === 'json') writeEnvelope('json', { apiVersion: 'weaver.v1', ok: true, data: { skill: SKILL_NAME, version: VERSION, ...result } });
  else process.stdout.write(`${result.action} ${SKILL_NAME} at ${result.canonical}${result.links.length ? `\nlinked ${result.links.join(', ')}` : ''}\n`);
  return 0;
}

export async function runCLI(argv: string[], pollRuntime: Partial<PollRuntime> = {}): Promise<number> {
  let commandId: string | undefined;
  let errorFormat: OutputFormat = requestedOutput(argv);
  try {
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) { process.stdout.write(`weaver ${VERSION}\n`); return 0; }
    if (argv.includes('--skill')) {
      const skill = sourceSkill().files.get('SKILL.md');
      if (!skill) throw new LocalIPCError('SKILL_MISSING', 'This executable carries no SKILL.md');
      writeSync(process.stdout.fd, Buffer.from(skill));
      return 0;
    }
    if (argv.includes('--help')) {
      const rest=argv.filter(arg=>arg!=='--help');
      const words=positionals(rest);
      if(words[0]==='skills') { process.stdout.write(SKILLS_HELP+'\n'); return 0; }
      if(words[0]==='server') { process.stdout.write(SERVER_HELP+'\n'); return 0; }
      if(words[0]==='web') {
        const web=parseWeb(rest);
        if(web.output==='text')process.stdout.write(WEB_HELP+'\n');
        else writeEnvelope(web.output,{apiVersion:'weaver.v1',ok:true,data:{command:'web',mutation:false,usage:WEB_HELP}});
      } else {
        const item=words.length?catalogCommand(words):undefined;
        if(words.length&&!item)throw new LocalIPCError('INVALID_ARGUMENT','Unknown command. Run weaver --help for the catalog.');
        parseCLI(item?rest:['capabilities',...rest]);
        if(errorFormat==='text'||(!rest.includes('--output')&&!rest.includes('--json'))) {
          process.stdout.write(item?`${item.usage}\nCLI options: ${JSON.stringify(CLI_VALUE_OPTIONS)}\nMutation: ${item.mutation}\nInput fields: ${JSON.stringify(item.inputFields,null,2)}\n`:CLI_HELP+'\n');
        } else writeEnvelope(errorFormat,{apiVersion:'weaver.v1',ok:true,data:item?{...item,cliOptions:CLI_VALUE_OPTIONS}:{catalog:CLI_CATALOG,cliOptions:CLI_VALUE_OPTIONS}});
      }
      return 0;
    }
    const words = positionals(argv);
    if (words[0] === 'web') {
      if (words.length !== 1) throw new LocalIPCError('INVALID_ARGUMENT', 'Unexpected web arguments');
      const web = parseWeb(argv);
      if (web.outputExplicit) errorFormat = web.output;
      const running = await checkRunning(web.dataDir);
      if (running) {
        const extra: Record<string, unknown> = { alreadyRunning: true };
        if (web.portExplicit && running.data.port !== web.port) extra.note = `A Weaver service is already running on port ${running.data.port}; using its URL instead of the requested port ${web.port}`;
        if (web.open) openBrowser(running.data.url);
        writeSync(process.stdout.fd, readyLine(running.data.url, running.data.port, web.output, extra));
        return 0;
      }
      let runtime;
      try { runtime = await startRuntime({ dataDir: web.dataDir, port: web.port, open: web.open, dev: web.dev }); }
      catch (error) { throw startupFailure(error, web.port); }
      writeSync(process.stdout.fd, readyLine(runtime.url, runtime.port, web.output));
      const stop = () => { void runtime.close(); };
      // Repeated signals (process-group stops deliver one per process) join the same idempotent drain.
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await runtime.done;
      return 0;
    }
    if (words[0] === 'skills') return runSkills(argv, words);
    if (words[0] === 'server') return runServer(argv, words, serverEnv({
      request: async (dataDir, payload, timeoutMs) => await sendRequest(dataDir, payload, timeoutMs) as Envelope,
      output: (format, envelope) => writeEnvelope(format, envelope),
      defaultPort: DEFAULT_WEB_PORT,
      defaultDataDir: defaultDataDir(),
    }));
    const options = parseCLI(argv);
    errorFormat = options.output;
    commandId = options.commandId;
    const item = CLI_CATALOG.find(entry => entry.command === options.command);
    if (options.commentFile !== undefined) options.comment = await readCommentFile(options.commentFile);
    if (item?.local) {
      if (!options.taskId) throw new LocalIPCError('INVALID_ARGUMENT', `${item.usage} requires --task-id`);
      return await pollTask(options, item.local, pollRuntime);
    }
    const rpc = item?.rpc;
    let request: Record<string, unknown>;
    if (rpc) {
      if (options.commandId || options.taskId) throw new LocalIPCError('INVALID_ARGUMENT', 'Policy, engine, quota, and probe commands do not take command or task IDs');
      if (rpc.arity === 1) {
        if (!options.input && item.command !== 'quota.refresh' && item.command !== 'workers.probe') throw new LocalIPCError('INVALID_ARGUMENT', 'This command requires --input');
        const body = options.input ? await readInput(options.input) : {};
        if (options.worker !== undefined) {
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LocalIPCError('INVALID_ARGUMENT', 'Input must be a JSON object');
          const record = body as Record<string, unknown>;
          if (record.worker !== undefined && record.worker !== options.worker) throw new LocalIPCError('INVALID_ARGUMENT', 'Input worker does not match CLI worker');
          record.worker = options.worker;
        }
        request = { method: rpc.method, args: [body] };
      } else if (options.input) throw new LocalIPCError('INVALID_ARGUMENT', 'This command does not take --input');
      else request = { method: rpc.method, args: [] };
    } else {
      request = makeRequest(options, options.input ? await readInput(options.input) : {});
      applyCallerWorkspace(request, process.cwd());
      if (request.command === 'operations.get' && options.commandId) {
        const args = request.args;
        if (args && typeof args === 'object' && !Array.isArray(args) && (args as Record<string, unknown>).commandId === undefined) (args as Record<string, unknown>).commandId = options.commandId;
      }
      commandId = typeof request.commandId === 'string' ? request.commandId : undefined;
    }
    const response = await (pollRuntime.request ?? sendRequest)(options.dataDir, request) as { ok: boolean };
    if (options.field && response.ok) process.stdout.write(responseField(response, options.field) + '\n');
    else writeEnvelope(options.output, response);
    return response.ok ? 0 : 1;
  } catch (error) {
    const code = error instanceof LocalIPCError ? error.code : 'CLI_ERROR';
    const message = error instanceof LocalIPCError ? error.message : 'Could not complete the CLI request';
    writeEnvelope(errorFormat, { ...failure(code, message), commandId: commandId ?? null });
    return 1;
  }
}
function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    // npm bin links and --preserve-symlinks-main may name the same file differently.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    // Imported hosts can supply a non-file argv[1]; importing must not run the CLI.
    return false;
  }
}
if (isDirectEntry()) {
  void runCLI(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
