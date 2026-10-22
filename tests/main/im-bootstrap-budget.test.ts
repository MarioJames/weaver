import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IM_MASTER_READY_MARKER, imInstructions, imMasterIdentityPrompt, validateImInstructionBudget } from '../../src/main/im/bootstrap';
import { PARENT_TEXT_MAX } from '../../src/main/im/limits';
import { ImSettingsStore } from '../../src/main/im/settings';

const root = mkdtempSync(join(tmpdir(), 'im-budget-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const epoch = '00000000-0000-0000-0000-000000000000';
const enabled = (workspaces: string[]) => ({ enabled: true, appId: 'cli_budget', appSecret: 'FAKE_SECRET', allowedOpenIds: ['ou_fake'], engine: 'codex', model: 'gpt-test', effort: 'low', workspaces, idleTimeoutMinutes: 30 });

test('startup checks the complete generated UTF-16 instructions at the exact shared budget without truncation', () => {
  const paths = [join(root, "项目 'quoted' \\ path 😀")];
  const base = imInstructions('/data', 'claude', epoch, paths);
  assert.ok(base.includes(JSON.stringify(paths)));
  const dataDir = '/data' + 'x'.repeat(PARENT_TEXT_MAX - base.length);
  const full = imInstructions(dataDir, 'claude', epoch, paths);
  assert.equal(full.length, PARENT_TEXT_MAX);
  assert.ok(full.includes(JSON.stringify(paths)));
  assert.throws(() => imInstructions(dataDir + 'x', 'claude', epoch, paths), { code: 'IM_BOOTSTRAP_TOO_LARGE' });
  // Quotes in shell data and JSON backslashes consume their real escaped length, not path.length.
  assert.throws(() => imInstructions(dataDir.replace('xxxx', "''''"), 'claude', epoch, paths), { code: 'IM_BOOTSTRAP_TOO_LARGE' });
  assert.throws(() => imInstructions(dataDir, 'claude', epoch, [...paths, '/😀\\"']), { code: 'IM_BOOTSTRAP_TOO_LARGE' });
});

test('all directories may be individually valid while the complete bootstrap is too large: save is atomic and old config can still turn off', () => {
  const dataDir = join(root, 'store');
  const store = new ImSettingsStore(dataDir);
  const initial = store.save({ expectedRevision: 0, config: enabled([root]) });
  const bytes = readFileSync(store.path, 'utf8');
  const nested = join(root, ...Array.from({ length: 7 }, (_, n) => `${n}-${'a'.repeat(90)}`));
  mkdirSync(nested, { recursive: true });
  const directories = Array.from({ length: 32 }, (_, n) => join(nested, `project-${n}`));
  for (const directory of directories) { mkdirSync(directory); assert.ok(directory.length <= 2000); }
  assert.throws(() => store.save({ expectedRevision: 1, config: enabled(directories) }), { code: 'IM_BOOTSTRAP_TOO_LARGE' });
  assert.equal(readFileSync(store.path, 'utf8'), bytes);
  assert.deepEqual(store.current(), initial);
  assert.throws(() => store.save({ expectedRevision: 1, config: { ...enabled(directories), enabled: false } }), { code: 'IM_BOOTSTRAP_TOO_LARGE' }, 'changing a disabled list still validates the complete budget');
  // Simulate a structurally valid older version saved before budget checks existed.
  writeFileSync(store.path, JSON.stringify({ version: 3, revision: 8, config: enabled(directories) }), { mode: 0o600 });
  const legacy = new ImSettingsStore(dataDir);
  assert.equal(legacy.current().revision, 8, 'load does not misclassify an over-budget existing file as corrupt');
  const { appSecret: _secret, ...publicInput } = enabled(directories);
  const off = legacy.save({ expectedRevision: 8, config: { ...publicInput, enabled: false } });
  assert.equal(off.revision, 9);
  assert.equal(off.config.appSecret, 'FAKE_SECRET');
  assert.deepEqual(off.config.workspaces, directories);
  assert.throws(() => legacy.save({ expectedRevision: 9, config: publicInput }), { code: 'IM_BOOTSTRAP_TOO_LARGE' });
});

test('the actual quoted storage directory is counted before any save, and an in-budget list remains complete', () => {
  const dataDir = join(root, ...Array.from({ length: 39 }, () => "'".repeat(100)));
  const store = new ImSettingsStore(dataDir);
  const absent = store.path;
  assert.ok(imInstructions(dataDir.replaceAll("'", 'x'), 'claude', epoch, [root]).length < PARENT_TEXT_MAX, 'the unescaped spelling would fit, so shell quoting is material');
  assert.throws(() => store.save({ expectedRevision: 0, config: enabled([root]) }), { code: 'IM_BOOTSTRAP_TOO_LARGE' });
  assert.throws(() => readFileSync(absent), { code: 'ENOENT' });
  const normal = new ImSettingsStore(join(root, 'normal-store'));
  const paths = Array.from({ length: 12 }, (_, n) => { const path = join(root, `项目-${n}-quoted'\\name`); mkdirSync(path); return path; });
  const saved = normal.save({ expectedRevision: 0, config: enabled(paths) });
  assert.deepEqual(saved.config.workspaces, paths);
  const text = imInstructions(join(root, 'normal-store'), 'claude', epoch, paths);
  assert.ok(text.includes(JSON.stringify(paths)));
  assert.ok(text.length <= PARENT_TEXT_MAX);
});

test('system rules route entry Master to the single reference and keep the instance-specific wiring', () => {
  const paths = ['/projects/fake', "/projects/项目 'quoted'"];
  const text = imInstructions('/data', 'opencode', epoch, paths);
  assert.match(text, /入口 Master/);
  assert.match(text, /不是执行 owner/);
  assert.match(text, /references\/master-guideline\.md/);
  assert.ok(text.includes(`sessionRef=im:${epoch}`));
  assert.ok(text.includes('engineKind=opencode'));
  assert.ok(text.includes("weaver --data-dir '/data'"));
  assert.ok(text.includes(JSON.stringify(paths)));
  assert.match(text, /tasks\.create.*ownerProfileId.*workspace/);
  assert.match(text, /tasks\.start/);
  assert.match(text, /owners\.attach/);
  assert.match(text, /Bot启动cwd为home/);
  assert.match(text, /不限制\/代替实际项目路径/);
  assert.match(text, /跨\s*engine/);
  assert.match(text, /白名单不是无限授权/);
  assert.match(text, /项目读写与实际工作限定/);
  assert.match(text, /环境接线.*不扩展项目访问授权/);
  assert.match(text, /不读取凭据或其他项目/);
  assert.match(text, /Markdown/);
  assert.match(text, /<weaver-actions>/);
  assert.match(text, /公开输出/);
  // The full Markdown rules and the strict actions JSON example live in the reference only.
  assert.ok(!text.includes('用**加粗**点到为止'));
  assert.ok(!text.includes('{"actions":[{"label":"继续排查"'));
  // The long scheduling procedure belongs to the reference, not to a second copy here.
  assert.ok(!text.includes('tasks.start的立即ACK'));
  assert.ok(!text.includes('同一批同一项目'));
});

test('the fixed identity prompt is initialization-only and exposes the stable ready marker', () => {
  const prompt = imMasterIdentityPrompt();
  assert.equal(prompt, imMasterIdentityPrompt());
  assert.ok(prompt.length < 500);
  assert.equal(IM_MASTER_READY_MARKER, 'WEAVER_MASTER_READY');
  assert.match(prompt, /agents-weaver/);
  assert.match(prompt, /references\/master-guideline\.md/);
  assert.match(prompt, /只做身份初始化/);
  assert.match(prompt, /不执行实际工作/);
  assert.match(prompt, /不创建 task\/owner/);
  assert.match(prompt, /不调用 owners\.attach/);
  assert.ok(prompt.includes(IM_MASTER_READY_MARKER));
  assert.match(prompt, /保持待命/);
  assert.match(prompt, /等待真实用户消息/);
});

test('the entry skill links the Master reference and the reference exists in the repository skill', () => {
  const repositorySkill = readFileSync(new URL('../../skills/agents-weaver/SKILL.md', import.meta.url), 'utf8');
  const repositoryReference = readFileSync(new URL('../../skills/agents-weaver/references/master-guideline.md', import.meta.url), 'utf8');
  assert.match(repositorySkill, /references\/master-guideline\.md/);
  assert.match(repositoryReference, /# Entry Master guideline/);
  assert.match(repositoryReference, /owners\.attach/);
  assert.match(repositoryReference, /ownerProfileId/);
  assert.match(repositoryReference, /ownerHost/);
  assert.match(repositoryReference, /never limits or replaces the real project path/);
  assert.match(repositoryReference, /## Public output/);
  assert.match(repositoryReference, /blank line between paragraphs/);
  assert.match(repositoryReference, /never a bare URL/);
  assert.match(repositoryReference, /no HTML/i);
  assert.ok(repositoryReference.includes('<weaver-actions>{"actions":[{"label":"继续排查"'));
  assert.match(repositoryReference, /new-session/);
  assert.match(repositoryReference, /grants no project access/);
});

test('save-time budget reserves the full UUID epoch and the longer supported engine kind', () => {
  const paths = ['/projects/fake'];
  const base = imInstructions('/data', 'codex', epoch, paths);
  const dataDir = '/data' + 'x'.repeat(PARENT_TEXT_MAX - base.length);
  assert.equal(imInstructions(dataDir, 'codex', epoch, paths).length, PARENT_TEXT_MAX);
  assert.throws(() => validateImInstructionBudget(dataDir, paths), { code: 'IM_BOOTSTRAP_TOO_LARGE' });
  const shortEpochBase = imInstructions('/data', 'claude', 'x', paths);
  const shortEpochDir = '/data' + 'x'.repeat(PARENT_TEXT_MAX - shortEpochBase.length);
  assert.equal(imInstructions(shortEpochDir, 'claude', 'x', paths).length, PARENT_TEXT_MAX);
  assert.throws(() => validateImInstructionBudget(shortEpochDir, paths), { code: 'IM_BOOTSTRAP_TOO_LARGE' });
});
