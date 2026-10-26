import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button, Empty, Input, Segmented, Tag } from '@lobehub/ui';
import type { SelectProps } from '@lobehub/ui';
import { ArrowLeft, ChevronDown, ChevronRight, Pin, Search, TriangleAlert } from 'lucide-react';
import { VList } from 'virtua';
import type { Task } from '../../../shared/contracts/tasks';
import type { TaskHealth } from '../../../shared/contracts/monitoring';
import { routeHref } from '../../app/router';
import { command } from '../../api/commands';
import { displayStatus } from '../../format/status-colors';
import { tagColor } from '../../format/tag-colors';
import { AgentChip } from '../../ui/AgentChip';
import { EntityLink } from '../../ui/EntityLink';
import { GroupHeading } from '../../ui/GroupHeading';
import { StatusBadge } from '../../ui/StatusBadge';
import { TimeText } from '../../ui/TimeText';
import { EngineIcon } from '../../ui/EngineIcon';
import { FreeChannelTag } from '../../ui/FreeChannelTag';
import { NamedSelect } from '../../ui/NamedControls';
import { HEALTH_LABELS } from './TaskHealthBadge';
import { cardFooter } from './task-footer';
import { isPinned, type TaskPins } from './task-pins';
import type { WorkbenchBoard } from './task-persistence';
import { needsAttention } from './task-attention';
import { cardOwner, dispatchKind, taskTitle } from './task-view';
import {
  BOARD_COLUMNS, applyBoardFilters, boardColumnCounts, boardGroupKey, boardOwnerOptions,
  boardVisible, boardWorkspaceOptions, columnizeBoard, groupBoardColumn, isBoardHealthAlert,
  isGroupCollapsed,
  type BoardColumnKey, type BoardGroup,
} from './task-board';
import { boardStyles } from './board-style';

export type { BoardColumnKey };

type LaneRow =
  | { kind: 'heading'; key: string; group: BoardGroup }
  | { kind: 'card'; key: string; task: Task };

function laneRows(groups: BoardGroup[], column: BoardColumnKey, collapsed: Record<string, boolean>, pins: TaskPins): LaneRow[] {
  const rows: LaneRow[] = [];
  for (const group of groups) {
    rows.push({ kind: 'heading', key: `group:${column}:${group.workspace}`, group });
    if (isGroupCollapsed(collapsed, column, group.workspace)) continue;
    const pinned = group.tasks.filter(task => isPinned(pins, task.id)).sort((a, b) => (pins[b.id] ?? 0) - (pins[a.id] ?? 0));
    const zone = new Set(pinned.map(task => task.id));
    for (const task of [...pinned, ...group.tasks.filter(task => !zone.has(task.id))]) {
      rows.push({ kind: 'card', key: task.id, task });
    }
  }
  return rows;
}

const multiProps: Partial<SelectProps> = { mode: 'multiple', allowClear: true };

export interface TaskBoardViewProps {
  tasks: Task[];
  now: number;
  narrow: boolean;
  prefs: WorkbenchBoard;
  onPrefsChange: (next: WorkbenchBoard) => void;
  pins: TaskPins;
  onTogglePin: (id: string) => void;
  selectedId?: string;
  onSelect: (id: string) => void;
  freeChannel?: (workerId?: string) => boolean;
  inspector?: ReactNode;
}

export function TaskBoardView({
  tasks, now, narrow, prefs, onPrefsChange, pins, onTogglePin, selectedId, onSelect, freeChannel, inspector,
}: TaskBoardViewProps) {
  const visible = boardVisible(tasks, now);
  const filtered = applyBoardFilters(visible, prefs);
  const columns = columnizeBoard(filtered);
  const groups = {
    queued: groupBoardColumn(columns.queued),
    running: groupBoardColumn(columns.running),
    review: groupBoardColumn(columns.review),
    closed: groupBoardColumn(columns.closed),
  } satisfies Record<BoardColumnKey, BoardGroup[]>;
  const counts = boardColumnCounts(filtered);
  const hasFilter = prefs.query.trim() !== '' || prefs.workspaces.length > 0 || prefs.owners.length > 0;
  const clearFilters = () => onPrefsChange({ ...prefs, query: '', workspaces: [], owners: [] });
  const toggleGroup = (column: BoardColumnKey, workspace: string) => {
    const key = boardGroupKey(column, workspace);
    const next = isGroupCollapsed(prefs.collapsed, column, workspace);
    onPrefsChange({ ...prefs, collapsed: { ...prefs.collapsed, [key]: !next } });
  };

  const [activeState, setActiveState] = useState<BoardColumnKey>('queued');
  const total = counts.queued + counts.running + counts.review + counts.closed;
  const active: BoardColumnKey = (counts[activeState] > 0 || total === 0)
    ? activeState
    : (BOARD_COLUMNS.find(column => counts[column.key] > 0)?.key ?? 'queued');

  const workspaceOptions = boardWorkspaceOptions(visible);
  const ownerOptions = boardOwnerOptions(visible);

  const renderColumn = (column: BoardColumnKey, label: string) => {
    const rows = laneRows(groups[column], column, prefs.collapsed, pins);
    return (
      <section key={column} aria-label={`${label}列`} {...stylex.props(boardStyles.column(column))}>
        <div {...stylex.props(boardStyles.columnHead)}>
          <span {...stylex.props(boardStyles.columnTitle(column))}>
            <span>{label}</span>
            <span {...stylex.props(boardStyles.columnCount)}>{counts[column]}</span>
          </span>
        </div>
        {rows.length === 0 ? (
          <div {...stylex.props(boardStyles.emptyColumn)}>暂无任务</div>
        ) : (
          <VList
            data={rows}
            ssrCount={typeof window === 'undefined' ? 40 : undefined}
            className={stylex.props(boardStyles.lane).className}
          >
            {row => row.kind === 'heading' ? (
              <div key={row.key} {...stylex.props(boardStyles.laneRow)}>
                <button
                  type="button"
                  aria-expanded={!isGroupCollapsed(prefs.collapsed, column, row.group.workspace)}
                  onClick={() => toggleGroup(column, row.group.workspace)}
                  title={row.group.workspace || row.group.label}
                  {...stylex.props(boardStyles.groupToggle)}
                >
                  {isGroupCollapsed(prefs.collapsed, column, row.group.workspace)
                    ? <ChevronRight size={14} aria-hidden="true" />
                    : <ChevronDown size={14} aria-hidden="true" />}
                  <GroupHeading label={row.group.label} count={row.group.tasks.length} title={row.group.workspace || row.group.label} />
                </button>
              </div>
            ) : (
              <div key={row.key} {...stylex.props(boardStyles.laneRow)}>
                <BoardCard
                  task={row.task}
                  tasks={tasks}
                  now={now}
                  pins={pins}
                  onTogglePin={onTogglePin}
                  selected={selectedId === row.task.id}
                  onSelect={onSelect}
                  freeChannel={freeChannel}
                />
              </div>
            )}
          </VList>
        )}
        {column === 'closed' && (
          <div {...stylex.props(boardStyles.moreRow)}>
            <EntityLink route={{ page: 'tasks', view: 'all' }} title="在全部任务中查看">查看更早的任务</EntityLink>
          </div>
        )}
      </section>
    );
  };

  return (
    <div {...stylex.props(boardStyles.boardWrap)}>
      <div {...stylex.props(boardStyles.toolbar)}>
        <Input
          allowClear
          aria-label="搜索看板"
          placeholder="搜索任务、子 Agent、工作目录"
          prefix={<Search size={14} />}
          value={prefs.query}
          onChange={event => onPrefsChange({ ...prefs, query: event.target.value })}
          {...stylex.props(boardStyles.search)}
        />
        <NamedSelect
          aria-label="工作目录"
          placeholder="工作目录"
          value={prefs.workspaces}
          options={workspaceOptions}
          onChange={value => onPrefsChange({ ...prefs, workspaces: Array.isArray(value) ? value.map(String) : [] })}
          {...multiProps}
          {...stylex.props(boardStyles.select)}
        />
        <NamedSelect
          aria-label="父 Agent"
          placeholder="父 Agent"
          value={prefs.owners}
          options={ownerOptions.map(option => ({ value: option.value, label: option.label }))}
          onChange={value => onPrefsChange({ ...prefs, owners: Array.isArray(value) ? value.map(String) : [] })}
          {...multiProps}
          {...stylex.props(boardStyles.select)}
        />
        {hasFilter && <Button size="small" onClick={clearFilters}>清除筛选</Button>}
      </div>
      {narrow && (
        <Segmented
          aria-label="状态列"
          value={active}
          options={BOARD_COLUMNS.map(column => ({ value: column.key, label: `${column.label} ${counts[column.key]}` }))}
          onChange={value => setActiveState(value as BoardColumnKey)}
        />
      )}
      {filtered.length === 0 ? (
        <div {...stylex.props(boardStyles.boardScroll)}>
          <Empty
            title={tasks.length === 0 ? '还没有任务' : '没有匹配的任务'}
            description={tasks.length === 0 ? undefined : '调整搜索或筛选条件。'}
            action={hasFilter ? <Button size="small" onClick={clearFilters}>清除筛选</Button> : undefined}
          />
        </div>
      ) : (
        <div role="region" aria-label="任务状态列" {...stylex.props(boardStyles.boardScroll)}>
          <div {...stylex.props(boardStyles.columns)}>
            {narrow
              ? renderColumn(active, BOARD_COLUMNS.find(column => column.key === active)!.label)
              : BOARD_COLUMNS.map(column => renderColumn(column.key, column.label))}
          </div>
        </div>
      )}
      {inspector}
    </div>
  );
}

function BoardCard({ task, tasks, now, pins, onTogglePin, selected, onSelect, freeChannel }: {
  task: Task;
  tasks: Task[];
  now: number;
  pins: TaskPins;
  onTogglePin: (id: string) => void;
  selected: boolean;
  onSelect: (id: string) => void;
  freeChannel?: (workerId?: string) => boolean;
}) {
  const status = displayStatus(task);
  const spinning = status === 'running' || status === 'cancelling';
  const owner = cardOwner(task, id => tasks.find(item => item.id === id));
  const footer = cardFooter(task, owner);
  const pinned = isPinned(pins, task.id);
  const attention = needsAttention(task, tasks, now);
  const href = routeHref({ page: 'tasks', view: 'board', taskId: task.id });
  return (
    <div {...stylex.props(boardStyles.card)}>
      <div {...stylex.props(boardStyles.cardHead)}>
        <a
          href={href}
          title={taskTitle(task)}
          data-task-row={task.id}
          aria-current={selected ? 'true' : undefined}
          onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onSelect(task.id);
          }}
          {...stylex.props(boardStyles.cardLink)}
        >
          <span {...stylex.props(boardStyles.cardBadges)}>
            <StatusBadge status={status} />
            {spinning && <BoardHealthBadge taskId={task.id} active />}
          </span>
          <span {...stylex.props(boardStyles.cardTitleText)}>{taskTitle(task)}</span>
        </a>
        <span {...stylex.props(boardStyles.cardIcons)}>
          {attention && (
            <span aria-label="需关注" title="需关注" {...stylex.props(boardStyles.attentionMark)}>
              <TriangleAlert size={14} aria-hidden="true" />
            </span>
          )}
          <button
            type="button"
            aria-pressed={pinned}
            aria-label={pinned ? '取消置顶' : '置顶'}
            title={pinned ? '取消置顶' : '置顶'}
            onClick={() => onTogglePin(task.id)}
            {...stylex.props(boardStyles.pinButton)}
          >
            <Pin size={14} aria-hidden="true" fill={pinned ? 'currentColor' : 'none'} />
          </button>
        </span>
      </div>
      <span {...stylex.props(boardStyles.cardWorker)}>
        {task.dispatch?.worker ? (
          <AgentChip kind={dispatchKind(task)} name={task.dispatch.worker} title={task.dispatch.worker} />
        ) : (
          <span>未派发</span>
        )}
        {task.dispatch?.worker && freeChannel?.(task.dispatch.worker) && <FreeChannelTag title={`子 Agent ${task.dispatch.worker} 使用免费渠道`} />}
      </span>
      <span {...stylex.props(boardStyles.cardFooter)}>
        <span {...stylex.props(boardStyles.cardFooterSeg)}>由 <span title={owner.title} {...stylex.props(boardStyles.cardHost)}>{owner.name}</span> 于 <TimeText value={footer.at} now={now} /> {footer.verb}{footer.tail ? ' ·' : null}</span>
        {footer.tail && <span {...stylex.props(boardStyles.cardFooterSeg)}>{footer.tail.label} <TimeText value={footer.tail.at} now={now} /></span>}
      </span>
    </div>
  );
}

/** 看板卡片的健康徽标：只在异常健康态展示紧凑单 Tag，正常执行中不展示，避免与状态文字重复。 */
export function BoardHealthBadge({ taskId, active }: { taskId: string; active: boolean }) {
  const [health, setHealth] = useState<TaskHealth>();
  useEffect(() => {
    setHealth(undefined);
    if (!active) return;
    let current = true;
    const load = () => { void command<TaskHealth>('tasks.health', { taskId }).then(value => { if (current) setHealth(value); }).catch(() => { /* health is evidence, not a page failure */ }); };
    load();
    const timer = setInterval(load, 5_000);
    return () => { current = false; clearInterval(timer); };
  }, [taskId, active]);
  if (!health || !isBoardHealthAlert(health.state)) return null;
  return (
    <span {...stylex.props(boardStyles.cardHealth)}>
      <Tag color={tagColor(health.state === 'stalled' ? 'error' : 'warning')}>{HEALTH_LABELS[health.state]}</Tag>
    </span>
  );
}

/** 看板检查器覆盖层：右侧 560 不透明浮层；Esc 关闭，打开时焦点进入浮层。 */
export function BoardInspectorOverlay({ label, narrow, onClose, children }: {
  label: string;
  narrow: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const frame = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  return (
    <div role="region" aria-label={label} {...stylex.props(boardStyles.overlay)}>
      {narrow && (
        <div {...stylex.props(boardStyles.overlayBack)}>
          <Button size="small" icon={<ArrowLeft size={14} />} onClick={onClose}>返回</Button>
        </div>
      )}
      <div ref={panel} tabIndex={-1} {...stylex.props(boardStyles.overlayBody)}>
        {children}
      </div>
    </div>
  );
}
