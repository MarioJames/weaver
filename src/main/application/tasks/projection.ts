import type { Task, TaskDispatch } from '../../../shared/contracts/tasks';
import { fail } from '../commands/errors';
import type { CommandArgs } from '../commands/types';

export type TaskView = 'full' | 'brief';
export interface TaskProjection {
  view: TaskView;
  fields?: string[];
}

/** Top-level task fields without the history collections; list and get each add their own extras. */
const TASK_FIELDS = [
  'id', 'title', 'instruction', 'workspace', 'acceptanceCriteria', 'constraints', 'executionRole',
  'parentTaskId', 'failure', 'ownerEpoch', 'ownerLastActivityAt', 'continuationPolicy',
  'continuationHistory', 'contextPack', 'ownerHost', 'ownerReport', 'revision', 'scheduled', 'queueReason',
  'retryOf', 'ownerId', 'packageId', 'acknowledged', 'reviewState', 'reviewComment', 'supersededBy',
  'supersededReason', 'dispatch', 'createdAt', 'updatedAt', 'status', 'progress', 'summary', 'run',
] as const;

/** tasks.get keeps the full task, including event history, artifact bodies and the optional native next step. */
export const TASK_GET_FIELDS = [...TASK_FIELDS, 'events', 'artifacts', 'next'] as const;
/** tasks.list already replaces history with counts; artifactCount/eventCount are its own summary fields. */
export const TASK_LIST_FIELDS = [...TASK_FIELDS, 'eventCount', 'artifactCount'] as const;

type BriefTask = Pick<Task, 'id' | 'status' | 'reviewState' | 'progress' | 'workspace' | 'title' | 'ownerId' | 'parentTaskId' | 'updatedAt' | 'dispatch'>;

/** A dispatch is already short apart from its optional workspace; keep only the routing and execution facts. */
function briefDispatch(dispatch: TaskDispatch): Record<string, unknown> {
  return {
    owner: dispatch.owner,
    worker: dispatch.worker,
    engine: dispatch.engine,
    model: dispatch.model,
    effort: dispatch.effort,
    execution: dispatch.execution,
    maxParallel: dispatch.maxParallel,
    ...(dispatch.maxWaitMinutes === undefined ? {} : { maxWaitMinutes: dispatch.maxWaitMinutes }),
    ...(dispatch.engineKind === undefined ? {} : { engineKind: dispatch.engineKind }),
  };
}

/** The brief shape: identity, state, progress, workspace and a short dispatch summary; never instruction, summary, run or history. */
export function briefTaskFields(task: BriefTask): Record<string, unknown> {
  return {
    id: task.id,
    status: task.status,
    reviewState: task.reviewState ?? 'pending',
    progress: task.progress,
    workspace: task.workspace ?? null,
    title: task.title,
    ownerId: task.ownerId ?? null,
    parentTaskId: task.parentTaskId ?? null,
    updatedAt: task.updatedAt,
    dispatch: task.dispatch ? briefDispatch(task.dispatch) : null,
  };
}

/** Validate view/fields once per request and return the projection to use. */
export function taskProjection(args: CommandArgs, command: string, allowed: readonly string[]): TaskProjection {
  let view: TaskView = 'full';
  if (args.view !== undefined) {
    if (args.view !== 'full' && args.view !== 'brief') fail('INVALID_ARGUMENT', `Invalid view for ${command}: ${JSON.stringify(args.view)}. Allowed views are "full" and "brief"`);
    view = args.view as TaskView;
  }
  const rawFields = args.fields;
  if (rawFields === undefined) return { view };
  if (!Array.isArray(rawFields) || rawFields.length === 0) fail('INVALID_ARGUMENT', `fields for ${command} must be a non-empty array of top-level field names`);
  const fields: string[] = [];
  for (const value of rawFields as unknown[]) {
    if (typeof value !== 'string' || value.trim() === '') fail('INVALID_ARGUMENT', `fields for ${command} must contain non-empty top-level field names`);
    const field = value as string;
    if (!allowed.includes(field)) fail('INVALID_ARGUMENT', `Unknown field "${field}" for ${command}. Allowed fields: ${allowed.join(', ')}`);
    if (!fields.includes(field)) fields.push(field);
  }
  return { view, fields };
}

/**
 * Apply the selected view and optional top-level projection. fields may name any field the full view has,
 * so an explicit request can still read one long field from the brief view without widening the default.
 */
export function projectTaskView(full: Record<string, unknown>, brief: Record<string, unknown>, projection: TaskProjection): Record<string, unknown> {
  const base = projection.view === 'brief' ? brief : full;
  if (!projection.fields) return base;
  const projected: Record<string, unknown> = {};
  for (const field of projection.fields) projected[field] = Object.hasOwn(base, field) ? base[field] : full[field];
  return projected;
}
