import { LocalIPCError } from '../main/local-ipc';

export type OutputFormat = 'json' | 'jsonl' | 'text';

/** Text carries the same handoff the json next field does: the wait command, or the exact subagent run. */
function renderNext(next: Record<string, unknown>): string[] {
  if (next.action === 'run_subagent') {
    return [`next: run a subagent on model ${next.model}, effort ${next.effort}`, String(next.prompt ?? ''), `then: ${next.then ?? ''}`].filter(Boolean);
  }
  return [`next: ${next.command ?? next.action ?? ''}`];
}
function renderData(data: unknown): string {
  if (!data || typeof data !== 'object') return data === undefined ? '' : String(data);
  const record = data as Record<string, unknown>;
  if (record.reason === 'stalled' && record.health && typeof record.health === 'object') {
    const health = record.health as Record<string, unknown>;
    return [`${record.id ?? ''} stalled (task status: ${record.status ?? 'unknown'})`,
      `health: silenceMs=${health.silenceMs ?? 'unknown'} cpuIdleMs=${health.cpuIdleMs ?? 'unknown'} cpuActive=${health.cpuActive ?? 'unknown'} engine=${health.engine ?? 'unknown'}`,
      `hint: ${record.hint ?? ''}`].join('\n');
  }
  if (typeof record.status === 'string' && typeof record.title === 'string') {
    const lines = [`${record.id ?? ''} ${record.status} ${record.title}`.trim()];
    if (record.next && typeof record.next === 'object') lines.push(...renderNext(record.next as Record<string, unknown>));
    if (Array.isArray(record.excludedWorkers) && record.excludedWorkers.length) lines.push(`excluded workers: ${record.excludedWorkers.join(', ')}`);
    return lines.join('\n');
  }
  if (Array.isArray(record.tasks)) return record.tasks.map(item => renderData(item)).join('\n') || 'No tasks';
  if (Array.isArray(record.owners)) return record.owners.map(item => { const owner = item as Record<string, unknown>; return `${owner.id ?? ''} ${owner.name ?? ''} ${owner.state ?? ''}`.trim(); }).join('\n') || 'No owners';
  if (Array.isArray(record.events)) return record.events.map(item => { const event = item as Record<string, unknown>; return `${event.kind ?? 'event'}: ${event.message ?? ''}`; }).join('\n') || 'No events';
  return JSON.stringify(data);
}
export function renderEnvelope(format: OutputFormat, envelope: { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown; apiVersion?: string; commandId?: string | null }): string {
  if (format !== 'text') return JSON.stringify(envelope);
  if (envelope.ok === false) return `${envelope.error?.code ?? 'ERROR'}: ${envelope.error?.message ?? 'Command failed'}`;
  return renderData(envelope.data);
}
export function writeEnvelope(format: OutputFormat, envelope: { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown; apiVersion?: string; commandId?: string | null }): void {
  process.stdout.write(renderEnvelope(format, envelope) + '\n');
}
export function responseField(response: unknown, path: string): string {
  let value = response;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new LocalIPCError('INVALID_ARGUMENT', `Response field not found: ${path}`);
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return JSON.stringify(value);
  throw new LocalIPCError('INVALID_ARGUMENT', `Response field must be a scalar: ${path}`);
}
/** Read a valid requested format before parsing can fail, independent of flag ordering. */
export function requestedOutput(argv:string[]):OutputFormat {
  const values=argv.flatMap((arg,index)=>arg==='--output'?[argv[index+1]]:[]);
  if(values.some(value=>!['json','jsonl','text'].includes(value)))return 'json';
  return values.at(-1) as OutputFormat ?? 'json';
}
