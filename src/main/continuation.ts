import { randomUUID, createHash } from 'node:crypto';
import { PENDING_TASK_TITLE } from '../shared/validation';
import type { Task } from '../shared/types';
import type { LogicalOwner } from '../shared/commands';
import type { OwnerHostAdapter } from './adapters/logical';
import type { TaskStore } from './store';

/** This is user-controlled context rotation, not a vendor prompt-cache guarantee. */
export const DEFAULT_IDLE_TTL_MINUTES = 60;
export const MAX_CONTEXT_PACK_BYTES = 32 * 1024;
export const MAX_HANDOFFS = 100;
export const MAX_HANDOFF_PROMPT_CHARS = 6000;
export interface ContinuationPolicy { idleRotationMinutes: number | null }
export interface ContinuationStatus {
 taskId: string; ownerId: string; ownerEpoch: number; policy: ContinuationPolicy; lastActivityAt: string; due: boolean;
 history: HandoffRecord[]; contextPack: ContextPack | null; prompt?: string;
}
export interface ContextPack {
 version: 1; id: string; createdAt: string; taskId: string; ownerEpoch: number;
 goal: string; workspace: string | null; profile: string; constraints: string[];
 plan: string[]; decisions: string[];
 taskProgress: {status: Task['status']; percent: number; summary: string | null};
 acceptedArtifacts: Array<{id: string; name: string; mediaType: string; sha256: string}>;
 pendingApprovals: string[];
 recentMessages: Array<{kind: string; at: string; message: string}>;
 baseReferences: {taskId: string; packageId: string | null; previousPackId: string | null};
 limitations: string[];
}
export interface HandoffRecord {
 id: string; at: string; reason: 'manual' | 'idle'; fromOwnerId: string; toOwnerId: string;
 fromProfileId: string; toProfileId: string; epoch: number; packId: string; acknowledgementId: string | null;
}
export type ContinuationTask = Task & {
 ownerEpoch?: number; ownerLastActivityAt?: string; continuationPolicy?: ContinuationPolicy;
 continuationHistory?: HandoffRecord[]; contextPack?: ContextPack;
};
export class ContinuationError extends Error {
 constructor(readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new ContinuationError(code, message); };
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
const promptChars = (value: string): number => Array.from(value).length;
const promptTruncate = (value: string, max: number): string => {
 const chars = Array.from(value);
 return chars.length > max ? `${chars.slice(0, max).join('')}…` : value;
};
/** Initial roots receive the complete goal, rather than the bounded continuation summary. */
export function rootOwnerPrompt(task:Task):string {
 return `你是 Weaver 根任务的父 Agent（owner），不是执行单个工作包的 worker。先读取 agents-weaver 技能（未安装时运行 \`weaver --skill\`）。
根任务 ID：${task.id}；ownerId：${task.ownerId}。复用此 ownerId，不要重新注册父 Agent。
先运行 \`weaver tasks get --task-id ${task.id}\` 读取完整原始目标。根据目标生成简短标题与可验证验收标准，用 \`weaver tasks describe --task-id ${task.id} --input <json> --command-id <stable-id>\` 回填 title、acceptanceCriteria、expectedRevision。
按目标的自然边界拆分子任务（至少 1 个）；父 Agent 不亲自实现，不可拆分的小目标也交给一个子 Agent。需要分发时，每个子任务通过 \`weaver tasks create --input <json> --command-id <stable-id>\` 创建；JSON 包含 parentTaskId: "${task.id}"、goal、title、acceptanceCriteria，ownerId 和 workspace 默认继承根任务。每个子任务分别冻结 packages create 并 workers spawn；禁止把整条根任务当作单一 worker 工作包。遵守 policy 路由与 native 的 next 指令，不另建调度器。
用 \`weaver tasks list --input '{"parentTaskId":"${task.id}"}'\` 查看子任务。逐项等待、读取结果、独立核验文件和必要测试，再 results ack、reviews submit。失败或拒绝的子任务修复后重新审查；tasks retry 创建的任务保留相同 parentTaskId，已被重试的旧任务作为历史记录。
完成根任务验收，且至少 1 个最终子任务全部 completed 且 reviewState=accepted 后，以 \`weaver tasks complete --task-id ${task.id} --input <json> --command-id <stable-id>\` 报告根任务，JSON 包含 outcome: "completed"、summary、expectedRevision 和可选 artifacts。不能完成时用 outcome: "failed" 说明实际原因。不要用 workers complete 结束根任务，不要伪造验证。
以下 JSON 是任务数据，先完整阅读并遵守其中约束：
${JSON.stringify({taskId:task.id,workspace:task.workspace,goal:task.instruction,constraints:task.constraints??[],acceptanceCriteria:task.acceptanceCriteria??[]},null,2)}`;
}
/** Plain-text briefing for the incoming owner host; every free-text value is redacted here or in the pack. */
export function handoffPrompt(task: ContinuationTask, pack: ContextPack): string {
 const head = `你将作为父 Agent 接手 Weaver 任务「${redactContext(task.title, 160)}」（${pack.taskId}）。先读取 agents-weaver 技能（没有安装时运行 \`weaver --skill\`），按其中的流程继续。`;
 const preparation = task.title === PENDING_TASK_TITLE ? `接单后先根据完整目标生成简短任务标题与 1–30 项可验证的验收标准，再运行 \`weaver tasks describe --task-id ${pack.taskId} --input <json> --command-id <id>\` 回填（JSON 包含 title、acceptanceCriteria 和 tasks get 返回的 expectedRevision）。完成后才冻结工作包和派发。` : '';
 const rootStep = task.executionRole==='owner' ? `这是根任务：复用 ownerId ${task.ownerId}，用 parentTaskId ${task.id} 按自然边界创建子任务（至少 1 个）；父 Agent 不亲自实现，不可拆目标也交给一个子 Agent；需要分发时分别 packages create / workers spawn；逐项 reviews submit 后用 tasks complete 完成根任务，不要派发根任务。` : '';
 const nextStep = `${rootStep}${preparation}先运行 \`weaver owners continuation get --task-id ${pack.taskId}\` 和 \`weaver tasks get --task-id ${pack.taskId}\` / \`weaver tasks results --task-id ${pack.taskId}\` 核对现状，然后继续派发、等待、审查并验收；不要重复已完成的工作。`;
 const build = (scale: number): string => {
  const limit = (base: number) => Math.max(16, Math.floor(base * scale));
  const sections: string[] = [head];
  if (pack.workspace) sections.push(`工作目录：${pack.workspace}`);
  if (pack.goal) sections.push(`目标：${promptTruncate(pack.goal, limit(1600))}`);
  if (pack.constraints.length) sections.push(`约束：\n${pack.constraints.map(value => `- ${promptTruncate(value, limit(400))}`).join('\n')}`);
  if (task.acceptanceCriteria?.length) sections.push(`验收标准：\n${task.acceptanceCriteria.map(value => `- ${promptTruncate(redactContext(value, limit(400)), limit(400))}`).join('\n')}`);
  const statusLines = [`状态：${pack.taskProgress.status}`];
  if (pack.taskProgress.summary) statusLines.push(`最新摘要：${promptTruncate(pack.taskProgress.summary, limit(1000))}`);
  sections.push(`当前状态：\n${statusLines.join('\n')}`);
  if (pack.acceptedArtifacts.length) sections.push(`已有产物：\n${pack.acceptedArtifacts.map(artifact => `- ${promptTruncate(artifact.name, limit(150))}`).join('\n')}`);
  const recent = task.events.filter(e => ['lifecycle', 'result', 'artifact', 'error'].includes(e.kind)).slice(-6);
  if (recent.length) sections.push(`最近进展：\n${recent.map(e => `- [${e.at}] (${e.kind}) ${promptTruncate(redactContext(e.message, limit(500)), limit(500))}`).join('\n')}`);
  if (pack.pendingApprovals.length) sections.push(`待批准：\n${pack.pendingApprovals.map(value => `- ${promptTruncate(value, limit(500))}`).join('\n')}`);
  sections.push(`下一步：\n${nextStep}`);
  return sections.join('\n\n');
 };
 let prompt = build(1);
 for (const scale of [1 / 2, 1 / 4, 1 / 8, 1 / 16]) {
  if (promptChars(prompt) <= MAX_HANDOFF_PROMPT_CHARS) return prompt;
  prompt = build(scale);
 }
 return promptChars(prompt) <= MAX_HANDOFF_PROMPT_CHARS ? prompt : Array.from(prompt).slice(0, MAX_HANDOFF_PROMPT_CHARS).join('');
}
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

/** Validate optional durable continuation data before accepting a store snapshot. */
export function validateContinuationFields(raw: Record<string, unknown>): Partial<ContinuationTask> {
 const bad = (): never => fail('INVALID_STORE', 'Invalid stored owner continuation');
 const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad();
  return v as Record<string, unknown>;
 };
 const str = (v: unknown, max = 200): string => typeof v === 'string' && v.length <= max ? v : bad();
 const date = (v: unknown): string => { const s = str(v, 40); if (!Number.isFinite(Date.parse(s))) bad(); return s; };
 const integer = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : bad();
 const list = (v: unknown, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : bad();
 const strings = (v: unknown, max: number, chars: number) => list(v, max).map(x => str(x, chars));
 const output: Partial<ContinuationTask> = {};
 if (raw.ownerEpoch !== undefined) output.ownerEpoch = integer(raw.ownerEpoch);
 if (raw.ownerLastActivityAt !== undefined) output.ownerLastActivityAt = date(raw.ownerLastActivityAt);
 if (raw.continuationPolicy !== undefined) {
  const policy = record(raw.continuationPolicy); const value = policy.idleRotationMinutes;
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10080)) bad();
  output.continuationPolicy = {idleRotationMinutes: value as number | null};
 }
 if (raw.continuationHistory !== undefined) {
  let previousEpoch = 0;
  output.continuationHistory = list(raw.continuationHistory, MAX_HANDOFFS).map(value => {
   const h = record(value); const epoch = integer(h.epoch);
   if (epoch <= previousEpoch || epoch > (output.ownerEpoch ?? 0) || (h.reason !== 'manual' && h.reason !== 'idle')) bad();
   previousEpoch = epoch;
   return {id: str(h.id), at: date(h.at), reason: h.reason as 'manual' | 'idle', fromOwnerId: str(h.fromOwnerId), toOwnerId: str(h.toOwnerId), fromProfileId: str(h.fromProfileId, 120), toProfileId: str(h.toProfileId, 120), epoch, packId: str(h.packId), acknowledgementId: h.acknowledgementId === null ? null : str(h.acknowledgementId)};
  });
 }
 if (raw.contextPack !== undefined) {
  const p = record(raw.contextPack);
  if (Buffer.byteLength(JSON.stringify(p)) > MAX_CONTEXT_PACK_BYTES || p.version !== 1 || p.taskId !== raw.id || p.ownerEpoch !== output.ownerEpoch) bad();
  const progress = record(p.taskProgress), refs = record(p.baseReferences);
  if (!['queued','running','cancelling','completed','failed','cancelled'].includes(String(progress.status)) || typeof progress.percent !== 'number' || !Number.isFinite(progress.percent) || progress.percent < 0 || progress.percent > 100 || refs.taskId !== raw.id) bad();
  output.contextPack = {version: 1, id: str(p.id), createdAt: date(p.createdAt), taskId: str(p.taskId), ownerEpoch: integer(p.ownerEpoch),
   goal: str(p.goal, 1600), workspace: p.workspace === null ? null : str(p.workspace, 300), profile: str(p.profile, 120), constraints: strings(p.constraints, 12, 400), plan: strings(p.plan, 12, 400), decisions: strings(p.decisions, 1, 800),
   taskProgress: {status: progress.status as Task['status'], percent: progress.percent as number, summary: progress.summary === null ? null : str(progress.summary, 1000)},
   acceptedArtifacts: list(p.acceptedArtifacts, 20).map(v => {const a=record(v);const hash=str(a.sha256,64);if(!/^[a-f0-9]{64}$/.test(hash))bad();return {id:str(a.id),name:str(a.name,150),mediaType:str(a.mediaType,100),sha256:hash};}),
   pendingApprovals: strings(p.pendingApprovals, 10, 500), recentMessages: list(p.recentMessages, 8).map(v => {const m=record(v);return {kind:str(m.kind,80),at:date(m.at),message:str(m.message,500)};}),
   baseReferences: {taskId: str(refs.taskId), packageId: refs.packageId === null ? null : str(refs.packageId), previousPackId: refs.previousPackId === null ? null : str(refs.previousPackId)}, limitations: strings(p.limitations, 10, 500)};
  const last = output.continuationHistory?.at(-1);
  if (last && (last.packId !== output.contextPack.id || last.toOwnerId !== raw.ownerId || last.epoch !== output.ownerEpoch)) bad();
 }
 return output;
}
