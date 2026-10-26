import { roleChannels } from '../../../shared/policy/channels';
import { dateText } from '../quota/quota-view';
import { blockText, pauseOfBlock } from '../probes/probe-view';
import { channelName, channelLabel } from '../../format/channel-label';
import { statusTagColor } from '../../format/tag-colors';
import type { Availability, Block, Config, Owner, PolicySnapshot, Worker } from '../../../shared/contracts/policy';
import type { Task } from '../../../shared/contracts/tasks';
import type { StatusTone } from '../../format/status-colors';
import { renameRole, roleIdError, type RoleSection } from '../../policy/policy-edit';

export const NAMES: Record<RoleSection, string> = { owners: '父 Agent', workers: '子 Agent' };
export const DESCRIPTIONS: Record<RoleSection, string> = {
  owners: '父 Agent 接收任务并派发给子 Agent。可以为同一引擎配置不同账号的父 Agent。',
  workers: '子 Agent 执行父 Agent 派发的任务包。',
};

/** What the saved policy lets dispatch do with this role right now. */
export function availabilityText(availability: Availability | undefined): string {
  if (!availability) return '尚未保存';
  if (availability.status === 'available') return '可派发';
  if (availability.status === 'disabled') return '已停用';
  if (availability.status === 'channel_disabled') return '渠道未启用';
  return `已限制：${availability.reason ?? '未说明原因'}${availability.release_at ? `，${dateText(availability.release_at)} 恢复` : ''}`;
}

/** The one line a list item needs beyond its switch: only states the switch does not already show. A pause written by the penalty ladders or the free probe also names its kind as a tag. Tag colors come from the shared semantic scheme. */
export function roleNote(availability: Availability | undefined, unsaved: boolean, block?: Block): { text: string; warning?: boolean; tag?: { label: string; color?: string } } | undefined {
  if (unsaved) return { text: availability ? '有未保存的修改' : '尚未保存', warning: true };
  if (availability?.status === 'channel_disabled') return { text: '渠道未启用' };
  if (availability?.status === 'blocked') {
    const pause = pauseOfBlock(block);
    if (pause && block) return { text: blockText(block), warning: true, tag: { label: pause.label, color: statusTagColor(pause.tone) } };
    return { text: availabilityText(availability), warning: true };
  }
  return undefined;
}

/** The bound channels of a role as display names; a disabled channel keeps its suffix. */
export function roleChannelNames(config: Config, role: Owner | Worker): string {
  return roleChannels(role).filter(Boolean).map(id => channelName(config.channels[id], id)).join('、') || '未选账号';
}

export type RoleField = 'channel' | 'model' | 'effort' | 'workers';
export interface RoleFieldIssue { field: RoleField; message: string }

/**
 * Which message a required field shows. A server rejection only exists after
 * a save attempt, so it always shows; the fresh-form client check waits until
 * the user touches the field (or touches every field by clicking save).
 */
export function visibleFieldError(client: string, server: string, touched: boolean): string {
  if (server) return server;
  return touched ? client : '';
}

/** The required choices a role is missing; a new role keeps every one empty until the user fills it. */
export function roleFieldIssues(section: RoleSection, record: Owner | Worker): RoleFieldIssue[] {
  const issues: RoleFieldIssue[] = [];
  if (!roleChannels(record).filter(Boolean).length) issues.push({ field: 'channel', message: section === 'owners' ? '选择账号或渠道。' : '至少选择一个账号或渠道。' });
  if (!record.model.trim()) issues.push({ field: 'model', message: '选择模型。' });
  if (!record.effort.trim()) issues.push({ field: 'effort', message: '选择推理强度。' });
  if (section === 'owners' && !(record as Owner).workers.length) issues.push({ field: 'workers', message: '至少添加一个子 Agent。' });
  return issues;
}

/** Ids whose draft still lacks a required choice; the shared SaveBar waits for all of them. */
export function incompleteRoleIds(config: Config | undefined, section: RoleSection): string[] {
  if (!config) return [];
  return Object.entries(config[section])
    .filter(([, record]) => roleFieldIssues(section, record).length > 0)
    .map(([id]) => id);
}

/** Picker options for every configured channel, so same-named channels on different engines stay distinguishable. */
export function channelOptions(config: Config): { value: string; label: string }[] {
  return Object.entries(config.channels).map(([id, channel]) => ({ value: id, label: channelLabel(channel) }));
}

/** Parents whose dispatch list references this worker, in config order — the child page's reverse reference. */
export function ownerUsersOf(config: Config, workerId: string): string[] {
  return Object.entries(config.owners).filter(([, owner]) => owner.workers.includes(workerId)).map(([id]) => id);
}

/** The first free id for a new role that collides with neither draft nor saved config. */
export function uniqueId(section: RoleSection, config: NonNullable<Config>, saved?: NonNullable<Config>): string {
  let id = 'new';
  let index = 2;
  while (Object.hasOwn(config[section], id) || Object.hasOwn(saved?.[section] ?? {}, id) || roleIdError(section, id, config)) { id = `new${index}`; index += 1; }
  return id;
}

export interface RoleMetrics {
  enabled: number;
  total: number;
  dispatchable: number;
  referenced: number;
  paused: number;
}

/** Object-level counts for the page metric strip. `dispatchable` and `paused` read the saved snapshot, `enabled` and `referenced` the draft on screen. */
export function roleMetrics(config: Config | undefined, snapshot: Pick<PolicySnapshot, 'owners' | 'workers'> | undefined, section: RoleSection): RoleMetrics {
  const roles = config ? Object.entries(config[section]) : [];
  const availability = snapshot?.[section] ?? {};
  const referenced = config
    ? section === 'owners'
      ? new Set(Object.values(config.owners).filter(owner => owner.enabled).flatMap(owner => owner.workers)).size
      : new Set(Object.values(config.owners).flatMap(owner => owner.workers).filter(id => Object.hasOwn(config.workers, id))).size
    : 0;
  return {
    enabled: roles.filter(([, role]) => role.enabled).length,
    total: roles.length,
    dispatchable: Object.values(availability).filter(value => value.status === 'available').length,
    referenced,
    paused: Object.values(availability).filter(value => value.status === 'blocked').length,
  };
}

/** The searchable text of one role: its id, every bound account's id and display name, and the model. */
export function roleSearchText(config: Config, section: RoleSection, id: string): string {
  const role = config[section][id];
  if (!role) return id;
  const channels = roleChannels(role).flatMap(channel => [channel, config.channels[channel]?.label ?? '', config.channels[channel]?.engine ?? '']);
  return [id, ...channels, role.model].join(' ').toLowerCase();
}

/** Ids whose id, account name or model contains the query, in config order. */
export function filterRoleIds(config: Config, section: RoleSection, query: string): string[] {
  const needle = query.trim().toLowerCase();
  const ids = Object.keys(config[section]);
  return needle ? ids.filter(id => roleSearchText(config, section, id).includes(needle)) : ids;
}

export interface RoleStatusView {
  label: string;
  tone: StatusTone;
  hint?: string;
}

/** The state dot of a list row, in the vocabulary of roleNote: the switch already tells enabled from disabled, so the dot leads with dispatchability. */
export function roleStatusView(record: { enabled: boolean }, availability: Availability | undefined, block?: Block): RoleStatusView {
  // A pause is the more specific fact: the switch itself already shows a disabled role.
  if (availability?.status === 'blocked') {
    const pause = pauseOfBlock(block);
    return {
      label: pause?.label ?? '已暂停',
      tone: pause?.tone ?? 'warning',
      hint: block ? blockText(block) : availabilityText(availability),
    };
  }
  if (!record.enabled) return { label: '已停用', tone: 'default', hint: '此 Agent 已停用，不会参与派发。' };
  if (!availability) return { label: '尚未保存', tone: 'warning', hint: '保存后才参与派发。' };
  if (availability.status === 'disabled') return { label: '已停用', tone: 'default' };
  if (availability.status === 'available') return { label: '可用', tone: 'success', hint: '已保存的策略允许派发。' };
  if (availability.status === 'channel_disabled') return { label: '渠道停用', tone: 'warning', hint: '账号或渠道未启用，请在账号与渠道页检查。' };
  return { label: '已暂停', tone: 'warning', hint: availabilityText(availability) };
}

/** The shared ids that are not part of a longest increasing run: the rows a reorder moved. */
function movedRoleIds(draftIds: readonly string[], baseIds: readonly string[]): string[] {
  const base = new Set(baseIds);
  const draft = new Set(draftIds);
  const sharedBase = baseIds.filter(id => draft.has(id));
  const positions = new Map(sharedBase.map((id, index) => [id, index]));
  const sequence = draftIds.filter(id => base.has(id)).map(id => positions.get(id)!);
  if (sequence.length < 2) return [];
  const tails: number[] = [];
  const tailIndexes: number[] = [];
  const previous = new Array<number>(sequence.length).fill(-1);
  for (let index = 0; index < sequence.length; index += 1) {
    const value = sequence[index]!;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle]! < value) low = middle + 1; else high = middle;
    }
    previous[index] = low > 0 ? tailIndexes[low - 1]! : -1;
    tails[low] = value;
    tailIndexes[low] = index;
  }
  const keep = new Set<number>();
  let cursor = tailIndexes[tails.length - 1] ?? -1;
  while (cursor >= 0) { keep.add(cursor); cursor = previous[cursor]!; }
  return draftIds.filter(id => base.has(id)).filter((_, index) => !keep.has(index));
}

/**
 * How many agents across both shared sections differ from the saved policy: the SaveBar's N.
 * A rename is one change, not one delete plus one add: its record is moved onto the saved
 * baseline first so propagated worker references do not count their owners as edited.
 * Reordering counts the rows a longest increasing run leaves out, so a moved row is one agent.
 */
export function dirtyRoleCount(config: Config | undefined, snapshot: { config: Config } | undefined): number {
  if (!config || !snapshot) return 0;
  let baseline = structuredClone(snapshot.config);
  const renamed: Record<RoleSection, Set<string>> = { owners: new Set(), workers: new Set() };
  for (const section of ['owners', 'workers'] as const) {
    const removed = Object.keys(baseline[section]).filter(id => !Object.hasOwn(config[section], id));
    const added = Object.keys(config[section]).filter(id => !Object.hasOwn(baseline[section], id));
    for (const from of removed) {
      const to = added.find(id => !renamed[section].has(id) && JSON.stringify(config[section][id]) === JSON.stringify(baseline[section][from]));
      if (!to) continue;
      baseline = renameRole(baseline, section, from, to);
      renamed[section].add(to);
    }
  }
  const changed = new Set<string>();
  for (const section of ['owners', 'workers'] as const) {
    const ids = new Set([...Object.keys(config[section]), ...Object.keys(baseline[section])]);
    for (const id of ids) {
      if (renamed[section].has(id)) { changed.add(`${section}:${id}`); continue; }
      if (JSON.stringify(config[section][id]) !== JSON.stringify(baseline[section][id])) changed.add(`${section}:${id}`);
    }
    for (const id of movedRoleIds(Object.keys(config[section]), Object.keys(baseline[section]))) changed.add(`${section}:${id}`);
  }
  return changed.size;
}

/** Where the selection falls back after the draft is discarded: the first role when the routed id is gone
 * (a rename that never saved), the section root when no role remains, undefined when the URL stays valid.
 * A manually entered unknown id is not discarded through this path, so the page keeps its 未找到 empty state. */
export function fallbackRoleId(config: Config | undefined, section: RoleSection, routedId: string | undefined): string | undefined {
  if (!config || !routedId || Object.hasOwn(config[section], routedId)) return undefined;
  return Object.keys(config[section])[0] ?? '';
}

/** Move one id to another id's index, the same result the sortable list produces. Unknown ids and no-ops return the input order. */
export function moveRoleOrder(ids: readonly string[], from: string, to: string): string[] {
  const source = ids.indexOf(from);
  const target = ids.indexOf(to);
  if (source < 0 || target < 0 || source === target) return [...ids];
  const next = [...ids];
  next.splice(source, 1);
  next.splice(target, 0, from);
  return next;
}

/** The latest tasks dispatched to one worker, newest first, for the child page's relation section. */
export function recentWorkerTasks(tasks: readonly Task[], workerId: string, limit = 5): Task[] {
  return tasks
    .filter(task => task.dispatch?.worker === workerId)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .slice(0, limit);
}
