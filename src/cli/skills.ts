import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { embeddedApp } from '../main/embedded';
import { modulePaths } from '../main/runtime';

export const SKILL_NAME = 'agents-weaver';
export type SkillAgent = 'claude-code' | 'codex';
export const SKILL_AGENTS: readonly SkillAgent[] = ['claude-code', 'codex'];
const MARKER = '.weaver-skill.json';

/** The skill this build carries: embedded in a standalone executable, the repository copy otherwise. */
export function sourceSkill(): { files: ReadonlyMap<string, Uint8Array>; dir?: string } {
  const embedded = embeddedApp()?.skill;
  if (embedded) return { files: embedded };
  const dir = join(modulePaths().repo, 'skills', SKILL_NAME);
  const files = new Map<string, Uint8Array>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(relative(dir, full).split(sep).join('/'), readFileSync(full));
    }
  };
  walk(dir);
  return { files, dir };
}

function kind(path: string): 'missing' | 'link' | 'dir' | 'other' {
  try {
    const info = lstatSync(path);
    return info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : 'other';
  } catch { return 'missing'; }
}

function ownedCopy(path: string): boolean {
  try { return JSON.parse(readFileSync(join(path, MARKER), 'utf8')).skill === SKILL_NAME; } catch { return false; }
}

export interface InstallOptions {
  home: string;
  files: ReadonlyMap<string, Uint8Array>;
  agents: readonly SkillAgent[];
  version: string;
  /** Skills root to install into instead of ~/.agents/skills; no agent links are made. */
  dir?: string;
  /** Point the canonical path at this directory (a source checkout) instead of copying. */
  linkTo?: string;
  force?: boolean;
}

export interface InstallResult { canonical: string; links: string[]; action: 'installed' | 'updated' | 'replaced' | 'unchanged' }

/**
 * Copies (or links) the skill to <skills root>/agents-weaver and links each agent's skill
 * directory to it. A copy Weaver installed carries a marker and is updated in place; anything
 * else at those paths is left alone unless `force` is set. Every check runs before any write.
 */
export function installSkill(options: InstallOptions): InstallResult {
  const canonical = join(options.dir ?? join(options.home, '.agents/skills'), SKILL_NAME);
  const links = options.dir ? [] : [...new Set(options.agents)].map(agent => join(options.home, agent === 'claude-code' ? '.claude/skills' : '.codex/skills', SKILL_NAME));
  const existing = kind(canonical);
  const sameLink = existing === 'link' && options.linkTo !== undefined && readlinkSync(canonical) === options.linkTo;
  const owned = existing === 'dir' && ownedCopy(canonical);
  if (existing !== 'missing' && !sameLink && !owned && !options.force) throw new Error(`SKILL_ALREADY_EXISTS: ${canonical} was not installed by weaver skills install; move it away or pass --force`);
  if (existing === 'other' ) throw new Error(`SKILL_PATH_INVALID: ${canonical} is not a directory or link`);
  for (const link of links) {
    const state = kind(link);
    if (state === 'missing' || (state === 'link' && readlinkSync(link) === canonical)) continue;
    if (!options.force || state !== 'link') throw new Error(`SKILL_ALREADY_EXISTS: ${link} is not a link to ${canonical}; move it away${state === 'link' ? ' or pass --force' : ''}`);
  }

  let action: InstallResult['action'] = existing === 'missing' ? 'installed' : sameLink ? 'unchanged' : owned ? 'updated' : 'replaced';
  if (!sameLink) {
    mkdirSync(dirname(canonical), { recursive: true });
    if (options.linkTo) {
      rmSync(canonical, { recursive: true, force: true });
      symlinkSync(options.linkTo, canonical);
    } else {
      // Stage beside the target and swap, so a reader never sees a half-written skill.
      const staged = `${canonical}.staged-${process.pid}`;
      rmSync(staged, { recursive: true, force: true });
      for (const [path, body] of options.files) {
        const file = join(staged, ...path.split('/'));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, body);
      }
      writeFileSync(join(staged, MARKER), `${JSON.stringify({ skill: SKILL_NAME, version: options.version, installedAt: new Date().toISOString() }, null, 2)}\n`);
      if (existing === 'link') rmSync(canonical, { force: true });
      else if (existing === 'dir') { const previous = `${canonical}.previous-${process.pid}`; renameSync(canonical, previous); renameSync(staged, canonical); rmSync(previous, { recursive: true, force: true }); }
      if (kind(canonical) === 'missing') renameSync(staged, canonical);
    }
  }
  for (const link of links) {
    if (kind(link) === 'link' && readlinkSync(link) === canonical) continue;
    mkdirSync(dirname(link), { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(canonical, link);
    if (action === 'unchanged') action = 'updated';
  }
  return { canonical, links, action };
}
