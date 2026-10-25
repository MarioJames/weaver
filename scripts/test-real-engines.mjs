import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// This is an acceptance client, never a server/bootstrapper. All subprocess output stays private.
process.umask(0o077);
const repo = fileURLToPath(new URL('../', import.meta.url));
const report = { startedAt: new Date().toISOString(), status: 'not_executed', target: null, checks: [], channels: [], inference: [], dispatch: { status: 'not_executed' }, cli: [] };
let reportPath;
let dataDir;
let ownerFile;
let sendRequest;
let baselinePolicy;
const inside = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const safeCode = error => /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : 'CHECK_FAILED';
function unpack(envelope) {
  if (envelope?.ok !== true) fail(safeCode(envelope?.error));
  return envelope.data;
}
function cli(command, input, mutation = false, extra = []) {
  const args = ['--import', 'tsx', 'src/cli/main.ts', '--data-dir', dataDir];
  if (ownerFile) args.push('--owner-file', ownerFile);
  args.push(...command.split(' '), '--output', 'json');
  if (input !== undefined) args.push('--input', '-');
  if (mutation) args.push('--command-id', `real-test-${randomUUID()}`);
  const result = spawnSync(process.execPath, [...args, ...extra], { cwd: repo, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { /* never echo output */ }
  report.cli.push({ command, exitCode: result.status, signal: result.signal, code: envelope?.error?.code ?? (result.error ? 'CLI_PROCESS_FAILED' : null) });
  if (result.status !== 0) fail(safeCode(envelope?.error ?? { code: 'CLI_PROCESS_FAILED' }));
  return unpack(envelope);
}
async function rpc(method, args = []) {
  // Reuse the application's authenticated IPC client; no second transport implementation.
  return unpack(await sendRequest(dataDir, { method, args }));
}
async function assertTarget(expected) {
  const server = await rpc('serverInfo');
  if (realpathSync(server.dataDir) !== dataDir || server.port === 4737 || !Number.isInteger(server.port)) fail('UNSAFE_TARGET');
  if (expected && (expected.pid !== server.pid || expected.startedAt !== server.startedAt)) fail('TARGET_RESTARTED');
  if (expected && baselinePolicy !== undefined && (await rpc('getPolicy')).revision !== baselinePolicy) fail('POLICY_CHANGED');
  return server;
}
function recordFailure(list, item, error) { list.push({ ...item, status: 'failed', code: safeCode(error) }); }

// Linux read-only evidence: compare the selected channel's private root with the actual
// launched process environment. Neither credentials nor their hashes enter the report.
function bindingSeen(db, taskId, channel, kind) {
  const taskRow = db.prepare('SELECT body FROM tasks WHERE id=?').get(taskId);
  const secretRow = db.prepare('SELECT body FROM channel_secrets WHERE id=?').get(channel);
  if (!taskRow || !secretRow) return false;
  const task = JSON.parse(taskRow.body);
  const secret = JSON.parse(secretRow.body);
  const run = task.run;
  if (!run?.channelStateDir || !inside(dataDir, resolve(run.channelStateDir)) || run.channel !== channel) return false;
  const root = secret.authDir;
  if (root && (!inside(dataDir, realpathSync(root)) || realpathSync(root) === dataDir)) fail('UNSAFE_CHANNEL_ROOT');
  const rootKeys = { dsh: 'DSH_HOME', codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', grok: 'GROK_HOME', qodercli: 'QODER_CONFIG_DIR', qoder: 'QODER_CONFIG_DIR', opencode: 'OPENCODE_DB', pi: 'PI_CODING_AGENT_DIR' };
  const pids = new Set([run.pid].filter(Number.isInteger));
  // Include descendants: run.pid can be the scope/launcher rather than the vendor CLI.
  for (let round = 0; round < 4; round++) for (const entry of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    try { const status = readFileSync(`/proc/${entry}/status`, 'utf8'); const parent = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]); if (pids.has(parent)) pids.add(Number(entry)); } catch { /* exited */ }
  }
  for (const pid of pids) {
    try {
      const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
      if (root && rootKeys[kind] && hash(env[rootKeys[kind]] ?? '') === hash(kind === 'opencode' ? join(root, 'opencode.db') : root)) return true;
      // API runs have an isolated generated configuration root. Compare actual key
      // bytes in that root or process env without persisting or printing them.
      if (!root && secret.apiKey) {
        const generatedRoot = run.channelStateDir;
        const keyInEnvironment = Object.values(env).some(value => hash(value) === hash(secret.apiKey));
        const keyInConfig = readdirSync(generatedRoot).some(name => {
          const path = join(generatedRoot, name);
          const stat = statSync(path);
          return stat.isFile() && stat.size < 256 * 1024 && readFileSync(path, 'utf8').includes(secret.apiKey);
        });
        const expectedRoot = kind === 'opencode' ? join(generatedRoot, 'opencode.db') : generatedRoot;
        if ((keyInEnvironment || keyInConfig) && rootKeys[kind] && hash(env[rootKeys[kind]] ?? '') === hash(expectedRoot)) return true;
      }
    } catch { /* process ended or cannot be read; absence is not proof */ }
  }
  return false;
}

async function main() {
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'report-dir': { type: 'string' }, inference: { type: 'boolean' }, dispatch: { type: 'boolean' }, owner: { type: 'string' }, channel: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, 'timeout-seconds': { type: 'string', default: '300' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('npm run test:real -- [--data-dir PATH] [--report-dir PRIVATE_PATH] [--inference [--channel ID [--model ID --effort VALUE]]] [--dispatch --owner PROFILE] [--timeout-seconds 300]');
    console.log('Default: existing weaver-real-test instance, installation/channel/model discovery only. Exit 0: requested coverage passed; 1: failure; 2: incomplete/unavailable. Paid calls require explicit flags.');
    return;
  }
  report.requested = { inference: !!values.inference, dispatch: !!values.dispatch, channel: values.channel ?? null };
  if ((values.channel || values.model || values.effort) && !values.inference) fail('SELECTION_REQUIRES_INFERENCE');
  if (!!values.model !== !!values.effort || ((values.model || values.effort) && !values.channel)) fail('MODEL_EFFORT_REQUIRE_CHANNEL_AND_PAIR');
  if (values.owner && !values.dispatch) fail('OWNER_REQUIRES_DISPATCH');
  const timeoutMs = Number(values['timeout-seconds']) * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600_000) fail('INVALID_TIMEOUT');
  const requested = resolve(values['data-dir'] ?? join(homedir(), '.local/share/weaver-real-test'));
  const production = join(homedir(), '.local/share/weaver');
  if (inside(production, requested) || inside(requested, production)) fail('UNSAFE_TARGET');
  dataDir = realpathSync(requested); // Must already exist; never create an instance.
  const prodReal = existsSync(production) ? realpathSync(production) : production;
  if (inside(prodReal, dataDir) || inside(dataDir, prodReal)) fail('UNSAFE_TARGET');
  const dbPath = realpathSync(join(dataDir, 'weaver.db'));
  if (!inside(dataDir, dbPath)) fail('UNSAFE_DATABASE');
  if (existsSync(join(prodReal, 'weaver.db'))) {
    const a = statSync(dbPath), b = statSync(join(prodReal, 'weaver.db'));
    if (a.dev === b.dev && a.ino === b.ino) fail('UNSAFE_DATABASE');
  }
  const { tsImport } = await import('tsx/esm/api');
  ({ sendRequest } = await tsImport('../src/cli/client.ts', import.meta.url));
  const server = await assertTarget();
  const folder = resolve(values['report-dir'] ?? join(dataDir, 'real-tests'));
  if (!inside(dataDir, folder) || folder === dataDir || inside(repo, folder)) fail('UNSAFE_REPORT_DIR');
  // Check existing ancestors before mkdir so a symlink cannot redirect even creation.
  let ancestor = folder;
  while (!existsSync(ancestor)) ancestor = resolve(ancestor, '..');
  const canonicalFolder = resolve(realpathSync(ancestor), relative(ancestor, folder));
  if (!inside(dataDir, canonicalFolder) || canonicalFolder === dataDir || inside(repo, canonicalFolder)) fail('UNSAFE_REPORT_DIR');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!inside(dataDir, realpathSync(folder)) || (statSync(folder).mode & 0o077) !== 0 || statSync(folder).uid !== process.getuid()) fail('UNSAFE_REPORT_DIR');
  reportPath = join(realpathSync(folder), `real-${Date.now()}-${randomUUID()}.json`);
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  const diff = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: repo, maxBuffer: 32 * 1024 * 1024 });
  report.target = { dataDir, database: { device: statSync(dbPath).dev, inode: statSync(dbPath).ino }, url: server.url, port: server.port, pid: server.pid, startedAt: server.startedAt, serverVersion: server.version, sourceCommit: git.status === 0 ? git.stdout.trim() : null, trackedDiffSha256: diff.status === 0 ? hash(diff.stdout) : null, runnerSha256: hash(readFileSync(fileURLToPath(import.meta.url))), sourceCLI: 'node --import tsx src/cli/main.ts' };
  console.error(JSON.stringify({ target: report.target, reportPath }));
  const snapshot = cli('channels list');
  const policy = snapshot.policy;
  report.target.policyRevision = baselinePolicy = policy.revision;
  if (values.channel && !Object.hasOwn(policy.config.channels, values.channel)) fail('UNKNOWN_CHANNEL');
  if (values.owner && !Object.hasOwn(policy.config.owners, values.owner)) fail('UNKNOWN_OWNER_PROFILE');
  const scan = cli('engines scan');
  report.installations = scan.probes.map(({ id, command, status, version }) => ({ id, command, version, status: status === 'installed' ? 'passed' : status === 'missing' ? 'unavailable' : 'failed' }));
  for (const [id, channel] of Object.entries(policy.config.channels)) {
    const conf = snapshot.configurations[id] ?? {};
    const configured = channel.kind === 'subscription' ? conf.hasCredentials : conf.hasApiKey || conf.hasConfig || conf.hasCredentials;
    const item = { channel: id, engine: channel.engine, kind: channel.kind, enabled: channel.enabled, status: configured ? 'passed' : 'not_configured', hasCredentials: !!conf.hasCredentials, hasApiKey: !!conf.hasApiKey, hasConfig: !!conf.hasConfig, models: { status: 'not_executed' } };
    report.channels.push(item);
    const requestedHello = !!values.inference && (!values.channel || values.channel === id);
    const hello = { channel: id, engine: channel.engine, requested: requestedHello, status: requestedHello ? (configured ? 'needs_selection' : 'not_configured') : 'not_executed' };
    report.inference.push(hello);
    if (!configured) continue;
    try {
      const models = cli('engines models', { engine: channel.engine, channel: id, refresh: true });
      item.models = { status: models.status === 'ok' ? 'passed' : models.status === 'failed' ? 'failed' : 'unavailable', source: models.source, ids: models.models.map(m => m.id), fetchedAt: models.fetchedAt, ...(models.status === 'failed' ? { code: 'MODEL_DISCOVERY_FAILED' } : models.status !== 'ok' ? { code: 'MODEL_DISCOVERY_UNAVAILABLE' } : {}) };
    } catch (error) { item.models = { status: 'failed', code: safeCode(error) }; if (safeCode(error) === 'APP_DRAINING') throw error; }
    // A directory error does not invalidate an existing saved route, or skip its Hello.
    if (!requestedHello) continue;
    try {
      await assertTarget(server);
      if (!channel.enabled || !policy.config.engines[channel.engine]?.enabled) { hello.status = 'unavailable'; hello.code = 'POLICY_DISABLED'; continue; }
      const roles = [...Object.entries(policy.config.workers), ...Object.entries(policy.config.owners)];
      const saved = roles.find(([, role]) => role.channel === id && role.model && role.effort);
      const selection = values.channel === id && values.model
        ? { model: values.model, effort: values.effort, source: 'explicit_arguments' }
        : saved ? { model: saved[1].model, effort: saved[1].effort, source: 'saved_role', role: saved[0] } : null;
      if (!selection) { hello.code = 'MODEL_AND_EFFORT_SELECTION_REQUIRED'; continue; }
      Object.assign(hello, selection);
      hello.discovered = item.models.ids?.includes(selection.model) ?? false;
      let job = await rpc('sayHi', [{ channel: id, engine: channel.engine, model: selection.model, effort: selection.effort }]);
      hello.jobId = job.id;
      const deadline = Date.now() + timeoutMs;
      while (job.status !== 'done' && Date.now() < deadline) { await delay(1000); await assertTarget(server); job = await rpc('sayHiResult', [job.id]); }
      await assertTarget(server);
      hello.status = job.status === 'done' && job.result?.ok === true && job.result.reply?.trim() === 'hi' ? 'passed' : 'failed';
      hello.code = job.status !== 'done' ? 'HELLO_TIMEOUT_JOB_MAY_CONTINUE' : hello.status === 'failed' ? 'HELLO_FAILED' : null;
      hello.vendorModel = job.result?.model; hello.durationMs = job.result?.durationMs;
    } catch (error) {
      Object.assign(hello, { status: 'failed', code: safeCode(error) });
      if (['TARGET_RESTARTED', 'POLICY_CHANGED', 'APP_DRAINING'].includes(safeCode(error))) throw error;
    }
  }
  if (values.dispatch) {
    report.dispatch = { status: 'not_configured' };
    const profile = values.owner ?? Object.keys(policy.config.owners).find(id => policy.owners[id]?.status === 'available');
    if (!profile || policy.owners[profile]?.status !== 'available') { report.dispatch.status = values.owner ? 'failed' : 'unavailable'; report.dispatch.code = values.owner ? 'OWNER_PROFILE_UNAVAILABLE' : 'NO_AVAILABLE_OWNER_PROFILE'; }
    else {
      const preview = cli('policy preview', { owner: profile });
      report.dispatch = { status: 'not_executed', profile, preview: { worker: preview.worker, channel: preview.channel, engine: preview.engine, model: preview.model, effort: preview.effort } };
      {
        await assertTarget(server);
        report.dispatch.status = 'failed';
        report.dispatch.code = 'DISPATCH_NOT_FINALIZED';
        const owner = cli('owners attach', { profileId: profile, name: 'Real engine acceptance', session: `test-real-${randomUUID()}` }, true);
        ownerFile = owner.credentialPath;
        if (!ownerFile || !inside(dataDir, realpathSync(ownerFile)) || (statSync(ownerFile).mode & 0o777) !== 0o600) fail('UNSAFE_OWNER_CREDENTIAL');
        report.dispatch.ownerId = owner.id;
        const workspace = join(realpathSync(folder), `worker-${randomUUID()}`);
        mkdirSync(workspace, { mode: 0o700 });
        const marker = 'WEAVER_REAL_OK';
        const task = cli('tasks create', { ownerId: owner.id, workspace, title: 'Read-only real worker acceptance', goal: `Reply with exactly ${marker}. Do not use tools, read or write files, change the environment, delegate, commit, push, or contact anyone.`, constraints: ['Read-only acceptance. Reply only; no tools or filesystem changes.'], acceptanceCriteria: [`Final reply is exactly ${marker}.`] }, true);
        report.dispatch.taskId = task.id;
        cli('packages create', { taskId: task.id, scope: ['No file reads or writes. Reply only with WEAVER_REAL_OK.'] }, true);
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(dbPath, { readOnly: true });
        let bound = false;
        let boundRunId;
        try {
          await assertTarget(server);
          const spawned = cli('workers spawn', { taskId: task.id }, true);
          const frozen = spawned.dispatch;
          if (!frozen || frozen.execution !== 'real') fail('REAL_CLI_REQUIRED');
          report.dispatch.frozen = Object.fromEntries(['owner', 'worker', 'channel', 'engine', 'model', 'effort', 'execution'].map(k => [k, frozen[k]]));
          if (frozen.owner !== profile || !policy.config.channels[frozen.channel] || policy.config.channels[frozen.channel].engine !== frozen.engine) fail('FROZEN_ROUTE_INVALID');
          const workerRole = policy.config.workers[frozen.worker];
          if (!workerRole?.enabled || !policy.config.owners[profile].workers.includes(frozen.worker) || ['channel', 'model', 'effort'].some(k => workerRole[k] !== frozen[k])) fail('FROZEN_ROLE_MISMATCH');
          const deadline = Date.now() + timeoutMs;
          let current;
          do {
            await assertTarget(server);
            current = cli('tasks get', { taskId: task.id });
            if (['owner', 'worker', 'channel', 'engine', 'model', 'effort', 'execution'].some(k => current.dispatch?.[k] !== frozen[k])) fail('FROZEN_ROUTE_CHANGED');
            if (current.run?.policyRevision !== undefined && current.run.policyRevision !== baselinePolicy) fail('POLICY_CHANGED');
            if (boundRunId && current.run?.id !== boundRunId) fail('RUN_CHANGED');
            if (bindingSeen(db, task.id, frozen.channel, policy.config.engines[frozen.engine]?.kind ?? frozen.engine)) { bound = true; boundRunId = current.run?.id; }
            if (current.dispatch && current.dispatch.execution !== 'real') fail('REAL_CLI_REQUIRED');
            // Match ResultsService: only a launch-permitted run must wait for finalization.
            if (['completed', 'failed', 'cancelled'].includes(current.status) && (!current.run?.launchPermittedAt || current.run.finalizedAt)) break;
            await delay(1000);
          } while (Date.now() < deadline);
          report.dispatch.actual = { status: current.status, channel: current.run?.channel, engine: current.run?.engine, model: current.run?.model, effort: current.run?.effort, execution: current.run?.execution, terminal: current.run?.evidence?.terminal, independentBindingObserved: bound };
          if (current.status !== 'completed') fail('WORKER_NOT_COMPLETED_TASK_RETAINED');
          const result = cli('tasks results', { taskId: task.id });
          const matched = ['channel', 'engine', 'model', 'effort'].every(k => current.run?.[k] === frozen[k]);
          if (!bound) fail('PROCESS_BINDING_NOT_OBSERVED');
          const evidence = current.run?.evidence;
          const vendorRouteMatched = evidence?.requestedModel === frozen.model && evidence?.requestedEffort === frozen.effort && evidence?.engine === (policy.config.engines[frozen.engine]?.kind ?? frozen.engine) && evidence?.workspace === workspace && evidence?.role === 'worker';
          if (!matched || !vendorRouteMatched || !current.run?.finalizedAt || current.run?.execution !== 'real' || current.run?.evidence?.terminal !== 'success' || result.summary?.trim() !== marker || result.exitCode !== 0) fail('WORKER_EVIDENCE_MISMATCH');
          report.dispatch.manifestDigest = result.manifestDigest;
          await assertTarget(server);
          cli('results ack', { taskId: task.id, expectedRevision: current.revision, manifestDigest: result.manifestDigest }, true);
          current = cli('tasks get', { taskId: task.id });
          await assertTarget(server);
          cli('reviews submit', { taskId: task.id, expectedRevision: current.revision, manifestDigest: result.manifestDigest, decision: 'accepted', comment: 'Observed real CLI success, exact marker, saved route and independent channel root binding.' }, true);
          await assertTarget(server);
          report.dispatch.status = 'passed';
          delete report.dispatch.code;
        } catch (error) { report.dispatch.status = 'failed'; report.dispatch.code = safeCode(error); }
        finally { db.close(); }
      }
    }
  }
  await assertTarget(server);
  report.checks.push({ check: 'target remained on the same test server', status: 'passed' });
  const statuses = [...report.installations, ...report.channels.flatMap(c => [c, ...(c.status === 'passed' ? [c.models] : [])]), ...report.inference.filter(h => h.requested), ...(values.dispatch ? [report.dispatch] : [])].map(c => c.status);
  report.status = statuses.includes('failed') ? 'failed' : statuses.some(s => s !== 'passed') ? 'incomplete' : 'passed';

}
try { await main(); } catch (error) { report.status = 'failed'; recordFailure(report.checks, { check: 'runner' }, error); }
if (report.status !== 'not_executed') {
  report.finishedAt = new Date().toISOString();
  const all = [...report.checks, ...(report.installations ?? []), ...report.channels.flatMap(c => [c, c.models]), ...report.inference, report.dispatch];
  report.coverage = { productAcceptance: 'not_executed', counts: Object.fromEntries(['passed', 'failed', 'not_configured', 'unavailable', 'needs_selection', 'not_executed'].map(s => [s, all.filter(v => v.status === s).length])) };
  report.exitCode = report.status === 'passed' ? 0 : report.status === 'incomplete' ? 2 : 1;
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
}
