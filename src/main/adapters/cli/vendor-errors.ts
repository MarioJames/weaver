import type { TaskFailure } from '../../../shared/types';
import { redact } from './redact';

const LIMITS = [
 {kind:'quota', pattern:/FreeUsageLimitError|GoUsageLimitError|insufficient[_ ](?:balance|quota)|\b402\b|(?:usage|spending|credit|quota)[_ ]limit|quota.{0,30}(?:exceeded|exhausted)|(?:out of|insufficient|zero|no) (?:credits|balance)|balance.{0,20}(?:exhausted|insufficient)/i},
 {kind:'rate_limit', pattern:/rate[_ -]?limit|too many requests|\b429\b|AI_APICallError/i},
 {kind:'auth', pattern:/authentication[_ ](?:failed|error)|invalid[_ ]api[_ ]key|unauthorized|\b401\b/i},
] as const;
const ENGINE_PATTERNS:Record<string,RegExp> = {
 opencode:/AI_APICallError|FreeUsageLimitError|GoUsageLimitError/i,
 qodercli:/usage limit|quota|credits/i, pi:/usage limit|quota|credits/i,
 grok:/balance|\b402\b/i, codex:/usage limit|you.?ve hit your limit|limit reached/i,
 claude:/usage limit|you.?ve hit your limit|limit reached/i,
};
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
 return {kind,message:redact(message).slice(0,1900),...(retryAt?{retryAt}:{} )};
}
