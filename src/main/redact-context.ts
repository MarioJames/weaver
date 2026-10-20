import { redactSecrets } from '../shared/redact';

/** Best-effort credential removal (the shared rule set), then the length bound. Packs intentionally exclude artifact bodies and full transcripts. */
export function redactContext(value: string, limit = 700): string {
 return redactSecrets(value).slice(0, limit);
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
