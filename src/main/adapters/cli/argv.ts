import type { RealEngineKind } from '../../../shared/contracts/tasks';

const PI_THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** dsh reasoningEffort vocabulary (dsh-llm-deepseek README: off | low | high | max). */
const DSH_EFFORTS = new Set(['off', 'low', 'high', 'max']);

export interface LaunchSpec {
  argv: string[];
  /** Prompt bytes written to the child stdin, or null when the CLI reads a private file. */
  stdin: string | null;
}

/**
 * The per-run dsh patch-list overlay (applied after the headless profile layer).
 * Pins the requested model and reasoning effort plus the unattended permission posture,
 * and carries no credential material.
 *
 * Credential basis (see package READMEs under
 * @deepseek-ai/dsh/node_modules/@deepseek-ai):
 * - dsh-llm-deepseek-api-key/README.md: `apiKeyEnv` defaults to DEEPSEEK_API_KEY and
 *   "When the credentials service exists, its precedence applies; only compositions
 *   without that service read the launch environment directly".
 * - dsh-credentials-local/README.md: "lookup precedence: the stored file wins, followed
 *   by the launch environment, the project's `.env`, and the harness-home `.env`".
 * - dsh-llm-deepseek/README.md: "`deepseek-official` resolves only its configured
 *   API-key reference" (no account fallback).
 * Headless disables the local credential service by default, so the overlay re-enables
 * exactly one entry (`credentials` / dsh-credentials-local) with `disabled: false`.
 * `authorization` and `deepseek-account` stay disabled (headless default): enabling
 * authorization would register an interactive sign-in surface instead of failing closed.
 * With the service present, both the stored ~/.dsh/.credentials.yaml ref (DEEPSEEK_API_KEY)
 * and the launch/project/home environment layers resolve; the overlay itself never
 * contains a credential value and Weaver never reads the credential file.
 *
 * Permission choice: explicit `workspace-write` sandbox with `ask` approval.
 * Repeating the standing mode needs no approval (dsh-tool-bash/dsh-tool-fs: sandbox
 * denials are retried once with wider `sandbox_permissions` plus user approval), so
 * in-workspace file reads/writes and command runs proceed without interaction, while
 * any escalation beyond the workspace boundary routes to `ask` and fails closed in
 * headless (no answerer is composed; authorization stays disabled). `danger-full-access`
 * is NOT used: it would lift the sandbox boundary workspace-wide and set approval to
 * `never` (deterministic rejection, the opposite of a --yolo auto-approve), which is
 * wider than an unattended worker needs. The literal values also shadow
 * DSH_PERMISSION_MODE for this run, so the server environment cannot widen it back.
 */
export function buildDshOverlayPatch(model: string, effort: string): string {
  if (!DSH_EFFORTS.has(effort)) throw new Error(`dsh reasoningEffort must be one of ${[...DSH_EFFORTS].join(', ')}`);
  const scalar = (value: string): string => JSON.stringify(value);
  return [
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    `    model: ${scalar(model)}`,
    '- id: llm-deepseek',
    '  config:',
    `    reasoningEffort: ${scalar(effort)}`,
    '- id: sandbox-policy',
    '  config:',
    '    mode: workspace-write',
    '    workspaceRoot: !!js process.cwd()',
    '- id: approval',
    '  config:',
    '    policy: ask',
    '- id: credentials',
    '  disabled: false',
    '',
  ].join('\n');
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
  /** dsh only: the private per-run --patch overlay file written by prepare. Unused by every other engine. */
  overlayPath: string;
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
        argv: ['codex', 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '--cd', input.workspace, '--model', input.model, '-c', `model_reasoning_effort="${input.effort}"`, '-'],
      };
    case 'dsh':
      // One-shot headless run: the prompt travels over stdin (task omitted), the child cwd
      // is the workspace (dsh has no --cwd switch), and --patch pins model, reasoning
      // effort and the workspace-write/ask permission posture for this run only.
      // --patch is a launcher flag and must precede the headless app flag --json.
      // Validated here so a bad effort fails before any process starts; the overlay file
      // itself is written by prepareCliAgentInput.
      buildDshOverlayPatch(input.model, input.effort);
      return {
        stdin: input.instruction,
        argv: ['dsh', '--profile', 'headless', '--patch', input.overlayPath, '--json'],
      };
  }
}
