import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sayHi, parseHelloInput } from '../src/main/engines/hello';
import type { CliAgentInput } from '../src/main/adapters/launch';

function fakeLaunch(script: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }) => void, seen: CliAgentInput[] = []) {
  return (input: CliAgentInput) => {
    seen.push(input);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: '', kill(signal?: string) { child.killed = signal ?? 'SIGTERM'; child.stdout.end(); setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; } });
    setImmediate(() => script(child));
    return child as any;
  };
}

const root = () => mkdtempSync(join(tmpdir(), 'weaver-hello-'));

test('a reply on a clean exit is reported as reachable, and the scratch directory is removed', async () => {
  const dir = root(); const seen: CliAgentInput[] = [];
  try {
    const result = await sayHi({ engine: 'codex', kind: 'codex', model: 'gpt-x', effort: 'low' }, { root: dir, launch: fakeLaunch(child => {
      child.stdout.write(JSON.stringify({ type: 'log', message: 'Launching' }) + '\n');
      child.stdout.end(JSON.stringify({ type: 'result', summary: 'Hi!' }) + '\n');
      child.emit('close', 0, null);
    }, seen) });
    assert.equal(result.ok, true);
    assert.equal(result.reply, 'Hi!');
    assert.equal(seen[0].model, 'gpt-x');
    assert.equal(seen[0].effort, 'low');
    assert.match(seen[0].instruction, /hi/i);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failing exit reports the last log line or stderr as the reason', async () => {
  const dir = root();
  try {
    const result = await sayHi({ engine: 'opencode', kind: 'opencode', model: 'm', effort: 'max' }, { root: dir, launch: fakeLaunch(child => {
      child.stderr.end('model not found\n');
      child.stdout.end();
      child.emit('close', 1, null);
    }) });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /model not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no reply within the deadline stops the process and reports a timeout', async () => {
  const dir = root(); let killed = '';
  try {
    const result = await sayHi({ engine: 'grok', kind: 'grok', model: 'm', effort: 'high' }, { root: dir, timeoutMs: 20, launch: (input) => { const launch = fakeLaunch(() => {}); const child = launch(input); const kill = child.kill.bind(child); child.kill = (signal?: string) => { killed = signal ?? 'SIGTERM'; return kill(signal); }; return child; } });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /超时|timed out/);
    assert.equal(killed, 'SIGTERM');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('engines without a real launcher are refused without starting anything', async () => {
  const dir = root(); const seen: CliAgentInput[] = [];
  try {
    const result = await sayHi({ engine: 'claude', kind: 'claude', model: 'sonnet', effort: 'high' }, { root: dir, launch: fakeLaunch(() => {}, seen) });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Claude/);
    assert.equal(seen.length, 0);
    assert.equal(existsSync(join(dir, 'x')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a launcher that rejects the input is reported, not thrown', async () => {
  const dir = root();
  try {
    const result = await sayHi({ engine: 'codex', kind: 'codex', model: 'bad model', effort: 'low' }, { root: dir, launch: () => { throw new Error('Model must be a bounded identifier'); } });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /bounded identifier/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('input must name a configured engine with model and effort', () => {
  assert.deepEqual(parseHelloInput({ engine: 'codex', model: 'gpt', effort: 'low' }), { engine: 'codex', model: 'gpt', effort: 'low' });
  assert.throws(() => parseHelloInput({ engine: 'codex', model: '', effort: 'low' }));
  assert.throws(() => parseHelloInput({ engine: 'codex', model: 'gpt', effort: 'low', extra: 1 }));
  assert.throws(() => parseHelloInput(null));
});
