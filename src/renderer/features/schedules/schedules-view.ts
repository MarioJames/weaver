import type { ScheduleDefinition, ScheduleInput, ScheduleRun, ScheduleTiming } from '../../../shared/contracts/schedules';
import { QUOTA_INTERVAL_RANGE } from '../../../shared/policy/settings';
import { isValidTimeZone, projectTimeZone } from '../../format/timezone';
import type { StatusTone } from '../../format/status-colors';
import { criteriaLines, workspacePathError } from '../tasks/TaskComposer';

/** The one place a schedule fact becomes UI text: kinds, triggers, run states and timing rules. */
export const KIND_LABELS: Record<ScheduleDefinition['kind'], string> = { script: '脚本', agent: 'Agent' };

export const TRIGGER_LABELS: Record<ScheduleRun['trigger'], string> = { scheduled: '定时', manual: '手动' };

export const RUN_LABELS: Record<ScheduleRun['status'], string> = {
  running: '运行中', succeeded: '已成功', failed: '失败', interrupted: '已中断', skipped: '已跳过', cancelled: '已取消',
};

/** Run states read through the shared task status tones, so the same idea keeps the same color everywhere. */
export const RUN_TONES: Record<ScheduleRun['status'], StatusTone> = {
  running: 'processing', succeeded: 'success', failed: 'error', interrupted: 'error', skipped: 'default', cancelled: 'default',
};

export const BUILTIN_LABEL = '内置';
/** The builtin quota schedule is owned by the quota settings; this names that single source. */
export const BUILTIN_HINT = '由「设置」页「额度」分组同源管理';

export const isBuiltinQuota = (schedule: ScheduleDefinition): boolean => schedule.builtin === 'quota.refresh';

/** A schedule with an active run can neither be deleted nor edited in ways that affect execution. */
export const isRunning = (schedule: ScheduleDefinition): boolean => !!schedule.activeRunId;

/** Interval rules read as text: whole minutes, hours and days collapse, everything else stays in seconds. */
export function intervalText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '间隔无效';
  const units: readonly (readonly [number, string])[] = [[86400, '天'], [3600, '小时'], [60, '分钟']];
  for (const [size, unit] of units) if (seconds >= size && seconds % size === 0) return seconds / size === 1 ? `每${unit}` : `每 ${seconds / size} ${unit}`;
  return `每 ${seconds} 秒`;
}

export function timingText(timing: ScheduleTiming): string {
  return timing.mode === 'interval' ? intervalText(timing.seconds) : `cron ${timing.expression}`;
}

export const INTERVAL_MIN = 1;
export const INTERVAL_MAX = 31_536_000;
export const TIMEOUT_MIN = 1;
export const TIMEOUT_MAX = 86_400;
/** Builtin quota shares the policy settings' single authority: 5–1440 whole minutes. */
export const BUILTIN_INTERVAL_MIN_SECONDS = QUOTA_INTERVAL_RANGE.min * 60;
export const BUILTIN_INTERVAL_MAX_SECONDS = QUOTA_INTERVAL_RANGE.max * 60;
export const INTERVAL_DESC = `两次触发之间间隔的秒数，${INTERVAL_MIN}–${INTERVAL_MAX} 之间的整数。`;
export const TIMEOUT_DESC = `单次执行的最长秒数，${TIMEOUT_MIN}–${TIMEOUT_MAX} 之间的整数；超时后本次运行的进程会被终止。`;
export const WORKSPACE_DESC = '执行时所在的项目目录。请选择 Weaver 所在机器上已存在的绝对路径目录。';
export const BUILTIN_INTERVAL_DESC = `两次刷新之间的分钟数，也是「设置」页「额度」的间隔：${QUOTA_INTERVAL_RANGE.min}–${QUOTA_INTERVAL_RANGE.max} 分钟的整数（${BUILTIN_INTERVAL_MIN_SECONDS}–${BUILTIN_INTERVAL_MAX_SECONDS} 秒，整分钟）。内置任务不接受 cron 表达式。`;
export const CRON_DESC = '5 或 6 个用空格分隔的字段（分 时 日 月 周，可加秒）。支持 L、W、# 等日期规则，保存时会验证表达式。';

/** Client-side cron sanity only: the scheduler stays authoritative. 5/6 fields; the character set is up to the server parser. */
export function cronExpressionError(expression: string): string {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (!fields.length) return '填写 cron 表达式。';
  if (fields.length !== 5 && fields.length !== 6) return '需要 5 或 6 个用空格分隔的字段，例如 */15 * * * *。';
  return '';
}

/** What the form edits. Interval and timeout start with editable defaults and example placeholders. */
export interface ScheduleDraft {
  name: string;
  kind: ScheduleDefinition['kind'];
  enabled: boolean;
  timingMode: ScheduleTiming['mode'];
  intervalSeconds?: number;
  cron: string;
  timezone: string;
  workspace: string;
  command: string;
  timeoutSeconds?: number;
  goal: string;
  profile: string;
  criteria: string;
  constraints: string;
}

export function emptyDraft(): ScheduleDraft {
  return {
    name: '', kind: 'script', enabled: true, timingMode: 'interval', intervalSeconds: 900,
    cron: '', timezone: projectTimeZone(), workspace: '', command: '', timeoutSeconds: 3600,
    goal: '', profile: '', criteria: '', constraints: '',
  };
}

export function draftFromDefinition(definition: ScheduleDefinition): ScheduleDraft {
  const timing = definition.timing;
  return {
    name: definition.name,
    kind: definition.kind,
    enabled: definition.enabled,
    timingMode: timing.mode,
    intervalSeconds: timing.mode === 'interval' ? timing.seconds : undefined,
    cron: timing.mode === 'cron' ? timing.expression : '',
    timezone: timing.mode === 'cron' ? timing.timezone : projectTimeZone(),
    workspace: definition.workspace ?? '',
    command: definition.script?.command ?? '',
    timeoutSeconds: definition.script?.timeoutSeconds,
    goal: definition.agent?.goal ?? '',
    profile: definition.agent?.ownerProfileId ?? '',
    criteria: (definition.agent?.acceptanceCriteria ?? []).join('\n'),
    constraints: (definition.agent?.constraints ?? []).join('\n'),
  };
}

/** Unsaved-change detection for the close confirmation; drafts are flat values, so a string compare is exact. */
export function draftChanged(a: ScheduleDraft, b: ScheduleDraft): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function timingOf(draft: ScheduleDraft): ScheduleTiming {
  return draft.timingMode === 'interval'
    ? { mode: 'interval', seconds: draft.intervalSeconds as number }
    : { mode: 'cron', expression: draft.cron.trim(), timezone: draft.timezone };
}

const optionalLines = (text: string): string[] | undefined => {
  const values = criteriaLines(text);
  return values.length ? values : undefined;
};

/** The create payload, and the update patch when editing: enabled rides in the same payload so one request applies it. */
export function scheduleInput(draft: ScheduleDraft): ScheduleInput {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    enabled: draft.enabled,
    timing: timingOf(draft),
    workspace: draft.workspace.trim(),
    ...(draft.kind === 'script'
      ? { script: { command: draft.command.trim(), timeoutSeconds: draft.timeoutSeconds as number } }
      : {
          agent: {
            goal: draft.goal.trim(),
            ownerProfileId: draft.profile,
            ...{ ...(optionalLines(draft.criteria) ? { acceptanceCriteria: optionalLines(draft.criteria) } : {}) },
            ...{ ...(optionalLines(draft.constraints) ? { constraints: optionalLines(draft.constraints) } : {}) },
          },
        }),
  };
}

/** Builtin editing sends one atomic patch: the timing plus, when it flipped, the enabled state. */
export function builtinPatch(draft: ScheduleDraft, definition: ScheduleDefinition, active=isRunning(definition)): Partial<ScheduleInput> {
  if(active)return {enabled:draft.enabled};
  const patch: Partial<ScheduleInput> = { timing: timingOf(draft), enabled:draft.enabled };
  return patch;
}

export type ScheduleDraftErrors = Partial<Record<'name' | 'interval' | 'cron' | 'timezone' | 'workspace' | 'command' | 'timeout' | 'goal' | 'profile' | 'criteria' | 'constraints', string>>;

const NAME_MAX = 160;

/** The shared contract keeps both lists at most 30 lines with up to 1000 characters each. */
export function scheduleLinesError(text: string, field: '验收标准' | '约束'): string {
  const lines = criteriaLines(text);
  if (lines.length > 30) return `${field}最多 30 条，每行一条。`;
  if (lines.some(line => line.length > 1000)) return `每条${field}不超过 1000 个字符。`;
  return '';
}

/** Field errors shown inline; the save button stays disabled while any of them is set.
 * Builtin records own only their timing/enabled, so every other field check is skipped for them. */
export function draftErrors(draft: ScheduleDraft, builtin = false): ScheduleDraftErrors {
  const errors: ScheduleDraftErrors = {};
  if (!draft.name.trim()) errors.name = '填写任务名称。';
  else if (draft.name.length > NAME_MAX) errors.name = `名称最多 ${NAME_MAX} 个字符。`;
  if (draft.timingMode === 'interval') {
    const seconds = draft.intervalSeconds;
    if (seconds === undefined || !Number.isInteger(seconds)
      || (builtin
        ? seconds < BUILTIN_INTERVAL_MIN_SECONDS || seconds > BUILTIN_INTERVAL_MAX_SECONDS || seconds % 60 !== 0
        : seconds < INTERVAL_MIN || seconds > INTERVAL_MAX)) {
      errors.interval = builtin ? BUILTIN_INTERVAL_DESC : INTERVAL_DESC;
    }
  } else if (builtin) {
    errors.interval = BUILTIN_INTERVAL_DESC;
  } else {
    const cronProblem = cronExpressionError(draft.cron);
    if (cronProblem) errors.cron = cronProblem;
    if (!isValidTimeZone(draft.timezone)) errors.timezone = '选择有效的 IANA 时区。';
  }
  if (!builtin) {
    const workspaceProblem = workspacePathError(draft.workspace, true);
    if (workspaceProblem) errors.workspace = workspaceProblem;
    if (draft.kind === 'script') {
      if (!draft.command.trim()) errors.command = '填写要执行的命令。';
      if (draft.timeoutSeconds === undefined || !Number.isInteger(draft.timeoutSeconds) || draft.timeoutSeconds < TIMEOUT_MIN || draft.timeoutSeconds > TIMEOUT_MAX) errors.timeout = TIMEOUT_DESC;
    } else {
      if (!draft.goal.trim()) errors.goal = '填写 Agent 的目标。';
      if (!draft.profile) errors.profile = '选择父 Agent 配置。';
      const criteriaProblem = scheduleLinesError(draft.criteria, '验收标准');
      if (criteriaProblem) errors.criteria = criteriaProblem;
      const constraintsProblem = scheduleLinesError(draft.constraints, '约束');
      if (constraintsProblem) errors.constraints = constraintsProblem;
    }
  }
  return errors;
}
