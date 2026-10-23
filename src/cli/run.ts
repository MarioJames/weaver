import { writeSync } from 'node:fs';
import { failure, LocalIPCError, requestTimeoutMs } from '../main/local-ipc';
import { VERSION } from '../shared/version';
import { CLI_CATALOG, CLI_HELP, CLI_VALUE_OPTIONS, catalogCommand } from './catalog';
import { sendRequest } from './client';
import { runSkills, SKILLS_HELP } from './commands/skills';
import { runWeb, writeWebHelp } from './commands/web';
import { buildRequest, readCommentFile } from './input';
import { requestedOutput, responseField, writeEnvelope, type OutputFormat } from './output';
import { readOwnerCredential } from './owner-identity';
import { DEFAULT_WEB_PORT, defaultDataDir, parseCLI, positionals } from './parse';
import { pollTask, type PollRuntime } from './poll-task';
import { isReconnectCommand, reconnectPolicy, sendReadRequest } from './reconnect';
import { runServer, SERVER_HELP } from './server/commands';
import { serverEnv, type Envelope } from './server/env';
import { sourceSkill } from './skills';

/** `weaver [command] --help`: text by default, one envelope with --output json|jsonl. */
function writeHelp(argv: string[], errorFormat: OutputFormat): void {
  const rest = argv.filter(arg => arg !== '--help');
  const words = positionals(rest);
  if (words[0] === 'skills') { process.stdout.write(SKILLS_HELP + '\n'); return; }
  if (words[0] === 'server') { process.stdout.write(SERVER_HELP + '\n'); return; }
  if (words[0] === 'web') { writeWebHelp(rest); return; }
  const item = words.length ? catalogCommand(words) : undefined;
  if (words.length && !item) throw new LocalIPCError('INVALID_ARGUMENT', 'Unknown command. Run weaver --help for the catalog.');
  parseCLI(item ? rest : ['capabilities', ...rest]);
  if (errorFormat === 'text' || (!rest.includes('--output') && !rest.includes('--json'))) {
    process.stdout.write(item ? `${item.usage}\nCLI options: ${JSON.stringify(CLI_VALUE_OPTIONS)}\nMutation: ${item.mutation}\nInput fields: ${JSON.stringify(item.inputFields, null, 2)}\n` : CLI_HELP + '\n');
  } else writeEnvelope(errorFormat, { apiVersion: 'weaver.v1', ok: true, data: item ? { ...item, cliOptions: CLI_VALUE_OPTIONS } : { catalog: CLI_CATALOG, cliOptions: CLI_VALUE_OPTIONS } });
}

export async function runCLI(argv: string[], pollRuntime: Partial<PollRuntime> = {}): Promise<number> {
  if (argv[0] === '__weaver-opencode-cleanup') {
    const { runCleanupChild } = await import('../main/engines/cleanup');
    return runCleanupChild(argv.slice(1));
  }
  if (argv[0] === '__weaver-im-parent-host') {
    try {
      const { runParentHost } = await import('../main/im/parent-host');
      process.exit(await runParentHost(argv.slice(1)));
    } catch { return 1; }
  }
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
      writeHelp(argv, errorFormat);
      return 0;
    }
    const words = positionals(argv);
    if (words[0] === 'web') return await runWeb(argv, words, format => { errorFormat = format; });
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
    // An explicit credential file is part of the request identity: bad, unsafe or missing files
    // fail closed before any transport call, including direct RPC and local wait/watch polling.
    const ownerAuth = options.ownerFile !== undefined ? await readOwnerCredential(options.ownerFile) : undefined;
    const item = CLI_CATALOG.find(entry => entry.command === options.command);
    if (options.commentFile !== undefined) options.comment = await readCommentFile(options.commentFile);
    if (item?.local) {
      if (!options.taskId) throw new LocalIPCError('INVALID_ARGUMENT', `${item.usage} requires --task-id`);
      return await pollTask(options, item.local, pollRuntime, ownerAuth);
    }
    const request = await buildRequest(options, item, ownerAuth);
    if ((options.reconnectGraceSeconds !== undefined || options.reconnectMaxIntervalSeconds !== undefined) &&
      !isReconnectCommand(String(request.command ?? ''))) throw new LocalIPCError('INVALID_ARGUMENT', '--reconnect-grace and --reconnect-max-interval-s are only valid for tasks get, tasks wait, tasks watch, tasks events and tasks health');
    if (!item?.rpc) commandId = typeof request.commandId === 'string' ? request.commandId : undefined;
    const send = pollRuntime.request ?? sendRequest;
    // Only reads replay across a restart; a mutation can be reconciled through operations get instead.
    const response = typeof request.command === 'string' && isReconnectCommand(request.command)
      ? await sendReadRequest(options.dataDir, request, {
          policy: reconnectPolicy(options),
          timeoutMs: requestTimeoutMs(request),
          runtime: {
            now: pollRuntime.now ?? Date.now,
            sleep: pollRuntime.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
            report: pollRuntime.stderr ?? ((text: string) => { process.stderr.write(text + '\n'); }),
          },
          request: send,
        }) as { ok: boolean }
      : await send(options.dataDir, request) as { ok: boolean };
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
