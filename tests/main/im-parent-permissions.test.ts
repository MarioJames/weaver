import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParentAgent, prepareParentAgentInput } from '../../src/main/im/parent-agent';
import { findExecutableSync } from '../../src/main/system/executables';

const FIXTURE = new URL('../fixtures/parent/codex-fixture.mjs', import.meta.url).pathname;

const section = { writable_roots: ['/kept'], network_access: false, exclude_slash_tmp: true, exclude_tmpdir_env_var: true };
const workspacePolicy = { type: 'workspaceWrite', networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
for (const scenario of [
  { name: 'workspace-write', mode: 'workspace-write', policy: workspacePolicy },
  { name: 'read-only', mode: 'read-only', policy: { type: 'readOnly' } },
  { name: 'danger-full-access', mode: 'danger-full-access', policy: { type: 'dangerFullAccess' } },
  { name: 'read-only upgrade', mode: 'read-only', policy: { type: 'dangerFullAccess' }, invalid: true },
  { name: 'network relaxation', mode: 'workspace-write', policy: { ...workspacePolicy, networkAccess: true }, invalid: true },
  { name: 'tmp relaxation', mode: 'workspace-write', policy: { ...workspacePolicy, excludeSlashTmp: false }, invalid: true },
  { name: 'approval relaxation', mode: 'workspace-write', policy: workspacePolicy, approval: 'never', invalid: true },
  { name: 'unknown config', mode: null, policy: { type: 'externalSandbox' }, invalid: true },
  { name: 'unexpected writable root', mode: 'workspace-write', policy: workspacePolicy, extraRoot: true, invalid: true },
  { name: 'dropped effective roots', mode: 'workspace-write', policy: workspacePolicy, dropRoots: true, invalid: true },
]) test(`Codex additional roots: ${scenario.name}`, async () => {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'perm-'));
  const extra = join(dir, 'extra'); mkdirSync(extra);
  const marker = join(dir, 'params');
  // Isolate executable discovery from any developer-machine CLI: the constructor
  // requires `codex` on PATH before the custom launch runs, so each case owns a
  // fake `codex` (real fixture copy, never executed) and hides the rest of PATH,
  // mirroring clean CI where no real CLI exists.
  const fakeBin = join(dir, 'fakebin'); mkdirSync(fakeBin);
  const fakeCodex = join(fakeBin, 'codex');
  copyFileSync(FIXTURE, fakeCodex);
  chmodSync(fakeCodex, 0o755);
  const previousPath = process.env.PATH ?? '';
  process.env.PATH = fakeBin;
  // Prove discovery actually resolves the owned fake, not a host CLI.
  assert.equal(findExecutableSync('codex'), fakeCodex);
  const config = { sandbox_mode: scenario.mode, sandbox_workspace_write: section, approval_policy: 'on-request', approvals_reviewer: 'user' };
  const script = `const rl=require('node:readline').createInterface({input:process.stdin}); const emit=o=>console.log(JSON.stringify(o)); let startConfig; rl.on('line',line=>{ const f=JSON.parse(line); if(f.method==='initialize')emit({id:f.id,result:{}}); if(f.method==='config/read')emit({id:f.id,result:{config:${JSON.stringify(config)}}}); if(f.method==='thread/start'){startConfig=f.params.config;emit({id:f.id,result:{thread:{id:'t'},sandbox:{...${JSON.stringify(scenario.policy)},...(${JSON.stringify(scenario.policy.type)}==='workspaceWrite'?{writableRoots:${scenario.dropRoots ? `[${JSON.stringify(extra)}]` : scenario.extraRoot ? `[...f.params.config.sandbox_workspace_write.writable_roots,'/unexpected']` : 'f.params.config.sandbox_workspace_write.writable_roots'}}:{})},approvalPolicy:${JSON.stringify(scenario.approval ?? 'on-request')},approvalsReviewer:'user'}});} if(f.method==='turn/start'){ require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({turn:f.params,config:startConfig}),{mode:384}); emit({id:f.id,result:{turn:{id:'u'}}}); emit({method:'turn/completed',params:{threadId:'t',turn:{id:'u',status:'completed',items:[{type:'agentMessage',text:'okay'}]}}}); }});rl.on('close',()=>process.exit(0));`;
  let session: Awaited<ReturnType<typeof createParentAgent>> | undefined;
  let launched: readonly string[] | undefined;
  try {
    const starting = createParentAgent({ engineKind: 'codex', model: 'fixture', effort: 'low', workspace: dir, additionalWorkspaces: [extra], instructions: 'fixture' }, { launch: (command, workspace) => { launched = [...command]; return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] }); } });
    // Prove the executable/discovery vs launcher boundary: the adapter passes the
    // owned fake path as argv[0] (plus fixed app-server args), while the test
    // launch itself only starts absolute Node running the synthetic RPC script.
    assert.ok(launched, 'custom launch must observe the adapter command');
    assert.equal(launched[0], fakeCodex);
    assert.deepEqual(launched.slice(1, 4), ['app-server', '--listen', 'stdio://']);
    assert.notEqual(launched[0], process.execPath);
    if (scenario.invalid) { await assert.rejects(starting, scenario.extraRoot ? /unexpected writable root/ : /effective|permissions/); return; }
    session = await starting;
    assert.equal(await session.send('test'), 'okay');
    const params = JSON.parse(readFileSync(marker, 'utf8'));
    if (scenario.mode === 'workspace-write') {
      assert.deepEqual(params.turn.sandboxPolicy, { ...workspacePolicy, writableRoots: ['/kept', extra] });
      assert.deepEqual(params.config.sandbox_workspace_write, { ...section, writable_roots: ['/kept', extra] });
    } else { assert.equal(params.turn.sandboxPolicy, undefined); assert.equal(params.config.sandbox_workspace_write, undefined); }
    assert.equal(params.turn.approvalPolicy, undefined);
  } finally { await session?.close(); process.env.PATH = previousPath; rmSync(dir, { recursive: true, force: true }); }
});

test('additional workspace validation rejects aliases before launch', () => {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'perm-'));
  try {
    assert.throws(() => prepareParentAgentInput({ engineKind: 'claude', model: 'fixture', effort: 'low', workspace: dir, additionalWorkspaces: [dir], instructions: 'fixture' }), /distinct existing/);
  } finally { rmSync(dir, { recursive: true }); }
});
