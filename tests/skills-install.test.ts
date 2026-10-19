import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkill, SKILL_NAME, sourceSkill } from '../src/cli/skills';

const files = () => new Map<string, Uint8Array>([['SKILL.md', Buffer.from('---\nname: agents-weaver\n---\n')], ['references/config.md', Buffer.from('config')]]);
function home() { return mkdtempSync(join(tmpdir(), 'weaver-skill-home-')); }

test('install copies the skill to ~/.agents/skills and links Claude Code and Codex to it', () => {
  const h = home();
  try {
    const result = installSkill({ home: h, files: files(), agents: ['claude-code', 'codex'], version: '9.9.9' });
    const canonical = join(h, '.agents/skills', SKILL_NAME);
    assert.equal(result.canonical, canonical);
    assert.equal(readFileSync(join(canonical, 'references/config.md'), 'utf8'), 'config');
    assert.equal(JSON.parse(readFileSync(join(canonical, '.weaver-skill.json'), 'utf8')).version, '9.9.9');
    for (const link of [join(h, '.claude/skills', SKILL_NAME), join(h, '.codex/skills', SKILL_NAME)]) {
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      assert.equal(readlinkSync(link), canonical);
    }
    // A second install updates a Weaver-owned copy in place.
    const again = installSkill({ home: h, files: new Map([['SKILL.md', Buffer.from('v2')]]), agents: ['claude-code'], version: '9.9.10' });
    assert.equal(again.action, 'updated');
    assert.equal(readFileSync(join(canonical, 'SKILL.md'), 'utf8'), 'v2');
    assert.equal(existsSync(join(canonical, 'references/config.md')), false, 'files dropped from the bundle are removed');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('install refuses to replace a skill it does not own unless forced', () => {
  const h = home();
  try {
    const canonical = join(h, '.agents/skills', SKILL_NAME);
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, 'SKILL.md'), 'hand-written');
    assert.throws(() => installSkill({ home: h, files: files(), agents: [], version: '1' }), /SKILL_ALREADY_EXISTS/);
    assert.equal(readFileSync(join(canonical, 'SKILL.md'), 'utf8'), 'hand-written');
    const forced = installSkill({ home: h, files: files(), agents: [], version: '1', force: true });
    assert.equal(forced.action, 'replaced');
    // A foreign link at an agent path is never replaced silently.
    mkdirSync(join(h, '.claude/skills'), { recursive: true });
    symlinkSync('/somewhere/else', join(h, '.claude/skills', SKILL_NAME));
    assert.throws(() => installSkill({ home: h, files: files(), agents: ['claude-code'], version: '1' }), /SKILL_ALREADY_EXISTS/);
    assert.equal(readlinkSync(join(h, '.claude/skills', SKILL_NAME)), '/somewhere/else');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('link mode points the canonical path at a source checkout for development', () => {
  const h = home();
  try {
    const source = join(h, 'repo/skills', SKILL_NAME);
    mkdirSync(source, { recursive: true });
    const result = installSkill({ home: h, files: files(), agents: ['claude-code'], version: '1', linkTo: source });
    assert.equal(readlinkSync(result.canonical), source);
    assert.equal(readlinkSync(join(h, '.claude/skills', SKILL_NAME)), result.canonical);
    assert.equal(installSkill({ home: h, files: files(), agents: ['claude-code'], version: '1', linkTo: source }).action, 'unchanged');
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test('the bundled skill in a source checkout is the repository skill', () => {
  const bundled = sourceSkill();
  assert.match(Buffer.from(bundled.files.get('SKILL.md')!).toString('utf8'), /^---\nname: agents-weaver\n/);
  assert.ok(bundled.files.has('references/handoff.md'));
  assert.ok(bundled.files.has('references/config.md'));
  assert.ok(bundled.files.has('references/convorel.md'));
});
