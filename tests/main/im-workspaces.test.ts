import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseImWorkspaces, resolveImWorkspaces } from '../../src/main/im/workspaces';
import { ImSettingsStore } from '../../src/main/im/settings';
import { imInstructions } from '../../src/main/im/bootstrap';

const root = mkdtempSync(join(tmpdir(), 'im-workspaces-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const project = (name: string) => { const path = join(root, name); mkdirSync(path); return path; };
const config = (workspaces: string[]) => ({ enabled: false, appId: '', appSecret: '', allowedOpenIds: [], channel: '', model: '', effort: 'medium', workspaces, idleTimeoutMinutes: 30, ownerProfileId: ''});

test('directory list validates boundaries without creating paths or reading their contents', () => {
  const a = project('one'); const b = project('two'); const missing = join(root, 'not-created');
  assert.deepEqual(resolveImWorkspaces([a, b]), [a, b]);
  assert.deepEqual(resolveImWorkspaces([], false), []);
  assert.throws(() => resolveImWorkspaces([]), { code: 'IM_WORKSPACES_INVALID' });
  for (const value of [undefined, null, '', {}, Array(1), [''], ['relative'], [42], [a, a], [a + '\n'], ['/' + 'x'.repeat(2000)], Array(33).fill(a)]) {
    assert.throws(() => parseImWorkspaces(value), { code: 'IM_WORKSPACES_INVALID' });
  }
  assert.deepEqual(parseImWorkspaces([missing]), [missing], 'load is structural even after deletion');
  assert.throws(() => resolveImWorkspaces([missing]), { code: 'IM_WORKSPACES_UNAVAILABLE' });
  const file = join(root, 'file'); writeFileSync(file, 'fixture');
  assert.throws(() => resolveImWorkspaces([file]), { code: 'IM_WORKSPACES_UNAVAILABLE' });
  const all = Array.from({length:32}, (_, n) => project(`p${n}`));
  assert.deepEqual(resolveImWorkspaces(all), all);
});

test('realpath canonicalization accepts one alias but rejects duplicate aliases without replacing settings', () => {
  const path = project('canonical'); const alias = join(root, 'alias'); symlinkSync(path, alias);
  assert.deepEqual(resolveImWorkspaces([alias]), [path]);
  const store = new ImSettingsStore(project('settings')); store.save({expectedRevision:0,config:config([alias])});
  assert.deepEqual(store.current().config.workspaces, [path]); const bytes = readFileSync(store.path, 'utf8');
  assert.throws(() => store.save({expectedRevision:1,config:config([path,alias])}), {code:'IM_SETTINGS_INVALID'});
  assert.equal(readFileSync(store.path,'utf8'), bytes);
  rmSync(path, {recursive:true}); assert.deepEqual(new ImSettingsStore(join(root,'settings')).current().config.workspaces,[path]);
  assert.throws(() => resolveImWorkspaces(store.current().config.workspaces), {code:'IM_WORKSPACES_UNAVAILABLE'});
});

test('credential homes and their descendants/symlink aliases are refused, without reading contents', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR; const credentials = project('fake-credential-home'); const child = join(credentials,'nested'); mkdirSync(child);
  const alias = join(root,'credential-alias'); symlinkSync(child, alias);
  process.env.CLAUDE_CONFIG_DIR = credentials;
  try {
    for (const path of [credentials,child,alias]) assert.throws(() => resolveImWorkspaces([path]), {code:'IM_WORKSPACES_INVALID'});
    // A same-prefix sibling is a different directory and remains allowed.
    const sibling = project('fake-credential-home-sibling'); assert.deepEqual(resolveImWorkspaces([sibling]),[sibling]);
  } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
});

test('dsh credential home, descendants and aliases are refused while home itself stays allowed', () => {
  // Read-only metadata only: never read credential files or directory contents.
  const home = homedir();
  const dsh = join(home, '.dsh');
  const dshChild = join(dsh, 'profiles');
  // Lexical roots stay refused even when absent: no existence check precedes the rejection.
  for (const path of [dsh, dshChild]) assert.throws(() => resolveImWorkspaces([path]), { code: 'IM_WORKSPACES_INVALID' });
  // home itself is the explicit Bot startup cwd and remains an allowed spelling.
  assert.deepEqual(resolveImWorkspaces([home]), [home]);
  // Symlink-alias shielding is proven by the generic credential-root alias fixtures
  // (CLAUDE_CONFIG_DIR and protected-root cases); the real .dsh spelling cannot be
  // isolated from home, so the live-alias check only runs when the metadata target
  // exists. A dangling alias cannot resolve and stays unavailable by design.
  const alias = join(root, 'dsh-alias');
  const targetExists = statSync(dshChild, { throwIfNoEntry: false })?.isDirectory() ?? false;
  symlinkSync(dshChild, alias);
  if (targetExists) assert.throws(() => resolveImWorkspaces([alias]), { code: 'IM_WORKSPACES_INVALID' });
  else assert.throws(() => resolveImWorkspaces([alias]), { code: 'IM_WORKSPACES_UNAVAILABLE' });
});

test('bootstrap gives all paths as JSON data and explicit project-root workflow with stable operation ids', () => {
  const dirs = [join(root,"a 'quoted' $(not-a-command)"), join(root,'项目二')];
  const instructions = imInstructions("/isolated/data 'quoted'", 'codex', 'fixture-epoch', dirs);
  assert.ok(instructions.includes(JSON.stringify(dirs)));
  assert.ok(instructions.includes("weaver --data-dir '/isolated/data '\\''quoted'\\'''"));
  assert.match(instructions, /tasks\.create.*ownerProfileId.*workspace/);
  assert.match(instructions, /tasks\.start --task-id/);
  assert.match(instructions, /command-id/);
  assert.match(instructions, /Bot启动cwd为home/);
  assert.match(instructions, /不限制\/代替实际项目路径/);
});

test('protected root symlink also shields canonical root, descendants and other aliases', async t => {
  const canonical = project('protected-canonical'); const child = join(canonical,'child'); mkdirSync(child);
  const protectedLink = join(root,'protected-link'); const otherAlias = join(root,'protected-other-alias');
  symlinkSync(canonical, protectedLink); symlinkSync(child, otherAlias);
  const previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = protectedLink;
  try {
    for (const [name,path] of [['canonical root',canonical],['canonical descendant',child],['other alias',otherAlias],['lexical root',protectedLink]] as const) {
      await t.test(name, () => assert.throws(() => resolveImWorkspaces([path]), {code:'IM_WORKSPACES_INVALID'}));
    }
    const sibling = project('protected-canonical-sibling'); assert.deepEqual(resolveImWorkspaces([sibling]),[sibling]);
    const absent = join(root,'absent-protected-home'); process.env.CLAUDE_CONFIG_DIR = absent;
    assert.throws(() => resolveImWorkspaces([join(absent,'nested')]), {code:'IM_WORKSPACES_INVALID'});
    assert.deepEqual(resolveImWorkspaces([sibling]),[sibling], 'absent credential roots retain lexical protection without blocking other projects');
  } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
});
