import { Tag } from '@lobehub/ui';
import { TAG_COLORS } from '../format/tag-colors';

/**
 * The one badge for sub agents on the free channel. It renders only where the caller already
 * knows the worker is free (`free_channel === true` in the policy config); a paid or unknown
 * worker gets nothing. Its color comes from the freeChannel semantic and is shared by the
 * role list, the schedule weights, board cards and the child task list.
 */
export function FreeChannelTag(props: { className?: string; title?: string }) {
  return <Tag size="small" color={TAG_COLORS.freeChannel} title={props.title ?? '此子 Agent 使用免费渠道'} className={props.className}>免费渠道</Tag>;
}
