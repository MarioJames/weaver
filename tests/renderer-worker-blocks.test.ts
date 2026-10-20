import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { availabilityOf, coveringBlock, defaultConfig, type Block } from '../src/main/policy/routing';
import { workerStatusTag } from '../src/renderer/components/OwnerSchedule';
import { BlockList, removeBlock } from '../src/renderer/pages/EnginesPage';
import { roleNote } from '../src/renderer/pages/RolesPage';
import { VENDOR_BLOCK_BY, blockOf } from '../src/renderer/probe-view';

const FUTURE = '2999-01-01T00:00:00.000Z';
const NOW = Date.now();
function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) }));
}

function twins() {
  const config = defaultConfig();
  config.engines.opencode!.enabled = true;
  config.workers.opencode_worker!.enabled = true;
  config.workers.opencode_twin = { ...config.workers.opencode_worker!, enabled: true };
  config.owners.opencode_owner = { ...config.owners.codex_owner!, engine: 'opencode', enabled: true, workers: ['opencode_worker', 'opencode_twin'] };
  return config;
}
const workerBlock = (worker: string, extra: Partial<Block> = {}): Block => ({ engine: 'opencode', worker, reason: '限流：Rate limit exceeded', since: '2026-10-19T00:00:00Z', by: VENDOR_BLOCK_BY, release_at: FUTURE, ...extra });
const engineBlock = (extra: Partial<Block> = {}): Block => ({ engine: 'opencode', reason: '该引擎全部子 Agent 均被限流/额度耗尽', since: '2026-10-19T00:00:00Z', by: VENDOR_BLOCK_BY, release_at: FUTURE, ...extra });

test('a worker block reaches only the worker it names, never a sibling or the owner', () => {
  const config = twins();
  const blocks = [workerBlock('opencode_worker')];
  const worker = config.workers.opencode_worker!;
  const twin = config.workers.opencode_twin!;
  assert.equal(blockOf(config, blocks, worker, NOW, 'opencode_worker'), blocks[0]);
  assert.equal(blockOf(config, blocks, twin, NOW, 'opencode_twin'), undefined);
  assert.equal(blockOf(config, blocks, config.owners.opencode_owner!, NOW), undefined);
  // Same answer as the router, so the tag and the dispatch never disagree.
  for (const [entity, id] of [[worker, 'opencode_worker'], [twin, 'opencode_twin'], [config.owners.opencode_owner!, undefined]] as const) {
    assert.equal(blockOf(config, blocks, entity, NOW, id) !== undefined, availabilityOf(config, blocks, entity, id).status === 'blocked');
    assert.equal(blockOf(config, blocks, entity, NOW, id), coveringBlock(blocks, entity, id));
  }
  // Without the worker id a worker block cannot match, as in routing.ts.
  assert.equal(blockOf(config, blocks, worker, NOW), undefined);
});

test('a whole-engine block covers every role of the engine, and an expired block covers none', () => {
  const config = twins();
  const blocks = [engineBlock()];
  assert.ok(blockOf(config, blocks, config.workers.opencode_worker!, NOW, 'opencode_worker'));
  assert.ok(blockOf(config, blocks, config.workers.opencode_twin!, NOW, 'opencode_twin'));
  assert.ok(blockOf(config, blocks, config.owners.opencode_owner!, NOW));
  assert.equal(blockOf(config, [engineBlock({ release_at: '2000-01-01T00:00:00Z' })], config.workers.opencode_worker!, NOW, 'opencode_worker'), undefined);
});

test('parent weight rows show a worker-level ban on that worker only', () => {
  const config = twins();
  const blocks = [workerBlock('opencode_worker')];
  const tag = workerStatusTag(config, blocks, 'opencode_worker', 5)!;
  assert.equal(tag.label, '暂时不可用');
  assert.match(tag.reason!, /Rate limit exceeded，.* 恢复/);
  assert.equal(workerStatusTag(config, blocks, 'opencode_twin', 5), undefined);
});

test('the sub-agent list tags the banned worker and leaves its sibling plain', () => {
  const config = twins();
  const blocks = [workerBlock('opencode_worker')];
  const banned = blockOf(config, blocks, config.workers.opencode_worker!, NOW, 'opencode_worker');
  const note = roleNote({ status: 'blocked', engine: 'opencode', worker: 'opencode_worker', reason: blocks[0]!.reason, release_at: FUTURE }, false, banned);
  assert.equal(note?.tag?.label, '暂时不可用');
  assert.match(note!.text, /Rate limit exceeded，.* 恢复/);
  const sibling = blockOf(config, blocks, config.workers.opencode_twin!, NOW, 'opencode_twin');
  assert.equal(roleNote({ status: 'available' }, false, sibling), undefined);
});

test('engine card lists each worker ban by name next to the whole-engine escalation', () => {
  const blocks = [workerBlock('opencode_worker'), workerBlock('opencode_twin'), engineBlock()];
  const html = markup(React.createElement(BlockList, { blocks, now: NOW, disabled: false, onRemove: () => {} }));
  assert.equal((html.match(/data-engine-block="/g) ?? []).length, 3, 'worker blocks are not merged away');
  assert.match(html, /opencode_worker · /);
  assert.match(html, /opencode_twin · /);
  assert.match(html, /该引擎全部子 Agent 均被限流\/额度耗尽/);
});

test('resume dispatch removes exactly the block with the same engine, model and worker', () => {
  const a = workerBlock('opencode_worker');
  const b = workerBlock('opencode_twin');
  const whole = engineBlock();
  const modelOnly = engineBlock({ model: 'm1', by: 'manual' });
  const all = [a, b, whole, modelOnly];
  assert.deepEqual(removeBlock(all, a), [b, whole, modelOnly]);
  assert.deepEqual(removeBlock(all, whole), [a, b, modelOnly]);
  assert.deepEqual(removeBlock(all, modelOnly), [a, b, whole]);
});
