import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, TaskStatus } from '../../src/shared/contracts/tasks';
import { TaskStore } from '../../src/main/store';
import {
  formatStoreStatus,
  formatTaskOverview,
  resolveTaskOverview,
  type RootTaskOverview,
  type TaskOverview,
} from '../../src/main/im/task-status';

const NOW = Date.parse('2026-10-23T00:00:00.000Z');

function overview(roots: RootTaskOverview[]): TaskOverview {
  return { generatedAt: new Date(NOW).toISOString(), staleAfterSeconds: 900, roots };
}

function reportedRoot(overrides: Partial<RootTaskOverview> = {}): RootTaskOverview {
  return {
    id: 'root-1',
    title: '修复登录 flake',
    ownerId: 'owner-a',
    status: 'running',
    progress: 40,
    ownerReport: {
      summary: '已复现并定位到竞态，补丁验证中',
      percent: 42,
      phase: '验证',
      blockers: ['等待 code review'],
      nextSteps: ['合入补丁'],
      reportedAt: new Date(NOW - 3 * 60_000).toISOString(),
    },
    reportAgeSeconds: 180,
    reportStale: false,
    childCounts: { total: 3, queued: 1, running: 1, cancelling: 0, completed: 1, failed: 0, cancelled: 0 },
    lastError: null,
    ...overrides,
  };
}

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    title: partial.title ?? 'task',
    instruction: 'do work',
    owner: { name: 'owner', transport: 'herdr-visible', session: 's', pane: '1' },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    status: 'running',
    progress: 0,
    events: [],
    artifacts: [],
    ...partial,
  } as Task;
}

function fakeStore(heads: Task[]): TaskStore {
  // Reads the live array on every call so a test can mutate it between reads
  // (this models the committed store: each Bot status read sees fresh state).
  const summaries = () =>
    heads.map(head => ({
      ...head,
      events: head.events.slice(-3),
      eventCount: head.events.length,
      artifacts: [],
    }));
  return {
    listSummariesCommitted: (statuses?: readonly TaskStatus[]) => {
      const all = summaries();
      return statuses ? all.filter(item => statuses.includes(item.status)) : all;
    },
    listHeadsCommitted: () =>
      heads.map(({ events, artifacts, ...head }) => ({ ...head, events: [], artifacts: [] })),
    getCommitted: (id: string) => {
      const found = heads.find(head => head.id === id);
      if (!found) throw new Error('Task not found');
      return structuredClone(found);
    },
  } as unknown as TaskStore;
}

test('空运行 root 用中文说明，不向 Bot 用户展示实现命令', () => {
  const text = formatTaskOverview(overview([]));
  assert.match(text, /当前没有正在运行的根任务/);
  assert.match(text, /直接告诉我要处理的项目和目标/);
  assert.ok(!text.includes('tasks.create'), 'empty state must not show implementation commands');
  assert.ok(!text.includes('tasks.start'), 'empty state must not show implementation commands');
});

test('多 root 多 owner 显示上报进度阶段摘要阻塞者新鲜度与子任务计数', () => {
  const stale: RootTaskOverview = {
    ...reportedRoot({
      id: 'root-2',
      title: '接入飞书推送',
      ownerId: 'owner-b',
      ownerReport: {
        summary: '通道已通，等待联调',
        percent: 70,
        phase: '联调',
        blockers: ['等用户确认 AppId', '等网络白名单'],
        nextSteps: [],
        reportedAt: new Date(NOW - 20 * 60_000).toISOString(),
      },
      reportAgeSeconds: 1200,
      reportStale: true,
      childCounts: { total: 2, queued: 0, running: 2, cancelling: 0, completed: 0, failed: 0, cancelled: 0 },
    }),
  };
  const text = formatTaskOverview(overview([reportedRoot(), stale]));
  assert.match(text, /运行中的根任务共 2 项（2 个 owner）/);
  assert.match(text, /修复登录 flake/);
  assert.match(text, /上报进度 42%/);
  assert.match(text, /阶段 验证/);
  assert.match(text, /已复现并定位到竞态/);
  assert.match(text, /状态 running · 上报进度 42% · 阶段 验证/);
  assert.match(text, /阻塞：等待 code review/);
  assert.match(text, /上报于 10-23 07:57（3 分钟前，新鲜）/);
  assert.match(text, /子任务 共3（排队1\/运行1\/取消中0\/完成1\/失败0\/已取消0）/);
  assert.match(text, /接入飞书推送/);
  assert.match(text, /上报于 10-23 07:40（20 分钟前，已过期，需重新上报）/);
  assert.match(text, /阻塞：等用户确认 AppId；等网络白名单/);
});

test('未上报 root 显示尚未上报与 root 进度最近错误与计数，不编造上报百分比', () => {
  const text = formatTaskOverview(
    overview([
      reportedRoot({
        ownerReport: null,
        reportAgeSeconds: null,
        reportStale: false,
        progress: 10,
        lastError: 'worker 启动失败：配额不足',
      }),
    ]),
  );
  assert.match(text, /尚未上报/);
  assert.match(text, /任务进度 10%/);
  assert.match(text, /最近错误：worker 启动失败：配额不足/);
  assert.ok(!text.includes('上报进度'), 'unreported roots must not show a report percent');
});

test('省略的 percent 与 phase 不占位', () => {
  const text = formatTaskOverview(
    overview([
      reportedRoot({
        ownerReport: {
          summary: '只写了摘要',
          percent: null,
          phase: null,
          blockers: [],
          nextSteps: [],
          reportedAt: new Date(NOW - 10_000).toISOString(),
        },
        reportAgeSeconds: 10,
      }),
    ]),
  );
  assert.ok(!text.includes('上报进度'), 'null percent must be omitted');
  assert.ok(!text.includes('阶段'), 'null phase must be omitted');
  assert.ok(!text.includes('阻塞'), 'empty blockers must be omitted');
  assert.match(text, /摘要：只写了摘要/);
  assert.match(text, /上报于 10-23 07:59（刚刚，新鲜）/);
});

test('上报时间不可解析时显示未知，不冒充新鲜', () => {
  const text = formatTaskOverview(
    overview([
      reportedRoot({
        ownerReport: {
          summary: '时间异常',
          percent: null,
          phase: null,
          blockers: [],
          nextSteps: [],
          reportedAt: 'not-a-date',
        },
        reportAgeSeconds: null,
        reportStale: false,
      }),
    ]),
  );
  assert.match(text, /上报时间未知（新鲜度未知）/);
  assert.ok(!text.includes('（新鲜）'), 'unknown age must not claim freshness');
});

test('摘要与阻塞中的凭据被脱敏，不泄漏原文', () => {
  const secret = 'secret-value-abc123';
  const text = formatTaskOverview(
    overview([
      reportedRoot({
        ownerReport: {
          summary: `使用 token=${secret} 继续`,
          percent: 50,
          phase: null,
          blockers: [`password=${secret}`],
          nextSteps: [],
          reportedAt: new Date(NOW - 30_000).toISOString(),
        },
      }),
    ]),
  );
  assert.ok(!text.includes(secret), 'secret value must not appear in status text');
  assert.match(text, /\[REDACTED\]/);
});

test('12 与 20 个运行 root 全部出现标题、摘要、阻塞与新鲜度，不做整体截断', () => {
  for (const count of [12, 20]) {
    const roots = Array.from({ length: count }, (_, index) =>
      reportedRoot({
        id: `root-${count}-${index}`,
        title: `任务 ${count}-${index} ${'标题'.repeat(40)}`,
        ownerReport: {
          summary: `摘要 ${count}-${index} ${'长摘要'.repeat(80)}`,
          percent: 50,
          phase: '验证',
          blockers: [`阻塞 ${count}-${index} ${'阻塞详情'.repeat(40)}`],
          nextSteps: [],
          reportedAt: new Date(NOW - (index + 1) * 60_000).toISOString(),
        },
        reportAgeSeconds: (index + 1) * 60,
      }),
    );
    const text = formatTaskOverview(overview(roots));
    for (let index = 0; index < count; index++) {
      assert.ok(text.includes(`任务 ${count}-${index}`), `root ${count}-${index} title must appear`);
      assert.ok(text.includes(`摘要 ${count}-${index}`), `root ${count}-${index} summary must appear`);
      assert.ok(text.includes(`阻塞 ${count}-${index}`), `root ${count}-${index} blocker must appear`);
    }
    assert.equal((text.match(/，新鲜）/g) ?? []).length, count, 'every root shows freshness');
    assert.ok(!text.includes('内容过长已截断'), 'no overall truncation may hide later roots');
  }
});

test('文本被清洗与单字段截断：控制字符折叠超长字段截断', () => {
  const text = formatTaskOverview(
    overview([
      reportedRoot({
        title: `  多   空格\t标题\u0007${'标'.repeat(100)}`,
        ownerReport: {
          summary: `首行\n第二行${'很长'.repeat(200)}`,
          percent: 5,
          phase: '  阶\n段 ',
          blockers: [`阻塞一\n换行\u0000${'x'.repeat(300)}`, '阻塞二', '阻塞三', '阻塞四'],
          nextSteps: [],
          reportedAt: new Date(NOW - 5_000).toISOString(),
        },
      }),
    ]),
  );
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text), 'no control chars leak into status text');
  assert.match(text, /摘要：首行 第二行/, 'summary stays on one line');
  assert.match(text, /阻塞：[^；]*；[^；]*；[^；]*；等共4项/);
  assert.ok(!text.includes('x'.repeat(200)), 'oversized blocker is truncated per field');
});

test('resolver：只收运行中的 owner root，子任务按状态计数，不展开子任务详情', () => {
  const root = task({
    id: 'r1', title: 'Root One', status: 'running', executionRole: 'owner', ownerId: 'o1', progress: 30,
  });
  const queuedRoot = task({ id: 'r2', title: 'Queued Root', status: 'queued', executionRole: 'owner', ownerId: 'o2' });
  const plain = task({ id: 'r3', title: 'Not Owner', status: 'running', ownerId: 'o3' });
  const childTitle = 'Child Detail Must Not Leak';
  const heads = [
    root,
    queuedRoot,
    plain,
    task({ id: 'c1', title: childTitle, status: 'running', parentTaskId: 'r1' }),
    task({ id: 'c2', title: 'c2', status: 'queued', parentTaskId: 'r1' }),
    task({ id: 'c3', title: 'c3', status: 'failed', parentTaskId: 'r1' }),
    task({ id: 'c4', title: 'other child', status: 'completed', parentTaskId: 'r2' }),
  ];
  const store = fakeStore(heads);
  const found = resolveTaskOverview(store, { now: NOW });
  assert.equal(found.roots.length, 1);
  assert.equal(found.roots[0]!.id, 'r1');
  assert.deepEqual(found.roots[0]!.childCounts, {
    total: 3, queued: 1, running: 1, cancelling: 0, completed: 0, failed: 1, cancelled: 0,
  });
  assert.equal(found.roots[0]!.ownerReport, null);
  assert.equal(found.roots[0]!.reportStale, false);
  const text = formatStoreStatus(store, { now: NOW });
  assert.match(text, /运行中的根任务共 1 项/);
  assert.ok(!text.includes(childTitle), 'child detail must never appear in status text');
  assert.ok(!text.includes('Queued Root'), 'non-running roots are excluded');
});

test('resolver：上报年龄与过期阈值及 lastError 来源', () => {
  const fresh = task({
    id: 'r1', title: 'Fresh', status: 'running', executionRole: 'owner', ownerId: 'o1', progress: 50,
    failure: { kind: 'other', message: 'ignored when a report exists' },
    ownerReport: {
      summary: '进展顺利',
      percent: null,
      phase: null,
      blockers: [],
      nextSteps: [],
      reportedAt: new Date(NOW - 899_000).toISOString(),
    },
  });
  const stale = task({
    id: 'r2', title: 'Stale', status: 'running', executionRole: 'owner', ownerId: 'o2', progress: 60,
    ownerReport: {
      summary: '很久没上报',
      percent: 90,
      phase: null,
      blockers: [],
      nextSteps: [],
      reportedAt: new Date(NOW - 900_000).toISOString(),
    },
  });
  const broken = task({
    id: 'r3', title: 'Broken', status: 'running', executionRole: 'owner', progress: 5,
    failure: { kind: 'quota', message: '额度耗尽' },
  });
  const store = fakeStore([fresh, stale, broken]);
  const found = resolveTaskOverview(store, { now: NOW });
  assert.equal(found.roots[0]!.reportStale, false);
  assert.equal(found.roots[0]!.reportAgeSeconds, 899);
  assert.equal(found.roots[1]!.reportStale, true);
  const text = formatStoreStatus(store, { now: NOW });
  assert.match(text, /额度耗尽/);
});

test('状态回调每次重建：第二次上报与变 stale 立即可见，不走缓存', () => {
  const heads: Task[] = [task({ id: 'r1', title: 'Root', status: 'running', executionRole: 'owner', ownerId: 'o1', progress: 10 })];
  const store = fakeStore(heads);
  const first = formatStoreStatus(store, { now: NOW });
  assert.match(first, /尚未上报/);
  const reported = task({
    id: 'r1', title: 'Root', status: 'running', executionRole: 'owner', ownerId: 'o1', progress: 55,
    ownerReport: {
      summary: '第二轮已上报',
      percent: 55,
      phase: '收尾',
      blockers: [],
      nextSteps: [],
      reportedAt: new Date(NOW).toISOString(),
    },
  });
  heads[0] = reported;
  const second = formatStoreStatus(store, { now: NOW + 901_000 });
  assert.match(second, /第二轮已上报/);
  assert.match(second, /已过期，需重新上报/);
  assert.ok(!second.includes('尚未上报'), 'fresh reads must replace the previous text');
});

test('真实库只有 running standalone 非 owner 任务时 overview roots 为空且文本仅声称无根任务', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-im-task-status-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  try {
    const standalone = task({
      id: 'standalone-worker-1',
      title: 'Synthetic standalone worker',
      status: 'running',
      progress: 30,
    });
    store.put(standalone);
    // 库内确实只有这个 running 的非 owner 根任务：无 executionRole、无 parentTaskId。
    const stored = store.get(standalone.id);
    assert.equal(stored.status, 'running');
    assert.equal(stored.executionRole, undefined);
    assert.equal(stored.parentTaskId, undefined);
    assert.equal(store.listHeadsCommitted().length, 1, 'the database holds only this standalone worker');
    const found = resolveTaskOverview(store, { now: NOW });
    assert.equal(found.roots.length, 0);
    const text = formatStoreStatus(store, { now: NOW });
    assert.equal(text, '当前没有正在运行的根任务。需要开始新工作时，直接告诉我要处理的项目和目标即可。');
    assert.ok(!text.includes('运行中的根任务共'), 'empty state must not claim any running roots');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
