import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imInstructions, validateImInstructionBudget } from '../../src/main/im/bootstrap';
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
  const dataDir = join(root, ...Array.from({ length: 42 }, () => "'".repeat(90)));
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

test('root launch instructions distinguish the immediate request receipt from observed owner-host readiness', () => {
  const text = imInstructions('/fixture', 'codex', epoch, ['/projects/fake']);
  assert.match(text, /tasks\.start.*受理/);
  assert.match(text, /tasks\.get.*tasks\.events/);
  assert.match(text, /ownerHost/);
  assert.match(text, /启动失败/);
});

test('同批同项目单root/复用已有任务/实时分页状态为产品政策', () => {
  const text = imInstructions('/fixture', 'codex', epoch, ['/projects/fake']);
  assert.match(text, /同一批.*同一项目.*一个root|只建一个root/);
  assert.match(text, /拆child|child/);
  assert.match(text, /复用|关联已有任务/);
  assert.match(text, /tasks list|分页/);
  assert.match(text, /root.*child|child.*root/);
  assert.match(text, /running.*queued|queued.*running|review/);
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
