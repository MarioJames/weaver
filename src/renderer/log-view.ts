import type { TaskEvent } from '../shared/types';
/** Best-effort display redaction. Never claim this catches every secret. */
export function redactLog(value: string): string {
 return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi,'[REDACTED PRIVATE KEY]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[REDACTED]@').replace(/\b(Bearer\s+)[^\s"'<>]+/gi,'$1[REDACTED]')
  .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)\s*[=:]\s*["']?)[^\s,"';&]+/gi,'$1[REDACTED]')
  .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/g,'[REDACTED]');
}
export function selectEvents(events: TaskEvent[], kind: string, query: string): TaskEvent[] {
 const needle=query.trim().toLocaleLowerCase();
 return events.filter(event=>(kind==='all'||event.kind===kind)&&(!needle||redactLog(event.message).toLocaleLowerCase().includes(needle)));
}
export function exportEvents(taskId: string, events: TaskEvent[]): string {
 return JSON.stringify({schema:'weaver.event-export.v1',taskId,redaction:'best-effort; review before sharing',events:events.map(event=>({...event,message:redactLog(event.message)}))},null,2);
}
