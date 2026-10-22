import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLogIdentity, closeRunFiles, createRunFiles, readExitRecord } from '../../src/main/adapters/cli/run-files';

const TMP = mkdtempSync(join(tmpdir(), 'wv-run-files-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const fresh = (prefix: string) => mkdtempSync(join(TMP, prefix));

test('createRunFiles pre-creates 0600 logs and returns matching fstat identity', () => {
  const dir = join(fresh('runfiles-'), 'state');
  const created = createRunFiles(dir, 'run1');
  try {
    assert.equal(statSync(created.paths.stdout).mode & 0o777, 0o600);
    assert.equal(statSync(created.paths.stderr).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.ok(created.paths.exit.endsWith('exit-run1.json'));
    assert.ok(created.paths.exitTmp.endsWith('exit-run1.tmp'));
    assert.equal(created.paths.exitTmp.slice(0, created.paths.exitTmp.lastIndexOf('/')), dir);
    assert.match(created.nonce, /^[0-9a-f]{32}$/);
    const liveOut = statSync(created.paths.stdout);
    const liveErr = statSync(created.paths.stderr);
    assert.equal(created.identity.stdout.dev, liveOut.dev);
    assert.equal(created.identity.stdout.ino, liveOut.ino);
    assert.equal(created.identity.stderr.dev, liveErr.dev);
    assert.equal(created.identity.stderr.ino, liveErr.ino);
    // FDs are writable append handles.
    writeFileSync(created.fds.stdout, 'hello\n');
    assert.equal(readFileSync(created.paths.stdout, 'utf8'), 'hello\n');
  } finally {
    closeRunFiles(created.fds);
  }
});

test('createRunFiles fails closed when a stale log file already exists', () => {
  const dir = join(fresh('runfiles-'), 'state');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'stdout-run2.log'), 'stale', { mode: 0o600 });
  assert.throws(() => createRunFiles(dir, 'run2'), /EEXIST/);
});

test('readExitRecord accepts a valid bound record', () => {
  const dir = fresh('runfiles-');
  const path = join(dir, 'exit.json');
  writeFileSync(path, JSON.stringify({ runId: 'r1', nonce: 'ab'.repeat(16), code: 7, signal: null, pid: 1234, at: '2026-01-01T00:00:00Z' }));
  const record = readExitRecord(path, 'r1', 'ab'.repeat(16));
  assert.deepEqual(record, { code: 7, signal: null, pid: 1234, at: '2026-01-01T00:00:00Z' });
});

test('readExitRecord returns undefined for every invalid shape', () => {
  const dir = fresh('runfiles-');
  const nonce = 'cd'.repeat(16);
  const cases: Array<[string, string | undefined]> = [
    ['missing file', undefined],
    ['tmp residue only', '{"runId":"r","nonce":"x"}'],
    ['not json', 'definitely not json{{{'],
    ['json scalar', '42'],
    ['json array', '[]'],
    ['runId mismatch', JSON.stringify({ runId: 'other', nonce, code: 0, signal: null, pid: 1, at: 't' })],
    ['nonce mismatch', JSON.stringify({ runId: 'r', nonce: '00'.repeat(16), code: 0, signal: null, pid: 1, at: 't' })],
    ['non-integer code', JSON.stringify({ runId: 'r', nonce, code: 1.5, signal: null, pid: 1, at: 't' })],
    ['missing pid', JSON.stringify({ runId: 'r', nonce, code: 0, signal: null, at: 't' })],
    ['bad signal type', JSON.stringify({ runId: 'r', nonce, code: 0, signal: 9, pid: 1, at: 't' })],
    ['missing at', JSON.stringify({ runId: 'r', nonce, code: 0, signal: null, pid: 1 })],
  ];
  for (const [name, body] of cases) {
    const path = join(dir, `exit-${name.length}.json`);
    if (name === 'tmp residue only') {
      writeFileSync(join(dir, 'exit-tmp.json.tmp'), body!);
      assert.equal(readExitRecord(join(dir, 'exit-tmp.json.tmp'), 'r', nonce), undefined, name);
      continue;
    }
    if (body !== undefined) writeFileSync(path, body);
    assert.equal(readExitRecord(name === 'missing file' ? join(dir, 'no-such.json') : path, 'r', nonce), undefined, name);
  }
  // String signal values are accepted.
  const sigPath = join(dir, 'exit-sig.json');
  writeFileSync(sigPath, JSON.stringify({ runId: 'r', nonce, code: 0, signal: 'SIGKILL', pid: 9, at: 't' }));
  assert.equal(readExitRecord(sigPath, 'r', nonce)?.signal, 'SIGKILL');
});

test('checkLogIdentity distinguishes ok / missing / replaced / truncated', () => {
  const dir = join(fresh('runfiles-'), 'state');
  const created = createRunFiles(dir, 'run9');
  try {
    assert.deepEqual(checkLogIdentity(created.paths, created.identity, { stdout: 0, stderr: 0 }), { ok: true });
    // Truncated: file smaller than the committed offset.
    writeFileSync(created.fds.stdout, '12345678');
    const truncated = checkLogIdentity(created.paths, created.identity, { stdout: 100, stderr: 0 });
    assert.equal(truncated.ok, false);
    assert.equal((truncated as { reason: string }).reason, 'truncated');
    // Replaced: swap the file for a new inode.
    const fd = openSync(created.paths.stdout + '.new', 'w', 0o600);
    closeSync(fd);
    const swapped = (() => {
      renameSync(created.paths.stdout + '.new', created.paths.stdout);
      return checkLogIdentity(created.paths, created.identity, { stdout: 0, stderr: 0 });
    })();
    assert.equal(swapped.ok, false);
    assert.equal((swapped as { reason: string }).reason, 'replaced');
  } finally {
    closeRunFiles(created.fds);
  }
  // Missing: point at paths that were never created.
  const missing = checkLogIdentity(
    { stdout: join(dir, 'nope-out.log'), stderr: join(dir, 'nope-err.log') },
    { stdout: { dev: 1, ino: 2 }, stderr: { dev: 3, ino: 4 } },
    { stdout: 0, stderr: 0 },
  );
  assert.deepEqual(missing, { ok: false, reason: 'missing', detail: 'stdout' });
});

test('log fds are append-only handles independent of later path opens', () => {
  const dir = join(fresh('runfiles-'), 'state');
  const created = createRunFiles(dir, 'runA');
  try {
    const before = fstatSync(created.fds.stdout);
    writeFileSync(created.paths.stdout, 'external\n');
    writeFileSync(created.fds.stdout, 'via-fd\n');
    assert.equal(readFileSync(created.paths.stdout, 'utf8'), 'external\nvia-fd\n');
    assert.equal(fstatSync(created.fds.stdout).ino, before.ino);
  } finally {
    closeRunFiles(created.fds);
  }
});
