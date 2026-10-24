import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startRuntime } from '../../src/main/runtime';
import { sendRequest } from '../../src/cli/client';
import { QuotaProber } from '../../src/main/quota';

const execFileAsync = promisify(execFile);
// Portable repo root: this file lives at <repo>/tests/main/, so the repo is two levels up.
// The CLI subprocess runs the current checkout's src/cli/main.ts, never a hardcoded path.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function envelope(command: string, args: Record<string, unknown> = {}, commandId = randomUUID(), ownerAuth?: unknown) {
  return { apiVersion: 'weaver.v1', command, args, commandId, ...(ownerAuth === undefined ? {} : { ownerAuth }) };
}

async function cli(args: string[], cwd = REPO): Promise<{ code: number; stdout: string; stderr: string; json: any }> {
  try {
    const r = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], { cwd, timeout: 20000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr, json: JSON.parse(r.stdout) };
  } catch (error: any) {
    const stdout = String(error.stdout ?? '');
    return { code: Number(error.code ?? 1), stdout, stderr: String(error.stderr ?? ''), json: stdout ? JSON.parse(stdout) : null };
  }
}

/**
 * Real isolated service + real CLI transport.
 * Synthetic host boundary (identified): the ownerHost launcher is a test fixture that
 * resolves immediately with a fake Herdr host record, so tasks.start marks the root
 * running without launching any real owner agent or process.
 */
test('tasks.report/overview round-trip over real service and real CLI transport', async () => {
  // Test-owned input dir for CLI --input JSON files. The Unix socket path
  // (base + control-<32 hex> + ipc.sock, 103-byte cap) cannot fit under a long
  // task scratch path, so both the input dir and the service dataDir are
  // short-lived directories under os.tmpdir(); both are removed in finally.
  const scratchDir = mkdtempSync(join(tmpdir(), 't-'));
  const dataDir = mkdtempSync(join(tmpdir(), 't-'));
  const quota = new QuotaProber({ env: { HOME: dataDir } });
  quota.refresh = async () => quota.get();
  const runtime = await startRuntime({
    dataDir,
    port: 0,
    open: false,
    quotaProber: quota,
    ownerHost: {
      launcher: async () => ({ session: 'fake', workspaceId: 'fake-ws', paneId: 'fake-pane', agentName: `fake-owner-${randomUUID().slice(0, 8)}` }),
      closer: async () => {},
    },
  }).catch(error => {
    rmSync(scratchDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  });
  try {
    // Attach owner A (no auth needed for the first attach).
    const attached: any = await sendRequest(dataDir, envelope('owners.attach', { name: 'CLI owner', profileId: 'codex_owner', session: 'cli-pane' }));
    assert.equal(attached.ok, true, JSON.stringify(attached));
    const credPath = attached.data.credentialPath as string;
    const secret = JSON.parse(readFileSync(credPath, 'utf8'));
    const auth = { ownerId: secret.ownerId, token: secret.token };

    // Create + describe + start a root through the real transport.
    const created: any = await sendRequest(dataDir, envelope('tasks.create', { title: 'CLI root', instruction: 'cli fixture', workspace: dataDir, ownerId: auth.ownerId }, randomUUID(), auth));
    assert.equal(created.ok, true, JSON.stringify(created));
    const rootId = created.data.id as string;
    const described: any = await sendRequest(dataDir, envelope('tasks.describe', { taskId: rootId, expectedRevision: created.data.revision, title: 'CLI root', acceptanceCriteria: ['verified'] }, randomUUID(), auth));
    assert.equal(described.ok, true, JSON.stringify(described));
    const started: any = await sendRequest(dataDir, envelope('tasks.start', { taskId: rootId }, randomUUID(), auth));
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.data.executionRole, 'owner');
    assert.equal(started.data.status, 'running');

    const writeScratch = (name: string, body: unknown): string => {
      const file = join(scratchDir, `${name}-${randomUUID()}.json`);
      writeFileSync(file, JSON.stringify(body));
      return file;
    };

    // Report through the real CLI binary with --owner-file (input JSON lives under scratch).
    const reportInput = writeScratch('report', { summary: 'CLI progress here', percent: 55, phase: 'build', blockers: [], nextSteps: ['next'] });
    const reportId = randomUUID();
    const reported = await cli(['tasks', 'report', '--task-id', rootId, '--input', reportInput, '--command-id', reportId, '--data-dir', dataDir, '--owner-file', credPath]);
    assert.equal(reported.json.ok, true, reported.stdout);
    assert.equal(reported.json.data.ownerReport.summary, 'CLI progress here');
    assert.equal(reported.json.data.ownerReport.percent, 55);
    assert.equal(reported.json.data.ownerReport.phase, 'build');

    // Overview through the real CLI binary (global read, no owner file).
    const overview = await cli(['tasks', 'overview', '--data-dir', dataDir]);
    assert.equal(overview.json.ok, true, overview.stdout);
    const roots = overview.json.data.roots as any[];
    assert.ok(roots.some(r => r.id === rootId), JSON.stringify(roots.map(r => r.id)));
    const mine = roots.find(r => r.id === rootId)!;
    assert.equal(mine.ownerReport.summary, 'CLI progress here');
    assert.equal(mine.progress, 55);
    assert.ok(typeof mine.reportAgeSeconds === 'number' && mine.reportAgeSeconds >= 0);
    assert.deepEqual(Object.keys(mine.childCounts).sort(), ['cancelled', 'cancelling', 'completed', 'failed', 'queued', 'running', 'total'].sort());

    // CLI report without credentials fails closed (UNAUTHORIZED, no progress change).
    const deniedInput = writeScratch('denied', { summary: 'no auth' });
    const denied = await cli(['tasks', 'report', '--task-id', rootId, '--input', deniedInput, '--command-id', randomUUID(), '--data-dir', dataDir]);
    assert.equal(denied.json.ok, false);
    assert.equal(denied.json.error.code, 'UNAUTHORIZED');

    // Real JSON nulls are rejected: omission reads back as null, but null is not an accepted input.
    for (const [name, body] of [
      ['null-percent', { summary: 'bad', percent: null }],
      ['null-phase', { summary: 'bad', phase: null }],
    ] as const) {
      const input = writeScratch(name, body);
      const rejected = await cli(['tasks', 'report', '--task-id', rootId, '--input', input, '--command-id', randomUUID(), '--data-dir', dataDir, '--owner-file', credPath]);
      assert.equal(rejected.json.ok, false, JSON.stringify(rejected.json));
      assert.equal(rejected.json.error.code, 'INVALID_REQUEST');
    }
    const afterNulls = await cli(['tasks', 'overview', '--data-dir', dataDir]);
    const unchanged = (afterNulls.json.data.roots as any[]).find(r => r.id === rootId)!;
    assert.equal(unchanged.ownerReport.summary, 'CLI progress here');
    assert.equal(unchanged.progress, 55);

    // Real CLI space-form credentials are redacted before storage, events and projections.
    const canaries = ['SYNTH-CANARY-CLI-A1', 'SYNTH-CANARY-CLI-B2', 'SYNTH-CANARY-CLI-C3'];
    const secretInput = writeScratch('secret', {
      summary: `secret report --token ${canaries[0]}`,
      blockers: [`--password "${canaries[1]} with space"`],
      nextSteps: [`--secret-key ${canaries[2]}`],
    });
    const secretReport = await cli(['tasks', 'report', '--task-id', rootId, '--input', secretInput, '--command-id', randomUUID(), '--data-dir', dataDir, '--owner-file', credPath]);
    assert.equal(secretReport.json.ok, true, secretReport.stdout);
    assert.match(JSON.stringify(secretReport.json.data.ownerReport), /REDACTED/);
    for (const value of canaries) assert.doesNotMatch(JSON.stringify(secretReport.json), new RegExp(value));
    const secretOverview = await cli(['tasks', 'overview', '--data-dir', dataDir]);
    const secretRoot = (secretOverview.json.data.roots as any[]).find(r => r.id === rootId)!;
    for (const value of canaries) assert.doesNotMatch(JSON.stringify(secretRoot), new RegExp(value));
    assert.equal(secretRoot.progress, 55);

    // Committed visibility: reopen the SQLite file directly and confirm the report survived.
    const { TaskStore } = await import('../../src/main/store');
    const reopened = new TaskStore(join(dataDir, 'weaver.db'));
    try {
      const committed = reopened.getCommitted(rootId);
      assert.match(JSON.stringify(committed.ownerReport), /REDACTED/);
      for (const value of canaries) assert.doesNotMatch(JSON.stringify(committed.ownerReport), new RegExp(value));
      assert.equal(committed.ownerReport?.percent, null);
      assert.equal(committed.progress, 55);
      for (const value of canaries) assert.doesNotMatch(JSON.stringify(committed.events), new RegExp(value));
    } finally {
      reopened.close();
    }
  } finally {
    await runtime.close();
    rmSync(scratchDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
