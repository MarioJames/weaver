import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { executableCandidates, executableExtensions, findExecutable, findExecutableSync } from '../src/main/system/executables';
import { findEngineExecutable } from '../src/main/engines/probe';

function scratch(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'weaver-exec-')));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}
const script = (path: string, mode = 0o755) => { writeFileSync(path, '#!/bin/sh\nexit 0\n'); chmodSync(path, mode); };
/** Both entry points answer the same question; run every case through each. */
async function both(name: string, pathEnv: string): Promise<[string | undefined, string | undefined]> {
  return [findExecutableSync(name, pathEnv), await findExecutable(name, pathEnv)];
}

test('an executable regular file is found and returned by its real path', scratch(async dir => {
  script(join(dir, 'tool'));
  assert.deepEqual(await both('tool', dir), [join(dir, 'tool'), join(dir, 'tool')]);
  assert.deepEqual(await both('tool', `${join(dir, 'nowhere')}${delimiter}${dir}`), [join(dir, 'tool'), join(dir, 'tool')]);
}));

test('a file without the execute bit is not an executable', scratch(async dir => {
  script(join(dir, 'plain'), 0o644);
  assert.deepEqual(await both('plain', dir), [undefined, undefined]);
}));

test('a directory with the command name is skipped and the next PATH entry wins', scratch(async dir => {
  const first = join(dir, 'first'); const second = join(dir, 'second');
  mkdirSync(join(first, 'tool'), { recursive: true }); mkdirSync(second);
  script(join(second, 'tool'));
  assert.deepEqual(await both('tool', first), [undefined, undefined]);
  assert.deepEqual(await both('tool', `${first}${delimiter}${second}`), [join(second, 'tool'), join(second, 'tool')]);
}));

test('a symlink to an executable resolves to the target, and a symlink to a directory is skipped', scratch(async dir => {
  const bin = join(dir, 'bin'); const real = join(dir, 'real');
  mkdirSync(bin); mkdirSync(join(real, 'dir'), { recursive: true });
  script(join(real, 'target'));
  symlinkSync(join(real, 'target'), join(bin, 'alias'));
  symlinkSync(join(real, 'dir'), join(bin, 'folder'));
  symlinkSync(join(dir, 'missing'), join(bin, 'dangling'));
  assert.deepEqual(await both('alias', bin), [join(real, 'target'), join(real, 'target')]);
  for (const name of ['folder', 'dangling']) assert.deepEqual(await both(name, bin), [undefined, undefined], name);
}));

test('empty PATH segments are skipped instead of meaning the current directory', scratch(async dir => {
  script(join(dir, 'tool'));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    for (const pathEnv of ['', delimiter, `${delimiter}${delimiter}`, `${delimiter}${join(dir, 'nowhere')}`]) {
      assert.deepEqual(await both('tool', pathEnv), [undefined, undefined], JSON.stringify(pathEnv));
    }
    assert.deepEqual(await both('tool', `${delimiter}${dir}`), [join(dir, 'tool'), join(dir, 'tool')]);
  } finally { process.chdir(previous); }
}));

test('a name with a path separator or .. is refused by both entry points', async () => {
  for (const name of ['', 'a/b', 'a\\b', '..', '../tool', 'x..y', '/bin/sh']) {
    assert.throws(() => findExecutableSync(name, '/usr/bin'), /bare command name/, JSON.stringify(name));
    await assert.rejects(findExecutable(name, '/usr/bin'), /bare command name/, JSON.stringify(name));
  }
});

test('PATHEXT extensions are tried in order on Windows and ignored elsewhere', () => {
  assert.deepEqual(executableExtensions('win32', '.EXE;.CMD;;.BAT'), ['.EXE', '.CMD', '.BAT']);
  assert.deepEqual(executableExtensions('win32', undefined), ['.EXE', '.CMD', '.BAT']);
  assert.deepEqual(executableExtensions('linux', '.EXE;.CMD'), ['']);
  assert.deepEqual(executableCandidates('tool', ['/a', '', '/b'].join(delimiter), ['.EXE', '.CMD']), [join('/a', 'tool.EXE'), join('/a', 'tool.CMD'), join('/b', 'tool.EXE'), join('/b', 'tool.CMD')]);
});

test('the engine lookup refuses commands outside the catalog before touching PATH', scratch(async dir => {
  script(join(dir, 'not-an-engine'));
  await assert.rejects(findEngineExecutable('not-an-engine', dir), /outside the probe allowlist/);
  assert.equal(await findEngineExecutable('claude', dir), undefined);
  script(join(dir, 'claude'));
  assert.equal(await findEngineExecutable('claude', dir), join(dir, 'claude'));
}));
