import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireInstanceLock, InstanceLockError, instanceLockKey } from '../../src/main/instance-lock';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wlock-'));
}

function lockModuleURL(): string {
  return pathToFileURL(join(process.cwd(), 'src/main/instance-lock.ts')).href;
}

test('second acquire on the same dataDir fails with INSTANCE_LOCKED', async () => {
  const dir = await tempDir();
  try {
    const first = await acquireInstanceLock(dir);
    await assert.rejects(
      acquireInstanceLock(dir),
      (error: unknown) => error instanceof InstanceLockError && error.code === 'INSTANCE_LOCKED',
    );
    await first.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release allows the lock to be reacquired', async () => {
  const dir = await tempDir();
  try {
    const first = await acquireInstanceLock(dir);
    await first.release();
    const second = await acquireInstanceLock(dir);
    await second.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('different dataDirs hold independent locks', async () => {
  const first = await tempDir();
  const second = await tempDir();
  try {
    const a = await acquireInstanceLock(first);
    const b = await acquireInstanceLock(second);
    await a.release();
    await b.release();
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('lock is released after the holder is SIGKILLed', async t => {
  if (process.platform !== 'linux') {
    t.skip('abstract-namespace lock is Linux-only');
    return;
  }
  const dir = await tempDir();
  const ready = join(dir, 'holder-ready');
  const script = [
    ';(async () => {',
    "  const fs = await import('node:fs/promises');",
    `  const { acquireInstanceLock } = await import(${JSON.stringify(lockModuleURL())});`,
    `  await acquireInstanceLock(${JSON.stringify(dir)});`,
    `  await fs.writeFile(${JSON.stringify(ready)}, 'ready');`,
    '  setInterval(() => {}, 10_000);',
    '})().catch(error => { console.error(error); process.exit(1); });',
  ].join('\n');
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const deadline = Date.now() + 15_000;
    let seen = false;
    while (Date.now() < deadline) {
      if ((await readFile(ready, 'utf8').catch(() => '')) === 'ready') { seen = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(seen, `lock holder never became ready (stderr: ${stderr})`);
    await assert.rejects(acquireInstanceLock(dir), { code: 'INSTANCE_LOCKED' });
    child.kill('SIGKILL');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('holder did not exit after SIGKILL')), 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const reacquired = await acquireInstanceLock(dir);
    await reacquired.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('lock socket is not inherited by spawned child processes', async t => {
  if (process.platform !== 'linux') {
    t.skip('fd inheritance check uses /proc (Linux-only)');
    return;
  }
  const { readFile: readProcFile } = await import('node:fs/promises');
  if (!(await readProcFile('/proc/net/unix', 'utf8').then(() => true).catch(() => false))) {
    t.skip('/proc/net/unix is unavailable');
    return;
  }
  const dir = await tempDir();
  const lock = await acquireInstanceLock(dir);
  try {
    // Inode of our abstract lock socket, resolved via the kernel socket table.
    const key = await instanceLockKey(dir);
    const table = await readProcFile('/proc/net/unix', 'utf8');
    const row = table.split('\n').find(line => line.includes(`@${key}`));
    assert.ok(row, 'lock socket visible in /proc/net/unix');
    const lockInode = row.trim().split(/\s+/)[6];
    assert.match(lockInode, /^\d+$/);
    const script = [
      ';(async () => {',
      "  const fs = await import('node:fs/promises');",
      '  const targets = [];',
      "  for (const name of await fs.readdir('/proc/self/fd')) {",
      '    try { targets.push(await fs.readlink(`/proc/self/fd/${name}`)); } catch {}',
      '  }',
      '  console.log(JSON.stringify(targets));',
      '})();',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>(resolve => child.once('close', resolve));
    assert.equal(code, 0, `fd inspector failed: ${stderr}`);
    const targets = JSON.parse(stdout.trim()) as string[];
    assert.ok(
      !targets.includes(`socket:[${lockInode}]`),
      `child inherited the lock fd (inode ${lockInode}): ${JSON.stringify(targets)}`,
    );
  } finally {
    await lock.release();
    await rm(dir, { recursive: true, force: true });
  }
});
