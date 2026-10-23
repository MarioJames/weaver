import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImService } from '../../src/main/im/service';
import type { ImChannelFactory, ImChannelHandlers } from '../../src/main/im/channel';
import { parentError, type ParentAgentFactory } from '../../src/main/im/parent-agent';
import type { PolicySnapshot } from '../../src/shared/contracts/policy';
import type { NormalizedMessage } from '@larksuite/channel';

const ROOT = await mkdtemp(join(tmpdir(), 'weaver-im-launch-cancel-'));
test.after(async () => { await rm(ROOT, { recursive: true, force: true }); });
const tick = async () => { for (let n = 0; n < 12; n++) await new Promise<void>(r => setImmediate(r)); };
function policy(): PolicySnapshot { return { revision: 0, config: { version: 1, engines: { codex: { enabled: true, kind: 'codex' } }, owners: { main: { enabled: true, engine: 'codex', model: 'gpt-test', effort: 'medium', workers: [], max_parallel: 1 } }, workers: {}, herdr: { max_wait_minutes: 30 } }, blocks: [], activeBlocks: [], owners: {}, workers: {}, execution: 'disabled' }; }
function fixture() {
  let handlers!: ImChannelHandlers;
  const factory: ImChannelFactory = (_c, h) => { handlers = h; return { connect: async () => {}, close: async () => {}, state: () => 'connected', send: async () => {}, retireCard: async () => {}, stream: async () => '', updateCard: async () => {} }; };
  return { factory, get handlers() { return handlers; } };
}
function message(id: string): NormalizedMessage {
  const now = Date.now();
  return { messageId: `om_${id}`, chatId: 'oc_a', chatType: 'p2p', senderId: 'ou_a', senderType: 'user', content: '你好', rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: now, raw: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_a' } }, message: { message_id: `om_${id}`, chat_id: 'oc_a', chat_type: 'p2p', message_type: 'text', create_time: String(now), content: JSON.stringify({ text: '你好' }) } } };
}

test('rebuild during launch aborts the private startup signal and closes fast', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(ROOT, 'cancel-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const f = fixture();
  let signals: (AbortSignal | undefined)[] = [];
  let factoryCalls = 0;
  let factoryCloses = 0;
  // Signal-aware mock factory: blocks until the private launch signal aborts, then rejects.
  // Production custom factories may ignore the optional second arg; the default Herdr
  // factory honors it by revoking its socket/startup intent and closing owned resources.
  const parent: ParentAgentFactory = ((_input: unknown, opts?: { signal?: AbortSignal }) => {
    factoryCalls++;
    signals.push(opts?.signal);
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(parentError('aborted', 'startup cancelled')), { once: true });
    });
  }) as unknown as ParentAgentFactory;
  const live = policy();
  const service = new ImService({ dataDir: dir, policy: () => live, parentFactory: parent, channelFactory: f.factory });
  t.after(async () => { await service.close(); });
  const config = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 1, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config });
  await tick();
  assert.equal(factoryCalls, 1);
  assert.equal(signals[0]?.aborted, false);
  // Rebuilding (disable) while the first launch is still in flight must cancel it fast
  // instead of waiting out the extended identity budget plus the 60s close timeout.
  const started = Date.now();
  await service.save({ expectedRevision: 1, config: { ...config, enabled: false } });
  const elapsed = Date.now() - started;
  assert.equal(signals[0]?.aborted, true);
  assert.ok(elapsed < 8000, `startup cancel stays fast (took ${elapsed}ms)`);
  assert.equal(service.snapshot().status.connection, 'disabled');
  void factoryCloses;
});

test('late launch result after fence never creates a stale parent', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(ROOT, 'late-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const f = fixture();
  let resolveLaunch!: (session: { send: () => Promise<string>; close: () => Promise<void> }) => void;
  const gate = new Promise<{ send: () => Promise<string>; close: () => Promise<void> }>(r => { resolveLaunch = r; });
  let sends = 0;
  const parent: ParentAgentFactory = (async () => gate) as unknown as ParentAgentFactory;
  const live = policy();
  const service = new ImService({ dataDir: dir, policy: () => live, parentFactory: parent, channelFactory: f.factory });
  t.after(async () => { await service.close(); });
  const config = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 1, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config });
  await tick();
  f.handlers.message(message('late'));
  await tick();
  // Disable fences the in-flight launch; a late factory resolution must not run user turns.
  const disable = service.save({ expectedRevision: 1, config: { ...config, enabled: false } });
  await tick();
  resolveLaunch({ send: async () => { sends++; return 'stale'; }, close: async () => {} });
  await disable;
  await tick();
  assert.equal(sends, 0);
  assert.equal(service.snapshot().status.connection, 'disabled');
});
