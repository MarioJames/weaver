import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../../src/main/policy/routing';
import type { Block, Config, PolicySnapshot } from '../../src/shared/contracts/policy';
import { VENDOR_BLOCK_BY } from '../../src/shared/policy/blocks';
import { withWorkerParallel, workerParallelText } from '../../src/renderer/policy/policy-edit';
import { RolesPage } from '../../src/renderer/features/roles/RolesPage';
import { WorkerBlockNotice, WorkerParallelField } from '../../src/renderer/features/roles/RoleEditor';
import { OwnerScheduleFields } from '../../src/renderer/features/roles/OwnerSchedule';
import { tagColor } from '../../src/renderer/format/tag-colors';
import { Form, useForm } from '@lobehub/ui/form';
import type { PolicyDraft } from '../../src/renderer/policy/usePolicyDraft';

const FUTURE = '2999-01-01T00:00:00.000Z';
const NOW = Date.now();
const body = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '');
function markup(node: React.ReactNode) {
  const props = { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'light', children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return body(renderToStaticMarkup(React.createElement(ConfigProvider, props)));
}
/** Form.Field only renders inside a Form. */
function InForm({ children }: { children: React.ReactNode }) {
  const form = useForm();
  return React.createElement(Form, { form, layout: 'vertical' }, children);
}
const field = (record: Parameters<typeof WorkerParallelField>[0]['record']) => React.createElement(InForm, null, React.createElement(WorkerParallelField, { record, update: () => {} }));
/** Every element in a React tree (props.children and props.action), for pulling a control out and calling its handler. */
function elements(node: unknown, found: React.ReactElement<any>[] = []): React.ReactElement<any>[] {
  if (Array.isArray(node)) { node.forEach(item => elements(item, found)); return found; }
  if (!React.isValidElement(node)) return found;
  const element = node as React.ReactElement<any>;
  found.push(element);
  elements(element.props.children, found);
  elements(element.props.action, found);
  return found;
}
const control = (tree: unknown, label: string) => {
  const hit = elements(tree).find(element => element.props['aria-label'] === label);
  assert.ok(hit, `${label} is in the tree`);
  return hit.props as Record<string, any>;
};

const vendorWorker = (worker: string, extra: Partial<Block> = {}): Block => ({ engine: 'opencode', worker, reason: '限流：Rate limit exceeded', since: '2026-10-19T00:00:00Z', by: VENDOR_BLOCK_BY, release_at: FUTURE, ...extra });
const vendorEngine = (extra: Partial<Block> = {}): Block => ({ engine: 'opencode', reason: '该引擎全部子 Agent 均被限流/额度耗尽', since: '2026-10-19T00:00:00Z', by: VENDOR_BLOCK_BY, release_at: FUTURE, ...extra });

test('the cap switch is off by default and on stores an integer inside 1 to 100', () => {
  const worker = defaultConfig().workers.claude_worker!;
  assert.equal(Object.hasOwn(withWorkerParallel(worker, false, undefined), 'max_parallel'), false);
  assert.equal(withWorkerParallel(worker, true, undefined).max_parallel, 1, 'turning it on starts at 1');
  assert.equal(withWorkerParallel(worker, true, 4).max_parallel, 4);
  assert.equal(withWorkerParallel(worker, true, 4.6).max_parallel, 5);
  assert.equal(withWorkerParallel(worker, true, 0).max_parallel, 1);
  assert.equal(withWorkerParallel(worker, true, 500).max_parallel, 100);
  assert.equal(withWorkerParallel({ ...worker, max_parallel: 3 }, false, 3).max_parallel, undefined, 'off removes a stored cap');
  assert.equal(worker.max_parallel, undefined, 'the input record is not mutated');
});

test('the cap field renders the switch alone when off and the 1-100 number input when on', () => {
  const worker = defaultConfig().workers.claude_worker!;
  const off = markup(field(worker));
  assert.match(off, /同一时间最多运行几个任务，超出的任务排队等待；用于避免供应商限流。/);
  assert.match(off, /限制同时运行的任务数/);
  assert.doesNotMatch(off, /aria-label="并发上限"|min="1" max="100"/, 'no number input while off');
  const on = markup(field({ ...worker, max_parallel: 3 }));
  assert.match(on, /min="1" max="100"/);
  assert.match(on, /value="3"/);
});

test('flipping the switch and typing a number save max_parallel or remove it', () => {
  const worker = defaultConfig().workers.claude_worker!;
  const saved: unknown[] = [];
  const update = (next: unknown) => saved.push(next);
  control(WorkerParallelField({ record: worker, update }), '限制同时运行的任务数').onChange(true);
  assert.equal((saved.at(-1) as typeof worker).max_parallel, 1);
  const on = { ...worker, max_parallel: 2 };
  control(WorkerParallelField({ record: on, update }), '并发上限').onChange(8);
  assert.equal((saved.at(-1) as typeof worker).max_parallel, 8);
  control(WorkerParallelField({ record: on, update }), '限制同时运行的任务数').onChange(false);
  assert.equal(Object.hasOwn(saved.at(-1) as object, 'max_parallel'), false);
});

test('only a limited worker gets a 并发 ≤ N label, in neutral color', () => {
  assert.equal(workerParallelText({ max_parallel: 3 }), '并发 ≤ 3');
  assert.equal(workerParallelText({}), undefined);
  assert.equal(workerParallelText(undefined), undefined);
  assert.equal(workerParallelText({ max_parallel: 0 }), undefined);

  const config = defaultConfig();
  config.workers.codex_worker!.max_parallel = 2;
  const record = { ...config.owners.claude_owner!, workers: ['claude_worker', 'codex_worker'] };
  const weights = markup(React.createElement(OwnerScheduleFields, { config, blocks: [], record, update: () => {} }));
  assert.equal((weights.match(/并发 ≤ /g) ?? []).length, 1);
  assert.match(weights, /并发 ≤ 2/);
  assert.ok(weights.indexOf('codex_worker') < weights.indexOf('并发 ≤ 2'));
  assert.equal(tagColor('neutral'), 'gray');
});

function draft(config: Config, blocks: Block[]): PolicyDraft {
  const snapshot = { revision: 1, config, blocks, activeBlocks: blocks, owners: {}, workers: {}, execution: 'disabled' } as PolicySnapshot;
  return { snapshot, config, setConfig: () => {}, blocks, setBlocks: () => {}, loading: false, busy: false, loadError: '', saveError: '', issues: [], conflict: false, dirty: false, load: async () => true, save: async () => true, commit: async () => {}, rebase: () => {}, applyServerSnapshot: () => true } as PolicyDraft;
}

test('the sub-agent page lists 并发 ≤ N after the model and shows the resume notice for a paused worker', () => {
  const config = defaultConfig();
  config.workers.claude_worker!.max_parallel = 3;
  const paused = markup(React.createElement(RolesPage, { section: 'workers', policy: draft(config, [{ engine: 'claude', worker: 'claude_worker', reason: '限流：Rate limit exceeded', since: '2026-10-19T00:00:00Z', by: VENDOR_BLOCK_BY, release_at: FUTURE }]) }));
  assert.ok(paused.indexOf('claude · sonnet') < paused.indexOf('并发 ≤ 3'));
  assert.match(paused, /已暂停派发/);
  assert.match(paused, /Rate limit exceeded/);
  assert.match(paused, /aria-label="恢复派发"[^>]*>[\s\S]*?恢复派发/);
  const clear = markup(React.createElement(RolesPage, { section: 'workers', policy: draft(config, []) }));
  assert.doesNotMatch(clear, /已暂停派发|恢复派发/);
  assert.match(clear, /并发上限/);
});

test('a paused worker gets a resume text button in the list entry and in the editor notice, an available one gets neither', () => {
  const config = defaultConfig();
  const paused = markup(React.createElement(RolesPage, { section: 'workers', policy: draft(config, [{ engine: 'claude', worker: 'claude_worker', reason: '限流：Rate limit exceeded', since: '2026-10-19T00:00:00Z', by: VENDOR_BLOCK_BY, release_at: FUTURE }]) }));
  assert.equal((paused.match(/aria-label="恢复派发 claude_worker"/g) ?? []).length, 1, 'one button in the list entry');
  assert.equal((paused.match(/aria-label="恢复派发"/g) ?? []).length, 1, 'one in the notice of the selected worker');
  const listButton = paused.match(/<button[^>]*aria-label="恢复派发 claude_worker"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(listButton.replace(/<[^>]*>/g, ''), /恢复派发/, 'visible text, not only an icon');
  assert.doesNotMatch(listButton, /<[^>]*role="switch"/);
  const clear = markup(React.createElement(RolesPage, { section: 'workers', policy: draft(config, []) }));
  assert.doesNotMatch(clear, /恢复派发/);
  // Parent agents never get one: a block reaches them through their engine, not through a worker.
  const owners = markup(React.createElement(RolesPage, { section: 'owners', policy: draft(config, [{ engine: 'claude', worker: 'claude_worker', reason: 'x', since: '2026-10-19T00:00:00Z', by: 'manual' }]) }));
  assert.doesNotMatch(owners, /aria-label="恢复派发/);
});

test('the pause notice names the reason and release time and its button calls resume once', () => {
  const calls: string[] = [];
  const block = vendorWorker('opencode_worker');
  const tree = WorkerBlockNotice({ block, now: NOW, onResume: () => calls.push('resume') });
  const html = markup(tree);
  assert.match(html, /限流/);
  assert.match(html, /Rate limit exceeded/);
  assert.match(html, /自动解除/);
  control(tree, '恢复派发').onClick();
  assert.deepEqual(calls, ['resume']);
  assert.match(markup(WorkerBlockNotice({ block: vendorEngine(), now: NOW, onResume: () => {} })), /整个引擎 opencode/);
  assert.match(markup(WorkerBlockNotice({ block: { ...vendorWorker('w'), release_at: undefined, by: 'manual' }, now: NOW, onResume: () => {} })), /需手动恢复/);
});
