import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { startCliAgent } from '../src/main/adapters/cli';
import type { WorkerRecord } from '../src/shared/types';

const run = promisify(execFile);
async function fixture(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-provider-stream-'));
  writeFileSync(join(dir, 'pi'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(dir, 'child.pid'))},String(process.pid));\n${script}`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  const agent = startCliAgent({ engine: 'pi', model: 'fixture/pi', effort: 'high', workspace: dir, stateDir: join(dir, 'state'), instruction: 'Fixture only. No model calls.' });
  let stdout = '';
  let stderr = '';
  const errors: string[] = [];
  agent.stdout.on('data', chunk => { stdout += chunk.toString(); });
  agent.stderr.on('data', chunk => { stderr += chunk.toString(); });
  agent.on('error', error => { errors.push(String(error)); });
  try {
    const closed = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timeout = setTimeout(() => { agent.kill('SIGKILL'); reject(new Error('Fixture launcher failed to close')); }, 12_000);
      agent.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
    const shown = await run('systemctl', ['--user', 'show', `${agent.scopeUnit}.scope`, '-p', 'ActiveState', '--no-pager']).catch(error => ({ stdout: (error as { stdout?: string }).stdout ?? '' }));
    const childPid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
    const executable = () => {
      try { const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'; } catch { return false; }
    };
    const deadline = Date.now() + 500;
    while (executable() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const observed = { unit: agent.scopeUnit, childPid, childExecutable: executable(), ...closed, evidence: agent.evidence, errors, stderr, records: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as WorkerRecord), active: shown.stdout };
    assert.doesNotMatch(observed.active, /ActiveState=(active|activating|deactivating)(?:\n|$)/);
    assert.equal(observed.childExecutable, false);
    assert.deepEqual(errors, []);
    return observed;
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    agent.kill('SIGKILL');
    await run('systemctl', ['--user', 'stop', `${agent.scopeUnit}.scope`]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

test('normal bounded Pi updates can exceed the old total transport byte cap', { timeout: 20_000 }, async t => {
  const update = JSON.stringify({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'snapshot '.repeat(250) }] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } });
  const frames = 800;
  const transportBytes = Buffer.byteLength(`${update}\n`) * frames;
  assert.ok(transportBytes > 1_500_000);
  assert.ok(Buffer.byteLength(update) < 128 * 1024);
  const observed = await fixture(`
const {once} = require('node:events');
async function emit(line) { if (!process.stdout.write(line+'\\n')) await once(process.stdout,'drain'); }
(async()=>{
 for(let i=0;i<${frames};i++) await emit(${JSON.stringify(update)});
 await emit(JSON.stringify({type:'message_end',message:{role:'assistant',model:'fixture/pi',stopReason:'stop',content:[{type:'text',text:'PONG'}]}}));
 await emit(JSON.stringify({type:'agent_end'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
`);
  t.diagnostic(JSON.stringify({ transportBytes, maxFrameBytes: Buffer.byteLength(update), ...observed }));
  assert.equal(observed.evidence.terminal, 'success');
  assert.equal(observed.code, 0);
  assert.equal(observed.records.at(-1)?.type, 'result');
  assert.ok(observed.records.some(record => record.type === 'artifact' && record.content === 'PONG'));
});

test('retained Pi evidence is clipped without rejecting a valid vendor completion', { timeout: 20_000 }, async t => {
  const observed = await fixture(`
for (const [text,stopReason] of [['earlier'.repeat(4000),'toolUse'],['final:'.repeat(8000)+'FINAL_TAIL','stop']]) process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason,content:[{type:'text',text}]}})+'\\n');
process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');
`);
  const artifact = observed.records.find(record => record.type === 'artifact');
  assert.equal(observed.evidence.terminal, 'success');
  assert.equal(observed.code, 0);
  assert.ok(artifact?.type === 'artifact');
  assert.ok(artifact.content.length <= 30_000);
  assert.match(artifact.content, /Earlier assistant text omitted/);
  assert.ok(artifact.content.endsWith('FINAL_TAIL'));
  assert.match(JSON.stringify(observed.records), /retained evidence clipped: field=assistant_text limitCharacters=30000 observedCharactersAtLeast=30001/);
  t.diagnostic(JSON.stringify({ ...observed, records: observed.records.map(record => record.type === 'artifact' ? { ...record, content: `[${record.content.length} characters]` } : record.type === 'result' ? { type: record.type, summary: `[${record.summary.length} characters]` } : record) }));
});

test('an oversized vendor frame is skipped and a later result is delivered without termination', { timeout: 20_000 }, async t => {
  const observed = await fixture(`
const {once} = require('node:events');
async function emit(text) { if (!process.stdout.write(text)) await once(process.stdout, 'drain'); }
(async () => {
 await emit('x'.repeat(8 * 1024 * 1024 + 1));
 await emit('\\n');
 await emit(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'SURVIVED'}]}})+'\\n');
 await emit(JSON.stringify({type:'agent_end'})+'\\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
  const diagnostics = JSON.stringify(observed.records);
  t.diagnostic(JSON.stringify(observed));
  assert.equal(observed.evidence.terminal, 'success');
  assert.equal(observed.code, 0);
  assert.equal(observed.signal, null);
  assert.ok(observed.records.some(record => record.type === 'result' && record.summary.includes('SURVIVED')));
  assert.equal(observed.records.filter(record => record.type === 'log' && record.message.includes('vendor protocol frame exceeded limit')).length, 1);
  assert.match(diagnostics, /vendor protocol frame exceeded limit: phase=(complete|unterminated) limitBytes=8388608 observedBytes=\d+/);
  assert.doesNotMatch(diagnostics, /local protocol terminal truncated/);
});

test('zero/nonzero exit and final records keep their failure meaning after stream changes', { timeout: 20_000 }, async t => {
  for (const mode of ['error', 'nonzero', 'missing-final'] as const) {
    const observed = await fixture(`
process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:${JSON.stringify(mode === 'error' ? 'error' : 'stop')},errorMessage:'fixture vendor failure',content:[{type:'text',text:'PONG'}]}})+'\\n');
${mode !== 'missing-final' ? "process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');" : ''}
process.exitCode=${mode === 'nonzero' ? 7 : 0};
`);
    t.diagnostic(JSON.stringify({ mode, ...observed }));
    assert.notEqual(observed.evidence.terminal, 'success');
    assert.notEqual(observed.code, 0);
    assert.equal(observed.records.some(record => record.type === 'result'), false);
    assert.equal(observed.evidence.terminal, mode === 'missing-final' ? 'missing' : 'error');
  }
});
