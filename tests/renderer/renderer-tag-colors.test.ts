import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfig } from '../../src/main/policy/routing';
import { FREE_PROBE_BLOCK_BY, STALL_BLOCK_BY } from '../../src/shared/policy/blocks';
import type { Block } from '../../src/shared/contracts/policy';
import { TAG_COLORS, TONE_TAG_COLORS, statusTagColor, tagColor } from '../../src/renderer/format/tag-colors';
import { workerStatusTag } from '../../src/renderer/features/roles/OwnerSchedule';
import { roleNote } from '../../src/renderer/features/roles/RolesPage';

test('every semantic maps to one distinct Tag color preset, never a raw color value', () => {
  const colors = Object.values(TAG_COLORS);
  assert.equal(new Set(colors).size, colors.length, 'two semantics sharing a color defeats the hierarchy');
  for (const color of colors) assert.match(color, /^[a-z]+$/, `not a Tag color preset: ${color}`);
  // The concrete hierarchy the scheme promises: state colors stay recognizable, identity and
  // billing channel get their own families.
  assert.equal(TAG_COLORS.neutral, 'gray');
  assert.equal(TAG_COLORS.inProgress, 'processing');
  assert.equal(TAG_COLORS.success, 'success');
  assert.equal(TAG_COLORS.warning, 'warning');
  assert.equal(TAG_COLORS.error, 'error');
  assert.equal(TAG_COLORS.needsChange, 'volcano');
  assert.equal(TAG_COLORS.stopping, 'orange');
  assert.equal(TAG_COLORS.ownerRole, 'purple');
  assert.equal(TAG_COLORS.childRole, 'geekblue');
  assert.equal(TAG_COLORS.freeChannel, 'cyan');
});

test('free channel and role identity colors are disjoint from every status color', () => {
  const statusColors = new Set(Object.values(TONE_TAG_COLORS));
  for (const semantic of ['freeChannel', 'ownerRole', 'childRole'] as const) {
    assert.equal(statusColors.has(TAG_COLORS[semantic]), false, `${semantic} collides with a status color`);
  }
  assert.notEqual(TAG_COLORS.ownerRole, TAG_COLORS.childRole, '父 Agent and 子任务 must not share a color');
});

test('task tones resolve through the same scheme, the plain tone keeps the Tag default', () => {
  assert.equal(statusTagColor('default'), undefined);
  assert.equal(statusTagColor('processing'), TAG_COLORS.inProgress);
  assert.equal(statusTagColor('warning'), TAG_COLORS.warning);
  assert.equal(statusTagColor('success'), TAG_COLORS.success);
  assert.equal(statusTagColor('error'), TAG_COLORS.error);
  assert.equal(statusTagColor('orange'), TAG_COLORS.stopping);
  assert.equal(statusTagColor('volcano'), TAG_COLORS.needsChange);
  assert.equal(tagColor('freeChannel'), 'cyan');
});

function schedule() {
  const config = defaultConfig();
  config.engines.qoder.enabled = true;
  config.engines.opencode.enabled = true;
  config.workers.qoder_worker.enabled = true;
  config.workers.opencode_worker.enabled = true;
  return config;
}
const blockFor = (worker: 'qoder_worker' | 'opencode_worker', by: string): Block => {
  const profile = schedule().workers[worker];
  return { engine: profile.engine, model: profile.model, reason: by === FREE_PROBE_BLOCK_BY ? '额度耗尽：免费额度已用完' : '探测失败：超时', since: '2026-10-19T00:00:00Z', by };
};

test('schedule status tags take their colors from the semantic scheme, not ad-hoc strings', () => {
  const config = schedule();
  assert.equal(workerStatusTag(config, [], 'gone_worker', 5)!.color, tagColor('error'));
  // 不派发 and the disabled locks stay deliberately plain so the free-channel tag stands out beside them.
  assert.equal(workerStatusTag(config, [], 'qoder_worker', 0)!.color, undefined);
  assert.equal(workerStatusTag(config, [], 'qoder_worker', 5), undefined);
  assert.equal(workerStatusTag(config, [blockFor('qoder_worker', FREE_PROBE_BLOCK_BY)], 'qoder_worker', 5)!.color, statusTagColor('orange'));
  assert.equal(workerStatusTag(config, [blockFor('opencode_worker', STALL_BLOCK_BY)], 'opencode_worker', 5)!.color, statusTagColor('warning'));
});

test('role note pause tags use the same semantic colors as the schedule', () => {
  const note = roleNote({ status: 'blocked' }, false, blockFor('qoder_worker', FREE_PROBE_BLOCK_BY));
  assert.equal(note?.tag?.label, '免费额度用完');
  assert.equal(note?.tag?.color, statusTagColor('orange'));
  const plain = roleNote({ status: 'blocked', reason: '手动暂停' }, false, blockFor('qoder_worker', 'manual'));
  assert.equal(plain?.tag, undefined);
  assert.equal(plain?.warning, true);
});
