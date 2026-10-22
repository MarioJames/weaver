import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalIPC, readDiscovery, type StartLocalIPCOptions } from '../../src/main/local-ipc';

const response = (request: unknown) => ({ apiVersion: 'weaver.v1', commandId: null, ok: true, data: request });

async function startOrSkip(t: TestContext, directory: string, handler: (input: never) => unknown, options?: StartLocalIPCOptions) {
  try {
    return await startLocalIPC(directory, handler as (input: unknown) => unknown, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Sandbox denies Unix socket listen (EPERM); no bypass attempted');
      return;
    }
    throw error;
  }
}

test('empty discovery + lockHeld starts and archives a .corrupt backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-ipc-'));
  try {
    await writeFile(join(directory, 'control.v1.json'), '', { mode: 0o600 });
    const app = await startOrSkip(t, directory, response, { lockHeld: true });
    if (!app) return;
    try {
      const entries = await readdir(directory);
      const backups = entries.filter(name => name.startsWith('control.v1.json.corrupt-'));
      assert.equal(backups.length, 1);
      assert.equal(await readFile(join(directory, backups[0]), 'utf8'), '');
      const discovery = await readDiscovery(directory);
      assert.match(discovery.discovery.instanceId, /^[a-f0-9]{32}$/);
      assert.equal((await lstat(join(directory, 'control.v1.json'))).mode & 0o777, 0o600);
      assert.ok(!entries.some(name => name.includes('.tmp-')), 'no publish temp residue remains');
    } finally {
      await app.close();
    }
    assert.ok(!(await readdir(directory)).includes('control.v1.json'), 'close removes our own discovery');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt discovery without lockHeld fails ENDPOINT_EXISTS and is preserved', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-ipc-'));
  try {
    await writeFile(join(directory, 'control.v1.json'), 'not-json{{{', { mode: 0o600 });
    await assert.rejects(startLocalIPC(directory, response), { code: 'ENDPOINT_EXISTS' });
    assert.equal(await readFile(join(directory, 'control.v1.json'), 'utf8'), 'not-json{{{');
    assert.ok(!(await readdir(directory)).some(name => name.includes('.corrupt-')), 'no backup without the lock');
    // The same leftover is recoverable once the singleton lock is held.
    const app = await startOrSkip(t, directory, response, { lockHeld: true });
    if (!app) return;
    try {
      assert.ok((await readdir(directory)).some(name => name.startsWith('control.v1.json.corrupt-')));
      await readDiscovery(directory);
    } finally {
      await app.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publish is atomic: no empty discovery is visible before rename', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-ipc-'));
  try {
    let observed = false;
    const app = await startOrSkip(t, directory, response, {
      lockHeld: true,
      __beforeRename(tmpPath) {
        observed = true;
        // The temp file already holds the complete payload...
        const parsed = JSON.parse(readFileSync(tmpPath, 'utf8')) as { version: number };
        assert.equal(parsed.version, 1);
        assert.equal(statSync(tmpPath).mode & 0o777, 0o600);
        // ...while the final path is still absent: readers can never see an empty file.
        assert.equal(existsSync(join(directory, 'control.v1.json')), false);
      },
    });
    if (!app) return;
    try {
      assert.equal(observed, true);
      await readDiscovery(directory);
    } finally {
      await app.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('lockHeld supersedes a live older instance without breaking inode-checked close', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-ipc-'));
  try {
    const first = await startOrSkip(t, directory, response);
    if (!first) return;
    const before = await readDiscovery(directory);
    const second = await startOrSkip(t, directory, response, { lockHeld: true });
    if (!second) {
      await first.close();
      return;
    }
    try {
      const entries = await readdir(directory);
      assert.ok(entries.some(name => name.startsWith('control.v1.json.superseded-')));
      const after = await readDiscovery(directory);
      assert.notEqual(after.discovery.instanceId, before.discovery.instanceId);
      // The superseded instance's close must not delete the replacement (inode check).
      await first.close();
      assert.equal((await readDiscovery(directory)).discovery.instanceId, after.discovery.instanceId);
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
