import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startRuntime } from '../../src/main/runtime';
import { QuotaProber } from '../../src/main/quota';
import { EngineCleanupJobs, parseEngineCleanup } from '../../src/main/engines/cleanup';
import type { EngineCleanupJob } from '../../src/shared/contracts/engine-cleanup';

const options = { engine: 'opencode', mode: 'preview', keepDays: 1, pruneEvents: false, eventIdleMinutes: 60, vacuum: true } as const;
function database(path: string) {
 const db = new DatabaseSync(path);
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE session(id TEXT PRIMARY KEY,time_updated INTEGER NOT NULL);
 CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT REFERENCES session(id) ON DELETE CASCADE);
 CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT REFERENCES message(id) ON DELETE CASCADE,session_id TEXT);
 CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER,owner_id TEXT);
 CREATE TABLE event(id TEXT PRIMARY KEY,aggregate_id TEXT REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,seq INTEGER,type TEXT,data TEXT);
 CREATE TABLE auth(id TEXT PRIMARY KEY,data TEXT);
 INSERT INTO session VALUES('old',1),('retained',${Date.now()});
 INSERT INTO message VALUES('old-m','old'),('retained-m','retained');
 INSERT INTO part VALUES('old-p','old-m','old'),('retained-p','retained-m','retained');
 INSERT INTO event_sequence VALUES('old',3,'owner'),('retained',9,'owner'),('orphan',7,'owner');
 INSERT INTO event VALUES('old-e','old',3,'t','{}'),('retained-e','retained',9,'t','{}'),('orphan-e','orphan',7,'t','{}');
 INSERT INTO auth VALUES('credential','private');`);
 return db;
}
test('cleanup rejects unsafe RPC inputs before touching storage', () => {
 for (const patch of [{ engine: 'codex' }, { db: '/any/path' }, { keepDays: 0 }, { keepDays: 1.5 }, { eventIdleMinutes: -1 }, { vacuum: 'true' }, { pruneEvents: 1 }, { mode: 'apply' }, { previewId: 'bad' }]) assert.throws(() => parseEngineCleanup({ ...options, ...patch }));
 assert.equal(parseEngineCleanup({ ...options, eventIdleMinutes: 0 }).eventIdleMinutes, 0);
});
test('real HTTP asynchronous cleanup is preview-gated, protects retained history/config and rejects changed previews', async () => {
 const dir = mkdtempSync(join(tmpdir(), 't-')); const path = join(dir, 'opencode.db'); const db = database(path);
 const original = { env: process.env.OPENCODE_DB, argv: process.argv[1] };
 process.env.OPENCODE_DB = path; process.argv[1] = resolve('src/cli/main.ts');
 const runtime = await startRuntime({ dataDir: join(dir, 's'), port: 0, open: false, quotaProber: new QuotaProber({ env: { HOME: dir } }) });
 const rpc = async (method: string, args: unknown[]) => {
  const response = await fetch(`${runtime.url}/api/rpc`, { method: 'POST', headers: { origin: runtime.url, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
  return await response.json() as { result?: EngineCleanupJob; error?: { code: string; message: string } };
 };
 const start = async (input: unknown) => { const body = await rpc('startEngineCleanup', [input]); assert.equal(body.error, undefined, JSON.stringify(body)); return body.result!; };
 const wait = async (job: EngineCleanupJob) => { for (let n = 0; n < 200; n++) { const next = (await rpc('getEngineCleanup', [job.id])).result!; if (next.status === 'done') return next; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('cleanup did not finish'); };
 try {
  assert.ok((await rpc('startEngineCleanup', [{ ...options, db: path }])).error);
  assert.ok((await rpc('startEngineCleanup', [{ ...options, mode: 'apply', previewId: '0123456789abcdef' }])).error);
  const job = await start(options); assert.equal(job.status, 'running');
  assert.ok((await rpc('startEngineCleanup', [options])).error, 'concurrent invocation must be refused');
  const preview = await wait(job); assert.equal(preview.result?.status, 'preview');
  assert.equal(db.prepare('SELECT count(*) n FROM session').get()!.n, 2);
  assert.ok((await rpc('startEngineCleanup', [{ ...options, mode: 'apply', pruneEvents: true, previewId: job.id }])).error);
  db.exec("INSERT INTO session VALUES('changed',1)");
  const stale = await wait(await start({ ...options, mode: 'apply', previewId: job.id })); assert.equal(stale.result?.status, 'error');
  assert.equal(db.prepare('SELECT count(*) n FROM session').get()!.n, 3);
  const busyPreview = await wait(await start(options));
  db.exec('BEGIN IMMEDIATE');
  try {
   const busy = await wait(await start({ ...options, mode: 'apply', previewId: busyPreview.id }));
   assert.equal(busy.result?.status, 'skipped');
   if (busy.result?.status === 'skipped') assert.equal(busy.result.reason, 'database-busy');
  } finally { db.exec('ROLLBACK'); }
  assert.equal(db.prepare('SELECT count(*) n FROM session').get()!.n, 3);
  const nextPreview = await wait(await start(options));
  const applied = await wait(await start({ ...options, mode: 'apply', previewId: nextPreview.id })); assert.equal(applied.result?.status, 'applied');
  assert.deepEqual(db.prepare('SELECT id FROM session').all().map(row => row.id), ['retained']);
  assert.deepEqual(db.prepare('SELECT id FROM event ORDER BY id').all().map(row => row.id), ['orphan-e', 'retained-e']);
  assert.equal(db.prepare('SELECT data FROM auth').get()!.data, 'private');
  assert.equal(db.prepare("SELECT seq FROM event_sequence WHERE aggregate_id='retained'").get()!.seq, 9);
  assert.ok((await rpc('startEngineCleanup', [{ ...options, mode: 'apply', previewId: nextPreview.id }])).error);
  const pruning = await wait(await start({ ...options, pruneEvents: true, eventIdleMinutes: 0 }));
  const pruningResult = await wait(await start({ ...options, pruneEvents: true, eventIdleMinutes: 0, mode: 'apply', previewId: pruning.id })); assert.equal(pruningResult.result?.status, 'applied');
  assert.deepEqual(db.prepare('SELECT id FROM event').all().map(row => row.id), ['orphan-e']);
  assert.equal(db.prepare('SELECT id FROM message').get()!.id, 'retained-m');
  assert.equal(db.prepare('SELECT id FROM part').get()!.id, 'retained-p');
  assert.equal(db.prepare('SELECT data FROM auth').get()!.data, 'private');
  process.env.OPENCODE_DB = join(dir, 'missing.db'); const missing = await wait(await start(options)); assert.equal(missing.result?.status, 'error'); assert.equal(existsSync(process.env.OPENCODE_DB), false);
 } finally { await runtime.close(); db.close(); if (original.env === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = original.env; process.argv[1] = original.argv; rmSync(dir, { recursive: true, force: true }); }
});

test('unsupported platform rejects maintenance before opening any database', () => {
 const dir = mkdtempSync(join(tmpdir(), 't-')); const path = join(dir, 'must-not-be-created.db');
 try {
  const moduleURL = new URL('../../src/shared/engine-cleanup.ts', import.meta.url).href;
  const code = `import { runCleanupChild } from ${JSON.stringify(moduleURL)}; Object.defineProperty(process, 'platform', { value: 'win32' }); process.exitCode = runCleanupChild([${JSON.stringify(JSON.stringify({ input: options, now: Date.now() }))}]);`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, OPENCODE_DB: path } });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'error');
  assert.match(report.error, /当前平台暂不支持/);
  assert.equal(existsSync(path), false);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function leaseFixture(run: (path: string, db: DatabaseSync) => Promise<void>) {
 const dir = mkdtempSync(join(process.env.ACCEPTANCE_TMPDIR || tmpdir(), 't-'));
 const path = join(dir, 'opencode.db'); const db = database(path);
 const original = { env: process.env.OPENCODE_DB, argv: process.argv[1] };
 process.env.OPENCODE_DB = path; process.argv[1] = resolve('src/cli/main.ts');
 try { await run(path, db); }
 finally { db.close(); if (original.env === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = original.env; process.argv[1] = original.argv; rmSync(dir, { recursive: true, force: true }); }
}

test('maintenance lease refusal creates no job and does not touch the database', async () => leaseFixture(async (_path, db) => {
 let tracked = 0; let acquired = 0;
 const jobs = new EngineCleanupJobs(promise => { tracked++; return promise; }, () => { acquired++; throw new Error('fixture admission denied'); });
 assert.throws(() => jobs.start(options), /fixture admission denied/);
 assert.equal(acquired, 1); assert.equal(tracked, 0); assert.equal(jobs.get('opencode'), undefined);
 assert.equal(db.prepare('SELECT count(*) n FROM session').get()!.n, 2);
}));

test('maintenance lease spans preview and apply, rejects concurrency before acquiring, and preserves a denied preview', async () => leaseFixture(async (_path, db) => {
 let held = false; let acquired = 0; let released = 0; let deny = false; let completion: Promise<unknown> = Promise.resolve();
 const jobs = new EngineCleanupJobs(promise => { completion = promise; return promise; }, () => {
  acquired++; if (deny) throw new Error('fixture admission denied');
  assert.equal(held, false); held = true;
  return () => { assert.equal(held, true); held = false; released++; };
 });
 const preview = jobs.start(options);
 assert.equal(held, true); assert.equal(released, 0);
 assert.throws(() => jobs.start(options), /已有数据库清理任务/); assert.equal(acquired, 1);
 await completion;
 assert.equal(jobs.get(preview.id)?.result?.status, 'preview'); assert.equal(held, false); assert.equal(released, 1);
 assert.throws(() => jobs.start({ ...options, mode: 'apply', keepDays: 2, previewId: preview.id }), /选项已变更/); assert.equal(acquired, 1);
 deny = true;
 assert.throws(() => jobs.start({ ...options, mode: 'apply', previewId: preview.id }), /fixture admission denied/);
 assert.equal(released, 1); assert.equal(db.prepare('SELECT count(*) n FROM session').get()!.n, 2);
 deny = false;
 const apply = jobs.start({ ...options, mode: 'apply', previewId: preview.id });
 assert.equal(held, true); await completion;
 assert.equal(jobs.get(apply.id)?.result?.status, 'applied'); assert.equal(held, false); assert.equal(released, 2);
 assert.deepEqual(db.prepare('SELECT id FROM session').all().map(row => row.id), ['retained']);
}));

test('maintenance lease releases once when the cleanup child reports an error', async () => leaseFixture(async (path) => {
 process.env.OPENCODE_DB = path + '.missing';
 let held = false; let released = 0; let completion: Promise<unknown> = Promise.resolve();
 const jobs = new EngineCleanupJobs(promise => { completion = promise; return promise; }, () => { held = true; return () => { held = false; released++; }; });
 const job = jobs.start(options); assert.equal(held, true);
 await completion;
 assert.equal(jobs.get(job.id)?.result?.status, 'error'); assert.equal(held, false); assert.equal(released, 1);
 assert.equal(existsSync(process.env.OPENCODE_DB!), false);
}));
