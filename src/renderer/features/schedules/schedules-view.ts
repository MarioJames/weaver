import type { ScheduleDefinition, ScheduleExecutor, ScheduleInput, ScheduleRun, ScheduleTiming } from '../../../shared/contracts/schedules';
import type { PolicySnapshot } from '../../../shared/contracts/policy';
import { QUOTA_INTERVAL_RANGE } from '../../../shared/policy/settings';
import { isValidTimeZone, projectTimeZone } from '../../format/timezone';
import type { StatusTone } from '../../format/status-colors';
import { workspacePathError } from '../tasks/TaskComposer';

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
export const WORKSPACE_DESC = '可留空；填写时必须是 Weaver 所在机器上已存在的绝对路径目录。项目位置也可以直接写进任务目标。';
export const BUILTIN_INTERVAL_DESC = `两次刷新之间的分钟数，也是「设置」页「额度」的间隔：${QUOTA_INTERVAL_RANGE.min}–${QUOTA_INTERVAL_RANGE.max} 分钟的整数（${BUILTIN_INTERVAL_MIN_SECONDS}–${BUILTIN_INTERVAL_MAX_SECONDS} 秒，整分钟）。内置任务不接受 cron 表达式。`;
export const CRON_DESC = '5 或 6 个用空格分隔的字段（分 时 日 月 周，可加秒）。支持 L、W、# 等日期规则，保存时会验证表达式。';
export const GOAL_DESC = '任务目标与其他要求都写在这里，包括项目位置与操作步骤。';
export const EXECUTOR_DESC = '父 Agent 可统筹复杂任务，子 Agent 直接执行简单任务。全部配置都会列出，不可用的置灰不能提交；已删除的保存值会保留显示，换成可用配置后才能提交。';

/** Client-side cron sanity only: the scheduler stays authoritative. 5/6 fields; the character set is up to the server parser. */
export function cronExpressionError(expression: string): string {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (!fields.length) return '填写 cron 表达式。';
  if (fields.length !== 5 && fields.length !== 6) return '需要 5 或 6 个用空格分隔的字段，例如 */15 * * * *。';
  return '';
}

/** Which side of the policy executes an agent schedule: a parent owner or a worker child. */
export type ScheduleExecutorRole = ScheduleExecutor['role'];

export const EXECUTOR_ROLE_LABELS: Record<ScheduleExecutorRole, string> = { owner: '父 Agent', worker: '子 Agent' };

/** Select value encoding that survives same-name owner/worker profiles: the role prefix disambiguates, the rest is the full id. */
export function encodeExecutorValue(role: ScheduleExecutorRole, profileId: string): string {
  return `${role}:${profileId}`;
}

export function decodeExecutorValue(value: string): ScheduleExecutor | undefined {
  if (value.startsWith('owner:')) return { role: 'owner', profileId: value.slice('owner:'.length) };
  if (value.startsWith('worker:')) return { role: 'worker', profileId: value.slice('worker:'.length) };
  return undefined;
}

export interface ExecutorOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function engineModelText(engine?: string, model?: string): string {
  if (engine && model) return `${engine}/${model}`;
  return engine ?? model ?? '';
}

/** Every configured parent and child profile becomes one searchable option; availability comes from the live policy snapshot. */
export function buildExecutorOptions(policy?: PolicySnapshot): ExecutorOption[] {
  if (!policy) return [];
  const options: ExecutorOption[] = [];
  for (const id of Object.keys(policy.config.owners)) {
    const available = policy.owners[id]?.status === 'available';
    const detail = engineModelText(policy.config.channels[policy.config.owners[id]!.channel]?.label ?? policy.config.owners[id]?.channel, policy.config.owners[id]?.model);
    options.push({
      value: encodeExecutorValue('owner', id),
      label: `${id} · 父 Agent${detail ? ` · ${detail}` : ''}${available ? '' : ' · 不可用'}`,
      disabled: !available,
    });
  }
  for (const id of Object.keys(policy.config.workers)) {
    const available = policy.workers[id]?.status === 'available';
    const detail = engineModelText(policy.config.channels[policy.config.workers[id]!.channel]?.label ?? policy.config.workers[id]?.channel, policy.config.workers[id]?.model);
    options.push({
      value: encodeExecutorValue('worker', id),
      label: `${id} · 子 Agent${detail ? ` · ${detail}` : ''}${available ? '' : ' · 不可用'}`,
      disabled: !available,
    });
  }
  return options;
}

/** The executor is backend-validated; the frontend only reads the typed shape. */
export function executorOfDefinition(definition: ScheduleDefinition): ScheduleExecutor | undefined {
  return definition.agent?.executor;
}

export function executorText(executor?: ScheduleExecutor): string {
  if (!executor) return '';
  return `${EXECUTOR_ROLE_LABELS[executor.role]} · ${executor.profileId}`;
}

/** Submit gate reads the live snapshot: only an `available` entry may execute. */
export function isExecutorAvailable(policy: PolicySnapshot | undefined, role: ScheduleExecutorRole, profileId: string): boolean {
  if (!policy || !profileId) return false;
  const availability = role === 'owner' ? policy.owners[profileId] : policy.workers[profileId];
  return availability?.status === 'available';
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
  executorRole: ScheduleExecutorRole;
  executorProfile: string;
}

export function emptyDraft(): ScheduleDraft {
  return {
    name: '', kind: 'script', enabled: true, timingMode: 'interval', intervalSeconds: 900,
    cron: '', timezone: projectTimeZone(), workspace: '', command: '', timeoutSeconds: 3600,
    goal: '', executorRole: 'owner', executorProfile: '',
  };
}

export function draftFromDefinition(definition: ScheduleDefinition): ScheduleDraft {
  const timing = definition.timing;
  const executor = executorOfDefinition(definition);
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
    executorRole: executor?.role ?? 'owner',
    executorProfile: executor?.profileId ?? '',
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

/** The create payload, and the update patch when editing: enabled rides in the same payload so one request applies it.
 *  Workspace always travels as an explicit string: blank means cleared, so an edit that empties it really unsets the directory. */
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
            executor: { role: draft.executorRole, profileId: draft.executorProfile },
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

export type ScheduleDraftErrors = Partial<Record<'name' | 'interval' | 'cron' | 'timezone' | 'workspace' | 'command' | 'timeout' | 'goal' | 'executor', string>>;

const NAME_MAX = 160;
const GOAL_MAX = 16000;

/** Field errors shown inline; the save button stays disabled while any of them is set.
 *  Builtin records own only their timing/enabled, so every other field check is skipped for them. */
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
    const workspaceProblem = workspacePathError(draft.workspace, false);
    if (workspaceProblem) errors.workspace = workspaceProblem;
    if (draft.kind === 'script') {
      if (!draft.command.trim()) errors.command = '填写要执行的命令。';
      if (draft.timeoutSeconds === undefined || !Number.isInteger(draft.timeoutSeconds) || draft.timeoutSeconds < TIMEOUT_MIN || draft.timeoutSeconds > TIMEOUT_MAX) errors.timeout = TIMEOUT_DESC;
    } else {
      if (!draft.goal.trim()) errors.goal = '填写任务目标。';
      else if (draft.goal.trim().length > GOAL_MAX) errors.goal = `任务目标最多 ${GOAL_MAX} 个字符。`;
      if (!draft.executorProfile) errors.executor = '选择执行 Agent。';
    }
  }
  return errors;
}
