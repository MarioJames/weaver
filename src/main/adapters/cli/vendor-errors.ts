import type { TaskFailure } from '../../../shared/contracts/tasks';
import { redactSecrets } from '../../../shared/redact';

const LIMITS = [
 {kind:'quota', pattern:/FreeUsageLimitError|GoUsageLimitError|insufficient[_ ](?:balance|quota)|\b402\b|(?:usage|spending|credit|quota)[_ ]limit|(?:quota|(?:free|go)[_ ]usage).{0,30}(?:exceeded|exhausted)|(?:out of|insufficient|zero|no) (?:credits|balance)|balance.{0,20}(?:exhausted|insufficient)/i},
 {kind:'rate_limit', pattern:/rate[_ -]?limit|too many requests|\b429\b/i},
 {kind:'auth', pattern:/authentication[_ ](?:failed|error)|invalid[_ ]api[_ ]key|unauthorized|\b401\b/i},
] as const;
const ENGINE_PATTERNS:Record<string,RegExp> = {
 opencode:/FreeUsageLimitError|GoUsageLimitError|usage limit/i,
 qodercli:/usage limit|quota|credits/i, pi:/usage limit|quota|credits/i,
 grok:/balance|\b402\b/i, codex:/usage limit|you.?ve hit your limit|limit reached/i,
 claude:/usage limit|you.?ve hit your limit|limit reached/i,
 // dsh turn-outside failures print `dsh: <CODE>: <message>`; RATE_LIMIT already matches the
 // global rate pattern, QUOTA needs its own entry. AUTH and CONTEXT_WINDOW_EXCEEDED stay
 // unclassified vendor failures surfaced with their own message.
 dsh:/\bQUOTA\b/,
};
/** Extract OpenCode's quoted error field before showing it to people. Raw evidence stays in vendorError. */
export function vendorMessage(message:string):string {
 const quoted=message.match(/\berror\.error=("(?:\\.|[^"\\])*")/);
 let value=message;
 if(quoted)try{value=JSON.parse(quoted[1]);}catch{ /* Malformed logs still have a bounded readable fallback. */ }
 return redactSecrets(value).replace(/^(?:(?:AI_APICallError|AI_RetryError):\s*)+/i,'').replace(/\s+/g,' ').trim();
}

export function vendorBlockReason(failure:Pick<TaskFailure,'kind'|'message'>):string {
 const prefix=failure.kind==='quota'?'额度耗尽':'限流';
 const reason=`${prefix}：${vendorMessage(failure.message)}`;
 return reason.length>120?`${reason.slice(0,119)}…`:reason;
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';

/**
 * The error text a pi JSON event carries: the assistant message's errorMessage, or an event-level error.
 * pi events also hold provider names, token counters and timestamps, so classifying the serialized line
 * can read those as a rate limit; only the error text itself is evidence.
 */
export function piErrorText(event: Record<string, unknown>): string {
  const message = event.message && typeof event.message === 'object' ? event.message as Record<string, unknown> : undefined;
  const error = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : undefined;
  return text(message?.errorMessage) || text(event.errorMessage) || text(error?.message) || text(event.error) || text(message?.error) || '';
}

/** Classifies one structured vendor line. Pi events are judged on their error text only; other engines keep whole-line matching. */
export function classifyVendorEvent(engine: string, event: Record<string, unknown>, line: string, now = Date.now()): TaskFailure | undefined {
  const failure = classifyVendorError(engine, engine === 'pi' ? piErrorText(event) : line, now);
  const retryAt = engine === 'pi' ? undefined : structuredRetryAt(event, now);
  return failure && retryAt ? { ...failure, retryAt } : failure;
}

/** Only a finite future timestamp is evidence; invalid vendor hints leave the existing fallback intact. */
function futureIso(target: number, now: number): string | undefined {
  return Number.isSafeInteger(target) && target > now && Number.isFinite(new Date(target).getTime())
    ? new Date(target).toISOString() : undefined;
}

function relativeIso(value: string, now: number, defaultUnit: 'ms' | 's' = 's'): string | undefined {
  const source = value.trim();
  if (!source || source.length > 200) return;
  if (/^\d+(?:\.\d+)?$/.test(source)) {
    return futureIso(now + Math.ceil(Number(source) * (defaultUnit === 'ms' ? 1 : 1000)), now);
  }
  const units: Record<string, number> = { h: 3600000, hour: 3600000, hours: 3600000, m: 60000, minute: 60000, minutes: 60000, s: 1000, second: 1000, seconds: 1000, ms: 1, millisecond: 1, milliseconds: 1 };
  const token = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|m|hours?|h)/igy;
  let index = 0;
  let total = 0;
  let previousUnit = Infinity;
  while (index < source.length) {
    token.lastIndex = index;
    const match = token.exec(source);
    if (!match) return;
    const amount = Number(match[1]);
    const unit = units[match[2].toLowerCase()]!;
    if (unit >= previousUnit || (previousUnit !== Infinity && amount * unit >= previousUnit)) return;
    total += amount * unit;
    index = token.lastIndex;
    while (/\s/.test(source[index] ?? '') && index < source.length) index += 1;
    if (index < source.length && !Number.isInteger(amount)) return;
    previousUnit = unit;
  }
  return futureIso(now + Math.ceil(total), now);
}

function absoluteIso(value: unknown, now: number): string | undefined {
  if (typeof value !== 'string') return;
  const source = value.trim();
  // Avoid Date.parse's permissive interpretation of numbers, partial dates and prose.
  const target = Date.parse(source);
  if (!Number.isFinite(target)) return;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(source)) {
    const calendar = new Date(`${source.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== source.slice(0, 10)
        || Number(source.slice(11, 13)) > 23 || Number(source.slice(14, 16)) > 59 || Number(source.slice(17, 19)) > 59) return;
  } else if (new Date(target).toUTCString() !== source) return;
  return futureIso(target, now);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** OpenCode APIError retains responseHeaders in error.data; retry status.next is epoch milliseconds. */
function structuredRetryAt(value: unknown, now: number, depth = 0): string | undefined {
  const item = record(value);
  if (!item || depth > 4) return;
  const headers = record(item.responseHeaders);
  if (headers) {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const ms = normalized['retry-after-ms'];
    if (typeof ms === 'string' && /^\d+(?:\.\d+)?$/.test(ms.trim())) {
      const result = relativeIso(ms, now, 'ms');
      if (result) return result;
    }
    const seconds = normalized['retry-after'];
    if (typeof seconds === 'string') {
      const result = /^\d+(?:\.\d+)?$/.test(seconds.trim()) ? relativeIso(seconds, now) : absoluteIso(seconds, now);
      if (result) return result;
    }
  }
  for (const key of ['retryAt', 'retry_at', 'reset_at', 'resetAt']) {
    const result = absoluteIso(item[key], now);
    if (result) return result;
  }
  if (item.type === 'retry' && typeof item.next === 'number') {
    const result = futureIso(item.next, now);
    if (result) return result;
  }
  for (const key of ['error', 'data', 'properties', 'status']) {
    const result = structuredRetryAt(item[key], now, depth + 1);
    if (result) return result;
  }
}

function textRetryAt(message: string, now: number): string | undefined {
  const hint = /\b(retry[-_ ]?after(?:[-_ ](?:milliseconds|ms))?|retrying\s+in|reset[_ ]?at)["'\s:=]+([^"'\r\n}\]]+)/ig;
  for (const match of message.matchAll(hint)) {
    // The attempt counter is UI metadata, never part of the duration.
    const value = match[2].replace(/\s+attempt\b.*$/i, '').trim();
    const absolute = absoluteIso(value, now);
    if (absolute) return absolute;
    if (/^reset/i.test(match[1])) continue;
    const duration = value.split(/[,;)]|\.(?=\s|$)/, 1)[0].trim();
    if (/^retrying/i.test(match[1]) && /^\d+(?:\.\d+)?$/.test(duration)) continue;
    const result = relativeIso(duration, now, /(?:ms|milliseconds)$/i.test(match[1]) ? 'ms' : 's');
    if (result) return result;
  }
}

export function classifyVendorError(engine:string,message:string,now=Date.now()):TaskFailure|undefined {
 let kind:TaskFailure['kind']|undefined=LIMITS.find(rule=>rule.pattern.test(message))?.kind;
 if(!kind&&ENGINE_PATTERNS[engine]?.test(message))kind='quota';
 if(!kind)return;
 let event: unknown;
 try { event = JSON.parse(message); } catch { /* Plain CLI logs still carry retry hints. */ }
 const retryAt=structuredRetryAt(event,now) ?? textRetryAt(vendorMessage(message),now) ?? textRetryAt(message,now);
 return {kind,message:vendorMessage(message).slice(0,1900),...(retryAt?{retryAt}:{} )};
}
