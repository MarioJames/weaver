import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import { input } from '../../src/main/schedules/input';

const ROOT = process.env.ACCEPTANCE_TMPDIR ?? tmpdir();
mkdirSync(ROOT, { recursive: true });

function setup() {
  const dir = mkdtempSync(join(ROOT, 'schedules-input-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const policy = new PolicyStore(store.db);
  return {
    dir,
    store,
    policy,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function save(policy: PolicyStore, mutate: (snapshot: ReturnType<PolicyStore['snapshot']>) => void) {
  const snapshot = policy.snapshot();
  mutate(snapshot);
  policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: snapshot.blocks }, { allowEngineEnable: true });
}

function agent(value: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { name: 'fixture', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: value, ...extra };
}

const goal = { goal: '整理项目文档' };

test('executor role selects the matching policy section, including a shared owner/worker id', () => {
  const f = setup();
  try {
    assert.deepEqual(input(agent({ ...goal, executor: { role: 'owner', profileId: 'codex_owner' } }), f.policy).agent, {
      goal: '整理项目文档', executor: { role: 'owner', profileId: 'codex_owner' },
    });
    assert.equal(input(agent({ ...goal, executor: { role: 'worker', profileId: 'claude_worker' } }), f.policy).agent?.executor.role, 'worker');
    assert.throws(() => input(agent({ ...goal, executor: { role: 'owner', profileId: 'claude_worker' } }), f.policy), /available owner profile/);
    assert.throws(() => input(agent({ ...goal, executor: { role: 'worker', profileId: 'codex_owner' } }), f.policy), /available worker profile/);

    save(f.policy, snapshot => {
      snapshot.config.workers.codex_owner = { enabled: true, channels:["default_claude"], model: 'sonnet', effort: 'high' };
    });
    const sameIdOwner = { ...goal, executor: { role: 'owner', profileId: 'codex_owner' } };
    const sameIdWorker = { ...goal, executor: { role: 'worker', profileId: 'codex_owner' } };
    assert.equal(input(agent(sameIdOwner), f.policy).agent?.executor.role, 'owner');
    assert.equal(input(agent(sameIdWorker), f.policy).agent?.executor.role, 'worker');

    save(f.policy, snapshot => { snapshot.config.workers.codex_owner.enabled = false; });
    assert.equal(input(agent(sameIdOwner), f.policy).agent?.executor.role, 'owner');
    assert.throws(() => input(agent(sameIdWorker), f.policy), /available worker profile: codex_owner/);

    save(f.policy, snapshot => {
      snapshot.config.workers.codex_owner.enabled = true;
      snapshot.blocks.push({ engine: 'claude', worker: 'codex_owner', reason: 'fixture block', since: new Date().toISOString() });
    });
    assert.equal(input(agent(sameIdOwner), f.policy).agent?.executor.role, 'owner');
    assert.throws(() => input(agent(sameIdWorker), f.policy), /available worker profile: codex_owner/);

    save(f.policy, snapshot => {
      snapshot.blocks.push({ engine: 'codex', reason: 'fixture block', since: new Date().toISOString() });
    });
    assert.throws(() => input(agent(sameIdOwner), f.policy), /available owner profile: codex_owner/);
    assert.throws(() => input(agent(sameIdWorker), f.policy), /available worker profile: codex_owner/);
  } finally {
    f.close();
  }
});

test('available profiles on any enabled engine are accepted without the old claude/codex gate', () => {
  const f = setup();
  try {
    save(f.policy, snapshot => {
      snapshot.config.engines.opencode.enabled = true;
      snapshot.config.workers.opencode_worker.enabled = true;
      snapshot.config.owners.opencode_owner = {
        enabled: true, channel: "default_opencode", model: 'opencode/glm-5.3-flash-free', effort: 'max',
        workers: ['opencode_worker'], max_parallel: 1,
      };
    });
    assert.equal(input(agent({ ...goal, executor: { role: 'owner', profileId: 'opencode_owner' } }), f.policy).agent?.executor.profileId, 'opencode_owner');
    assert.equal(input(agent({ ...goal, executor: { role: 'worker', profileId: 'opencode_worker' } }), f.policy).agent?.executor.profileId, 'opencode_worker');
  } finally {
    f.close();
  }
});

test('agent input is exactly goal plus executor; removed fields and model overrides are rejected', () => {
  const f = setup();
  try {
    assert.throws(() => input(agent({ ...goal, ownerProfileId: 'codex_owner' }), f.policy), /Unexpected schedule field/);
    assert.throws(() => input(agent({ ...goal, executor: { role: 'owner', profileId: 'codex_owner' }, acceptanceCriteria: ['x'] }), f.policy), /Unexpected schedule field/);
    assert.throws(() => input(agent({ ...goal, executor: { role: 'owner', profileId: 'codex_owner' }, model: 'override' }), f.policy), /Unexpected schedule field/);
    assert.throws(() => input(agent({ ...goal, executor: { role: 'owner', profileId: 'codex_owner', effort: 'low' } }), f.policy), /Unexpected schedule field/);
    assert.throws(() => input(agent({ ...goal, executor: { role: 'parent', profileId: 'codex_owner' } }), f.policy), /role must be owner or worker/);
    assert.throws(() => input(agent({ ...goal, executor: { role: 'owner' } }), f.policy), /profileId/);
    assert.throws(() => input(agent({ ...goal, executor: { role: 'worker', profileId: 'missing' } }), f.policy), /available worker profile: missing/);
  } finally {
    f.close();
  }
});

test('goal must be substantively non-empty and bounded', () => {
  const f = setup();
  try {
    const executor = { role: 'owner', profileId: 'codex_owner' };
    for (const value of ['', '   ', '\n\t']) {
      assert.throws(() => input(agent({ goal: value, executor }), f.policy), /Invalid goal/);
    }
    assert.throws(() => input(agent({ goal: 'g'.repeat(16001), executor }), f.policy), /Invalid goal/);
    assert.equal(input(agent({ goal: 'g'.repeat(16000), executor }), f.policy).agent?.goal.length, 16000);
  } finally {
    f.close();
  }
});

test('workspace is optional, blank clears to undefined, and explicit paths keep the real-directory boundary', () => {
  const f = setup();
  try {
    const executor = { role: 'owner', profileId: 'codex_owner' };
    for (const workspace of [undefined, '', '   ']) {
      const parsed = input(agent({ ...goal, executor }, workspace === undefined ? {} : { workspace }), f.policy);
      assert.equal(parsed.workspace, undefined);
    }
    assert.throws(() => input(agent({ ...goal, executor }, { workspace: null }), f.policy), /workspace must be a string/);
    assert.throws(() => input(agent({ ...goal, executor }, { workspace: 42 }), f.policy), /workspace must be a string/);
    assert.throws(() => input(agent({ ...goal, executor }, { workspace: 'relative/path' }), f.policy), /absolute project directory/);
    assert.throws(() => input(agent({ ...goal, executor }, { workspace: join(f.dir, 'missing') }), f.policy), /Workspace does not exist/);
    assert.throws(() => input(agent({ ...goal, executor }, { workspace: ` ${f.dir} ` }), f.policy), /absolute project directory/);
    assert.equal(input(agent({ ...goal, executor }, { workspace: f.dir }), f.policy).workspace, realpathSync(f.dir));
  } finally {
    f.close();
  }
});

test('script schedules still require a command and timeout and keep blank workspace optional', () => {
  const f = setup();
  try {
    const base = { name: 'script fixture', kind: 'script', timing: { mode: 'interval', seconds: 60 } };
    const parsed = input({ ...base, script: { command: 'printf hello', timeoutSeconds: 30 } }, f.policy);
    assert.equal(parsed.kind, 'script');
    assert.equal(parsed.workspace, undefined);
    assert.equal(parsed.script?.command, 'printf hello');
    assert.throws(() => input(base, f.policy), /Expected an object/);
    assert.throws(() => input({ ...base, script: { command: '   ', timeoutSeconds: 30 } }, f.policy), /Invalid command/);
    assert.throws(() => input({ ...base, script: { command: 'true', timeoutSeconds: 0 } }, f.policy), /timeoutSeconds must be an integer/);
    assert.throws(() => input({ ...base, script: { command: 'true', timeoutSeconds: 86401 } }, f.policy), /timeoutSeconds must be an integer/);
  } finally {
    f.close();
  }
});
