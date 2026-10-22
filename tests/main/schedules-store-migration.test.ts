import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import { input } from '../../src/main/schedules/input';
import { ScheduleStore, type StoredRun } from '../../src/main/schedules/store';

const ROOT = process.env.ACCEPTANCE_TMPDIR ?? tmpdir();
const AT = '2030-01-01T00:00:00.000Z';
mkdirSync(ROOT, { recursive: true });

function setup() {
  const dir = mkdtempSync(join(ROOT, 'schedules-migration-'));
  const path = join(dir, 'weaver.db');
  return {
    dir,
    path,
    open: () => new TaskStore(path),
    close(dirPath = dir) {
      rmSync(dirPath, { recursive: true, force: true });
    },
  };
}

type Definition = Record<string, unknown>;

function legacyDefinition(id: string, goal: string, criteria?: unknown, constraints?: unknown): Definition {
  const agent: Record<string, unknown> = { goal, ownerProfileId: 'codex_owner' };
  if (criteria !== undefined) agent.acceptanceCriteria = criteria;
  if (constraints !== undefined) agent.constraints = constraints;
  return {
    id,
    name: `旧任务 ${id}`,
    kind: 'agent',
    enabled: true,
    timing: { mode: 'interval', seconds: 300 },
    revision: 7,
    createdAt: AT,
    updatedAt: AT,
    nextRunAt: '2030-01-01T00:05:00.000Z',
    lastRunAt: AT,
    agent,
  };
}

function readRaw(store: TaskStore, key: string) {
  return JSON.stringify(store.getValue<unknown>(key));
}

test('legacy definitions upgrade once to executor, preserving every requirement and leaving runs, timing and claims untouched', () => {
  const f = setup();
  let store = f.open();
  try {
    const withContext = legacyDefinition('legacy-context', '原始目标：整理 docs 与代码差异', ['核对所有链接', '列出未覆盖的接口'], ['不要改动生产配置', '  ', '保留原始文件']);
    const activeDefinition = {
      ...withContext,
      activeRunId: 'run-1',
      lastRun: {
        id: 'run-1', scheduleId: withContext.id, trigger: 'manual', status: 'running',
        startedAt: AT, finishedAt: null, output: '历史输出', taskId: 'task-1',
      },
    };
    const plain = legacyDefinition('legacy-plain', '只保留原始目标');
    const builtin = {
      id: 'builtin', name: '额度刷新', kind: 'script', builtin: 'quota.refresh', enabled: true,
      timing: { mode: 'interval', seconds: 900 }, revision: 2, createdAt: AT, updatedAt: AT,
      nextRunAt: '2030-01-01T00:15:00.000Z', lastRunAt: null,
    };
    const current = {
      id: 'current', name: '新任务', kind: 'agent', enabled: false,
      timing: { mode: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' }, revision: 3,
      createdAt: AT, updatedAt: AT, nextRunAt: null, lastRunAt: null,
      agent: { goal: '新目标', executor: { role: 'worker', profileId: 'claude_worker' } },
    };
    const historicalRun: StoredRun = {
      id: 'run-1', scheduleId: String(withContext.id), trigger: 'manual', status: 'running',
      startedAt: AT, finishedAt: null, output: '历史输出', taskId: 'task-1', outputSlot: 2,
      process: { unit: 'weaver-schedule-run-1', invocation: 'invocation-1' },
      definition: structuredClone(activeDefinition) as never,
    };
    const rawRunsBefore = JSON.stringify([historicalRun]);
    store.putValue('schedules.v1', { definitions: [activeDefinition, plain, builtin, current] });
    store.putValue('schedules.runs.legacy-context', [historicalRun]);
    store.putValue('schedules.output.legacy-context.2', '完整的旧输出');

    const state = new ScheduleStore(store).read();
    assert.equal(state.definitions.length, 4);

    const migrated = state.definitions.find(definition => definition.id === 'legacy-context')!;
    const expectedGoal = [
      '原始目标：整理 docs 与代码差异',
      '验收标准：\n- 核对所有链接\n- 列出未覆盖的接口',
      '约束：\n- 不要改动生产配置\n- 保留原始文件',
    ].join('\n\n');
    assert.deepEqual(migrated.agent, { goal: expectedGoal, executor: { role: 'owner', profileId: 'codex_owner' } });
    assert.deepEqual(Object.keys(migrated.agent!).sort(), ['executor', 'goal']);
    assert.equal(migrated.name, '旧任务 legacy-context');
    assert.equal(migrated.enabled, true);
    assert.deepEqual(migrated.timing, { mode: 'interval', seconds: 300 });
    assert.equal(migrated.revision, 7);
    assert.equal(migrated.createdAt, AT);
    assert.equal(migrated.updatedAt, AT);
    assert.equal(migrated.nextRunAt, '2030-01-01T00:05:00.000Z');
    assert.equal(migrated.activeRunId, 'run-1');
    assert.deepEqual(migrated.lastRun, activeDefinition.lastRun);

    const unchanged = state.definitions.find(definition => definition.id === 'legacy-plain')!;
    assert.deepEqual(unchanged.agent, { goal: '只保留原始目标', executor: { role: 'owner', profileId: 'codex_owner' } });
    assert.equal(unchanged.nextRunAt, plain.nextRunAt);
    assert.deepEqual(state.definitions.find(definition => definition.id === 'builtin'), builtin);
    assert.deepEqual(state.definitions.find(definition => definition.id === 'current'), current);

    assert.deepEqual(state.runs['legacy-context'], [historicalRun]);
    assert.equal(readRaw(store, 'schedules.runs.legacy-context'), rawRunsBefore);
    assert.equal(store.getValue<string>('schedules.output.legacy-context.2'), '完整的旧输出');
    assert.equal(JSON.stringify(state.runs['legacy-context'][0].definition), JSON.stringify(activeDefinition), 'the frozen run definition is history and must not be rewritten');

    const firstUpgrade = readRaw(store, 'schedules.v1');
    assert.ok(firstUpgrade.includes('"executor"'));
    assert.ok(!firstUpgrade.includes('ownerProfileId'));

    // Reopen twice without clearing or reseeding: the migrated KV must stay byte-for-byte stable.
    store.close();
    store = new TaskStore(f.path);
    new ScheduleStore(store).read();
    const secondRead = readRaw(store, 'schedules.v1');
    assert.equal(secondRead, firstUpgrade);
    assert.equal(readRaw(store, 'schedules.runs.legacy-context'), rawRunsBefore);
    store.close();
    store = new TaskStore(f.path);
    new ScheduleStore(store).read();
    assert.equal(readRaw(store, 'schedules.v1'), secondRead);
    assert.equal(readRaw(store, 'schedules.runs.legacy-context'), rawRunsBefore);
  } finally {
    store.close();
    f.close();
  }
});

test('a large legacy prompt is stored in full; run/edit revalidation reports the existing budget error instead of truncating', () => {
  const f = setup();
  const store = f.open();
  try {
    const original = 'g'.repeat(15990);
    const criteria = ['a'.repeat(500), 'b'.repeat(500)];
    const constraints = ['c'.repeat(500)];
    const definition = legacyDefinition('legacy-large', original, criteria, constraints);
    store.putValue('schedules.v1', { definitions: [definition] });

    const migrated = new ScheduleStore(store).read().definitions[0];
    const expected = `${original}\n\n验收标准：\n- ${criteria[0]}\n- ${criteria[1]}\n\n约束：\n- ${constraints[0]}`;
    assert.equal(migrated.agent?.goal, expected);
    assert.ok(migrated.agent!.goal.length > 16000);
    assert.ok(migrated.agent!.goal.includes(criteria[0]));
    assert.ok(migrated.agent!.goal.includes(criteria[1]));
    assert.ok(migrated.agent!.goal.includes(constraints[0]));

    const policy = new PolicyStore(store.db);
    assert.throws(() => input({
      name: migrated.name,
      kind: 'agent',
      timing: migrated.timing,
      agent: migrated.agent,
    }, policy), /Invalid goal \(maximum 16000 characters\)/);
    assert.equal(JSON.parse(readRaw(store, 'schedules.v1')).definitions[0].agent.goal, expected, 'persistence keeps the full text even when the input budget rejects it');
  } finally {
    store.close();
    f.close();
  }
});

test('unknown, contradictory or corrupt definitions fail closed and leave the original KV untouched', () => {
  const f = setup();
  const store = f.open();
  try {
    const valid = legacyDefinition('valid', '合法旧任务');
    const run: StoredRun = {
      id: 'run-keep', scheduleId: 'valid', trigger: 'scheduled', status: 'succeeded',
      startedAt: AT, finishedAt: AT, output: 'keep me', outputSlot: 0,
      definition: structuredClone(valid) as never,
    };
    const cases: Array<[string, unknown, RegExp]> = [
      ['contradictory', { definitions: [valid, { ...legacyDefinition('mixed', 'x'), agent: { goal: 'x', ownerProfileId: 'codex_owner', executor: { role: 'owner', profileId: 'codex_owner' } } }] }, /mixes legacy ownerProfileId with executor/],
      ['unknown legacy field', { definitions: [{ ...legacyDefinition('unknown', 'x'), agent: { goal: 'x', ownerProfileId: 'codex_owner', model: 'm' } }] }, /unknown fields/],
      ['current with retired field', { definitions: [{ ...legacyDefinition('retired', 'x'), agent: { goal: 'x', executor: { role: 'owner', profileId: 'codex_owner' }, acceptanceCriteria: ['x'] } }] }, /unknown fields/],
      ['empty goal', { definitions: [{ ...legacyDefinition('empty', 'x'), agent: { goal: '   ', ownerProfileId: 'codex_owner' } }] }, /goal is empty/],
      ['agent with script', { definitions: [{ ...legacyDefinition('scripted-agent', 'x'), script: { command: 'true', timeoutSeconds: 10 } }] }, /also carries a script/],
      ['bad container', { definitions: 'not-an-array' }, /definitions container/],
      ['bad array', [], /definitions container/],
    ];
    for (const [label, value, pattern] of cases) {
      store.putValue('schedules.v1', value);
      store.putValue('schedules.runs.valid', [run]);
      const rawBefore = readRaw(store, 'schedules.v1');
      const runsBefore = readRaw(store, 'schedules.runs.valid');
      assert.throws(() => new ScheduleStore(store).read(), pattern, label);
      assert.equal(readRaw(store, 'schedules.v1'), rawBefore, `${label}: definitions must stay untouched`);
      assert.equal(readRaw(store, 'schedules.runs.valid'), runsBefore, `${label}: runs must stay untouched`);
    }
  } finally {
    store.close();
    f.close();
  }
});
