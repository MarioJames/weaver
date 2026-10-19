import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { startCliAgent } from '../src/main/adapters/cli';
import type { WorkerRecord } from '../src/shared/types';

for (const framing of ['complete', 'unterminated'] as const) for (const terminal of ['success', 'error', 'missing'] as const) {
  test(`launch skips oversized ${framing} stdout and preserves later ${terminal} terminal`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'weaver-overflow-'));
    const signals: unknown[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null as number | null,
      kill: (signal: unknown) => { signals.push(signal); return true; },
    });
    // Substitute only the OS process boundary; decodeLines, launch and the
    // vendor normalizer all run unchanged, without a systemd user session.
    t.mock.method(childProcess, 'spawn', () => child);
    t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(null, 'LoadState=not-found\n', ''));
      return new EventEmitter();
    });
    syncBuiltinESMExports();
    try {
      const agent = startCliAgent({ engine: 'pi', model: 'fixture/pi', effort: 'high', workspace: dir, stateDir: join(dir, 'state'), instruction: 'Fixture only' });
      const records: WorkerRecord[] = [];
      let output = '';
      agent.stdout.on('data', chunk => { output += chunk.toString(); });
      const closed = once(agent, 'close');
      // A frame above the former 128 KiB cap must still reach the normalizer.
      child.stdout.write(JSON.stringify({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(180 * 1024) }] } }) + '\n');
      assert.equal(output.includes('vendor protocol frame exceeded limit'), false);
      if (framing === 'complete') {
        child.stdout.write(Buffer.concat([Buffer.alloc(8 * 1024 * 1024 + 1, 120), Buffer.from('\n')]));
      } else {
        child.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 120));
        child.stdout.write(Buffer.alloc(1024, 120));
        child.stdout.write('\n');
      }
      assert.deepEqual(signals, [], 'oversized lines must not terminate the worker');
      assert.equal(agent.evidence.terminal, 'pending');
      child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: terminal === 'error' ? 'error' : 'stop', content: [{ type: 'text', text: 'SURVIVED' }] } }) + '\n');
      if (terminal !== 'missing') child.stdout.write('{"type":"agent_end"}\n');
      child.exitCode = 0;
      child.emit('close', 0, null);
      const [code, signal] = await closed;
      records.push(...output.trim().split('\n').map(line => JSON.parse(line) as WorkerRecord));
      assert.deepEqual(signals, []);
      assert.equal(signal, null);
      assert.equal(code, terminal === 'success' ? 0 : 1);
      assert.equal(agent.evidence.terminal, terminal);
      assert.equal(records.filter(record => record.type === 'log' && record.message.includes('vendor protocol frame exceeded limit')).length, 1);
      assert.equal(records.some(record => record.type === 'result' && record.summary.includes('SURVIVED')), terminal === 'success');
      assert.doesNotMatch(output, /local protocol terminal truncated/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
