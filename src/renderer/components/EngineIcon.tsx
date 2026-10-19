import type { ComponentType } from 'react';
import { Bot } from 'lucide-react';
import { ClaudeCode, Codex, Grok, OpenCode, Pi, Qoder } from '@lobehub/icons';
import { factsStyles } from './agent-facts-style';

type IconProps = { size?: number; 'aria-hidden'?: boolean | 'true' | 'false' };

/** Engine kind -> brand mark: the brand's own colors where the icon set draws them, the mono mark otherwise. */
const ENGINE_ICONS: Record<string, ComponentType<IconProps>> = {
  claude: ClaudeCode.Color,
  codex: Codex.Color,
  opencode: OpenCode,
  pi: Pi,
  grok: Grok,
  qodercli: Qoder.Color,
  qoder: Qoder.Color,
};

/** Brand icon of an engine kind, hidden from assistive tech: the adjacent text carries the name. */
export function EngineIcon({ kind, size = 14 }: { kind?: string; size?: number }) {
  const Icon = kind ? ENGINE_ICONS[kind.toLowerCase()] : undefined;
  return Icon ? <Icon size={size} aria-hidden="true" /> : <Bot size={size} aria-hidden="true" />;
}

/** Name with its brand icon in one centered inline row; callers keep the audible text. */
export function AgentLabel({ kind, name }: { kind?: string; name: string }) {
  return <span className={factsStyles.label}><EngineIcon kind={kind} />{name}</span>;
}
