import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startHttpServer } from '../src/main/http';

function get(port: number, path: string) {
  return new Promise<{ status: number; text: string; type?: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('an embedded renderer is served from memory with the same path rules as files on disk', async () => {
  const files = new Map<string, Uint8Array>([
    ['index.html', Buffer.from('<html>INDEX</html>')],
    ['assets/app.js', Buffer.from('console.log(1)')],
    ['notes.secret', Buffer.from('SECRET')],
  ]);
  const http = await startHttpServer({ port: 0, staticFiles: files, call: async () => null });
  try {
    const index = await get(http.port, '/');
    assert.equal(index.status, 200);
    assert.equal(index.text, '<html>INDEX</html>');
    assert.match(index.type ?? '', /text\/html/);
    const script = await get(http.port, '/assets/app.js?v=1');
    assert.equal(script.status, 200);
    assert.match(script.type ?? '', /javascript/);
    for (const path of ['/notes.secret', '/assets/../notes.secret', '/assets/%2e%2e/index.html', '/missing.js']) {
      const result = await get(http.port, path);
      assert.equal(result.status, 404, path);
      assert.equal(result.text.includes('SECRET'), false, path);
    }
  } finally { await http.close(); }
});

test('weaver --version prints the package version', async () => {
  const { readFileSync } = await import('node:fs');
  const { VERSION } = await import('../src/shared/version');
  assert.equal(VERSION, JSON.parse(readFileSync('package.json', 'utf8')).version);
  const { runCLI } = await import('../src/cli/main');
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: string) => { written.push(String(chunk)); return true; };
  try { assert.equal(await runCLI(['--version']), 0); } finally { (process.stdout as any).write = write; }
  assert.equal(written.join(''), `weaver ${VERSION}\n`);
});

test('--skill prints the bundled SKILL.md frontmatter to stdout', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), '--skill'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^---\nname: agents-weaver\n/);
  assert.match(result.stdout, /description: /);
  assert.match(result.stdout, /^# /m);
});

test('--input takes a file, stdin, or the JSON object inline, and names a missing file', async () => {
  const { readInput } = await import('../src/cli/main');
  assert.deepEqual(await readInput('{"owner":"codex_owner"}'), { owner: 'codex_owner' });
  assert.deepEqual(await readInput('  {"a":[1]}'), { a: [1] });
  await assert.rejects(readInput('{"owner":'), /Inline --input must be valid JSON/);
  await assert.rejects(readInput('/nonexistent/weaver-input.json'), /Input file not found: \/nonexistent\/weaver-input.json/);
});
