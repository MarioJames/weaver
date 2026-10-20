import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { LocalIPCError } from '../../main/local-ipc';
import { VERSION } from '../../shared/version';
import { installSkill, SKILL_AGENTS, SKILL_NAME, sourceSkill, type SkillAgent } from '../skills';
import { writeEnvelope, type OutputFormat } from '../output';

export const SKILLS_HELP = `weaver skills install [--agent claude-code,codex] [--dir <skills-root>] [--link] [--force] [--output json|text]

Installs the ${SKILL_NAME} skill this executable carries. It does not need a running control plane.

  --agent  Agents to link: claude-code (~/.claude/skills), codex (~/.codex/skills), comma-separated. Default both.
  --dir    Install into <skills-root>/${SKILL_NAME} instead of ~/.agents/skills, with no agent links.
  --link   Link to this source checkout's skills/${SKILL_NAME} instead of copying, so edits apply at once.
  --force  Replace a skill or agent link at those paths that weaver did not install.

The copy goes to ~/.agents/skills/${SKILL_NAME} and each agent path links to it. Rerunning updates a copy weaver installed.`;

export function runSkills(argv: string[], words: string[]): number {
  if (words.length !== 2 || words[1] !== 'install') throw new LocalIPCError('INVALID_ARGUMENT', 'Usage: weaver skills install [--agent claude-code,codex] [--dir <skills-root>] [--link] [--force]');
  let agents: SkillAgent[] = [...SKILL_AGENTS];
  let dir: string | undefined;
  let link = false;
  let force = false;
  let output: OutputFormat = 'text';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === 'skills' || arg === 'install') continue;
    if (arg === '--link') link = true;
    else if (arg === '--force') force = true;
    else if (arg === '--json') output = 'json';
    else if (arg === '--output') { const value = argv[++i]; if (value !== 'json' && value !== 'text') throw new LocalIPCError('INVALID_ARGUMENT', '--output must be json or text'); output = value; }
    else if (arg === '--agent') {
      const value = argv[++i] ?? '';
      const chosen = value.split(',').map(item => item.trim()).filter(Boolean);
      if (!chosen.length || chosen.some(item => !(SKILL_AGENTS as readonly string[]).includes(item))) throw new LocalIPCError('INVALID_ARGUMENT', '--agent takes claude-code, codex, or claude-code,codex');
      agents = chosen as SkillAgent[];
    } else if (arg === '--dir') {
      const value = argv[++i];
      if (!value || !isAbsolute(value)) throw new LocalIPCError('INVALID_ARGUMENT', '--dir must be an absolute path');
      dir = value;
    } else throw new LocalIPCError('INVALID_ARGUMENT', `Unknown skills argument: ${arg}`);
  }
  const source = sourceSkill();
  if (link && !source.dir) throw new LocalIPCError('INVALID_ARGUMENT', '--link needs a source checkout; this executable carries its own copy');
  let result;
  try { result = installSkill({ home: homedir(), files: source.files, agents, dir, force, version: VERSION, linkTo: link ? source.dir : undefined }); }
  catch (error) { throw new LocalIPCError(String((error as Error).message).split(':')[0] || 'SKILL_INSTALL_FAILED', (error as Error).message); }
  if (output === 'json') writeEnvelope('json', { apiVersion: 'weaver.v1', ok: true, data: { skill: SKILL_NAME, version: VERSION, ...result } });
  else process.stdout.write(`${result.action} ${SKILL_NAME} at ${result.canonical}${result.links.length ? `\nlinked ${result.links.join(', ')}` : ''}\n`);
  return 0;
}
