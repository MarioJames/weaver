import type { Channel } from '../../shared/contracts/channels';

/** Every channel display marks a disabled channel with this suffix so it is never silently selectable. */
const DISABLED = '（渠道停用）';

/** Short display for list rows and reverse references: the label, falling back to the id. */
export function channelName(channel: Channel | undefined, id: string): string {
  return `${channel?.label ?? id}${channel?.enabled ? '' : DISABLED}`;
}

/** Full display for pickers: label · engine, so same-named channels on different engines stay distinguishable. */
export function channelLabel(channel: Channel): string {
  return `${channel.label} · ${channel.engine}${channel.enabled ? '' : DISABLED}`;
}
