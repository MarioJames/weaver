import type { StatusTone } from './status-colors';

/**
 * The one place that decides what a Tag color means. Every `<Tag color=…>` in the renderer
 * takes its value from here, so the same idea is the same color on every page and two
 * different ideas never share a color. Values are `@lobehub/ui` Tag color presets
 * (preset colors and the system colors success/warning/error/processing; see the Tag utils).
 *
 * Identity (purple/geekblue) and billing channel (cyan) are deliberately disjoint from the
 * status scheme {processing, success, warning, error, orange, volcano} so a role label can
 * never be mistaken for a state.
 */
export type TagSemantic =
  | 'neutral'      // 中性 / 次要信息：事件种类、工具计数、引擎名等纯说明（有意选择的灰）
  | 'inProgress'   // 进行中 / 正在探测
  | 'success'      // 成功 / 可用 / 已确认收到
  | 'warning'      // 警告 / 待处理：待确认、已限制、暂时不可用
  | 'error'        // 错误 / 不可用 / 失败
  | 'needsChange'  // 需修改（沿用 volcano）
  | 'stopping'     // 停止中 / 免费额度用完（沿用 orange）
  | 'ownerRole'    // 身份：父 Agent
  | 'childRole'    // 身份：子任务
  | 'fresh'        // 新任务：创建 2 分钟内（task-pins 的 NEW_TASK_WINDOW_MS），看板标题行最前的「新」标识
  | 'freeChannel'; // 计费渠道：免费渠道

export const TAG_COLORS: Record<TagSemantic, string> = {
  neutral: 'gray',
  inProgress: 'processing',
  success: 'success',
  warning: 'warning',
  error: 'error',
  needsChange: 'volcano',
  stopping: 'orange',
  ownerRole: 'purple',
  childRole: 'geekblue',
  fresh: 'magenta',
  freeChannel: 'cyan',
};

/** The color preset a semantic maps to. */
export function tagColor(semantic: TagSemantic): string { return TAG_COLORS[semantic]; }

/** Task status tones read through the same scheme: each tone names exactly one semantic. */
export const TONE_TAG_COLORS: Record<Exclude<StatusTone, 'default'>, string> = {
  processing: TAG_COLORS.inProgress,
  warning: TAG_COLORS.warning,
  success: TAG_COLORS.success,
  error: TAG_COLORS.error,
  orange: TAG_COLORS.stopping,
  volcano: TAG_COLORS.needsChange,
};

/** A task status tone as a Tag color; 'default' means "no color": the Tag's own plain look. */
export function statusTagColor(tone: StatusTone): string | undefined {
  return tone === 'default' ? undefined : TONE_TAG_COLORS[tone];
}
