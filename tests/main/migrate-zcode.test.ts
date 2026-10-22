import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, migrate } from '../../src/main/migrate';
import { PolicyStore } from '../../src/main/policy/store';
import { defaultConfig, validateConfig } from '../../src/main/policy/routing';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { MockWorkerAdapter } from '../../src/main/adapters/worker';
import { CommandHandler } from '../../src/main/commands';
import { dispatchKind } from '../../src/renderer/features/tasks/task-view';
import { modelText } from '../../src/renderer/features/tasks/AgentFacts';
import type { Block, Config } from '../../src/shared/contracts/policy';
import type { Task } from '../../src/shared/contracts/tasks';

// Step 11 only deletes rows (no table changes), so a fully migrated database whose user_version is put back to 10 and
// which is then filled with the shapes an older build wrote is exactly the historical database the step upgrades.

const version = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number | string }).user_version);
const rows = (db: DatabaseSync, sql: string) => (db.prepare(sql).all() as Record<string, unknown>[]).map(row => ({ ...row }));

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.exec('PRAGMA user_version=10');
  return db;
}

/** Rows exactly as PolicyStore.writeAll lays a config out, bypassing validation so retired kinds can be stored. */
function seedPolicy(db: DatabaseSync, config: Config, blocks: Block[] = [], revisions = 1): void {
  Object.entries(config.engines).forEach(([id, engine], index) => db.prepare('INSERT INTO policy_engines(id,position,enabled,kind,quota_refresh) VALUES (?,?,?,?,?)').run(id, index, engine.enabled ? 1 : 0, engine.kind, engine.quota_refresh === undefined ? null : engine.quota_refresh ? 1 : 0));
  Object.entries(config.workers).forEach(([id, w], index) => db.prepare('INSERT INTO policy_workers(id,position,enabled,engine,model,effort,description,free_channel,max_parallel) VALUES (?,?,?,?,?,?,?,?,?)').run(id, index, w.enabled ? 1 : 0, w.engine, w.model, w.effort, w.description ?? null, w.free_channel === undefined ? null : w.free_channel ? 1 : 0, w.max_parallel ?? null));
  Object.entries(config.owners).forEach(([id, o], index) => {
    db.prepare('INSERT INTO policy_owners(id,position,enabled,engine,model,effort,max_parallel) VALUES (?,?,?,?,?,?,?)').run(id, index, o.enabled ? 1 : 0, o.engine, o.model, o.effort, o.max_parallel);
    o.workers.forEach((worker, position) => db.prepare('INSERT INTO policy_owner_workers(owner_id,worker_id,position,weight) VALUES (?,?,?,?)').run(id, worker, position, o.worker_weights?.[worker] ?? null));
  });
  blocks.forEach((b, index) => db.prepare('INSERT INTO policy_blocks(position,engine,model,worker,reason,since,release_at,by) VALUES (?,?,?,?,?,?,?,?)').run(index, b.engine, b.model ?? null, b.worker ?? null, b.reason, b.since, b.release_at ?? null, b.by ?? null));
  const { herdr, $schema, chatgpt_review, quota, free_channel_probe, janitor } = config as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries({ herdr, $schema, chatgpt_review, quota, free_channel_probe, janitor })) if (value !== undefined) db.prepare('INSERT INTO policy_settings(key,body) VALUES (?,?)').run(key, JSON.stringify(value));
  for (let revision = 1; revision <= revisions; revision++) db.prepare('INSERT INTO policy_revisions(revision,saved_at,source,body) VALUES (?,?,?,?)').run(revision, '2030-01-01T00:00:00.000Z', 'save', JSON.stringify({ version: 1, revision, config, blocks }));
}

const zcodeEngine = { enabled: false, kind: 'zcode', quota_refresh: false } as unknown as Config['engines'][string];
const since = '2030-01-01T00:00:00.000Z';

test('an empty database installs at the current version with a default policy that has no zcode engine', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  assert.equal(version(db), SCHEMA_VERSION);
  assert.deepEqual(rows(db, 'SELECT * FROM policy_engines'), []);
  const store = new PolicyStore(db);
  assert.deepEqual(Object.keys(store.snapshot().config.engines), Object.keys(defaultConfig().engines));
  assert.ok(!Object.values(store.snapshot().config.engines).some(engine => engine.kind === 'zcode'));
  db.close();
});

test('an older database holding the default policy with its zcode engine upgrades and the policy loads and validates', () => {
  const db = legacyDatabase();
  const old = defaultConfig();
  old.engines.zcode = zcodeEngine;
  seedPolicy(db, old, [], 3);
  assert.equal(rows(db, "SELECT id FROM policy_engines WHERE kind='zcode'").length, 1);
  const store = new PolicyStore(db);
  assert.equal(version(db), SCHEMA_VERSION);
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.config, defaultConfig());
  assert.deepEqual(validateConfig(snapshot.config), []);
  assert.equal(snapshot.revision, 3, 'history is kept, not renumbered');
  assert.deepEqual(rows(db, "SELECT id FROM policy_engines WHERE kind='zcode'"), []);
  // The retained snapshots no longer carry the engine, so a rollback to the oldest one is accepted.
  assert.doesNotMatch(String((db.prepare('SELECT body FROM policy_revisions WHERE revision=1').get() as { body: string }).body), /zcode/);
  assert.deepEqual(store.rollback(1).config, defaultConfig());
  db.close();
});

test('zcode workers, owners, links, weights, blocks and runtime rows are removed; other engines keep theirs', () => {
  const db = legacyDatabase();
  const old = defaultConfig();
  old.engines.zc = { enabled: true, kind: 'zcode' } as never; // an engine id other than "zcode" is matched by kind
  old.engines.zcode = zcodeEngine;
  old.workers.zc_worker = { enabled: true, engine: 'zc', model: 'm', effort: 'auto' };
  old.workers.zcode_worker = { enabled: false, engine: 'zcode', model: 'm', effort: 'auto', free_channel: true };
  old.owners.claude_owner!.workers = ['claude_worker', 'zc_worker', 'qoder_worker', 'zcode_worker'];
  old.owners.claude_owner!.worker_weights = { claude_worker: 4, zc_worker: 9, zcode_worker: 1 };
  // codex_owner keeps a worker but its only enabled one was a zcode worker: it stays, disabled, instead of failing validation.
  old.workers.codex_worker!.enabled = false;
  old.owners.codex_owner!.workers = ['codex_worker', 'zc_worker'];
  // pi_owner only had zcode workers: nothing is left to keep it.
  old.owners.pi_owner!.workers = ['zc_worker', 'zcode_worker'];
  old.owners.zc_owner = { enabled: true, engine: 'zc', model: 'm', effort: 'auto', workers: ['zc_worker', 'claude_worker'], max_parallel: 1 };
  const blocks: Block[] = [
    { engine: 'zc', reason: 'x', since },
    { engine: 'zcode', worker: 'zcode_worker', reason: 'x', since },
    { engine: 'claude', reason: 'keep', since },
    { engine: 'claude', model: 'm', reason: 'keep model', since },
  ];
  seedPolicy(db, old, blocks);
  db.prepare('INSERT INTO stall_penalties(engine,level,last_trigger_at,needs_attention,blocked_until,next_probe_at,probe_successes,head) VALUES (?,?,?,?,?,?,?,?)').run('zc', 1, 1, 0, null, null, 0, '');
  db.prepare('INSERT INTO stall_penalties(engine,level,last_trigger_at,needs_attention,blocked_until,next_probe_at,probe_successes,head) VALUES (?,?,?,?,?,?,?,?)').run('claude', 1, 1, 0, null, null, 0, '');
  db.prepare('INSERT INTO vendor_worker_limits(worker,level,last_trigger_at) VALUES (?,?,?)').run('zc_worker', 2, 5);
  db.prepare('INSERT INTO vendor_worker_limits(worker,level,last_trigger_at) VALUES (?,?,?)').run('claude_worker', 2, 5);
  db.prepare('INSERT INTO quota_records(engine,body) VALUES (?,?)').run('zcode', '{}');
  db.prepare('INSERT INTO free_probe_workers(worker,level,mode,last_trigger_at,needs_attention,blocked_until,next_probe_at,probe_successes,head,block_since) VALUES (?,?,?,?,?,?,?,?,?,?)').run('zcode_worker', 1, null, null, 0, null, null, 0, '', null);

  const store = new PolicyStore(db);
  const { config } = store.snapshot();
  assert.deepEqual(validateConfig(config), []);
  assert.deepEqual(Object.keys(config.engines), Object.keys(defaultConfig().engines));
  assert.deepEqual(Object.keys(config.workers), Object.keys(defaultConfig().workers));
  assert.deepEqual(Object.keys(config.owners), ['claude_owner', 'codex_owner']);
  assert.deepEqual(config.owners.claude_owner!.workers, ['claude_worker', 'qoder_worker']);
  assert.deepEqual(config.owners.claude_owner!.worker_weights, { claude_worker: 4 });
  assert.equal(config.owners.claude_owner!.enabled, true);
  assert.deepEqual([config.owners.codex_owner!.workers, config.owners.codex_owner!.enabled], [['codex_worker'], false]);
  assert.deepEqual(store.snapshot().blocks.map(block => block.reason), ['keep', 'keep model']);
  assert.deepEqual(rows(db, 'SELECT engine FROM stall_penalties'), [{ engine: 'claude' }]);
  assert.deepEqual(rows(db, 'SELECT worker FROM vendor_worker_limits'), [{ worker: 'claude_worker' }]);
  assert.deepEqual(rows(db, 'SELECT * FROM quota_records'), []);
  assert.deepEqual(rows(db, 'SELECT * FROM free_probe_workers'), []);
  assert.deepEqual(rows(db, "SELECT * FROM policy_owner_workers WHERE worker_id LIKE 'zc%' OR owner_id LIKE 'zc%'"), []);
  // The saved snapshot is pruned by the same rules, so rolling back to it gives the same policy.
  assert.deepEqual(store.rollback(1).config, config);
  db.close();
});

test('running the upgrade again changes nothing, including after the version is put back', () => {
  const db = legacyDatabase();
  const old = defaultConfig();
  old.engines.zcode = zcodeEngine;
  old.workers.zcode_worker = { enabled: true, engine: 'zcode', model: 'm', effort: 'auto' };
  old.owners.pi_owner!.workers = ['pi_worker', 'zcode_worker'];
  seedPolicy(db, old);
  migrate(db);
  const dump = () => JSON.stringify(['policy_engines', 'policy_workers', 'policy_owners', 'policy_owner_workers', 'policy_blocks', 'policy_revisions'].map(table => rows(db, `SELECT * FROM ${table}`)));
  const once = dump();
  migrate(db);
  assert.equal(dump(), once, 'a current database runs nothing');
  db.exec('PRAGMA user_version=10');
  migrate(db);
  assert.equal(version(db), SCHEMA_VERSION);
  assert.equal(dump(), once, 'the step itself is idempotent');
  assert.deepEqual(new PolicyStore(db).snapshot().config.owners.pi_owner!.workers, ['pi_worker']);
  db.close();
});

test('tasks recorded with the zcode engine stay readable through the store, tasks.get and tasks.list, and render as text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-zcode-history-'));
  try {
    const path = join(dir, 'weaver.db');
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(), title: 'old zcode run', instruction: 'x', status: 'completed', progress: 100, createdAt: now, updatedAt: now, events: [], artifacts: [],
      owner: { name: 'owner', transport: 'herdr-visible', session: 'main', pane: '1' },
      dispatch: { owner: 'claude_owner', worker: 'zcode_worker', engine: 'zcode', engineKind: 'zcode', model: 'GLM-5.3-Flash', effort: 'auto', execution: 'real', adapter: 'zcode' },
      run: { id: randomUUID(), adapter: 'zcode', execution: 'real', status: 'stopped', evidence: { engine: 'zcode', requestedModel: 'GLM-5.3-Flash', requestedEffort: 'auto', workspace: dir, terminal: 'success' } },
    } as unknown as Task;
    const writer = new TaskStore(path);
    writer.put(task);
    writer.close();
    const store = new TaskStore(path);
    const manager = new TaskManager(store, new MockWorkerAdapter(process.execPath, 'unused'));
    const handler = new CommandHandler(manager, new PolicyStore(path), () => { throw new Error('no launch'); }, () => false);
    const call = (command: string, args: Record<string, unknown>) => {
      const response = handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command, args });
      assert.equal(response.ok, true, JSON.stringify(response));
      return response.data as any;
    };
    assert.equal(store.get(task.id).dispatch?.engine, 'zcode');
    assert.equal(store.get(task.id).run?.evidence?.engine, 'zcode');
    assert.equal(call('tasks.get', { taskId: task.id }).dispatch.engine, 'zcode');
    assert.ok(JSON.stringify(call('tasks.list', {})).includes(task.id));
    assert.equal(dispatchKind(task), 'zcode');
    assert.equal(modelText(task), 'zcode / GLM-5.3-Flash · auto');
    handler.draining = true;
    await manager.shutdown();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
