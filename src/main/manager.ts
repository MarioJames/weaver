import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import type { Artifact, RealEngineKind, Task, TaskInput, TaskFailure, WorkerRecord } from '../shared/contracts/tasks';
import { parseTaskInput } from '../shared/validation';
import type { ManagedProcess, WorkerAdapter } from './adapters/worker';
import type { CliRun, RunAttachState, RunBatch, RunCursor, RunFinal, RunLaunchRecord } from './adapters/cli/run';
import { cleanupEscapedDescendants, type EscapedCleanup } from './adapters/cli/scope';
import { pidInScope } from './monitors/process-tree';
import { JsonlParser } from './protocol';
import { event, slotGroupCount, slotGroupName, slotGroupOf } from './domain/tasks';
import type { TaskStore } from './store';
import { classifyVendorError } from './adapters/cli/vendor-errors';
import { redactSecrets } from '../shared/redact';
import { redactContext } from './redact-context';

const KILL_GRACE_MS = 1500;
const FIRST_OUTPUT_MS = 120_000;
const ARTIFACT_LIMIT = 20;
const STDERR_TAIL = 2048;
const IDENTITY_WAIT_MS = 2_000;
const UNKNOWN_OUTCOME_MESSAGE = 'Execution result unknown: the worker scope ended without an exit record. Retry explicitly with tasks retry.';
const ARTIFACT_OVERFLOW_MESSAGE = 'Artifact limit reached (20); further worker artifacts are not stored, results are unaffected';

interface Running {
  child?: ManagedProcess;
  run?: CliRun;
  runId?: string;
  timeout?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  firstTimer?: NodeJS.Timeout;
  error?: string;
  result?: string;
  cancelled: boolean;
  stderrTail: string;
  adapterTail?: boolean;
  vendorError?: string;
  terminating?: boolean;
  detached?: boolean;
  artifactOverflowNoted?: boolean;
}

interface FileRunAdapter extends WorkerAdapter {
  startRun?: (task: Task, runId: string, beforeSpawn: (record: RunLaunchRecord) => void) => CliRun;
  attachRun?: (task: Task, state: RunAttachState) => CliRun;
}

interface AttachOptions {
  invocation?: string;
  cancelled: boolean;
  deferNoOutput?: boolean;
}

function isoAt(ms: number): string { return new Date(ms).toISOString(); }

function parseIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function invalidCursor(cursor: RunCursor): boolean {
  return [cursor.stdoutOffset, cursor.stderrOffset, cursor.appliedRecords].some(value => !Number.isSafeInteger(value) || value < 0);
}

/** `herdr.max_wait_minutes` is the owner's polling bound, never an execution deadline: only a direct mock test may pass the short hook. */
export function executionTimeoutMs(task: Pick<Task, 'dispatch'>, fallback?: number): number | undefined {
  if ((task.dispatch?.execution ?? 'mock') !== 'mock') return undefined;
  if (fallback !== undefined && Number.isSafeInteger(fallback) && fallback > 0) return fallback;
  return undefined;
}

/** Main-process launch port: application services may capture safe metadata and synchronously veto spawn. */
export interface TaskLaunchGuard {
  capture(task: Task): import('../shared/contracts/tasks').AgentRun['consoleAccount'];
  beforeSpawn(task: Task): void;
}

export class TaskManager {
  launchGuard?: TaskLaunchGuard;
  readonly listeners = new Set<() => void>();
  notify(): void { this.changed(); for (const listener of this.listeners) listener(); }
  update(task: Task): void { this.persist(task); }
  private running = new Map<string, Running>();
  private recoveryTimers = new Map<string, NodeJS.Timeout>();
  private launchGate = true;
  private committing: (() => void) | undefined;
  get runningCount(): number { return this.running.size; }
  get adapterId(): string { return this.adapter.id; }
  get canLaunchReal(): boolean { return this.adapter.canLaunchReal?.() === true; }
  /** The shutdown gate handed to guardPiRun: a closed gate aborts a pending pi preflight before beforeSpawn. */
  get launchGateOpen(): boolean { return this.launchGate; }
  get shuttingDown(): boolean { return !this.launchGate; }
  constructor(readonly store: TaskStore, private adapter: WorkerAdapter, private changed: () => void = () => {}, private timeoutMs?: number, private fatal: (error: unknown) => void = console.error, committed?: () => void) {
    this.committing = committed;
    if (committed) this.store.onCommit(() => this.committing?.());
  }
  private fileAdapter(): FileRunAdapter { return this.adapter as FileRunAdapter; }
  /** RoutingWorkerAdapter always exposes startRun; its private launcher field tells whether a file-mode launcher was wired. */
  private canFileStart(): boolean {
    const adapter = this.adapter as FileRunAdapter & { startRunFn?: unknown };
    if (typeof adapter.startRun !== 'function') return false;
    if ('startRunFn' in adapter) return adapter.startRunFn !== undefined;
    return true;
  }
  create(input: TaskInput, id: string = randomUUID()): Task {
    const valid = parseTaskInput(input);
    const at = new Date().toISOString();
    const task: Task = { ...valid, id, createdAt: at, updatedAt: at, status: 'queued', revision: 0, reviewState: 'pending', progress: 0, events: [], artifacts: [] };
    event(task, 'lifecycle', 'Task queued. Owner reference is metadata only; no Herdr session was contacted.');
    this.persist(task); return task;
  }
  start(id: string, liveMaxParallel?: number): Task {
    if (!this.launchGate) throw new Error('Task manager is shutting down; no new worker may start');
    const task = this.store.get(id);
    if (task.status !== 'queued') throw new Error('Only queued tasks can be started');
    if (task.dispatch) {
      const limit = liveMaxParallel ?? task.dispatch.maxParallel;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Configured max_parallel is invalid');
      const group = slotGroupOf(task);
      const running = slotGroupCount(this.store.listHeads(), group);
      if (running >= limit) throw new Error(`${slotGroupName(this.store.listOwners(), task.ownerId, task.dispatch.owner)} is at its configured concurrency limit (${limit})`);
    }
    const consoleAccount = this.launchGuard?.capture(task);
    const timeoutMs = executionTimeoutMs(task, this.timeoutMs);
    const execution = task.dispatch?.execution ?? 'mock';
    delete task.failure;
    task.scheduled = false;
    delete task.queueReason;
    task.status = 'running';
    task.run = {
      id: randomUUID(),
      ...(consoleAccount ? { consoleAccount } : {}),
      adapter: task.dispatch?.adapter ?? (execution === 'mock' ? 'mock-jsonl' : this.adapter.id),
      execution,
      status: 'running',
      startedAt: new Date().toISOString(),
      ...(task.dispatch ? { engine: task.dispatch.engine, model: task.dispatch.model, effort: task.dispatch.effort, workspace: task.dispatch.workspace ?? task.workspace } : {}),
    };
    if (execution === 'native') {
      // The owner runs this worker itself and reports back through completeNative; there is no process or timer here.
      event(task, 'lifecycle', `Owner runs ${task.dispatch?.worker} with its built-in subagent tool; waiting for its report`);
      this.persist(task);
      return this.store.get(id);
    }
    event(task, 'lifecycle', execution === 'real'
      ? `Launching ${task.dispatch?.engineKind ?? task.dispatch?.engine} in ${task.dispatch?.workspace}`
      : 'Launching explicit mock-jsonl provider');
    // A real run is persisted in its preparing shape first: no launchPermittedAt until beforeSpawn commits it.
    this.persist(task);
    if (execution === 'real' && this.canFileStart()) return this.startFileRun(id, task);
    return this.startLegacyRun(id, task, execution, timeoutMs);
  }
  private startFileRun(id: string, task: Task): Task {
    const adapter = this.fileAdapter();
    let cli: CliRun;
    try {
      cli = adapter.startRun!(task, task.run!.id, record => this.beforeSpawn(id, record));
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error)).slice(-4000);
      this.finalizeFailureNow(id, { kind: 'early_exit', message });
      return this.store.get(id);
    }
    const active: Running = { run: cli, runId: task.run!.id, cancelled: false, stderrTail: '' };
    this.running.set(id, active);
    if (cli.pid !== undefined) {
      // Re-read: beforeSpawn committed the launch record on its own snapshot.
      const current = this.store.get(id);
      if (current.run && !current.run.finalizedAt && current.run.pid !== cli.pid) { current.run.pid = cli.pid; this.persist(current); }
    }
    this.wireRun(id, active);
    this.armNoOutput(id);
    return this.store.get(id);
  }
  /** The single commit that permits an external spawn. Its failure closes the run files and never spawns. */
  private beforeSpawn(id: string, record: RunLaunchRecord): void {
    this.store.transaction(() => {
      const task = this.store.get(id);
      if (!task.run) throw new Error('Run disappeared before the launch permission commit');
      if (!this.launchGate) throw new Error('Task manager launch gate is closed');
      this.launchGuard?.beforeSpawn(task);
      const at = new Date().toISOString();
      const started = parseIso(task.run.startedAt) ?? Date.now();
      task.run.launchPermittedAt = at;
      task.run.scopeUnit = record.unit;
      task.run.stateDir = record.stateDir;
      task.run.nonce = record.nonce;
      task.run.logs = {
        stdout: record.logs.stdout,
        stderr: record.logs.stderr,
        exit: record.logs.exit,
        ...(record.logs.exitTmp ? { exitTmp: record.logs.exitTmp } : {}),
      };
      task.run.logIdentity = {
        stdout: { ...record.logIdentity.stdout },
        stderr: { ...record.logIdentity.stderr },
      };
      task.run.noOutputDeadline = isoAt(started + FIRST_OUTPUT_MS);
      task.run.replay = { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 0 };
      this.persist(task);
    });
  }
  private startLegacyRun(id: string, task: Task, execution: 'real' | 'mock' | 'native', timeoutMs: number | undefined): Task {
    let child: ManagedProcess;
    try { this.launchGuard?.beforeSpawn(task); child = this.adapter.start(task); } catch (error) {
      task.failure = { kind: 'early_exit', message: redactSecrets(error instanceof Error ? error.message : String(error)).slice(-4000) };
      task.status = 'failed'; task.run!.status = 'stopped'; task.run!.endedAt = new Date().toISOString(); task.run!.finalizedAt = new Date().toISOString();
      event(task, 'error', task.failure.message); this.persist(task); return task;
    }
    const run: Running = { child, cancelled: false, stderrTail: '', ...(timeoutMs === undefined ? {} : { timeout: setTimeout(() => this.stop(id, 'Mock worker exceeded its test timeout'), timeoutMs) }) };
    this.running.set(id, run);
    if (execution === 'real') {
      run.firstTimer = setTimeout(() => this.failAttempt(id, { kind: 'no_output', message: 'Worker produced no valid vendor output within 120 seconds' }), FIRST_OUTPUT_MS);
      child.on('first-output', (at: string) => { const current = this.store.get(id); if (run.error || run.cancelled || current.run?.firstOutputAt) return; clearTimeout(run.firstTimer); if (current.run) current.run.firstOutputAt = at; this.persist(current, 'stream'); });
      child.on('stderr-tail', (tail: string) => { run.adapterTail = true; run.stderrTail = tail; });
      child.on('vendor-error', (message: string, failure?: TaskFailure) => { run.vendorError = redactSecrets(message).slice(-2048); if (failure) this.failAttempt(id, { ...failure, vendorError: run.vendorError }); });
      child.on('engine-model', (report: { actual: string; expected: string; match: boolean; responseModel?: string }) => this.recordEngineModel(id, run, report));
      child.on('cleanup', (cleaned: EscapedCleanup) => this.onRunCleanup(id, undefined, cleaned));
    }
    const parser = new JsonlParser(record => this.record(id, record));
    child.stdout.on('data', (chunk: Buffer) => {
      if (run.error || run.cancelled) return;
      try { parser.push(chunk); } catch (error) { this.stop(id, `Invalid worker output: ${String(error)}`); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (run.error || run.cancelled) return;
      const safe = redactSecrets(chunk.toString('utf8'));
      if (!run.adapterTail) run.stderrTail = (run.stderrTail + safe).slice(-2048);
      if (execution === 'real') {
        const failure = classifyVendorError(task.dispatch?.engineKind ?? task.run?.adapter ?? '', run.stderrTail);
        if (failure) { this.failAttempt(id, { ...failure, stderrTail: run.stderrTail }); return; }
      }
      // Mock stderr has no volume cap: chunks become bounded timeline records below, so a chatty worker can no longer fail its own run.
      const clipped = safe.length > 8000 ? `${safe.slice(0, 8000)}…（单条 stderr 已截断）` : safe;
      try { const current = this.store.get(id); event(current, 'log', `stderr: ${clipped}`); this.persist(current, 'stream'); } catch (error) { this.stop(id, 'Unable to persist stderr'); this.fatal(error); }
    });
    child.on('error', (error: Error) => { this.failAttempt(id, { kind: task.run?.firstOutputAt ? 'other' : 'early_exit', message: redactSecrets(error.message).slice(-4000) }); });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (run.detached) return;
      clearTimeout(run.timeout); clearTimeout(run.killTimer); clearTimeout(run.firstTimer);
      if (!run.error && !run.cancelled) { try { parser.finish(); } catch (error) { run.error = `Invalid worker output: ${String(error)}`; } }
      this.running.delete(id);
      try {
        const current = this.store.get(id);
        if (current.run) { this.observe(current, child); current.run.status = 'stopped'; current.run.endedAt = new Date().toISOString(); current.run.exitCode = code; current.run.finalizedAt = new Date().toISOString(); delete current.run.pid; }
        if (run.cancelled) { current.failure ??= { kind: 'cancelled', message: 'Worker cancelled', ...(run.stderrTail ? { stderrTail: run.stderrTail } : {}) }; current.status = 'cancelled'; event(current, 'lifecycle', 'Worker stopped after cancellation'); }
        else if (run.error || code !== 0 || !run.result) {
          current.status = 'failed';
          const existing = current.failure;
          current.failure = { ...(existing ?? { kind: current.run?.firstOutputAt ? 'vendor' : 'early_exit', message: run.error || `Worker exited without successful result (code ${code}, signal ${signal ?? 'none'})` }), ...(code !== null ? { exitCode: code } : {}), ...(run.stderrTail ? { stderrTail: run.stderrTail } : {}), ...(run.vendorError ? { vendorError: run.vendorError } : {}) };
          if (!existing) event(current, 'error', this.failureDetail(current.failure));
          else { const errorEvent = [...current.events].reverse().find(item => item.kind === 'error'); if (errorEvent) errorEvent.message = this.failureDetail(current.failure); }
        } else { current.status = 'completed'; current.progress = 100; current.summary = run.result; event(current, 'lifecycle', 'Worker exited successfully; output is ready for owner review'); }
        this.persist(current);
      } catch (error) { this.fatal(error); }
    });
    task.run!.pid = child.pid;
    this.observe(task, child);
    try { this.persist(task); } catch (error) { this.stop(id, 'Unable to persist worker PID'); throw error; }
    return this.store.get(id);
  }
  cancel(id: string): Task {
    const task = this.requestCancel(id);
    if (task.status === 'cancelling') this.enforceTermination(id);
    return task;
  }
  /** Persist only the cancellation intent; external signals are sent by enforceTermination after the transaction commits. */
  requestCancel(id: string): Task {
    const task = this.store.get(id);
    if (task.status === 'queued') { task.status = 'cancelled'; task.scheduled = false; delete task.queueReason; event(task, 'lifecycle', 'Cancelled before dispatch'); this.persist(task); return task; }
    if (task.status === 'cancelling' || task.status === 'cancelled') return task;
    if (task.status !== 'running') throw new Error('Only queued or running tasks can be cancelled');
    if (task.run?.execution === 'native') {
      task.status = 'cancelled'; task.run.status = 'stopped'; task.run.endedAt = new Date().toISOString(); task.run.finalizedAt = new Date().toISOString();
      event(task, 'lifecycle', 'Cancelled; the owner should stop its built-in subagent'); this.persist(task); return task;
    }
    const at = Date.now();
    task.status = 'cancelling';
    if (task.run) {
      task.run.status = 'stopping';
      task.run.cancelRequestedAt ??= isoAt(at);
      task.run.cancelSignal = 'SIGTERM';
      task.run.killAfter ??= isoAt(at + KILL_GRACE_MS);
      task.run.terminationPhase ??= 'term';
    }
    event(task, 'lifecycle', 'Cancellation requested; waiting for worker exit');
    this.persist(task);
    return task;
  }
  /** Send the already-persisted termination intent. A missing in-memory run keeps the intent for reattach. */
  enforceTermination(id: string): void {
    const active = this.running.get(id);
    if (!active) return;
    active.cancelled = true;
    active.run?.setCancelled();
    this.terminateActive(id, active);
  }
  /** The owner's report for a native run. Artifacts are already validated plain files. */
  completeNative(id: string, report: { outcome: 'completed' | 'failed'; summary: string; artifacts: Pick<Artifact, 'name' | 'mediaType' | 'content'>[] }): Task {
    const task = this.store.get(id);
    if (task.status !== 'running' || task.run?.execution !== 'native') throw new Error('Only a running native task accepts a report');
    const at = new Date().toISOString();
    for (const artifact of report.artifacts) { task.artifacts.push({ id: randomUUID(), ...artifact, createdAt: at }); event(task, 'artifact', `Received ${artifact.name}`); }
    task.run.status = 'stopped'; task.run.endedAt = at; task.run.finalizedAt = at;
    if (report.outcome === 'completed') { task.status = 'completed'; task.progress = 100; task.summary = report.summary; event(task, 'result', report.summary); event(task, 'lifecycle', 'Owner reported the native run complete; output is ready for review'); }
    else { task.status = 'failed'; event(task, 'error', `Owner reported the native run failed: ${report.summary}`); }
    this.persist(task);
    return task;
  }
  async shutdown(): Promise<void> {
    // The gate closes first: a pending pi preflight must not launch after this point.
    this.launchGate = false;
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    const identityDeadline = Date.now() + IDENTITY_WAIT_MS;
    while (Date.now() < identityDeadline) {
      const waiting = [...this.running.entries()].some(([id, active]) => {
        if (!active.run || !active.run.unit) return false;
        try { return !this.store.get(id).run?.scopeInvocation; } catch { return false; }
      });
      if (!waiting) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const mockExits: Promise<void>[] = [];
    for (const [id, active] of [...this.running]) {
      if (active.run) {
        clearTimeout(active.firstTimer); clearTimeout(active.killTimer); clearTimeout(active.timeout);
        active.run.detach();
        active.detached = true;
        this.running.delete(id);
        continue;
      }
      const task = this.store.get(id);
      if ((task.run?.execution ?? task.dispatch?.execution ?? 'mock') === 'mock' && active.child) {
        const exited = new Promise<void>(resolve => { const child = active.child!; let settled = false; const finish = () => { if (!settled) { settled = true; resolve(); } }; child.once('close', finish); setTimeout(finish, 2000).unref(); });
        mockExits.push(exited);
        try {
          if (task.status === 'running' || task.status === 'cancelling') { this.requestCancel(id); this.enforceTermination(id); }
          else if (active.killTimer === undefined) active.child.kill('SIGTERM');
        } catch (error) { this.fatal(error); }
      } else {
        // A legacy non-file real run cannot be detached; never cancel it. Suppress its late writes.
        // Unref (never kill) the launcher/pipe handles so a detached legacy run cannot keep the loop alive.
        clearTimeout(active.firstTimer); clearTimeout(active.killTimer); clearTimeout(active.timeout);
        active.firstTimer = undefined; active.killTimer = undefined; active.timeout = undefined;
        try { (active.child?.stdout as unknown as { unref?: () => void } | undefined)?.unref?.(); } catch { /* ignore */ }
        try { (active.child?.stderr as unknown as { unref?: () => void } | undefined)?.unref?.(); } catch { /* ignore */ }
        try { (active.child as unknown as { unref?: () => void } | undefined)?.unref?.(); } catch { /* ignore */ }
        active.detached = true;
        this.running.delete(id);
      }
    }
    await Promise.all(mockExits);
    this.store.flush();
  }
  private failureDetail(failure: TaskFailure): string {
    return [failure.message, failure.exitCode !== undefined ? `exit code: ${failure.exitCode}` : undefined, failure.stderrTail ? `stderr tail: ${failure.stderrTail}` : undefined, failure.vendorError ? `last vendor error: ${failure.vendorError}` : undefined].filter(Boolean).join('; ').slice(-8000);
  }
  private failAttempt(id: string, failure: TaskFailure): void {
    const run = this.running.get(id); if (!run || run.cancelled || run.error) return;
    const task = this.store.get(id);
    this.commitFailure(task, failure, run);
    run.error = task.failure!.message;
    clearTimeout(run.firstTimer);
    this.terminateActive(id, run);
  }
  private commitFailure(task: Task, failure: TaskFailure, active?: Running): void {
    const at = Date.now();
    const vendorError = failure.vendorError ?? active?.vendorError ?? task.run?.vendorError;
    const stderrTail = failure.stderrTail ?? active?.stderrTail ?? task.run?.stderrTail;
    task.failure = {
      ...failure,
      ...(stderrTail ? { stderrTail: stderrTail.slice(-STDERR_TAIL) } : {}),
      ...(vendorError ? { vendorError: vendorError.slice(-STDERR_TAIL) } : {}),
    };
    task.status = 'failed';
    if (task.run) {
      task.run.status = 'stopping';
      task.run.stderrTail = stderrTail?.slice(-STDERR_TAIL) ?? task.run.stderrTail;
      if (vendorError) task.run.vendorError = vendorError.slice(-STDERR_TAIL);
      if (failure.retryAt) task.run.retryAt = failure.retryAt;
      task.run.killAfter ??= isoAt(at + KILL_GRACE_MS);
      task.run.terminationPhase ??= 'term';
    }
    event(task, 'error', this.failureDetail(task.failure));
    this.persist(task);
  }
  /** Reattach-side failure decision: persisted and terminated even when no in-memory run exists. */
  recordFailureIntent(id: string, failure: TaskFailure, options: { logTruncated?: boolean } = {}): Task | undefined {
    const task = this.store.get(id);
    if (task.run?.finalizedAt) return task;
    if (options.logTruncated && task.run) task.run.logTruncated = true;
    if (!task.failure) this.commitFailure(task, failure);
    else {
      const at = Date.now();
      task.status = 'failed';
      if (task.run) { task.run.killAfter ??= isoAt(at + KILL_GRACE_MS); task.run.terminationPhase ??= 'term'; task.run.status = 'stopping'; }
      this.persist(task);
    }
    return this.store.get(id);
  }
  /** The model the engine says it actually used goes on the timeline once; a model other than the configured one fails the attempt, so a wrong-model result is never delivered as a success. */
  private recordEngineModel(id: string, run: Running, report: { actual: string; expected: string; match: boolean; responseModel?: string }): void {
    if (run.error || run.cancelled) return;
    const task = this.store.get(id); const engine = task.dispatch?.engineKind ?? task.dispatch?.engine ?? 'engine';
    event(task, 'lifecycle', `${engine} 实际模型：${report.actual}${report.responseModel ? `（供应商响应模型：${report.responseModel}）` : ''}`);
    this.persist(task, 'stream');
    if (!report.match) this.failAttempt(id, { kind: 'other', message: `${engine} 实际使用 ${report.actual}，配置为 ${report.expected}；结果不可信，已终止。请检查 cc-switch 或本地代理是否改写了模型` });
  }
  private stop(id: string, message: string): void {
    const run = this.running.get(id); if (!run) return;
    if (run.error) return;
    this.failAttempt(id, { kind: 'other', message });
  }
  private terminateActive(id: string, active: Running): void {
    if (active.terminating || active.detached) return;
    active.terminating = true;
    const task = this.store.get(id);
    const killAfter = parseIso(task.run?.killAfter) ?? Date.now() + KILL_GRACE_MS;
    const killNow = () => {
      if (this.running.get(id) !== active || active.detached) return;
      active.killTimer = undefined;
      this.markKillPhase(id);
      void active.run?.terminate('SIGKILL').catch(() => {});
      active.child?.kill('SIGKILL');
    };
    const remaining = killAfter - Date.now();
    if (task.run?.terminationPhase === 'kill' || remaining <= 0) { killNow(); return; }
    void active.run?.terminate('SIGTERM').catch(() => {});
    active.child?.kill('SIGTERM');
    active.killTimer = setTimeout(killNow, remaining);
    active.killTimer.unref?.();
  }
  private markKillPhase(id: string): void {
    try {
      const task = this.store.get(id);
      if (!task.run || task.run.finalizedAt || task.run.terminationPhase === 'kill') return;
      task.run.terminationPhase = 'kill';
      this.persist(task);
    } catch { /* the run may have finalized while the timer fired */ }
  }
  private record(id: string, record: WorkerRecord): void {
    const run = this.running.get(id); if (!run || run.cancelled || run.error) return;
    if (run.result) throw new Error('Records after terminal result are not allowed');
    const task = this.store.get(id);
    this.observe(task, run.child!);
    switch (record.type) {
      case 'log': event(task, 'log', record.message); break;
      case 'progress': task.progress = Math.max(task.progress, record.percent); event(task, 'progress', record.message); break;
      case 'artifact':
        // Artifact storage stays bounded (parity with the tasks.create API limit), but overflow no longer fails the run:
        // the first 20 artifacts and the final result are always kept, extras are dropped with a single timeline note.
        if (task.artifacts.length >= ARTIFACT_LIMIT) {
          this.noteArtifactOverflow(task, run);
          break;
        }
        task.artifacts.push({ id: randomUUID(), name: record.name, mediaType: record.mediaType, content: record.content, createdAt: new Date().toISOString() });
        event(task, 'artifact', `Received ${record.name}`); break;
      case 'result': run.result = record.summary; if (task.run) task.run.resultSummary = record.summary; event(task, 'result', record.summary); break;
    }
    this.persist(task, 'stream');
  }
  private observe(task: Task, child: Pick<ManagedProcess, 'scopeUnit' | 'evidence'>): void {
    if (!task.run) return;
    if (child.scopeUnit) task.run.scopeUnit = child.scopeUnit.slice(0, 200);
    if (child.evidence) this.applyEvidence(task, child.evidence);
  }
  private applyEvidence(task: Task, source: NonNullable<Task['run']>['evidence']): void {
    if (!task.run || !source) return;
    task.run.evidence = {
      engine: source.engine,
      requestedModel: source.requestedModel.slice(0, 200),
      requestedEffort: source.requestedEffort.slice(0, 120),
      workspace: source.workspace.slice(0, 2000),
      terminal: source.terminal,
      ...(source.role ? { role: source.role } : {}),
      ...(source.vendorModel ? { vendorModel: redactContext(source.vendorModel, 512) } : {}),
      ...(source.vendorSessionId ? { vendorSessionId: redactContext(source.vendorSessionId, 512) } : {}),
      ...(source.promptPath ? { promptPath: source.promptPath.slice(0, 2000) } : {}),
      ...(source.sessionDir ? { sessionDir: source.sessionDir.slice(0, 2000) } : {}),
    };
    if (source.usage) {
      task.run.evidence.usage = {};
      for (const key of ['inputTokens', 'outputTokens'] as const) {
        const value = source.usage[key];
        if (Number.isSafeInteger(value) && typeof value === 'number' && value >= 0) task.run.evidence.usage[key] = value;
      }
    }
  }
  private persist(task: Task, durability: 'sync' | 'stream' = 'sync'): void { task.revision = (task.revision ?? 0) + 1; this.store.put(task, durability, this.fatal); this.notify(); }

  // --- file-mode run handling -----------------------------------------------------------------------------------------

  private wireRun(id: string, active: Running, replayed: Array<{ name: string | symbol; args: unknown[] }> = []): void {
    const cli = active.run!;
    cli.on('batch', (batch: RunBatch) => this.onBatch(id, active, batch));
    cli.on('final', (final: RunFinal) => this.onFinal(id, active, final));
    cli.on('identity', (invocation: string) => this.onIdentity(id, active, invocation));
    cli.on('pid', (pid: number) => this.onRunPid(id, active, pid));
    cli.on('cleanup', (cleaned: EscapedCleanup) => this.onRunCleanup(id, active, cleaned));
    cli.on('integrity', (reason: string, detail: string) => this.onIntegrity(id, active, reason, detail));
    cli.on('error', (error: Error) => this.onRunError(id, active, error));
    for (const item of replayed) {
      if (item.name === 'batch') this.onBatch(id, active, item.args[0] as RunBatch);
      else if (item.name === 'final') this.onFinal(id, active, item.args[0] as RunFinal);
      else if (item.name === 'identity') this.onIdentity(id, active, item.args[0] as string);
      else if (item.name === 'integrity') this.onIntegrity(id, active, item.args[0] as string, item.args[1] as string);
      else if (item.name === 'error') this.onRunError(id, active, item.args[0] as Error);
    }
  }
  private isCurrent(id: string, active: Running): boolean {
    if (this.running.get(id) !== active || active.detached) return false;
    const task = this.store.get(id);
    return !!task.run && task.run.id === active.runId && !task.run.finalizedAt;
  }
  private onBatch(id: string, active: Running, batch: RunBatch): void {
    if (!this.isCurrent(id, active)) return;
    const task = this.store.get(id);
    if (!task.run) return;
    const decided = task.status === 'cancelling' || task.status === 'failed' || !!task.run.cancelRequestedAt || !!task.failure;
    if (decided) {
      task.run.replay = { ...batch.cursor };
      if (batch.stderrTail !== undefined) task.run.stderrTail = batch.stderrTail.slice(-STDERR_TAIL);
      if (batch.vendorError) task.run.vendorError = batch.vendorError.slice(-STDERR_TAIL);
      this.persist(task, 'stream');
      return;
    }
    if (invalidCursor(batch.cursor)) {
      this.failActive(id, active, { kind: 'other', message: 'Invalid worker record cursor' });
      return;
    }
    let engineMismatch: { actual: string; expected: string; match: boolean; responseModel?: string } | undefined;
    if (batch.engineModel) {
      engineMismatch = batch.engineModel;
      const engine = task.dispatch?.engineKind ?? task.dispatch?.engine ?? 'engine';
      event(task, 'lifecycle', `${engine} 实际模型：${engineMismatch.actual}${engineMismatch.responseModel ? `（供应商响应模型：${engineMismatch.responseModel}）` : ''}`);
    }
    if (batch.failure || (engineMismatch && !engineMismatch.match)) {
      const failure = batch.failure ?? { kind: 'other' as const, message: `${task.dispatch?.engineKind ?? task.dispatch?.engine ?? 'engine'} 实际使用 ${engineMismatch!.actual}，配置为 ${engineMismatch!.expected}；结果不可信，已终止。请检查 cc-switch 或本地代理是否改写了模型` };
      this.commitFailure(task, { ...failure, ...(batch.vendorError ? { vendorError: batch.vendorError } : {}) }, active);
      active.error = task.failure!.message;
      clearTimeout(active.firstTimer);
      this.terminateActive(id, active);
      return;
    }
    task.run.replay = { ...batch.cursor };
    if (batch.stderrTail !== undefined) task.run.stderrTail = batch.stderrTail.slice(-STDERR_TAIL);
    if (batch.vendorError) task.run.vendorError = batch.vendorError.slice(-STDERR_TAIL);
    if (batch.firstOutput && !task.run.firstOutputAt) {
      task.run.firstOutputAt = new Date().toISOString();
      clearTimeout(active.firstTimer);
    }
    try {
      this.applyRecords(task, batch.records, active);
    } catch (error) {
      this.failActive(id, active, { kind: 'other', message: `Invalid worker output: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    // The first batch that proves vendor output is durable immediately; later batches keep the 500 ms stream window.
    this.persist(task, batch.firstOutput ? 'sync' : 'stream');
  }
  private failActive(id: string, active: Running, failure: TaskFailure): void {
    if (active.error || active.cancelled) return;
    const task = this.store.get(id);
    this.commitFailure(task, failure, active);
    active.error = task.failure!.message;
    clearTimeout(active.firstTimer);
    this.terminateActive(id, active);
  }
  private applyRecords(task: Task, records: WorkerRecord[], active?: Running): void {
    for (const record of records) {
      switch (record.type) {
        case 'log': event(task, 'log', record.message); break;
        case 'progress': task.progress = Math.max(task.progress, record.percent); event(task, 'progress', record.message); break;
        case 'artifact':
          // Artifact storage stays bounded (parity with the tasks.create API limit), but overflow no longer fails the run:
          // the first 20 artifacts and the final result are always kept, extras are dropped with a single timeline note.
          if (task.artifacts.length >= ARTIFACT_LIMIT) {
            this.noteArtifactOverflow(task, active);
            break;
          }
          task.artifacts.push({ id: randomUUID(), name: record.name, mediaType: record.mediaType, content: record.content, createdAt: new Date().toISOString() });
          event(task, 'artifact', `Received ${record.name}`); break;
        case 'result':
          if (task.run?.resultSummary !== undefined) throw new Error('Records after terminal result are not allowed');
          if (task.run) task.run.resultSummary = record.summary;
          event(task, 'result', record.summary); break;
      }
    }
  }
  private noteArtifactOverflow(task: Task, active?: Running): void {
    if (active?.artifactOverflowNoted || task.events.some(item => item.message === ARTIFACT_OVERFLOW_MESSAGE)) {
      if (active) active.artifactOverflowNoted = true;
      return;
    }
    if (active) active.artifactOverflowNoted = true;
    event(task, 'log', ARTIFACT_OVERFLOW_MESSAGE);
  }
  private onRunPid(id: string, active: Running, pid: number): void {
    if (!this.isCurrent(id, active) || !Number.isSafeInteger(pid) || pid < 1) return;
    const task = this.store.get(id);
    if (!task.run || task.run.pid === pid) return;
    task.run.pid = pid;
    this.persist(task, 'stream');
  }
  /** Escaped descendants are cleaned only when the run really ends; detach never emits this. */
  private onRunCleanup(id: string, active: Running | undefined, cleaned: EscapedCleanup): void {
    if (active && !this.isCurrent(id, active)) return;
    const units = Array.isArray(cleaned?.units) ? cleaned.units.filter((unit): unit is string => typeof unit === 'string').slice(0, 20) : [];
    const pids = Array.isArray(cleaned?.pids) ? cleaned.pids.filter((pid): pid is number => Number.isSafeInteger(pid)).slice(0, 50) : [];
    if (!units.length && !pids.length) return;
    try {
      const current = this.store.get(id);
      event(current, 'lifecycle', `Cleaned escaped worker processes: ${units.length ? `units ${units.join(', ')}` : ''}${units.length && pids.length ? '; ' : ''}${pids.length ? `pids ${pids.join(', ')}` : ''}`.slice(0, 2000));
      this.persist(current, 'stream');
    } catch (error) { this.fatal(error); }
  }
  private onIdentity(id: string, active: Running, invocation: string): void {
    if (!this.isCurrent(id, active) || !/^[0-9a-f]{32}$/.test(invocation)) return;
    const task = this.store.get(id);
    if (!task.run || !active.run || !active.run.unit || task.run.scopeUnit !== active.run.unit) return;
    if (task.run.scopeInvocation === invocation) return;
    task.run.scopeInvocation = invocation;
    this.persist(task);
  }
  private onIntegrity(id: string, active: Running, reason: string, detail: string): void {
    if (!this.isCurrent(id, active)) return;
    const task = this.store.get(id);
    if (task.run) task.run.logTruncated = true;
    if (!task.failure && task.status !== 'cancelling') {
      this.commitFailure(task, { kind: 'other', message: `Worker log integrity failed (${reason}: ${detail}); the run cannot be replayed safely` }, active);
    } else {
      this.persist(task);
    }
    active.error = task.failure?.message ?? active.error;
    this.terminateActive(id, active);
  }
  private onRunError(id: string, active: Running, error: Error): void {
    if (!this.isCurrent(id, active)) return;
    const code = (error as NodeJS.ErrnoException).code;
    const task = this.store.get(id);
    if (code === 'PREFLIGHT_ABORTED') {
      if (task.run?.cancelRequestedAt || task.status === 'cancelling') {
        this.running.delete(id);
        active.detached = true;
        active.run?.detach();
        this.finalizeRecovered(id, { status: 'cancelled', exitCode: null });
        return;
      }
      if (!task.run?.launchPermittedAt) {
        this.running.delete(id);
        active.detached = true;
        active.run?.detach();
        this.requeuePreparing(id);
        return;
      }
    }
    const message = redactSecrets(error.message).slice(-4000);
    if (!active.run?.unit || !this.store.get(id).run?.launchPermittedAt) {
      this.running.delete(id);
      active.detached = true;
      active.run?.detach();
      this.finalizeFailureNow(id, { kind: 'early_exit', message });
      return;
    }
    this.failActive(id, active, { kind: task.run?.firstOutputAt ? 'other' : 'early_exit', message });
  }
  requeuePreparing(id: string): void {
    const task = this.store.get(id);
    if (!task.run || task.run.finalizedAt || task.run.launchPermittedAt) return;
    task.status = 'queued';
    task.scheduled = true;
    delete task.queueReason;
    delete task.run;
    event(task, 'lifecycle', 'Launch was interrupted before the worker was allowed to start; the task is queued again');
    this.persist(task);
  }
  private onFinal(id: string, active: Running, final: RunFinal): void {
    if (!this.isCurrent(id, active)) return;
    const task = this.store.get(id);
    if (!task.run) return;
    const at = new Date().toISOString();
    const cancelIntent = task.status === 'cancelling' || task.status === 'cancelled' || !!task.run.cancelRequestedAt;
    const existingFailure = task.failure ?? (task.status === 'failed' ? { kind: 'other' as const, message: 'Worker failed before its final output was applied' } : undefined);
    let failure: TaskFailure | undefined = existingFailure;
    if (cancelIntent) {
      failure ??= { kind: 'cancelled', message: 'Worker cancelled' };
      task.status = 'cancelled';
      event(task, 'lifecycle', 'Worker stopped after cancellation');
    } else if (existingFailure) {
      task.status = 'failed';
    } else if (!final.exit.recorded) {
      failure = { kind: 'unknown_outcome', message: UNKNOWN_OUTCOME_MESSAGE };
      task.status = 'failed';
      event(task, 'error', this.failureDetail(failure));
    } else if (final.exit.code === 0 && (task.run.resultSummary !== undefined || final.records.some(record => record.type === 'result'))) {
      try { this.applyRecords(task, final.records, active); }
      catch (error) { failure = { kind: 'other', message: `Invalid worker output: ${error instanceof Error ? error.message : String(error)}` }; task.status = 'failed'; event(task, 'error', this.failureDetail(failure)); }
      if (!failure) { task.status = 'completed'; task.progress = 100; task.summary = task.run.resultSummary; event(task, 'lifecycle', 'Worker exited successfully; output is ready for owner review'); }
    } else {
      failure = {
        kind: task.run.firstOutputAt ? 'vendor' : 'early_exit',
        message: `Worker exited without successful result (code ${final.exit.code}, signal ${final.exit.signal ?? 'none'})`,
      };
      task.status = 'failed';
      event(task, 'error', this.failureDetail(failure));
    }
    if (failure) {
      task.failure = {
        ...failure,
        ...(final.exit.code !== null ? { exitCode: final.exit.code } : {}),
        ...(final.stderrTail ? { stderrTail: final.stderrTail.slice(-STDERR_TAIL) } : {}),
        ...(final.vendorError ? { vendorError: final.vendorError.slice(-STDERR_TAIL) } : {}),
      };
      if (existingFailure) {
        const errorEvent = [...task.events].reverse().find(item => item.kind === 'error');
        if (errorEvent) errorEvent.message = this.failureDetail(task.failure);
      }
    }
    if (final.stderrTail) task.run.stderrTail = final.stderrTail.slice(-STDERR_TAIL);
    if (final.vendorError) task.run.vendorError = final.vendorError.slice(-STDERR_TAIL);
    this.applyEvidence(task, final.evidence);
    task.run.replay = { ...final.cursor };
    task.run.status = 'stopped';
    task.run.endedAt = at;
    task.run.exitCode = final.exit.code;
    task.run.finalizedAt = at;
    delete task.run.pid;
    clearTimeout(active.firstTimer); clearTimeout(active.killTimer); clearTimeout(active.timeout);
    this.running.delete(id);
    try {
      this.persist(task);
    } catch (error) {
      this.fatal(error);
      return;
    }
    this.removeRunLogs(task);
  }
  private removeRunLogs(task: Task): void {
    const logs = task.run?.logs;
    if (!logs) return;
    const failures: string[] = [];
    for (const path of [logs.stdout, logs.stderr, logs.exit, logs.exitTmp]) {
      if (!path) continue;
      try { unlinkSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(path);
      }
    }
    if (failures.length === 0) return;
    try {
      const current = this.store.get(task.id);
      event(current, 'log', `Could not remove worker log files (kept for inspection): ${failures.join(', ')}`);
      this.persist(current, 'stream');
    } catch (error) { this.fatal(error); }
  }
  private finalizeFailureNow(id: string, failure: TaskFailure): void {
    const task = this.store.get(id);
    if (!task.run) return;
    const at = new Date().toISOString();
    task.status = 'failed';
    task.failure = { ...failure, ...(task.failure?.exitCode !== undefined ? { exitCode: task.failure.exitCode } : {}) };
    task.run.status = 'stopped';
    task.run.endedAt = at;
    task.run.finalizedAt = at;
    delete task.run.pid;
    event(task, 'error', this.failureDetail(task.failure));
    try { this.persist(task); } catch (error) { this.fatal(error); return; }
    this.removeRunLogs(task);
  }

  // --- reattach support -----------------------------------------------------------------------------------------------

  private endpoint(task: Task, invocation?: string, cancelled = false): RunAttachState {
    const run = task.run!;
    if (!run.logs || !run.stateDir || !run.nonce || !run.logIdentity || !run.scopeUnit) throw new Error('Run is missing its persisted file-mode launch record');
    const engine = (run.evidence?.engine ?? task.dispatch?.engineKind ?? run.adapter) as RealEngineKind;
    return {
      input: {
        engine,
        model: run.model ?? task.dispatch?.model ?? '',
        effort: run.effort ?? task.dispatch?.effort ?? '',
        workspace: run.workspace ?? task.dispatch?.workspace ?? '',
        role: 'worker',
        instruction: '',
        stateDir: run.stateDir,
        runId: run.id,
      },
      launch: {
        unit: run.scopeUnit,
        stateDir: run.stateDir,
        nonce: run.nonce,
        logs: { stdout: run.logs.stdout, stderr: run.logs.stderr, exit: run.logs.exit, exitTmp: run.logs.exitTmp ?? `${run.logs.exit}.tmp` },
        logIdentity: { stdout: { ...run.logIdentity.stdout }, stderr: { ...run.logIdentity.stderr } },
        promptPath: run.evidence?.promptPath ?? '',
        ...(run.evidence?.sessionDir ? { sessionDir: run.evidence.sessionDir } : {}),
      },
      ...(invocation ?? run.scopeInvocation ? { invocation: invocation ?? run.scopeInvocation } : {}),
      cursor: { ...(run.replay ?? { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 0 }) },
      ...(run.pid !== undefined ? { pid: run.pid } : {}),
      cancelled,
    };
  }
  attachRecovered(id: string, options: AttachOptions): boolean {
    const task = this.store.get(id);
    const run = task.run;
    if (!run || run.finalizedAt || this.running.has(id)) return false;
    const adapter = this.fileAdapter();
    if (!adapter.attachRun) throw new Error('The worker adapter cannot reattach file-mode runs');
    const state = this.endpoint(task, options.invocation, options.cancelled);
    // attachCliRun defers its first pump until after this call stack, so listeners wired below see the backlog.
    const cli = adapter.attachRun!(task, state);
    const active: Running = { run: cli, runId: run.id, cancelled: options.cancelled, stderrTail: run.stderrTail ?? '' };
    this.running.set(id, active);
    this.clearRecovery(id, false);
    this.wireRun(id, active);
    if (!options.deferNoOutput) this.armNoOutput(id);
    return true;
  }
  setScopeInvocation(id: string, invocation: string): void {
    if (!/^[0-9a-f]{32}$/.test(invocation)) return;
    const task = this.store.get(id);
    if (!task.run || task.run.finalizedAt || task.run.scopeInvocation === invocation) return;
    task.run.scopeInvocation = invocation;
    this.persist(task);
  }
  clearRecovery(id: string, writeEvent = true): void {
    const task = this.store.get(id);
    if (!task.run?.recovery) return;
    delete task.run.recovery;
    if (writeEvent) event(task, 'lifecycle', 'Recovery resolved; the worker run is under service management again');
    this.persist(task);
  }
  markRecoveryPending(id: string, reason: string): void {
    const task = this.store.get(id);
    if (!task.run || task.run.finalizedAt) return;
    if (task.run.recovery?.reason === reason) return;
    const since = new Date().toISOString();
    task.run.recovery = { state: 'pending', reason: reason.slice(0, 2000), since };
    event(task, 'lifecycle', `Recovery pending: ${reason}`.slice(0, 4000));
    this.persist(task);
  }
  approximateFirstOutput(id: string): void {
    const task = this.store.get(id);
    if (!task.run || task.run.finalizedAt) return;
    if (!task.run.firstOutputAt && (task.run.replay?.stdoutOffset ?? 0) <= 0) return;
    if (!task.run.firstOutputAt) task.run.firstOutputAt = new Date().toISOString();
    if (task.events.some(item => item.message.includes('firstOutputAt approximated at reattach'))) return;
    event(task, 'lifecycle', 'firstOutputAt approximated at reattach; vendor output already present in log');
    this.persist(task);
  }
  awaitBacklog(id: string, targetBytes: number, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        let done = false;
        try {
          const task = this.store.get(id);
          done = !!task.run?.finalizedAt || (task.run?.replay?.stdoutOffset ?? 0) >= targetBytes || !this.running.has(id);
        } catch { done = true; }
        if (done || Date.now() >= deadline) { resolve(); return; }
        setTimeout(check, 25).unref();
      };
      check();
    });
  }
  armNoOutput(id: string): void {
    const active = this.running.get(id);
    if (!active) return;
    const task = this.store.get(id);
    if (!task.run || task.run.finalizedAt || task.run.firstOutputAt) return;
    const started = parseIso(task.run.startedAt);
    const deadline = parseIso(task.run.noOutputDeadline) ?? (started === undefined ? undefined : started + FIRST_OUTPUT_MS);
    if (deadline === undefined) return;
    clearTimeout(active.firstTimer);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.failActive(id, active, { kind: 'no_output', message: 'Worker produced no valid vendor output within 120 seconds' });
      return;
    }
    active.firstTimer = setTimeout(() => {
      if (this.running.get(id) !== active) return;
      this.failActive(id, active, { kind: 'no_output', message: 'Worker produced no valid vendor output within 120 seconds' });
    }, remaining);
    active.firstTimer.unref?.();
  }
  commitTerminationPhase(id: string): void {
    const task = this.store.get(id);
    if (!task.run || task.run.finalizedAt || task.run.terminationPhase === 'kill') return;
    task.run.terminationPhase = 'kill';
    this.persist(task);
  }
  finalizeRecovered(id: string, outcome: { status: 'failed' | 'cancelled' | 'completed'; failure?: TaskFailure; logTruncated?: boolean; exitCode?: number | null; cursor?: RunCursor }): void {
    const task = this.store.get(id);
    if (!task.run || task.run.finalizedAt) return;
    const at = new Date().toISOString();
    const hadFailure = !!task.failure;
    if (outcome.logTruncated) task.run.logTruncated = true;
    if (outcome.cursor) task.run.replay = { ...outcome.cursor };
    delete task.run.recovery;
    task.run.status = 'stopped';
    task.run.endedAt = at;
    task.run.exitCode = outcome.exitCode ?? task.run.exitCode ?? null;
    task.run.finalizedAt = at;
    delete task.run.pid;
    if (outcome.status === 'cancelled') {
      task.status = 'cancelled';
      task.failure ??= { kind: 'cancelled', message: 'Worker cancelled' };
      event(task, 'lifecycle', 'Recovery completed the cancellation; the worker is stopped');
    } else if (outcome.status === 'completed') {
      task.status = 'completed';
      task.progress = 100;
      task.summary = task.run.resultSummary ?? task.summary;
      event(task, 'lifecycle', 'Recovery completed the run; output is ready for owner review');
    } else {
      task.status = 'failed';
      if (!task.failure) task.failure = outcome.failure ?? { kind: 'unknown_outcome', message: UNKNOWN_OUTCOME_MESSAGE };
      const detail = this.failureDetail(task.failure);
      const errorEvent = [...task.events].reverse().find(item => item.kind === 'error');
      if (hadFailure && errorEvent) errorEvent.message = detail;
      else event(task, 'error', detail);
    }
    try { this.persist(task); } catch (error) { this.fatal(error); return; }
    this.removeRunLogs(task);
  }
  /** Best-effort final sweep for a recovered run whose scope is gone before attachCliRun can do it. */
  async cleanupEscapedRun(id: string): Promise<void> {
    let task: Task;
    try { task = this.store.get(id); } catch { return; }
    const pid = task.run?.pid;
    const unit = task.run?.scopeUnit;
    if (!pid || !unit || !pidInScope(pid, unit)) return;
    try {
      const cleaned = await cleanupEscapedDescendants(pid, unit);
      this.onRunCleanup(id, undefined, cleaned);
    } catch { /* cleanup is best effort and must never block recovery */ }
  }
  scheduleRecoveryRetry(id: string, task: () => void | Promise<void>, delayMs: number): void {
    if (!this.launchGate || this.recoveryTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(id);
      if (!this.launchGate) return;
      void task();
    }, delayMs);
    timer.unref?.();
    this.recoveryTimers.set(id, timer);
  }
  isRunning(id: string): boolean { return this.running.has(id); }
}
