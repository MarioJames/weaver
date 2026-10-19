import type { ReactNode } from 'react';
import { CopyButton } from '@lobehub/ui';
import { Text } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import { dispatchKind, ownerLabel, taskOwnerId } from '../task-view';
import { AgentLabel } from './EngineIcon';
import { factsStyles } from './agent-facts-style';

/** One key/value pair of the block. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <>
    <dt className={factsStyles.key}>{label}</dt>
    <dd className={factsStyles.value}>{children}</dd>
  </>;
}

/** Who owns the work, who runs it and where: the facts a task record is keyed by, each hidden when unrecorded. */
export function AgentFacts({ task, ownerKind, compact }: { task: Task; ownerKind?: (ownerId?: string) => string | undefined; compact?: boolean }) {
  const dispatch = task.dispatch;
  const workspace = dispatch?.workspace || task.workspace;
  return <dl className={compact ? factsStyles.gridCompact : factsStyles.grid}>
    <Fact label="父 Agent"><AgentLabel kind={ownerKind?.(taskOwnerId(task))} name={ownerLabel(task)} /></Fact>
    {!compact && dispatch?.worker && <Fact label="Worker"><AgentLabel kind={dispatchKind(task)} name={dispatch.worker} /></Fact>}
    {!compact && workspace && <Fact label="工作目录">
      <Text className={factsStyles.path} ellipsis={{ rows: 1, tooltip: workspace }}>{workspace}</Text>
      <CopyButton aria-label="复制工作目录" content={workspace} size="small" title="复制工作目录" />
    </Fact>}
  </dl>;
}
