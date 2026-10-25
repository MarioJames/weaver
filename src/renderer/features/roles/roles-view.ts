import { roleChannels } from '../../../shared/policy/channels';
import { dateText } from '../quota/quota-view';
import { blockText, pauseOfBlock } from '../probes/probe-view';
import { channelName, channelLabel } from '../../format/channel-label';
import { statusTagColor } from '../../format/tag-colors';
import type { Availability, Block, Config, Owner, Worker } from '../../../shared/contracts/policy';
import { roleIdError, type RoleSection } from '../../policy/policy-edit';

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
  return roleChannels(role).map(id => channelName(config.channels[id], id)).join('、') || '未选账号';
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
