import type { RealEngineKind } from './types';

const PI_THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export interface LaunchSpec {
  argv: string[];
  /** Prompt bytes written to the child stdin, or null when the CLI reads a private file. */
  stdin: string | null;
}

export function buildLaunchSpec(input: {
  engine: RealEngineKind;
  model: string;
  effort: string;
  workspace: string;
  instruction: string;
  promptPath: string;
  sessionDir: string;
  leaderSocket: string;
}): LaunchSpec {
  switch (input.engine) {
    case 'pi':
      if (!PI_THINKING.has(input.effort)) throw new Error(`Pi thinking level is not one of ${[...PI_THINKING].join(', ')}`);
      return {
        stdin: input.instruction,
        argv: ['pi', '--print', '--mode', 'json', '--model', input.model, '--thinking', input.effort, '--no-session', '--session-dir', input.sessionDir, '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--tools', 'read,write,edit,bash', '--approve'],
      };
    case 'opencode':
      return {
        stdin: input.instruction,
        argv: ['opencode', 'run', '--format', 'json', '--model', input.model, '--variant', input.effort, '--pure', '--auto', '--print-logs', '--log-level', 'ERROR', '--dir', input.workspace],
      };
    case 'grok':
      return {
        stdin: null,
        argv: ['grok', '--prompt-file', input.promptPath, '--output-format', 'streaming-messages-json', '--model', input.model, '--effort', input.effort, '--no-subagents', '--no-leader', '--leader-socket', input.leaderSocket, '--permission-mode', 'bypassPermissions'],
      };
    case 'qodercli':
      // User-level settings carry personal hooks and plugins; a worker runs without them, like opencode --pure.
      return {
        stdin: input.instruction,
        argv: ['qodercli', '-p', '-o', 'stream-json', '-m', input.model, '--reasoning-effort', input.effort, '-w', input.workspace, '--permission-mode', 'bypass_permissions', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'],
      };
    case 'codex':
      return {
        stdin: input.instruction,
        argv: ['codex', 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--cd', input.workspace, '--model', input.model, '-c', `model_reasoning_effort="${input.effort}"`, '-'],
      };
  }
}
