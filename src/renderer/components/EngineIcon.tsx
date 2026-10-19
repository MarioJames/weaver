import type { ComponentType } from 'react';
import { Bot } from 'lucide-react';
import { ClaudeCode, Codex, Grok, OpenCode, Pi, Qoder } from '@lobehub/icons';
import { styles } from '../style';

/** Engine kind -> brand mark. Mono variants color with the text, so they read on light and dark. */
const ENGINE_ICONS: Record<string, ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' | 'false' }>> = {
  claude: ClaudeCode,
  codex: Codex,
  opencode: OpenCode,
  pi: Pi,
  grok: Grok,
  qodercli: Qoder,
  qoder: Qoder,
};

/** Brand icon of an engine kind, hidden from assistive tech: the adjacent text carries the name. */
export function EngineIcon({ kind, size = 14 }: { kind?: string; size?: number }) {
  const Icon = kind ? ENGINE_ICONS[kind.toLowerCase()] : undefined;
  return Icon ? <Icon size={size} aria-hidden="true" /> : <Bot size={size} aria-hidden="true" />;
}

/** Name with its brand icon in one inline row; callers keep the audible text. */
export function AgentLabel({ kind, name }: { kind?: string; name: string }) {
  return <span className={styles.agentLabel}><EngineIcon kind={kind} />{name}</span>;
}
