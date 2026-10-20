/** Best-effort credential removal. Packs intentionally exclude artifact bodies and full transcripts. */
export function redactContext(value: string, limit = 700): string {
 return value
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, '[REDACTED PRIVATE KEY]')
  .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[REDACTED AUTH]')
  .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED TOKEN]')
  .replace(/(["']?\b(?:password|passwd|(?:client[_-]?)?secret|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key|(?:secret[_-]?)?access[_-]?key|authorization)\b["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
  .slice(0, limit);
}

const PROBE_ERROR_MAX = 200;
const REASON_MAX = 120;

/** A vendor message is evidence, not a log file: credentials are stripped, then one bounded line, never the argv. */
export function boundedProbeError(value: string): string {
  const line = redactContext(value).replace(/\s+/g, ' ').trim();
  return line.length > PROBE_ERROR_MAX ? `${line.slice(0, PROBE_ERROR_MAX)}…` : line;
}

/** A reason is one bounded line: probe failures name one vendor, not a traceback. */
export function boundedReason(value: string): string {
  const line = redactContext(value).replace(/\s+/g, ' ').trim();
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}
