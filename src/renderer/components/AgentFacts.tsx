import type { ReactNode } from 'react';
import { CopyButton } from '@lobehub/ui';
import { Descriptions, Text } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import { dispatchKind, ownerLabel, taskOwnerId } from '../task-view';
import { AgentLabel } from './EngineIcon';
import { factsStyles } from './agent-facts-style';

const COLUMNS = 3;

/** Compact key/value pair of a board card. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <>
    <dt className={factsStyles.key}>{label}</dt>
    <dd className={factsStyles.value}>{children}</dd>
  </>;
}

/** `engine / model · effort`, each part only when recorded. */
export function modelText(task: Task): string | undefined {
  const dispatch = task.dispatch;
  if (!dispatch) return undefined;
  return [[dispatch.engine, dispatch.model].filter(Boolean).join(' / '), dispatch.effort].filter(Boolean).join(' · ') || undefined;
}

/**
 * Who owns the work, who runs it and where. Compact (board cards) is the parent agent alone; the full block is one
 * three-column Descriptions: sub agent, model and update time on the first row, parent agent and workspace on the second.
 */
export function AgentFacts({ task, ownerKind, compact }: { task: Task; ownerKind?: (ownerId?: string) => string | undefined; compact?: boolean }) {
  const dispatch = task.dispatch;
  const parent = <AgentLabel kind={ownerKind?.(taskOwnerId(task))} name={ownerLabel(task)} />;
  if (compact) return <dl className={factsStyles.gridCompact}><Fact label="父 Agent">{parent}</Fact></dl>;
  const workspace = dispatch?.workspace || task.workspace;
  const model = modelText(task);
  const first = [
    dispatch?.worker ? { key: 'worker', label: '子 Agent', children: <AgentLabel kind={dispatchKind(task)} name={dispatch.worker} /> } : undefined,
    model ? { key: 'model', label: '模型', children: <Text ellipsis={{ rows: 1, tooltip: model }}>{model}</Text> } : undefined,
    { key: 'updated', label: '更新时间', children: <time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString()}</time> },
  ].filter(item => !!item);
  // The last item of a short first row takes the free columns so the second row always starts on a new line.
  const items = [
    ...first.map((item, index) => index === first.length - 1 ? { ...item, span: COLUMNS - index } : item),
    { key: 'owner', label: '父 Agent', children: parent },
    ...(workspace ? [{ key: 'workspace', label: '工作目录', span: COLUMNS - 1, children: <span className={factsStyles.value}>
      <Text className={factsStyles.path} ellipsis={{ rows: 1, tooltip: workspace }}>{workspace}</Text>
      <CopyButton aria-label="复制工作目录" content={workspace} size="small" title="复制工作目录" />
    </span> }] : []),
  ];
  return <Descriptions className={factsStyles.descriptions} colon={false} column={COLUMNS} items={items} />;
}
