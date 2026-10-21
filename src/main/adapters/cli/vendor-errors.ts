import type { TaskFailure } from '../../../shared/contracts/tasks';
import { redactSecrets } from '../../../shared/redact';

const LIMITS = [
 {kind:'quota', pattern:/FreeUsageLimitError|GoUsageLimitError|insufficient[_ ](?:balance|quota)|\b402\b|(?:usage|spending|credit|quota)[_ ]limit|quota.{0,30}(?:exceeded|exhausted)|(?:out of|insufficient|zero|no) (?:credits|balance)|balance.{0,20}(?:exhausted|insufficient)/i},
 {kind:'rate_limit', pattern:/rate[_ -]?limit|too many requests|\b429\b/i},
 {kind:'auth', pattern:/authentication[_ ](?:failed|error)|invalid[_ ]api[_ ]key|unauthorized|\b401\b/i},
] as const;
const ENGINE_PATTERNS:Record<string,RegExp> = {
 opencode:/FreeUsageLimitError|GoUsageLimitError|usage limit/i,
 qodercli:/usage limit|quota|credits/i, pi:/usage limit|quota|credits/i,
 grok:/balance|\b402\b/i, codex:/usage limit|you.?ve hit your limit|limit reached/i,
 claude:/usage limit|you.?ve hit your limit|limit reached/i,
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
  return classifyVendorError(engine, engine === 'pi' ? piErrorText(event) : line, now);
}

export function classifyVendorError(engine:string,message:string,now=Date.now()):TaskFailure|undefined {
 let kind:TaskFailure['kind']|undefined=LIMITS.find(rule=>rule.pattern.test(message))?.kind;
 if(!kind&&ENGINE_PATTERNS[engine]?.test(message))kind='quota';
 if(!kind)return;
 const delay=message.match(/retry[-_ ]?after["'\s:=]+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|seconds|m|minutes)?/i);
 const absolute=message.match(/(?:retry[-_ ]?after|reset[_ ]?at)["'\s:=]+([^\r\n"}]+)/i)?.[1];
 const absoluteTime=absolute?Date.parse(absolute):NaN;
 const delayTime=delay?now+Number(delay[1])*(/^ms|millisecond/i.test(delay[2]??'')?1:/^m/i.test(delay[2]??'')?60000:1000):NaN;
 const target=Number.isFinite(absoluteTime)&&absoluteTime>now?absoluteTime:delayTime;
 const retryAt=Number.isFinite(new Date(target).getTime())?new Date(target).toISOString():undefined;
 return {kind,message:vendorMessage(message).slice(0,1900),...(retryAt?{retryAt}:{} )};
}
