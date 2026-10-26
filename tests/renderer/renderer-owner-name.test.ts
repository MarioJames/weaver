import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '../../src/shared/contracts/tasks';
import {
  ownerDisplayName, ownerHostLabel,
} from '../../src/renderer/features/tasks/task-view';

const owner = { name: 'Claude · weaver · 21:30', transport: 'herdr-visible' as const, session: 's', pane: 'p' };
const describedOwner = { ...owner, title: '夜间值守' } as unknown as Task['owner'];

const make = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `任务 ${id}`, instruction: 'goal', owner, status: 'completed', progress: 100,
  createdAt: '2026-10-26T21:30:00Z', updatedAt: '2026-10-26T21:35:00Z', events: [], artifacts: [], ...extra,
});

test('a child of a web root is named by the root task title first', () => {
  const root = make('root', { title: '迁移构建脚本', executionRole: 'owner', owner: describedOwner });
  const child = make('child', { parentTaskId: 'root', owner: describedOwner });
  assert.equal(ownerDisplayName(child, [root, child]), '迁移构建脚本');
  assert.equal(ownerDisplayName(root, [root]), '迁移构建脚本');
});

test('without a root title the instance title wins over the host clock', () => {
  const task = make('t', { ownerId: 'inst-1', owner: describedOwner, dispatch: { owner: 'claude_owner', worker: 'w', engine: 'claude', model: 'm', effort: 'high', execution: 'real', maxParallel: 1 } });
  assert.equal(ownerDisplayName(task), '夜间值守');
});

test('the last fallback is host and HH:mm, never the workspace directory in the machine name', () => {
  const task = make('t');
  assert.equal(ownerDisplayName(task), 'Claude · 21:30');
  assert.doesNotMatch(ownerDisplayName(task), /weaver/);
  assert.match(ownerHostLabel({ name: '', provider: 'codex', createdAt: '2026-10-26T21:30:00Z' }), /^codex · \d\d:\d\d$/);
  assert.match(ownerHostLabel({ name: 'Codex · 后端 CLI 接续', createdAt: '2026-10-26T08:05:00Z' }), /^Codex · \d\d:\d\d$/);
});
