import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = resolve('src/cli/main.ts');

test('CLI runs through an actual symlink entrypoint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wv-entry-'));
  try {
    const linked = join(directory, 'weaver.ts');
    symlinkSync(entry, linked);
    const help = spawnSync(process.execPath, ['--import', 'tsx', linked, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Weaver local control plane/);
    const machine = spawnSync(process.execPath, ['--import', 'tsx', linked, 'results', 'ack', '--help', '--output', 'json'], { encoding: 'utf8' });
    assert.equal(machine.status, 0, machine.stderr);
    assert.equal(JSON.parse(machine.stdout).data.command, 'results.ack');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('importing the CLI does not run it, including a host with non-file argv', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wv-entry-'));
  try {
    const moduleUrl = JSON.stringify(pathToFileURL(entry).href);
    const importer = join(directory, 'importer.mjs');
    writeFileSync(importer, `await import(${moduleUrl}); console.log('imported');\n`);
    const imported = spawnSync(process.execPath, ['--import', 'tsx', importer, '--help'], { encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, 'imported\n');
    const noFile = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `process.argv[1]=${JSON.stringify(join(directory, 'absent.mjs'))}; await import(${moduleUrl}); console.log('imported');`], { encoding: 'utf8' });
    assert.equal(noFile.status, 0, noFile.stderr);
    assert.equal(noFile.stdout, 'imported\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
