import type { TaskInput, WorkerRecord } from './types';
export function object(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
 return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max: number, allowEmpty = false): string {
 if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) throw new Error(`Invalid ${name} (maximum ${max} characters)`);
 return value;
}
export function parseTaskInput(value: unknown): TaskInput {
 const input = object(value); const owner = object(input.owner);
 if (owner.transport !== 'herdr-visible') throw new Error('Owner transport must be herdr-visible');
 const extra: Pick<TaskInput,'workspace'|'acceptanceCriteria'|'constraints'>={};
 if(input.workspace!==undefined) extra.workspace=text(input.workspace,'workspace',2000);
 for(const key of ['acceptanceCriteria','constraints'] as const)if(input[key]!==undefined){if(!Array.isArray(input[key])||(input[key] as unknown[]).length>30)throw new Error('Invalid '+key);extra[key]=(input[key] as unknown[]).map(v=>text(v,key,1000));}
 return {...extra, title: text(input.title, 'title', 160), instruction: text(input.instruction, 'instruction', 16000), owner: {
 name: text(owner.name, 'owner name', 120), transport: 'herdr-visible', session: text(owner.session, 'session', 120), pane: text(owner.pane, 'pane', 120)
 }};
}
export function parseId(value: unknown): string {
 const id = text(value, 'task ID', 36);
 if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) throw new Error('Invalid task ID');
 return id;
}
export function parseWorkerRecord(value: unknown): WorkerRecord {
 const record = object(value);
 switch (record.type) {
 case 'log': return {type:'log', message:text(record.message,'message',8000,true)};
 case 'progress':
  if (typeof record.percent !== 'number' || !Number.isFinite(record.percent) || record.percent < 0 || record.percent > 100) throw new Error('Progress must be 0–100');
  return {type:'progress', percent:record.percent, message:text(record.message,'message',8000,true)};
 case 'artifact': {
  const name = text(record.name,'artifact name',160);
  if (/[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new Error('Artifact name must be a plain filename');
  if (!['text/plain','text/markdown','application/json'].includes(String(record.mediaType))) throw new Error('Unsupported artifact media type');
  return {type:'artifact', name, mediaType: record.mediaType as 'text/plain' | 'text/markdown' | 'application/json', content:text(record.content,'artifact content',32000,true)};
 }
 case 'result': return {type:'result', summary:text(record.summary,'summary',8000)};
 default: throw new Error('Unknown worker record type');
 }
}
