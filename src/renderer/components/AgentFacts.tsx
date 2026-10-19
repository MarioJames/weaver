import { useEffect, useRef, useState } from 'react';
import { formatDate } from '../log-view';
import { CopyButton } from '@lobehub/ui';
import { Descriptions, Text, Tooltip } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import { dispatchKind, ownerLabel, taskOwnerId } from '../task-view';
import { AgentLabel } from './EngineIcon';
import { factsStyles } from './agent-facts-style';
import { styles } from '../style';

/** `engine / model · effort`, each part only when recorded. */
export function modelText(task: Task): string | undefined {
  const dispatch = task.dispatch;
  if (!dispatch) return undefined;
  return [[dispatch.engine, dispatch.model].filter(Boolean).join(' / '), dispatch.effort].filter(Boolean).join(' · ') || undefined;
}

/**
 * Who owns the work, who runs it and where. Compact (board cards) is the parent agent alone; the full block is one
 * responsive Descriptions: sub agent, model and update time on the first row, parent agent and workspace on the second.
 */
export function AgentFacts({ task, ownerKind, compact }: { task: Task; ownerKind?: (ownerId?: string) => string | undefined; compact?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(3);
  useEffect(() => {
    const element = root.current;
    if (!element || compact) return;
    const measure = () => { const width = element.getBoundingClientRect().width; setColumns(width < 560 ? 1 : width < 840 ? 2 : 3); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact]);
  const dispatch = task.dispatch;
  const parent = <AgentLabel kind={ownerKind?.(taskOwnerId(task))} name={ownerLabel(task)} />;
  if (compact) return <span className={styles.cardParent} aria-label={`父 Agent：${ownerLabel(task)}`} title={ownerLabel(task)}>{parent}</span>;
  const workspace = dispatch?.workspace || task.workspace;
  const model = modelText(task);
  const first = [
    dispatch?.worker ? { key: 'worker', label: '子 Agent', children: <Tooltip title={dispatch.worker}><AgentLabel kind={dispatchKind(task)} name={dispatch.worker} /></Tooltip> } : undefined,
    model ? { key: 'model', label: '模型', children: <Text ellipsis={{ rows: 1, tooltip: model }}>{model}</Text> } : undefined,
    { key: 'updated', label: '更新时间', children: <time title={formatDate(task.updatedAt)} dateTime={task.updatedAt}>{formatDate(task.updatedAt)}</time> },
  ].filter(item => !!item);
  // The last item of a short first row takes the free columns so the second row always starts on a new line.
  const items = [
    ...first.map((item, index) => index === first.length - 1 ? { ...item, span: Math.max(1, columns - index % columns) } : item),
    { key: 'owner', label: '父 Agent', children: <Tooltip title={ownerLabel(task)}>{parent}</Tooltip> },
    ...(workspace ? [{ key: 'workspace', label: '工作目录', span: Math.max(1, columns - 1), children: <span className={factsStyles.value}>
      <Text className={factsStyles.path} ellipsis={{ rows: 1, tooltip: workspace }}>{workspace}</Text>
      <CopyButton aria-label="复制工作目录" content={workspace} size="small" title="复制工作目录" />
    </span> }] : []),
  ];
  return <Descriptions ref={root} className={factsStyles.descriptions} colon={false} column={columns} items={items} />;
}
