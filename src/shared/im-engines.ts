import { EFFORTS } from './policy/settings';

/**
 * Engines whose catalog entry is installed and whose parent/worker adapters are mature enough
 * for a Feishu IM conversation. This is deliberately narrower than the policy schema vocabulary:
 * the other schema kinds have no installed probe and no parent protocol, so the UI must not offer them.
 */
export const IM_ENGINE_KINDS = ['claude', 'codex', 'opencode', 'pi', 'grok', 'qodercli', 'dsh'] as const;
export type ImEngineKind = (typeof IM_ENGINE_KINDS)[number];

const IM_ENGINE_SET: ReadonlySet<string> = new Set(IM_ENGINE_KINDS);

export function isImEngineKind(value: unknown): value is ImEngineKind {
  return typeof value === 'string' && IM_ENGINE_SET.has(value);
}

/** Bounded effort/variant token. OpenCode variants are provider-defined, so no fixed enum is invented. */
export const IM_EFFORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * Fixed effort levels come from the existing policy table. OpenCode returns `undefined` because the
 * native `variant` is a free-form provider/model value; callers then use a bounded text input.
 */
export function imEngineEfforts(kind: ImEngineKind): readonly string[] | undefined {
  if (kind === 'opencode') return undefined;
  const values = EFFORTS[kind];
  return Array.isArray(values) ? values : undefined;
}

/** True only for a fixed level the engine advertises, or a bounded free-form OpenCode variant. */
export function imEngineEffortAllowed(kind: ImEngineKind, effort: unknown): effort is string {
  if (typeof effort !== 'string' || !IM_EFFORT_PATTERN.test(effort)) return false;
  const values = imEngineEfforts(kind);
  return values ? values.includes(effort) : true;
}

const IM_ENGINE_LABELS: Record<ImEngineKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  grok: 'Grok',
  qodercli: 'Qoder',
  dsh: 'DSH',
};

export function imEngineLabel(kind: ImEngineKind): string {
  return IM_ENGINE_LABELS[kind];
}

/** One line the settings UI can show next to a free-form control. */
export function imEffortHint(kind: ImEngineKind): string | undefined {
  return imEngineEfforts(kind) ? undefined : '填写该模型接受的 variant。';
}
