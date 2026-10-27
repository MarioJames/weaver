import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createBackgroundParentAgent } from '../../src/main/im/parent-background';
import { fakeRunnerFactory } from '../helpers/background-host-runner';
import type { ImEngineKind } from '../../src/shared/im-engines';

// End-to-end proof that the unified parent progress channel reaches the Feishu
// card on the production path for every IM engine:
// ImService -> createBackgroundParentAgent -> __weaver-im-parent-host ->
// engine adapter, with progress frames carried back over the host wire and
// rendered as fixed batched status lines in the streaming card.
//
// Per engine the test asserts: the card stream contains exactly one
// "*深度思考中……*" plus exactly one "*工具调用中……*" batch start with its
// matching "*调用结束*" close (codex additionally shows one "*继续努力中……*"
// for its 3rd consecutive tool), every status line owns its line, the closing
// setContent carries only the answer, and no fixture-buried secret (SECRET_* /
// commands / absolute paths) leaks into the card stream. Tool/stage names never
// appear in the stream: only the fixed copy above.


const CLI_MAIN = new URL('../../src/cli/main.ts', import.meta.url).pathname;
// Engine card transcript lives in a test-owned temp directory only: it is created
// under WEAVER_PARENT_TEST_TMPDIR (or TMPDIR) and recycled by test.after. It never
// touches any pre-existing external evidence path.
const TRANSCRIPT_ROOT = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 't-'));
test.after(() => { rmSync(TRANSCRIPT_ROOT, { recursive: true, force: true }); });
const TRANSCRIPT = join(TRANSCRIPT_ROOT, 'engines-transcript.log');
const transcriptSections: string[] = [];

interface EngineCase {
  key: string;
  kind: ImEngineKind;
  binary: string;
  fixtureFile: string;
  scenarioEnv: string;
  markerEnv: string;
  snapshotEnv?: string;
  model: string;
  effort: string;
  answer: string;
  tools: string[];
  secrets: string[];
}

const ENGINES: EngineCase[] = [
  {
    key: 'claude', kind: 'claude', binary: 'claude', fixtureFile: 'claude-fixture.mjs',
    scenarioEnv: 'CLAUDE_FIXTURE_SCENARIO', markerEnv: 'CLAUDE_FIXTURE_MARKER',
    model: 'fixture-model', effort: 'high', answer: '最终回答1',
    tools: ['Bash', 'Grep'], secrets: ['SECRET', '/home', 'command', 'pattern'],
  },
  {
    key: 'codex', kind: 'codex', binary: 'codex', fixtureFile: 'codex-fixture.mjs',
    scenarioEnv: 'CODEX_FIXTURE_SCENARIO', markerEnv: 'CODEX_FIXTURE_MARKER',
    model: 'fixture-model', effort: 'high', answer: '进度答案',
    tools: ['shell', 'edit', 'web_search', 'read_file', 'dyn_search'],
    secrets: ['hunter2', 'SECRET', '/home/user', 'secret-tool', 'token.txt', 'rm -rf', 'spawnAgent', 'thr-sub'],
  },
  {
    key: 'opencode', kind: 'opencode', binary: 'opencode', fixtureFile: 'opencode-fixture.mjs',
    scenarioEnv: 'OPENCODE_FIXTURE_SCENARIO', markerEnv: 'OPENCODE_FIXTURE_MARKER',
    snapshotEnv: 'OPENCODE_FIXTURE_SNAPSHOT',
    model: 'fixture-provider/fixture-model', effort: 'high', answer: '进度完成',
    tools: ['bash', 'read'],
    secrets: ['SECRET_TOOL_TOKEN', 'SECRET_PATH', 'SECRET_TOOL_TITLE', 'SECRET_TOOL_OUTPUT', 'SECRET_FILE', 'SECRET_SUBTASK', 'SECRET_CHILD', 'SECRET_PATTERN'],
  },
  {
    key: 'pi', kind: 'pi', binary: 'pi', fixtureFile: 'pi-fixture.mjs',
    scenarioEnv: 'PI_FIXTURE_SCENARIO', markerEnv: 'PI_FIXTURE_MARKER',
    snapshotEnv: 'PI_FIXTURE_SNAPSHOT',
    model: 'fixture-model', effort: 'medium', answer: '最终回答1',
    tools: ['bash', 'edit'],
    secrets: ['SECRET_CMD', 'SECRET_TOKEN', 'SECRET_PARTIAL', 'SECRET_RESULT', 'SECRET_NESTED', 'SECRET_SUBAGENT', 'SECRET_INPUT', 'SECRET_PATH'],
  },
  {
    key: 'grok', kind: 'grok', binary: 'grok', fixtureFile: 'grok-fixture.mjs',
    scenarioEnv: 'GROK_FIXTURE_SCENARIO', markerEnv: 'GROK_FIXTURE_MARKER',
    snapshotEnv: 'GROK_FIXTURE_SNAPSHOT',
    model: 'fixture-model', effort: 'high', answer: '回答1',
    tools: ['execute', 'read'],
    secrets: ['SECRET_CMD', 'SECRET_TOKEN', 'SECRET_THOUGHT', 'SECRET_PLAN', 'SECRET_FOREIGN_TOOL', 'SECRET_PATH', 'SECRET_PW', '/etc/'],
  },
  {
    key: 'qodercli', kind: 'qodercli', binary: 'qodercli', fixtureFile: 'qoder-fixture.mjs',
    scenarioEnv: 'QODER_FIXTURE_SCENARIO', markerEnv: 'QODER_FIXTURE_MARKER',
    snapshotEnv: 'QODER_FIXTURE_SNAPSHOT',
    model: 'fixture-model', effort: 'high', answer: '最终回答1',
    tools: ['Bash', 'Grep'], secrets: ['SECRET', '/home', 'command', 'pattern'],
  },
  {
    key: 'dsh', kind: 'dsh', binary: 'dsh', fixtureFile: 'dsh-fixture.mjs',
    scenarioEnv: 'DSH_FIXTURE_SCENARIO', markerEnv: 'DSH_FIXTURE_MARKER',
    model: 'deepseek-flash', effort: 'high', answer: '你好，世界',
    tools: ['bash'], secrets: ['SECRET', 'SECRET_TOOL', 'SECRET_THINKING', 'SECRET_TOOL_RESULT', '/home'],
  },
];

interface Harness {
  dir: string;
  workspace: string;
  marker: string;
  previousPath: string;
  previousScenario?: string;
  previousMarker?: string;
  previousSnapshot?: string;
}

function setupBin(c: EngineCase, scenario = 'progress'): Harness {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), `wh-eng-${c.key}-`));
  chmodSync(dir, 0o700);
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  copyFileSync(new URL(`../fixtures/parent/${c.fixtureFile}`, import.meta.url), join(dir, c.binary));
  chmodSync(join(dir, c.binary), 0o700);
  const marker = join(dir, 'marker.ndjson');
  const previousPath = process.env.PATH ?? '';
  const previousScenario = process.env[c.scenarioEnv];
  const previousMarker = process.env[c.markerEnv];
  const previousSnapshot = c.snapshotEnv ? process.env[c.snapshotEnv] : undefined;
  process.env.PATH = `${dir}:${dirname(process.execPath)}:${previousPath}`;
  process.env[c.scenarioEnv] = scenario;
  process.env[c.markerEnv] = marker;
  if (c.snapshotEnv) process.env[c.snapshotEnv] = join(dir, 'snapshot.json');
  return { dir, workspace, marker, previousPath, previousScenario, previousMarker, previousSnapshot };
}

async function teardownBin(c: EngineCase, harness: Harness) {
  process.env.PATH = harness.previousPath;
  if (harness.previousScenario === undefined) delete process.env[c.scenarioEnv];
  else process.env[c.scenarioEnv] = harness.previousScenario;
  if (harness.previousMarker === undefined) delete process.env[c.markerEnv];
  else process.env[c.markerEnv] = harness.previousMarker;
  if (c.snapshotEnv) {
    if (harness.previousSnapshot === undefined) delete process.env[c.snapshotEnv];
    else process.env[c.snapshotEnv] = harness.previousSnapshot;
  }
  // Failed assertions/close must not leave a fixture alive or erase its identity first.
  const leaked = markerPids(harness.marker).filter(pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  for (const pid of leaked) {
    const proc = `/proc/${pid}`;
    try {
      const argv = readFileSync(`${proc}/cmdline`, 'utf8').split('\0');
      assert.equal(statSync(proc).uid, process.getuid!());
      assert.ok(argv.includes(join(harness.dir, c.binary)), `unverified fixture pid ${pid}`);
      process.kill(pid, 'SIGKILL');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  await untilFixturesGone(harness.marker);
  rmSync(harness.dir, { recursive: true, force: true });
}

function markerPids(marker: string): number[] {
  if (!existsSync(marker)) return [];
  const pids: number[] = [];
  for (const line of readFileSync(marker, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      for (const key of ['spawnPid', 'pid'] as const) {
        if (typeof entry[key] === 'number') pids.push(entry[key] as number);
      }
    } catch { /* marker line raced with writer */ }
  }
  return [...new Set(pids)];
}

async function untilFixturesGone(marker: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const alive = markerPids(marker).filter(pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (alive.length === 0) return;
    if (Date.now() > deadline) throw new Error(`fixture processes survived close: ${alive.join(',')}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

for (const c of ENGINES) {
  test(`${c.key} 统一进度经后台宿主到达卡片并收口只剩答案`, { timeout: 60000 }, async () => {
    const harness = setupBin(c, c.key === 'dsh' ? 'default' : 'progress');
    const dataDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'd-'));
    const serviceDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 's-'));
    const { runner } = fakeRunnerFactory();
    const { ImService } = await import('../../src/main/im/service');
    const chunks: string[] = [];
    const cards: unknown[] = [];
    let handlers!: import('../../src/main/im/channel').ImChannelHandlers;
    const factory: import('../../src/main/im/channel').ImChannelFactory = (_cfg, h) => {
      handlers = h;
      return {
        connect: async () => {},
        close: async () => {},
        state: () => 'connected' as const,
        send: async () => {},
        retireCard: async () => {},
        stream: async (_to, producer) => {
          const id = `om_${c.key}1`;
          await producer({
            messageId: id,
            append: async (text: string) => { chunks.push(text); },
            setContent: async (text: string) => { chunks.push(`[setContent]${text}`); },
          });
          return id;
        },
        updateCard: async (id, card) => { cards.push({ id, card }); },
      };
    };
    const policy = () => ({
      revision: 0,
      config: {
        version: 1,
        engines: { [c.key]: { enabled: true, kind: c.kind } },
        channels:{[`default_${c.key}`]:{engine:c.key,kind:c.kind==='pi'||c.kind==='dsh'?'api':'subscription',label:c.key,enabled:true}},
        owners: { main: { enabled: true, channel:`default_${c.key}`, model: c.model, effort: c.effort, workers: [], max_parallel: 1 } },
        workers: {}, herdr: { max_wait_minutes: 30 },
      },
      blocks: [], activeBlocks: [], owners: {}, workers: {}, execution: 'disabled',
    }) as any;
    const parentFactory = (input: any, opts?: { signal?: AbortSignal }) =>
      createBackgroundParentAgent(input, { dataDir, signal: opts?.signal }, { hostCommand: [process.execPath, '--import', 'tsx', CLI_MAIN], startupMs: 45000, runner });
    const service = new ImService({ dataDir: serviceDir, policy, parentFactory: parentFactory as any, channelFactory: factory });
    try {
      await service.save({ expectedRevision: 0, config: { enabled: true, appId: 'cli_test', appSecret: 'CANARY_SECRET', allowedOpenIds: ['ou_a'], channel:`default_${c.key}`, model: c.model, effort: c.effort, workspaces: [harness.workspace], idleTimeoutMinutes: 1, ownerProfileId: '' } as any });
      for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve));
      const now = Date.now();
      handlers.message({
        messageId: `om_${c.key}_progress1`, chatId: 'oc_a', chatType: 'p2p', senderId: 'ou_a', senderType: 'user',
        content: '你好', rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: false,
        createTime: now,
        raw: {
          sender: { sender_type: 'user', sender_id: { open_id: 'ou_a' } },
          message: { message_id: `om_${c.key}_progress1`, chat_id: 'oc_a', chat_type: 'p2p', message_type: 'text', create_time: String(now), content: JSON.stringify({ text: '你好' }) },
        },
      } as any);
      // Wait for the closing setContent instead of a fixed sleep.
      const deadline = Date.now() + 45000;
      for (;;) {
        for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));
        if (chunks.some(entry => entry.startsWith('[setContent]'))) break;
        if (Date.now() > deadline) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const streamText = chunks.filter(entry => !entry.startsWith('[setContent]')).join('');
      const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
      assert.equal(count(streamText, '*深度思考中……*'), 1, `${c.key} thinking line: ${JSON.stringify(chunks)}`);
      assert.equal(count(streamText, '*工具调用中……*'), 1, `${c.key} tool batch start: ${JSON.stringify(chunks)}`);
      assert.equal(count(streamText, '*调用结束*'), 1, `${c.key} batch close: ${JSON.stringify(chunks)}`);
      assert.equal(
        count(streamText, '*继续努力中……*'),
        c.key === 'codex' ? 1 : 0,
        `${c.key} encourage line: ${JSON.stringify(chunks)}`,
      );
      assert.ok(!streamText.includes('⏺'), `${c.key} leaked old per-tool rendering: ${JSON.stringify(chunks)}`);
      for (const tool of c.tools) {
        assert.ok(!streamText.includes(tool), `${c.key} card leaked tool name ${tool}: ${JSON.stringify(chunks)}`);
      }
      // Every status line owns its line: only the fixed copy may appear.
      const FIXED = ['*深度思考中……*', '*工具调用中……*', '*继续努力中……*', '*调用结束*'];
      for (const line of streamText.split('\n')) {
        if (line.includes('*')) assert.ok(FIXED.includes(line.trim()), `${c.key} status line shares its line: ${JSON.stringify(line)}`);
      }
      // The closing setContent carries only the answer; status is transient.
      assert.equal(chunks.at(-1), `[setContent]${c.answer}`, `${c.key} closing content: ${JSON.stringify(chunks)}`);
      assert.equal(cards.length, 1);
      const closingCard = (cards[0] as { card: { body: { elements: { content?: string }[] } } }).card;
      assert.equal(closingCard.body.elements[0]?.content, c.answer, `${c.key} updateCard leaked status`);
      // Fixture-buried secrets (args, commands, paths) must not reach the card.
      const serialized = chunks.join('');
      for (const secret of c.secrets) {
        assert.ok(!serialized.includes(secret), `${c.key} progress leaked ${secret}: ${serialized}`);
      }
      transcriptSections.push([
        `=== ${c.key} (engineKind=${c.kind}, expected tools: ${c.tools.join(',')}) ===`,
        '--- card appends (append chunks in order; [setContent] is the closing call) ---',
        ...chunks,
        '--- closing answer ---',
        c.answer,
        '',
      ].join('\n'));
    } finally {
      try {
        await service.close();
        await untilFixturesGone(harness.marker);
      } finally {
        await teardownBin(c, harness);
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(serviceDir, { recursive: true, force: true });
      }
    }
  });
}

test('落盘七引擎卡片序列证据', { timeout: 15000 }, async () => {
  assert.equal(transcriptSections.length, ENGINES.length, `missing engine sections: ${transcriptSections.length}/${ENGINES.length}`);
  const body = `${transcriptSections.join('\n')}\n`;
  for (const key of ENGINES.map(e => e.key)) assert.ok(body.includes(`=== ${key} `), `transcript missing ${key}`);
  writeFileSync(TRANSCRIPT, body, { mode: 0o600 });
});
