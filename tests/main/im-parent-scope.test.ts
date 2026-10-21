import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOwnedScope, type OwnedScope } from '../../src/main/adapters/cli/scope';

async function until(predicate: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not reached: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function bounded<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Subscribe immediately after spawn, before stdout, assertions or stdin can finish the child. */
function observeScope(scope: OwnedScope) {
  let exited = false;
  const closed = new Promise<number | null>(resolve => {
    scope.once('close', code => { exited = true; resolve(code as number | null); });
  });
  let firstError: Error | undefined;
  let onError: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    onError = error => { firstError ??= error; reject(error); };
    scope.on('error', onError);
  });
  // An error may arrive before the test reaches wait(); keep it handled and replay it there.
  void failed.catch(() => {});
  return {
    scope,
    wait: () => firstError ? Promise.reject(firstError) : bounded(Promise.race([closed, failed]), 'fixture scope close'),
    async dispose(): Promise<void> {
      try {
        if (!exited) {
          scope.stdin?.end();
          scope.kill('SIGKILL');
        }
        // Cleanup waits for actual close even if an earlier protocol/error wait rejected.
        await bounded(closed, 'fixture scope cleanup');
      } finally {
        if (exited) scope.removeListener('error', onError!);
      }
    },
  };
}

test('keepStdinOpen keeps the child stdin writable across multiple writes', async () => {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'weaver-im-scope-'));
  const previousPath = process.env.PATH;
  writeShims(dir);
  process.env.PATH = `${dir}:${previousPath}`;
  let resident: ReturnType<typeof observeScope> | undefined;
  try {
    const acks: string[] = [];
    resident = observeScope(startOwnedScope({
      command: [process.execPath, '-e', `
        let data='';process.stdin.setEncoding('utf8');
        process.stdin.on('data',chunk=>{data+=chunk;let i;while((i=data.indexOf('\\n'))>=0){const line=data.slice(0,i);data=data.slice(i+1);process.stdout.write('ack:'+line+'\\n');}});
        process.stdin.on('end',()=>process.exit(0));`],
      cwd: dir,
      env: { ...process.env },
      stdin: null,
      keepStdinOpen: true,
      unit: 'dev-weaver-im-testscope',
    }));
    const { scope } = resident;
    assert.ok(scope.stdin, 'keepStdinOpen must expose a writable stdin');
    scope.stdout.setEncoding('utf8');
    scope.stdout.on('data', chunk => acks.push(...chunk.split('\n').filter(Boolean)));
    scope.stdin!.write('第一行\n');
    await until(() => acks.includes('ack:第一行'), 'first ack');
    scope.stdin!.write('第二行\n');
    await until(() => acks.includes('ack:第二行'), 'second ack');
    scope.stdin!.end();
    const code = await resident.wait();
    assert.equal(code, 0);
  } finally {
    try { await resident?.dispose(); }
    finally {
      process.env.PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('keepStdinOpen rejects contradictory stdin options and leaves defaults untouched', async () => {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'weaver-im-scope-bad-'));
  const previousPath = process.env.PATH;
  writeShims(dir);
  process.env.PATH = `${dir}:${previousPath}`;
  let resident: ReturnType<typeof observeScope> | undefined;
  try {
    assert.throws(() => startOwnedScope({ command: ['unused'], cwd: dir, env: {}, stdin: 'x', keepStdinOpen: true, unit: 'unused' }), /keepStdinOpen/);
    assert.throws(() => startOwnedScope({ command: ['unused'], cwd: dir, env: {}, stdin: null, stdinPath: join(dir, 'missing'), keepStdinOpen: true, unit: 'unused' }), /keepStdinOpen/);
    // Default call without keepStdinOpen still closes stdin right away.
    const eof: string[] = [];
    resident = observeScope(startOwnedScope({
      command: [process.execPath, '-e', `let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write('EOF:'+d.length+'\\n');});`],
      cwd: dir,
      env: { ...process.env },
      stdin: 'payload\n',
      unit: 'dev-weaver-im-default',
    }));
    const { scope } = resident;
    assert.equal(scope.stdin, undefined);
    scope.stdout.setEncoding('utf8');
    scope.stdout.on('data', chunk => eof.push(chunk.trim()));
    await until(() => eof.some(line => line.startsWith('EOF:')), 'default stdin EOF');
    assert.equal(await resident.wait(), 0);
    assert.ok(eof.includes('EOF:8'), 'default stdin must deliver the complete payload before EOF');
  } finally {
    try { await resident?.dispose(); }
    finally {
      process.env.PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function writeShims(dir: string): void {
  writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(join(dir, 'systemctl'), '#!/bin/sh\necho ActiveState=inactive\n', { mode: 0o700 });
}
