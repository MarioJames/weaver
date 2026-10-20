import { randomUUID, createHash } from 'node:crypto';
import type { Task } from '../shared/contracts/tasks';
import type { ContextPack, ContinuationPolicy, HandoffRecord } from '../shared/contracts/continuation';
import type { LogicalOwner } from '../shared/contracts/owners';
import type { OwnerHostAdapter } from './adapters/logical';
import type { TaskStore } from './store';
import { handoffPrompt } from './owners/prompts';
import { redactContext } from './redact-context';

/** This is user-controlled context rotation, not a vendor prompt-cache guarantee. */
export const DEFAULT_IDLE_TTL_MINUTES = 60;
export const MAX_CONTEXT_PACK_BYTES = 32 * 1024;
export const MAX_HANDOFFS = 100;
export interface ContinuationStatus {
 taskId: string; ownerId: string; ownerEpoch: number; policy: ContinuationPolicy; lastActivityAt: string; due: boolean;
 history: HandoffRecord[]; contextPack: ContextPack | null; prompt?: string;
}
export type ContinuationTask = Task & {
 ownerEpoch?: number; ownerLastActivityAt?: string; continuationPolicy?: ContinuationPolicy;
 continuationHistory?: HandoffRecord[]; contextPack?: ContextPack;
};
export class ContinuationError extends Error {
 constructor(readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new ContinuationError(code, message); };
export function idleContinuationDue(task: ContinuationTask, now = Date.now()): boolean {
 const minutes = task.continuationPolicy?.idleRotationMinutes === undefined ? DEFAULT_IDLE_TTL_MINUTES : task.continuationPolicy.idleRotationMinutes;
 if (minutes === null) return false;
 // Worker event timestamps are deliberately not owner activity.
 const last = Date.parse(task.ownerLastActivityAt ?? task.createdAt);
 return Number.isFinite(last) && now >= last && now - last >= minutes * 60_000;
}
function assertQuiescent(task: Task): void {
 if (task.status === 'running' || task.status === 'cancelling' || task.scheduled || task.run?.status === 'running' || task.run?.status === 'stopping') {
  fail('ROTATION_BLOCKED', 'Owner transfer requires all workers and queued dispatch to finish or be cancelled');
 }
}
/** Mock handshake or manual metadata handoff; the old binding remains authoritative until atomic commit.
 * No timer, process, network call, AI invocation, or vendor cache operation is performed here.
 * CommandHandler owns durable command receipts; all mutations must enter via that handler.
 */
export class ContinuationService {
 constructor(private readonly store: TaskStore, private readonly host: OwnerHostAdapter, private readonly now: () => number = Date.now) {}
 get(taskId: string): ContinuationStatus {
  const task = this.read(taskId);
  const result = structuredClone({taskId, ownerId: task.ownerId, ownerEpoch: task.ownerEpoch ?? 0,
   policy: task.continuationPolicy ?? {idleRotationMinutes: DEFAULT_IDLE_TTL_MINUTES},
   lastActivityAt: task.ownerLastActivityAt ?? task.createdAt, due: idleContinuationDue(task, this.now()),
   history: task.continuationHistory ?? [], contextPack: task.contextPack ?? null}) as ContinuationStatus;
  if (result.contextPack) result.prompt = handoffPrompt(task, result.contextPack);
  return result;
 }
 due(taskId: string): boolean { return idleContinuationDue(this.read(taskId), this.now()); }
 configure(taskId: string, expectedRevision: number, idleRotationMinutes: number | null) {
  if (idleRotationMinutes !== null && (!Number.isInteger(idleRotationMinutes) || idleRotationMinutes < 1 || idleRotationMinutes > 10080)) fail('INVALID_REQUEST', 'Idle rotation must be null (disabled) or 1–10080 minutes');
  const task = this.read(taskId); this.revision(task, expectedRevision);
  task.continuationPolicy = {idleRotationMinutes};
  task.ownerLastActivityAt = new Date(this.now()).toISOString();
  task.revision = (task.revision ?? 0) + 1;
  task.updatedAt = task.ownerLastActivityAt;
  this.store.put(task); return this.get(taskId);
 }
  rotate(taskId: string, expectedRevision: number, reason: 'manual' | 'idle', expectedEpoch?: number, profileId?: string): ContinuationStatus {
  const original = this.read(taskId); this.revision(original, expectedRevision);
  if (reason !== 'manual' && reason !== 'idle') fail('INVALID_REQUEST', 'Invalid continuation reason');
  const epoch = original.ownerEpoch ?? 0;
  if (expectedEpoch !== undefined && expectedEpoch !== epoch) fail('OWNER_EPOCH_CONFLICT', 'Owner epoch changed');
  assertQuiescent(original);
  if (reason === 'idle' && !idleContinuationDue(original, this.now())) fail('NOT_DUE', 'Idle continuation is not due');
  if ((original.continuationHistory?.length ?? 0) >= MAX_HANDOFFS) fail('RESOURCE_LIMIT', 'Owner handoff history limit reached; no replacement created');
  const owner = this.store.getOwner(original.ownerId!);
  if (!owner) return fail('NOT_FOUND', 'Task has no logical owner');
  const targetProfile = profileId ?? owner.profileId;
  if (!targetProfile.trim() || targetProfile.length > 120) fail('INVALID_REQUEST', 'Invalid owner profile');
  const at = new Date(this.now()).toISOString();
  const pack = this.assemble(original, targetProfile, epoch + 1, at);
  const replacement: LogicalOwner = {id: randomUUID(), name: owner.name, profileId: targetProfile, mode: owner.mode, state: owner.mode === 'mock' ? 'ready' : 'attached', createdAt: at};
  let spawned = false;
  try {
   // Register cleanup before creating a mock host or a manual local attachment.
   spawned = true;
   let acknowledgementId: string | null = null;
   if (owner.mode === 'mock') {
    replacement.host = this.host.spawn({ownerId: replacement.id, name: replacement.name, profileId: targetProfile});
    const ready = this.host.inspect(replacement.id).host;
    if (ready.state !== 'ready' || ready.mode !== 'mock' || !ready.ownsHost) fail('OWNER_NOT_READY', 'Replacement owner is not ready');
    const message = this.host.send(replacement.id, JSON.stringify(pack));
    const ack = this.host.acknowledge(replacement.id, message.id);
    if (ack.status !== 'acknowledged' || ack.ownerId !== replacement.id || ack.id !== message.id) fail('OWNER_NOT_READY', 'Replacement did not acknowledge its context pack');
    replacement.messages = [ack]; acknowledgementId = ack.id;
   } else {
    replacement.host = this.host.attach({ownerId: replacement.id, name: replacement.name, profileId: targetProfile, session: 'external-cli', pane: 'unverified'});
    pack.limitations.push('External owner must read this context pack itself', 'The real CLI host performs any context switch; Weaver did not start a new AI or reset a vendor cache', 'No automatic delivery to, or acknowledgement from, the external host');
    if (Buffer.byteLength(JSON.stringify(pack)) > MAX_CONTEXT_PACK_BYTES) fail('CONTEXT_LIMIT', 'Context pack exceeds bounded size');
   }
   const handoff: HandoffRecord = {id: randomUUID(), at, reason, fromOwnerId: owner.id, toOwnerId: replacement.id,
    fromProfileId: owner.profileId, toProfileId: targetProfile, epoch: epoch + 1, packId: pack.id, acknowledgementId};
   this.store.transaction(() => {
    const current = this.read(taskId);
    if ((current.ownerEpoch ?? 0) !== epoch || current.ownerId !== owner.id) fail('OWNER_EPOCH_CONFLICT', 'Owner changed while preparing continuation');
    this.revision(current, expectedRevision); assertQuiescent(current);
    this.store.putOwner(replacement);
    current.ownerId = replacement.id;
    current.owner = {...current.owner, name: replacement.name};
    current.ownerEpoch = epoch + 1; current.ownerLastActivityAt = at; current.updatedAt = at;
    current.revision = (current.revision ?? 0) + 1;
    current.contextPack = pack; current.continuationHistory = [...(current.continuationHistory ?? []), handoff];
    this.store.put(current);
   });
   // Old owner/messages are retained unchanged for inspection. Only its binding is superseded.
   return this.get(taskId);
  } catch (error) {
   if (spawned) { try { this.host.close(replacement.id); } catch { /* No external host is ever owned by this service. */ } }
   throw error;
  }
 }
 private read(taskId: string): ContinuationTask { return this.store.get(taskId) as ContinuationTask; }
 private revision(task: Task, revision: number) {
  if (!Number.isSafeInteger(revision) || revision !== (task.revision ?? 0)) fail('REVISION_CONFLICT', `Current revision is ${task.revision ?? 0}`);
 }
 private assemble(task: ContinuationTask, profile: string, epoch: number, at: string): ContextPack {
  const pkg = this.store.getPackage(task.packageId!);
  const clean = (values: string[]) => values.slice(0, 12).map(v => redactContext(v, 400));
  const pack: ContextPack = {
   version: 1, id: randomUUID(), createdAt: at, taskId: task.id, ownerEpoch: epoch,
   goal: redactContext(task.instruction, 1600), workspace: task.workspace ? redactContext(task.workspace, 300) : null,
   profile: redactContext(profile, 120), constraints: clean(task.constraints ?? []),
   plan: clean(pkg?.scope ?? []),
   decisions: task.reviewState && task.reviewState !== 'pending' ? [redactContext(`Result review: ${task.reviewState}${task.reviewComment ? `: ${task.reviewComment}` : ''}`, 800)] : [],
   taskProgress: {status: task.status, percent: task.progress, summary: task.summary ? redactContext(task.summary, 1000) : null},
   acceptedArtifacts: task.reviewState === 'accepted' ? task.artifacts.slice(0, 20).map(a => ({id: a.id, name: redactContext(a.name, 150), mediaType: a.mediaType, sha256: createHash('sha256').update(a.content).digest('hex')})) : [],
   pendingApprovals: task.status === 'completed' && (!task.reviewState || task.reviewState === 'pending') ? ['Completed result awaits owner acceptance review'] : [],
   recentMessages: task.events.filter(e => e.kind !== 'log' && e.kind !== 'progress').slice(-8).map(e => ({kind: e.kind, at: e.at, message: redactContext(e.message, 500)})),
   baseReferences: {taskId: task.id, packageId: pkg?.id ?? null, previousPackId: task.contextPack?.id ?? null},
   limitations: ['Bounded snapshot; artifact bodies and full transcripts omitted', 'Plan contains recorded work-package scope only; no inferred decisions', 'Redaction is best-effort; host transport is not established by this pack', 'Idle interval is user policy, not vendor cache retention']
  };
  if (Buffer.byteLength(JSON.stringify(pack)) > MAX_CONTEXT_PACK_BYTES) fail('CONTEXT_LIMIT', 'Context pack exceeds bounded size');
  return pack;
 }
}
