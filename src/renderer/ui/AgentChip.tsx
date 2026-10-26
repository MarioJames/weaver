import * as stylex from '@stylexjs/stylex';
import { EngineIcon } from './EngineIcon';
import { agentChipStyles } from './agent-chip-style';

export interface AgentChipProps {
  kind?: string;
  name: string;
  title?: string;
}

/** Engine mark plus a one-line Agent name; the full name is always available on hover. */
export function AgentChip({ kind, name, title }: AgentChipProps) {
  return <span title={title ?? name} {...stylex.props(agentChipStyles.root)}>
    <EngineIcon kind={kind} />
    <span {...stylex.props(agentChipStyles.name)}>{name}</span>
  </span>;
}
