import type { EngineQuotaRecord, QuotaEngine, QuotaStatus, QuotaWindow } from '../../shared/contracts/quota';
import { object, type JsonObject } from './credentials';
import { parseProviderTimestamp } from './timestamps';

export const PROVIDERS = {
  codex: { source: 'codex_usage', url: 'https://chatgpt.com/backend-api/wham/usage' },
  claude: { source: 'claude_oauth_usage', url: 'https://api.anthropic.com/api/oauth/usage' },
  grok: { source: 'grok_cli_billing', url: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits' },
  opencode: { source: 'opencode_go_usage', url: 'https://opencode.ai/zen/go/v1/usage' },
  opencodeConsole: { source: 'opencode_console_status', url: 'https://opencode.ai/console/api/go/status' },
} as const;
type Measurement = Pick<EngineQuotaRecord, 'status' | 'statusBasis' | 'windows' | 'detail'>;
type Extra = 'available' | 'none' | 'unknown';
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const name = (value: unknown): string | null => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9 ._:/-]{0,79}$/.test(value) ? value : null;
const epoch = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8640000000000 ? new Date(value * 1000).toISOString() : null;
const iso = (value: unknown): string | null => {
  const ms = parseProviderTimestamp(value);
  return ms === null ? null : new Date(ms).toISOString();
};
const array = (value: unknown): JsonObject[] => Array.isArray(value) ? value.slice(0, 100).map(object).filter((row): row is JsonObject => !!row) : [];

function window(id: string, label: string, percent: unknown, reset: string | null, duration: number | null, scope: QuotaWindow['scope'] = 'account', model: string | null = null): QuotaWindow {
  const used = number(percent);
  return { id, label, scope, model, usedPercent: used, remainingPercent: used === null ? null : Math.max(0, 100 - used), resetsAt: reset, durationMinutes: duration, used: null, total: null, remaining: null, unit: 'percent' };
}

function durationLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback;
  return minutes % 1440 === 0 ? `${minutes / 1440} 天额度` : minutes % 60 === 0 ? `${minutes / 60} 小时额度` : `${minutes} 分钟额度`;
}

function evaluate(windows: QuotaWindow[], extra: Extra, now: number, permission?: boolean, blocked?: boolean, globalBlocked = false): Measurement {
  const account = windows.filter(w => w.scope === 'account' && w.usedPercent !== null && (!w.resetsAt || Date.parse(w.resetsAt) > now));
  const incomplete = windows.some(w => w.scope === 'account' && w.usedPercent === null && (!w.resetsAt || Date.parse(w.resetsAt) > now));
  const exhausted = account.some(w => w.usedPercent! >= 100);
  let status: QuotaStatus = 'unknown';
  if (globalBlocked) status = 'exhausted';
  else if (account.length && (permission === true && blocked !== true || exhausted && extra === 'available')) status = 'available';
  else if (exhausted) {
    if (permission !== true && extra === 'none') status = 'exhausted';
  } else if (!incomplete && account.some(w => w.usedPercent! < 100) && permission !== false && blocked !== true) status = 'available';
  const detail = status === 'available' ? exhausted && extra === 'available' ? '已确认额外额度仍可使用；这不保证模型可以运行' : permission === true && exhausted ? '服务端已允许账户继续使用；这不保证模型可以运行' : '已读取账户额度；这不保证模型可以运行'
    : status === 'exhausted' ? globalBlocked ? '服务端明确报告账户整体消费限制已达到' : '账户额度已耗尽，未确认有可继续使用的额外额度'
      : exhausted && extra === 'available' ? '套餐窗口已耗尽，但仍存在额外额度；未自动阻断'
        : '接口未提供足以确认账户可用性的完整额度信息';
  return { status, windows, detail, ...(globalBlocked ? { statusBasis: 'account_restriction' as const } : {}) };
}

function codex(body: JsonObject, now: number): Measurement {
  const windows: QuotaWindow[] = [];
  const convert = (limit: JsonObject | undefined, prefix: string, scope: QuotaWindow['scope'], model: string | null) => {
    for (const key of ['primary_window', 'secondary_window'] as const) {
      const raw = object(limit?.[key]);
      if (!raw) continue;
      const seconds = number(raw.limit_window_seconds);
      const minutes = seconds && seconds > 0 ? seconds / 60 : null;
      windows.push(window(`${prefix}:${key}`, durationLabel(minutes, key === 'primary_window' ? '主要额度窗口' : '次要额度窗口'), raw.used_percent, epoch(raw.reset_at), minutes, scope, model));
    }
  };
  const limit = object(body.rate_limit);
  convert(limit, 'codex:account', 'account', null);
  const additional = array(body.additional_rate_limits);
  for (const [index, extra] of additional.entries()) {
    const model = name(extra.normal_model_slug) ?? name(extra.metered_feature) ?? name(extra.limit_name);
    convert(object(extra.rate_limit), `codex:model:${model ?? index}`, 'model', model);
  }
  const credits = object(body.credits);
  const balance = amount(credits?.balance);
  const additionalAllowance = additional.some(row => object(row.rate_limit)?.allowed === true) || windows.some(w => w.scope === 'model' && w.usedPercent !== null && w.usedPercent < 100 && (!w.resetsAt || Date.parse(w.resetsAt) > now));
  const extraMalformed = body.additional_rate_limits !== undefined && body.additional_rate_limits !== null && (!Array.isArray(body.additional_rate_limits) || body.additional_rate_limits.some(row => !object(row) || !object(object(row)?.rate_limit)));
  const validBalance = balance !== null || credits?.balance === undefined || credits?.balance === null;
  const extra: Extra = credits?.has_credits === true || credits?.unlimited === true || balance !== null && balance > 0 ? 'available'
    : additionalAllowance ? 'unknown'
    : !extraMalformed && validBalance && credits?.has_credits === false && credits?.unlimited === false && (balance === null || balance === 0) ? 'none' : 'unknown';
  const spend = object(body.spend_control);
  return evaluate(windows, extra, now, typeof limit?.allowed === 'boolean' ? limit.allowed : undefined, limit?.limit_reached === true, spend?.reached === true);
}

function claude(body: JsonObject, now: number): Measurement {
  let windows: QuotaWindow[] = [];
  const authoritative = Array.isArray(body.limits) && body.limits.length > 0;
  for (const [index, limit] of array(body.limits).entries()) {
    if (number(limit.percent) === null) continue;
    const kind = typeof limit.kind === 'string' ? limit.kind : limit.group;
    const rawScope = object(limit.scope);
    const model = name(object(rawScope?.model)?.id) ?? name(object(rawScope?.model)?.display_name);
    const duration = kind === 'session' ? 300 : kind === 'weekly_all' || kind === 'weekly_scoped' ? 10080 : null;
    // The server sends `scope: null`, or `{ model: null, surface: null }`, for an account-wide meter. A key being present is not a scope; only a value is.
    const modelScoped = rawScope?.model !== undefined && rawScope.model !== null;
    const surfaceScoped = rawScope?.surface !== undefined && rawScope.surface !== null;
    const malformedScope = limit.scope !== undefined && limit.scope !== null && rawScope === undefined;
    const scope = modelScoped || kind === 'weekly_scoped' ? 'model' : surfaceScoped || malformedScope ? 'unknown' : kind === 'session' || kind === 'weekly_all' ? 'account' : 'unknown';
    const kindId = kind === 'session' || kind === 'weekly_all' || kind === 'weekly_scoped' ? kind : 'unknown';
    const scopedModel = scope === 'model' ? model : null;
    windows.push(window(`claude:${kindId}:${scopedModel ?? index}`, durationLabel(duration, '额度窗口'), limit.percent, iso(limit.resets_at), duration, scope, scopedModel));
  }
  if (!authoritative) {
    for (const [key, duration] of [['five_hour', 300], ['seven_day', 10080]] as const) {
      const raw = object(body[key]);
      if (raw) windows.push(window(`claude:${key}`, durationLabel(duration, '额度窗口'), raw.utilization, iso(raw.resets_at), duration));
    }
    for (const model of ['sonnet', 'opus'] as const) {
      const raw = object(body[`seven_day_${model}`]);
      if (raw) windows.push(window(`claude:seven_day_${model}`, '7 天额度', raw.utilization, iso(raw.resets_at), 10080, 'model', model));
    }
  }
  const usage = object(body.extra_usage);
  const percent = number(usage?.utilization);
  const used = number(usage?.used_credits);
  const total = number(usage?.monthly_limit);
  let extra: Extra = 'unknown';
  if (usage?.is_enabled === false) extra = 'none';
  else if (usage?.is_enabled === true) {
    if (usage.spend_limit_reached !== true && (percent !== null && percent < 100 || total !== null && used !== null && total > used)) extra = 'available';
    else if (usage.spend_limit_reached === true || percent !== null && percent >= 100 || total !== null && used !== null && used >= total) extra = 'none';
  }
  return evaluate(windows, extra, now);
}

function grok(body: JsonObject, now: number): Measurement {
  const config = object(body.config);
  if (!config) return evaluate([], 'unknown', now);
  const period = object(config.currentPeriod);
  const reset = iso(period?.end) ?? iso(config.billingPeriodEnd);
  const type = period?.type;
  let duration = type === 'USAGE_PERIOD_TYPE_WEEKLY' ? 10080 : type === 'USAGE_PERIOD_TYPE_DAILY' ? 1440 : null;
  const start = iso(period?.start);
  if (type === 'USAGE_PERIOD_TYPE_MONTHLY' && start && reset && Date.parse(reset) > Date.parse(start)) duration = (Date.parse(reset) - Date.parse(start)) / 60000;
  const label = type === 'USAGE_PERIOD_TYPE_MONTHLY' ? '月度额度' : durationLabel(duration, '账户额度');
  let percent = number(config.creditUsagePercent);
  const total = number(object(config.monthlyLimit)?.val);
  const used = number(object(config.used)?.val);
  if (percent === null && config.creditUsagePercent === undefined && total !== null && total > 0 && used !== null) percent = used / total * 100;
  const windows = [window('grok:account', label, percent, reset, duration)];
  for (const [index, product] of array(config.productUsage).entries()) {
    const productName = name(product.product);
    windows.push(window(`grok:product:${productName ?? index}`, productName ? `产品用量 · ${productName}` : '产品用量', product.usagePercent, reset, duration, 'unknown'));
  }
  const cap = number(object(config.onDemandCap)?.val);
  const consumed = number(object(config.onDemandUsed)?.val);
  const prepaid = amount(object(config.prepaidBalance)?.val);
  const extra: Extra = prepaid !== null && prepaid !== 0 || cap !== null && consumed !== null && cap > consumed ? 'available'
    : prepaid === 0 && cap !== null && (cap === 0 || consumed !== null && consumed >= cap) ? 'none' : 'unknown';
  // Grok's on-demand and prepaid billing availability does not establish model permission.
  return evaluate(windows, extra === 'available' ? 'unknown' : extra, now);
}

/**
 * Official but undocumented Go subscription endpoint: 200 is {usage:{rolling,weekly,monthly}}
 * with status ok|rate-limited, an integer percent and a server resetsAt. There is no balance,
 * dollar amount, plan name or per-model split; extra usage beyond the plan is not reported.
 * Unknown shapes fail closed to unknown; a rate-limited window is an exhausted Go plan window
 * only, never a claim about balance, free models or other routes.
 */
function opencode(body: JsonObject): Measurement {
  const usage = object(body.usage);
  const windows: QuotaWindow[] = [];
  const defs = [['rolling', 'OpenCode Go · 5 小时额度', 300], ['weekly', 'OpenCode Go · 每周额度', 10080], ['monthly', 'OpenCode Go · 每月额度', null]] as const;
  for (const [key, label, duration] of defs) {
    const slot = object(usage?.[key]);
    if (!slot || slot.status !== 'ok' && slot.status !== 'rate-limited') return { status: 'unknown', windows: [], detail: 'Go 套餐窗口缺失，无法确认账户额度' };
    if (typeof slot.percent !== 'number' || !Number.isFinite(slot.percent) || slot.percent < 0 || slot.percent > 100) return { status: 'unknown', windows: [], detail: 'Go 套餐窗口缺失，无法确认账户额度' };
    const resetsAt = parseProviderTimestamp(slot.resetsAt);
    if (resetsAt === null) return { status: 'unknown', windows: [], detail: 'Go 套餐窗口缺失，无法确认账户额度' };
    windows.push({ id: `opencode:${key}`, label, scope: 'account', model: null, usedPercent: slot.percent, remainingPercent: 100 - slot.percent, resetsAt: new Date(resetsAt).toISOString(), durationMinutes: duration, used: null, total: null, remaining: null, unit: 'percent' });
  }
  const exhausted = windows.some((entry, index) => {
    const raw = object(usage?.[defs[index][0]]);
    return raw?.status === 'rate-limited' || entry.usedPercent! >= 100;
  });
  return exhausted
    ? { status: 'exhausted', windows, detail: 'OpenCode Go 套餐窗口已耗尽；这仅指 Go 套餐窗口，不代表余额、免费模型或其他路线不可用。实际限额按对应模型反馈处理' }
    : { status: 'available', windows, detail: '已读取 Go 套餐窗口；这不保证模型可以运行' };
}

/** Only safe quota fields are projected; account identifiers and raw response data never leave this module. */
export function normalizeUsage(engine: QuotaEngine, payload: unknown, now: number): Measurement {
  const body = object(payload);
  if (!body) return { status: 'unknown', windows: [], detail: '额度响应缺少有效数据' };
  if ([body.limits, body.additional_rate_limits, object(body.config)?.productUsage].some(value => Array.isArray(value) && value.length > 100)) return { status: 'unknown', windows: [], detail: '额度响应包含过多窗口，无法确认账户额度' };
  return engine === 'codex' ? codex(body, now) : engine === 'claude' ? claude(body, now) : engine === 'grok' ? grok(body, now) : opencode(body);
}

const MICRO_MAX = 1_000_000_000_000_000_000n;
function microCents(value: unknown): bigint | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000_000) return null;
    return BigInt(value);
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 24 || !/^\d+$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0 && parsed <= MICRO_MAX ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Native Console shape: {access:{meters:{fiveHour,week,month:{usedMicroCents,limitMicroCents,resetsAt}}},useBalance?}.
 * Meters are plan metering units, not dollars: only used/limit percentages are projected
 * (used/total/remaining stay null, unit percent). Root identifiers such as
 * subscriberUserId/paymentMethodId are never read. Missing or malformed windows fail
 * closed to unknown; limit 0 is unknown, never exhausted; used over limit caps at 100
 * and reports an exhausted plan window only.
 */
export function normalizeConsoleStatus(payload: unknown): Measurement {
  const body = object(payload);
  const meters = object(object(body?.access)?.meters);
  const defs = [
    ['fiveHour', 'opencode:rolling', 'OpenCode Go · 5 小时额度', 300],
    ['week', 'opencode:weekly', 'OpenCode Go · 每周额度', 10080],
    ['month', 'opencode:monthly', 'OpenCode Go · 每月额度', null],
  ] as const;
  const missing = { status: 'unknown' as const, windows: [], detail: 'Go 套餐窗口缺失，无法确认账户额度' };
  if (!meters) return missing;
  const windows: QuotaWindow[] = [];
  for (const [key, id, label, duration] of defs) {
    const slot = object(meters[key]);
    if (!slot) return missing;
    const used = microCents(slot.usedMicroCents);
    const limit = microCents(slot.limitMicroCents);
    if (used === null || limit === null || limit === 0n) return missing;
    const resetsAt = parseProviderTimestamp(slot.resetsAt);
    if (resetsAt === null) return missing;
    const percent = used >= limit ? 100 : Number((used * 10000n) / limit) / 100;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return missing;
    windows.push({
      id, label, scope: 'account', model: null,
      usedPercent: percent, remainingPercent: Math.max(0, 100 - percent),
      resetsAt: new Date(resetsAt).toISOString(), durationMinutes: duration,
      used: null, total: null, remaining: null, unit: 'percent',
    });
  }
  const exhausted = windows.some(entry => entry.usedPercent! >= 100);
  return exhausted
    ? { status: 'exhausted', windows, detail: 'OpenCode Go 套餐窗口已耗尽；这仅指 Go 套餐窗口，不代表余额、免费模型或其他路线不可用。实际限额按对应模型反馈处理' }
    : { status: 'available', windows, detail: '已读取 Go 套餐窗口；这不保证模型可以运行' };
}
