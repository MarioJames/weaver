import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCliAgentInput, startCliAgent } from '../../src/main/adapters/cli';
import type { RealEngineKind } from '../../src/shared/contracts/tasks';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { MockWorkerAdapter } from '../../src/main/adapters/worker';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import { resolve } from 'node:path';

const instruction = 'Reply PONG only.';
const prepare = (dir: string, engine: RealEngineKind) => prepareCliAgentInput({
  engine, model: 'fixture-model', effort: engine === 'pi' ? 'high' : engine === 'codex' ? 'high' : 'auto', workspace: dir, stateDir: join(dir, 'state'), instruction,
});

test('only pi gets a session directory; every engine records its prompt file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-run-record-'));
  try {
    for (const engine of ['pi', 'opencode', 'grok', 'codex', 'qodercli'] as RealEngineKind[]) {
      const prepared = prepare(dir, engine);
      assert.equal(readFileSync(prepared.promptPath, 'utf8'), instruction, `${engine}: the prompt file is kept`);
      if (engine === 'pi') {
        assert.ok(prepared.sessionDir && existsSync(prepared.sessionDir), 'pi owns a session directory');
        assert.match(prepared.sessionDir!, /pi-session-[0-9a-f]+$/);
      } else assert.equal(prepared.sessionDir, undefined, `${engine}: no session directory is described`);
    }
    const created = readdirSync(join(dir, 'state')).filter(name => name.startsWith('pi-session-'));
    assert.equal(created.length, 1, 'exactly one session directory exists, the pi one');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a running agent exposes prompt path and the vendor session id as soon as the stream carries it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-run-evidence-'));
  const previous = process.env.PATH;
  writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(join(dir, 'systemctl'), '#!/bin/sh\necho ActiveState=inactive\n', { mode: 0o700 });
  const events = [
    { type: 'thread.started', thread_id: 'thread-abc' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'PONG' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ].map(item => JSON.stringify(item)).join('\\n');
  writeFileSync(join(dir, 'codex'), `#!${process.execPath}\nconst fs=require('fs');fs.readFileSync(0);fs.writeFileSync(1,${JSON.stringify(events)}.replace(/\\\\n/g,'\\n')+'\\n');`, { mode: 0o700 });
  process.env.PATH = `${dir}:${previous}`;
  try {
    const agent = startCliAgent({ engine: 'codex', model: 'fixture', effort: 'high', workspace: dir, stateDir: join(dir, 'state'), instruction });
    agent.on('error', () => {});
    let atFirstOutput: string | undefined;
    agent.on('first-output', () => { atFirstOutput = agent.evidence.vendorSessionId; });
    await new Promise(resolve => agent.once('close', resolve));
    assert.equal(atFirstOutput, 'thread-abc', 'known while the run is still going, not only at the end');
    assert.equal(agent.evidence.vendorSessionId, 'thread-abc');
    assert.match(agent.evidence.promptPath ?? '', /state\/prompt-[0-9a-f]+\.txt$/);
    assert.equal(readFileSync(agent.evidence.promptPath!, 'utf8'), instruction);
    assert.equal(agent.evidence.sessionDir, undefined, 'codex has no session directory');
  } finally { process.env.PATH = previous; rmSync(dir, { recursive: true, force: true }); }
});

test('the DB run keeps promptPath, sessionDir and the vendor session id and tasks.get returns them after a reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-run-db-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const adapter = new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs'));
  const manager = new TaskManager(store, adapter);
  const handler = new CommandHandler(manager, new PolicyStore(store.db));
  try {
    const created = handler.handle({ apiVersion: 'weaver.v1', commandId: 'run-record-create', command: 'tasks.create', args: { title: 'Run record', instruction: 'inspect', owner: { name: 'o', transport: 'herdr-visible', session: 's', pane: '1' } } });
    assert.equal(created.ok, true, JSON.stringify(created));
    const task = store.get((created.data as { id: string }).id);
    task.run = {
      id: 'run-1', adapter: 'pi', execution: 'real', status: 'stopped',
      evidence: { engine: 'pi', requestedModel: 'm', requestedEffort: 'high', workspace: dir, terminal: 'success', promptPath: join(dir, 'state', 'prompt-aa.txt'), sessionDir: join(dir, 'state', 'pi-session-aa'), vendorSessionId: 'pi-session-id-1' },
    };
    store.put(task);
    store.close();
    const reopened = new TaskStore(join(dir, 'weaver.db'));
    const again = new CommandHandler(new TaskManager(reopened, adapter), new PolicyStore(reopened.db));
    const got = again.handle({ apiVersion: 'weaver.v1', command: 'tasks.get', args: { taskId: task.id } });
    const evidence = (got.data as { run: { evidence: Record<string, unknown> } }).run.evidence;
    assert.equal(evidence.promptPath, join(dir, 'state', 'prompt-aa.txt'));
    assert.equal(evidence.sessionDir, join(dir, 'state', 'pi-session-aa'));
    assert.equal(evidence.vendorSessionId, 'pi-session-id-1');
    await again.drain();
    reopened.close();
  } finally { await handler.drain(); rmSync(dir, { recursive: true, force: true }); }
});
