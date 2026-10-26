import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { CopyButton, Descriptions, Text, Tooltip } from '@lobehub/ui';
import type { Task } from '../../../shared/contracts/tasks';
import { dispatchKind, ownerHostName, ownerLabel, taskOwnerId } from './task-view';
import type { cardOwner } from './task-view';
import { AgentLabel } from '../../ui/EngineIcon';
import { TimeText } from '../../ui/TimeText';
import { factsStyles } from './agent-facts-style';
import { taskStyles } from './task-style';

/** `engine / model · effort`, each part only when recorded. */
export function modelText(task: Task): string | undefined {
  const dispatch = task.dispatch;
  if (!dispatch) return undefined;
  return [[dispatch.channelLabel ?? dispatch.channel ?? '历史渠道未记录', dispatch.engine, dispatch.model].filter(Boolean).join(' / '), dispatch.effort].filter(Boolean).join(' · ') || undefined;
}

/**
 * Who owns the work, who runs it and where. Compact (board cards) is the parent agent alone; the full block is one
 * responsive Descriptions: sub agent, model and update time on the first row, parent agent and workspace on the second.
 */
export function AgentFacts({ task, ownerKind, compact, owner }: { task: Task; ownerKind?: (ownerId?: string) => string | undefined; compact?: boolean; owner?: ReturnType<typeof cardOwner> }) {
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
  // A card shows the owner host only: the full instance name also carries the workspace and a session time, and stays in the tooltip.
  const compactName = owner?.name ?? ownerHostName(task);
  const compactTitle = owner?.title ?? ownerLabel(task);
  if (compact) return <span {...stylex.props(taskStyles.cardParent)} aria-label={`父 Agent：${compactName}`} title={compactTitle}><AgentLabel kind={ownerKind?.(taskOwnerId(task))} name={compactName} /></span>;
  const workspace = dispatch?.workspace || task.workspace;
  const model = modelText(task);
  const first = [
    dispatch?.worker ? { key: 'worker', label: '子 Agent', children: <Tooltip title={dispatch.worker}><AgentLabel kind={dispatchKind(task)} name={dispatch.worker} /></Tooltip> } : undefined,
    model ? { key: 'model', label: '模型', children: <Text ellipsis={{ rows: 1, tooltip: model }}>{model}</Text> } : undefined,
    { key: 'updated', label: '更新时间', children: <TimeText className={stylex.props(factsStyles.time).className} value={task.updatedAt} /> },
  ].filter(item => !!item);
  // The last item of a short first row takes the free columns so the second row always starts on a new line.
  const items = [
    ...first.map((item, index) => index === first.length - 1 ? { ...item, span: Math.max(1, columns - index % columns) } : item),
    { key: 'owner', label: '父 Agent', children: <Tooltip title={ownerLabel(task)}>{parent}</Tooltip> },
    ...(workspace ? [{ key: 'workspace', label: '工作目录', span: Math.max(1, columns - 1), children: <span {...stylex.props(factsStyles.value)}>
      <Text className={stylex.props(factsStyles.path).className} ellipsis={{ rows: 1, tooltip: workspace }}>{workspace}</Text>
      <CopyButton aria-label="复制工作目录" content={workspace} size="small" title="复制工作目录" />
    </span> }] : []),
  ];
  return <Descriptions ref={root} classNames={{ label: stylex.props(factsStyles.label).className, content: stylex.props(factsStyles.content).className }} className={stylex.props(factsStyles.descriptions).className} colon={false} column={columns} items={items} />;
}
