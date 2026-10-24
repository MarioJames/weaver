import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_CATALOG } from '../../src/shared/engines';
import { parseHelloInput, sayHi } from '../../src/main/engines/hello';
import { startCliAgent } from '../../src/main/adapters/cli';
import type { CaptureResult } from '../../src/main/engines/probe';
import {
  EngineModelLister, NO_LIST_MESSAGE, claudeKnownModels, parseCodexModels, parseGrokModels, parseModelListInput,
  parseOpencodeModels, parsePiModels, parseQoderModels,
} from '../../src/main/engines/models';

// Output recorded from the installed CLIs (claude 2.1.304, codex 0.163.0, grok 1.0.62, opencode 1.19.3, pi 1.3.0, qodercli 1.1.73), trimmed.
const OPENCODE = 'opencode/beam-free\nopencode/big-pickle\nopencode/glm-5.3-flash-free\nopencode/glm-5.3-flash-free\n';
const PI = [
  'provider             model                context  max-out  thinking  images',
  'cc-switch-agentplan  ark-code-latest      128K     16.4K    no        no    ',
  'cc-switch-agentplan  glm-5.3-flash        1M       128K     yes       yes   ',
].join('\n');
const GROK = 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n';
const GROK_ANON = 'You are not authenticated.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.5\n';
const CODEX = JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', visibility: 'list', supported_in_api: true, base_instructions: 'x'.repeat(2000) },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
  { slug: 'gpt-6-luna', display_name: 'gpt-6-luna', description: '', visibility: 'list' },
  { display_name: 'no slug', visibility: 'list' },
] });
const QODER = 'MODEL\nQwen3.8-Flash\nDeepSeek-Flash\n';

const ok = (stdout: string, extra: Partial<CaptureResult> = {}): CaptureResult => ({ code: 0, timedOut: false, overflow: false, stdout, stderr: '', ...extra });

test('each engine list is parsed from its own recorded command output', () => {
  assert.deepEqual(parseOpencodeModels(OPENCODE).map(m => m.id), ['opencode/beam-free', 'opencode/big-pickle', 'opencode/glm-5.3-flash-free']);
  assert.deepEqual(parsePiModels(PI), [
    { id: 'cc-switch-agentplan/ark-code-latest', hint: '128K 上下文' },
    { id: 'cc-switch-agentplan/glm-5.3-flash', hint: '1M 上下文 · 支持思考' },
  ]);
  assert.deepEqual(parseGrokModels(GROK), [{ id: 'grok-4.7', hint: '默认' }, { id: 'grok-4.7-build-fast' }, { id: 'grok-4.6' }]);
  assert.deepEqual(parseGrokModels(GROK_ANON).map(m => m.id), ['grok-4.7', 'grok-4.5']);
  assert.deepEqual(parseCodexModels(CODEX), [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', hint: 'Latest workhorse model for coding and everyday work.' }, { id: 'gpt-6-luna' }]);
  assert.deepEqual(parseQoderModels(QODER).map(m => m.id), ['Qwen3.8-Flash', 'DeepSeek-Flash']);
});

test('garbled, empty or hostile output yields no models instead of throwing or inventing names', () => {
  for (const parse of [parseOpencodeModels, parsePiModels, parseGrokModels, parseCodexModels, parseQoderModels]) {
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse('\u001b[31mError: not logged in\u001b[0m'), []);
  }
  assert.deepEqual(parseCodexModels('{"models":"nope"}'), []);
  assert.deepEqual(parseCodexModels('not json'), []);
  assert.deepEqual(parseOpencodeModels('--flag/x\n../etc/passwd\nprovider/model;rm -rf'), []);
  assert.deepEqual(parseQoderModels('MODEL\n-p\nhas space'), []);
});

test('the lister runs only the engine list command with fixed arguments, and never calls a model', async () => {
  const calls: Array<{ exe: string; args: readonly string[] }> = [];
  const samples: Record<string, string> = { opencode: OPENCODE, pi: PI, grok: GROK, codex: CODEX, qoder: QODER };
  const lister = new EngineModelLister({
    pathEnv: '/bin', env: { HOME: '/nonexistent' },
    find: async command => `/fake/${command}`,
    run: async (exe, args) => { calls.push({ exe, args }); return ok(samples[ENGINE_CATALOG.find(e => `/fake/${e.command}` === exe)!.id]!); },
  });
  for (const id of ['opencode', 'pi', 'grok', 'codex', 'qoder']) {
    const list = await lister.list({ engine: id });
    assert.equal(list.status, 'ok', id);
    assert.ok(list.models.length > 0, id);
  }
  assert.deepEqual(calls.map(c => [c.exe.replace('/fake/', ''), ...c.args]), [
    ['opencode', 'models'], ['pi', '--list-models'], ['grok', 'models'], ['codex', 'debug', 'models'], ['qodercli', '--list-models'],
  ]);
  const sources = await Promise.all(['opencode', 'pi', 'grok', 'codex', 'qoder'].map(id => lister.list({ engine: id }).then(l => l.source)));
  assert.deepEqual(sources, ['opencode models', 'pi --list-models', 'grok models', 'codex debug models', 'qodercli --list-models']);
});

test('an engine without a list command falls back to manual entry without running anything', async () => {
  let ran = 0;
  const lister = new EngineModelLister({ find: async () => '/fake/unknown', run: async () => { ran++; return ok(''); } });
  const list = await lister.list({ engine: 'unknown' });
  assert.deepEqual([list.status, list.models, list.message], ['unsupported', [], NO_LIST_MESSAGE]);
  assert.equal(NO_LIST_MESSAGE, '该引擎不提供模型列表，请手动填写');
  assert.equal(ran, 0);
});

test('a missing, failing, slow or empty list command is reported as such and is not cached', async () => {
  const outcomes: Array<[string, CaptureResult | undefined]> = [
    ['unavailable', undefined],
    ['failed', ok('', { code: 2 })],
    ['failed', ok('', { timedOut: true })],
    ['failed', ok('', { overflow: true })],
    ['failed', ok('', { error: 'spawn EACCES' })],
    ['failed', ok('nothing recognisable here')],
  ];
  for (const [status, result] of outcomes) {
    let runs = 0;
    const lister = new EngineModelLister({ find: async () => result ? '/fake/opencode' : undefined, run: async () => { runs++; return result ?? ok(''); } });
    const first = await lister.list({ engine: 'opencode' });
    assert.equal(first.status, status);
    assert.deepEqual(first.models, []);
    assert.ok(first.message && first.message.length > 0);
    await lister.list({ engine: 'opencode' });
    assert.equal(runs, result ? 2 : 0, 'failures are retried rather than cached');
  }
});

test('lists are cached for a minute per engine, shared by concurrent calls, and refresh bypasses the cache', async () => {
  let now = Date.parse('2026-10-20T00:00:00Z');
  let runs = 0;
  const lister = new EngineModelLister({ now: () => new Date(now), find: async () => '/fake/pi', run: async () => { runs++; await new Promise(r => setTimeout(r, 5)); return ok(PI); } });
  await Promise.all([lister.list({ engine: 'pi' }), lister.list({ engine: 'pi' })]);
  assert.equal(runs, 1);
  await lister.list({ engine: 'pi' });
  assert.equal(runs, 1);
  await lister.list({ engine: 'pi', refresh: true });
  assert.equal(runs, 2);
  now += 61_000;
  await lister.list({ engine: 'pi' });
  assert.equal(runs, 3);
});

test('the list command runs with the service process environment untouched, apart from ELECTRON_RUN_AS_NODE', async () => {
  const seen: NodeJS.ProcessEnv[] = [];
  const lister = new EngineModelLister({
    pathEnv: '/bin', env: { HOME: '/h', HTTPS_PROXY: 'http://system.invalid:1', ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' },
    find: async () => '/fake/opencode', run: async (_exe, _args, _t, _m, env) => { seen.push(env); return ok(OPENCODE); },
  });
  await lister.list({ engine: 'opencode' });
  assert.equal(seen[0]!.HTTPS_PROXY, 'http://system.invalid:1');
  assert.equal(seen[0]!.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(seen[0]!.KEEP, 'yes');
});

test('Claude has no list command: names come from built-in aliases plus model names in settings.json, never other values', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-claude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    model: 'glm-5.3-flash',
    availableModels: ['opus', 'bad name; rm'],
    modelSettings: { 'claude-opus-5-5': {}, 'custom/relay-1': {} },
    env: { ANTHROPIC_AUTH_TOKEN: 'sk-relay-secret-value', ANTHROPIC_BASE_URL: 'https://relay.invalid', ANTHROPIC_DEFAULT_SONNET_MODEL: 'relay-sonnet', ANTHROPIC_MODEL: '$(whoami)' },
  }));
  const models = await claudeKnownModels({ CLAUDE_CONFIG_DIR: dir });
  const ids = models.map(m => m.id);
  assert.deepEqual(ids.slice(0, 4), ['glm-5.3-flash', 'opus', 'claude-opus-5-5', 'custom/relay-1']);
  for (const id of ['relay-sonnet', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5']) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!JSON.stringify(models).includes('sk-relay-secret-value'));
  assert.ok(!ids.some(id => /[\s;$(]/.test(id)));
  const lister = new EngineModelLister({ env: { CLAUDE_CONFIG_DIR: dir } });
  const list = await lister.list({ engine: 'claude' });
  assert.equal(list.status, 'ok');
  assert.match(list.source, /无列表命令/);
  const empty = await claudeKnownModels({ CLAUDE_CONFIG_DIR: join(dir, 'missing') });
  assert.deepEqual(empty.map(m => m.id), ['sonnet', 'opus', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
});

test('model list input rejects unknown engines and fields (a proxy included) and non-boolean refresh', () => {
  assert.deepEqual(parseModelListInput({ engine: 'codex', refresh: true }), { engine: 'codex', refresh: true });
  assert.deepEqual(parseModelListInput({ engine: 'pi' }), { engine: 'pi' });
  for (const bad of [null, [], { engine: 'rm' }, { engine: 'pi', command: 'x' }, { engine: 'pi', proxy: 'direct' }, { engine: 'pi', proxy: 'http://127.0.0.1:7890' }, { engine: 'pi', refresh: 'yes' }]) {
    assert.throws(() => parseModelListInput(bad), Error, JSON.stringify(bad));
  }
});

/** Replaces PATH with a directory holding one fake CLI that records the proxy variables it was started with. */
async function withFakeCli<T>(name: string, run: (dir: string, dump: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-env-'));
  const dump = join(dir, 'env.json');
  writeFileSync(join(dir, name), `#!${process.execPath}\nconst keys=['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','NO_PROXY','NODE_USE_ENV_PROXY'];\nrequire('node:fs').writeFileSync(${JSON.stringify(dump)},JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]??null]))));\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'hi'}]}}));\n`, { mode: 0o700 });
  const saved = { PATH: process.env.PATH, HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY };
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.HTTPS_PROXY = 'http://host-proxy.invalid:3128';
  process.env.HTTP_PROXY = 'http://host-proxy.invalid:3128';
  try { return await run(dir, dump); }
  finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
}
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, string | null>;

test('hello input rejects a proxy field like any other unknown field', () => {
  assert.deepEqual(parseHelloInput({ channel:'default_codex', engine: 'codex', model: 'm-1', effort: 'high' }), { channel:'default_codex', engine: 'codex', model: 'm-1', effort: 'high' });
  for (const bad of [{ engine: 'codex', model: 'm-1', effort: 'high', proxy: 'direct' }, { engine: 'codex', model: 'm-1', effort: 'high', proxy: 'http://127.0.0.1:7890' }, { engine: 'codex', model: 'm-1', effort: 'high', command: 'x' }]) {
    assert.throws(() => parseHelloInput(bad), /Unknown probe field/, JSON.stringify(bad));
  }
});

test('connectivity test starts the engine with the service process environment as it is', async () => {
  await withFakeCli('codex', async (dir, dump) => {
    const root = join(dir, 'hello');
    mkdirSync(root, { recursive: true });
    await sayHi({ channel:'fixture_codex', engine: 'codex', kind: 'codex', model: 'm-1', effort: 'high',channelConfig:{channel:{engine:'codex',kind:'api',enabled:true,label:'fixture'},secret:{apiKey:'fixture-key'}} }, { root, timeoutMs: 8000 });
    const seen = read(dump);
    assert.equal(seen.HTTPS_PROXY, 'http://host-proxy.invalid:3128');
    assert.equal(seen.HTTP_PROXY, 'http://host-proxy.invalid:3128');
    assert.equal(seen.NODE_USE_ENV_PROXY, null);
  });
});

test('a real task launch starts the engine with the service process environment as it is', { timeout: 40_000 }, async () => {
  await withFakeCli('pi', async (dir, dump) => {
    const agent = startCliAgent({ engine: 'pi', model: 'fixture/pi', effort: 'high', workspace: dir, stateDir: join(dir, 'state'), instruction: 'Fixture only. No model calls.' });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { agent.kill('SIGKILL'); reject(new Error('launcher did not close')); }, 15_000);
        agent.stdout.resume(); agent.stderr.resume();
        agent.once('close', () => { clearTimeout(timer); resolve(); });
      });
    } finally { agent.kill('SIGKILL'); }
    const seen = read(dump);
    assert.equal(seen.HTTPS_PROXY, 'http://host-proxy.invalid:3128');
    assert.equal(seen.http_proxy, null);
    assert.equal(seen.NODE_USE_ENV_PROXY, null);
  });
});

// Renderer side: what the model picker shows.
import { modelListView, modelSelectOptions, requestEngineModels, NO_LIST_TEXT } from '../../src/renderer/features/engines/engine-models';
import type { EngineModelList } from '../../src/shared/engines';

const listOf = (over: Partial<EngineModelList>): EngineModelList => ({ engine: 'pi', status: 'ok', source: 'pi --list-models', models: [], fetchedAt: '2026-10-20T00:00:00Z', ...over });

test('the picker line separates a list, a missing list command and a failed command', () => {
  assert.deepEqual(modelListView(undefined, false), { kind: 'idle' });
  assert.deepEqual(modelListView(undefined, true), { kind: 'loading' });
  assert.deepEqual(modelListView(listOf({ models: [{ id: 'a/b' }] }), false), { kind: 'ready', count: 1, source: 'pi --list-models' });
  assert.deepEqual(modelListView(listOf({ status: 'unsupported', message: NO_LIST_MESSAGE }), false), { kind: 'manual', text: '该引擎不提供模型列表，请手动填写' });
  assert.deepEqual(modelListView(listOf({ status: 'unavailable', message: '未在本机找到 pi，请手动填写' }), false), { kind: 'manual', text: '未在本机找到 pi，请手动填写' });
  assert.equal(modelListView(listOf({ status: 'failed', message: 'pi --list-models 超时' }), false).kind, 'failed');
  assert.deepEqual(modelSelectOptions(listOf({ models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'x', label: 'x' }] })), [{ value: 'gpt-6.1-sol', label: 'gpt-6.1-sol · GPT-6.1-Sol' }, { value: 'x', label: 'x' }]);
  assert.equal(NO_LIST_TEXT, NO_LIST_MESSAGE);
});

test('the model list request goes straight to the control plane client', async () => {
  const globals = globalThis as unknown as { window?: unknown };
  const saved = globals.window;
  try {
    const seen: unknown[] = [];
    globals.window = { weaver: { listEngineModels: async (input: unknown) => { seen.push(input); return listOf({ models: [{ id: 'a/b' }] }); } } };
    assert.equal((await requestEngineModels({ engine: 'pi' })).models.length, 1);
    assert.deepEqual(seen, [{ engine: 'pi' }]);
  } finally { globals.window = saved; }
});

test('account cache invalidation prevents an old inflight model result from repopulating the new account cache', async () => {
  let complete: ((result: CaptureResult) => void) | undefined;
  let runs = 0;
  const lister = new EngineModelLister({ find: async () => '/fixture/opencode', run: async () => { runs++; if (runs === 1) return await new Promise<CaptureResult>(resolve => { complete = resolve; }); return ok('opencode/new-account-model\n'); } });
  const old = lister.list({ engine: 'opencode' });
  await new Promise(resolve => setImmediate(resolve));
  lister.invalidate('opencode');
  const fresh = await lister.list({ engine: 'opencode' });
  complete!(ok('opencode/old-account-model\n')); await old;
  assert.equal((await lister.list({ engine: 'opencode' })).models[0]?.id, fresh.models[0]?.id);
  assert.equal(runs, 2);
});
