import { statSync } from 'node:fs';
import type { Task } from '../../../shared/contracts/tasks';
import type { TaskManager } from '../../manager';
import { recoverInterruptedTasks } from './recovery';
import { event } from '../../domain/tasks';
import {
  confirmScopeAbsent,
  findFdEvidence,
  inspectScope,
  killOwnedScope,
  type KillOwnedScopeResult,
  type ScopeInspection,
} from '../../adapters/cli/scope';
import { checkLogIdentity, type LogIdentityCheck } from '../../adapters/cli/run-files';

const RETRY_MS = 30_000;
const BACKLOG_WAIT_MS = 5_000;
const TERM_GRACE_MS = 1500;
const KILL_WAIT_MS = 5_000;

export interface ReattachDeps {
  inspectScope?: (unit: string) => Promise<ScopeInspection>;
  confirmScopeAbsent?: (unit: string) => Promise<boolean | 'unknown'>;
  findFdEvidence?: (unit: string, identity: { stdout: { dev: number; ino: number }; stderr: { dev: number; ino: number } }) => Promise<string | undefined>;
  checkLogIdentity?: (paths: { stdout: string; stderr: string }, identity: { stdout: { dev: number; ino: number }; stderr: { dev: number; ino: number } }, minSizes: { stdout: number; stderr: number }) => LogIdentityCheck;
  killOwnedScope?: (unit: string, invocation: string | undefined, signal: NodeJS.Signals) => Promise<KillOwnedScopeResult>;
  statSize?: (path: string) => number | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retryMs?: number;
  backlogWaitMs?: number;
  console?: (message: string) => void;
}

export interface ReattachReport {
  attached: string[];
  finalized: string[];
  pending: string[];
  failed: string[];
  requeued: string[];
  interrupted: string[];
  counts: { attached: number; finalized: number; pending: number; failed: number; requeued: number; interrupted: number };
}

type Outcome = 'attached' | 'finalized' | 'pending' | 'failed' | 'requeued' | 'skip';

const defaultStatSize = (path: string): number | undefined => {
  try { return statSync(path).size; } catch { return undefined; }
};

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

function validInvocation(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/**
 * Startup recovery for real file-mode runs (§11). Enumerates by run lifecycle,
 * not task.status, so a failed-but-not-finalized attempt is terminated and
 * finalized before any new attempt can start.
 */
export async function reattach(manager: TaskManager, deps: ReattachDeps = {}): Promise<ReattachReport> {
  const inspect = deps.inspectScope ?? inspectScope;
  const confirm = deps.confirmScopeAbsent ?? confirmScopeAbsent;
  const fdEvidence = deps.findFdEvidence ?? findFdEvidence;
  const identityCheck = deps.checkLogIdentity ?? checkLogIdentity;
  const kill = deps.killOwnedScope ?? killOwnedScope;
  const statSize = deps.statSize ?? defaultStatSize;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const retryMs = deps.retryMs ?? RETRY_MS;
  const backlogWaitMs = deps.backlogWaitMs ?? BACKLOG_WAIT_MS;
  const log = deps.console ?? (message => console.error(message));

  const report: ReattachReport = {
    attached: [], finalized: [], pending: [], failed: [], requeued: [], interrupted: [],
    counts: { attached: 0, finalized: 0, pending: 0, failed: 0, requeued: 0, interrupted: 0 },
  };
  const handled = new Set<string>();

  const record = (outcome: Outcome, id: string): void => {
    if (outcome === 'attached') report.attached.push(id);
    else if (outcome === 'finalized') report.finalized.push(id);
    else if (outcome === 'pending') report.pending.push(id);
    else if (outcome === 'failed') { report.failed.push(id); report.finalized.push(id); }
    else if (outcome === 'requeued') report.requeued.push(id);
  };
  const pending = (id: string, reason: string): Outcome => {
    manager.markRecoveryPending(id, reason);
    return 'pending';
  };
  const taskSnapshot = (id: string): Task => manager.store.get(id);
  const intent = (task: Task): { cancelled: boolean; failed: boolean } => ({
    cancelled: task.status === 'cancelling' || task.status === 'cancelled' || !!task.run?.cancelRequestedAt,
    failed: task.status === 'failed' || !!task.failure,
  });

  const waitAbsent = async (unit: string, deadline: number): Promise<boolean> => {
    for (;;) {
      const state = await confirm(unit);
      if (state === true) return true;
      if (now() >= deadline) return false;
      await sleep(100);
    }
  };

  /** Continue a persisted termination: never restart the grace period, never move the phase backwards. */
  const terminateScope = async (task: Task, invocation: string | undefined): Promise<boolean> => {
    const run = task.run!;
    const unit = run.scopeUnit!;
    const killAfter = run.killAfter ? Date.parse(run.killAfter) : now() + TERM_GRACE_MS;
    const alreadyKill = run.terminationPhase === 'kill' || !Number.isFinite(killAfter) || now() >= killAfter;
    const first = await kill(unit, invocation, alreadyKill ? 'SIGKILL' : 'SIGTERM');
    if (!first.ok && first.reason !== 'absent') {
      manager.markRecoveryPending(task.id, `Could not continue terminating scope ${unit}: ${first.reason}${first.detail ? ` (${first.detail})` : ''}`);
      return false;
    }
    const graceDeadline = Math.max(now(), alreadyKill ? now() : killAfter);
    if (await waitAbsent(unit, graceDeadline)) return true;
    manager.commitTerminationPhase(task.id);
    const forced = await kill(unit, invocation, 'SIGKILL');
    if (!forced.ok && forced.reason !== 'absent') {
      manager.markRecoveryPending(task.id, `Scope ${unit} did not disappear after SIGKILL: ${forced.reason}`);
      return false;
    }
    return waitAbsent(unit, now() + KILL_WAIT_MS);
  };

  const attach = async (task: Task, invocation: string | undefined, missingForBacklog: boolean): Promise<Outcome> => {
    const current = taskSnapshot(task.id);
    const run = current.run!;
    const hadFirstOutput = !!run.firstOutputAt;
    const cancelled = intent(current).cancelled;
    event(current, 'lifecycle', `Recovered worker run; continuing to monitor scope ${run.scopeUnit}`);
    manager.update(current);
    const target = run.logs ? (statSize(run.logs.stdout) ?? 0) : 0;
    if (!manager.attachRecovered(task.id, { invocation, cancelled, deferNoOutput: true })) return 'skip';
    if (cancelled || intent(taskSnapshot(task.id)).failed) {
      manager.enforceTermination(task.id);
      return 'attached';
    }
    if (missingForBacklog) {
      await manager.awaitBacklog(task.id, target, backlogWaitMs);
      if (!hadFirstOutput) manager.approximateFirstOutput(task.id);
    }
    manager.armNoOutput(task.id);
    return 'attached';
  };

  const finalizeNoLogs = async (task: Task): Promise<Outcome> => {
    await manager.cleanupEscapedRun(task.id);
    const state = intent(task);
    if (state.cancelled) {
      manager.finalizeRecovered(task.id, { status: 'cancelled', exitCode: null });
      return 'finalized';
    }
    if (state.failed) {
      manager.finalizeRecovered(task.id, { status: 'failed', failure: task.failure ?? { kind: 'other', message: 'Worker failed before recovery could read its final output' }, exitCode: task.run?.exitCode ?? null });
      return 'failed';
    }
    manager.finalizeRecovered(task.id, { status: 'failed', failure: { kind: 'unknown_outcome', message: 'Execution result unknown: the worker scope ended without an exit record. Retry explicitly with tasks retry.' }, exitCode: null });
    return 'failed';
  };

  const settleAbsent = async (task: Task): Promise<Outcome> => {
    const run = task.run!;
    if (!run.logs) return finalizeNoLogs(task);
    if (!run.logIdentity) {
      // Without a durable file identity the log cannot be attributed; only a
      // zero-byte/no-log intent or an explicit cancellation may settle here.
      return finalizeNoLogs(task);
    }
    const check = identityCheck(
      { stdout: run.logs.stdout, stderr: run.logs.stderr },
      run.logIdentity,
      { stdout: run.replay?.stdoutOffset ?? 0, stderr: run.replay?.stderrOffset ?? 0 },
    );
    if (!check.ok) {
      manager.recordFailureIntent(task.id, { kind: 'other', message: `Worker log is ${check.reason}${check.detail ? ` (${check.detail})` : ''}; the result cannot be recovered safely` }, { logTruncated: true });
      await manager.cleanupEscapedRun(task.id);
      manager.finalizeRecovered(task.id, { status: 'failed', failure: { kind: 'other', message: `Worker log is ${check.reason}${check.detail ? ` (${check.detail})` : ''}; the result cannot be recovered safely` }, logTruncated: true, exitCode: null });
      return 'failed';
    }
    return attach(task, run.scopeInvocation, true);
  };

  const settlePresent = async (task: Task, invocation: string): Promise<Outcome> => {
    const run = task.run!;
    const state = intent(task);
    const fileCheck = run.logs && run.logIdentity
      ? identityCheck(
        { stdout: run.logs.stdout, stderr: run.logs.stderr },
        run.logIdentity,
        { stdout: run.replay?.stdoutOffset ?? 0, stderr: run.replay?.stderrOffset ?? 0 },
      )
      : undefined;
    if (fileCheck && !fileCheck.ok) {
      if (!task.failure) manager.recordFailureIntent(task.id, { kind: 'other', message: `Worker log is ${fileCheck.reason}${fileCheck.detail ? ` (${fileCheck.detail})` : ''}; the result cannot be recovered safely` }, { logTruncated: true });
      else manager.recordFailureIntent(task.id, task.failure, { logTruncated: true });
      if (await terminateScope(taskSnapshot(task.id), invocation)) {
        await manager.cleanupEscapedRun(task.id);
        const current = taskSnapshot(task.id);
        manager.finalizeRecovered(task.id, { status: 'failed', failure: current.failure ?? { kind: 'other', message: 'Worker log failed its integrity check' }, logTruncated: true, exitCode: current.run?.exitCode ?? null });
        return 'failed';
      }
      return pending(task.id, taskSnapshot(task.id).run?.recovery?.reason ?? `Scope ${run.scopeUnit} is still present after termination`);
    }
    if (!run.logs || !run.logIdentity) {
      if (state.cancelled || state.failed) {
        if (await terminateScope(taskSnapshot(task.id), invocation)) {
          await manager.cleanupEscapedRun(task.id);
          manager.finalizeRecovered(task.id, { status: state.cancelled ? 'cancelled' : 'failed', ...(state.failed ? { failure: task.failure } : {}), exitCode: null });
          return state.cancelled ? 'finalized' : 'failed';
        }
        return pending(task.id, `Scope ${run.scopeUnit} is still present after termination`);
      }
      return pending(task.id, 'Scope is present and attributed, but this run has no persisted log paths to recover');
    }
    return attach(task, invocation, !state.cancelled && !state.failed);
  };

  const classify = async (id: string): Promise<Outcome> => {
    const task = taskSnapshot(id);
    const run = task.run;
    if (!run || run.finalizedAt) return 'skip';
    if (manager.isRunning(id)) return 'skip';
    if (!run.scopeUnit) return pending(id, 'Run has a launch permit but no persisted scope unit');
    const inspection = await inspect(run.scopeUnit);
    if (inspection.state === 'unknown') return pending(id, `Cannot inspect scope ${run.scopeUnit}: ${inspection.error}`);
    if (inspection.state === 'absent') {
      const absent = await confirm(run.scopeUnit);
      if (absent !== true) return pending(id, `Scope ${run.scopeUnit} absence is unconfirmed`);
      return settleAbsent(task);
    }
    const invocation = run.scopeInvocation;
    if (invocation && inspection.invocation === invocation) return settlePresent(task, invocation);
    if (!invocation) {
      const evidence = run.logIdentity ? await fdEvidence(run.scopeUnit, run.logIdentity) : undefined;
      if (!evidence) {
        return pending(id, `Scope ${run.scopeUnit} is present but its InvocationID is not persisted and FD evidence did not prove ownership; not killing it`);
      }
      manager.setScopeInvocation(id, evidence);
      return settlePresent(taskSnapshot(id), evidence);
    }
    return pending(id, `Scope ${run.scopeUnit} InvocationID does not match the persisted ownership (${invocation}); not killing it`);
  };

  const schedule = (id: string): void => {
    manager.scheduleRecoveryRetry(id, async () => {
      const task = taskSnapshot(id);
      if (task.run?.finalizedAt || !task.run?.recovery) return;
      const outcome = await classify(id);
      if (outcome === 'pending') schedule(id);
    }, retryMs);
  };

  for (const head of manager.store.listHeads()) {
    const task = manager.store.get(head.id);
    const run = task.run;
    if (!run || run.finalizedAt) continue;
    if (run.execution !== 'real') continue;
    handled.add(task.id);
    if (run.launchPermittedAt) {
      const outcome = await classify(task.id);
      if (outcome !== 'skip') record(outcome, task.id);
      if (outcome === 'pending') schedule(task.id);
      continue;
    }
    if (isPreparing(task)) {
      manager.requeuePreparing(task.id);
      record('requeued', task.id);
      continue;
    }
    // A historical real run has no launch permit and no new lifecycle fields:
    // leave it to the old interrupted-task semantics.
    handled.delete(task.id);
  }

  const interrupted = recoverInterruptedTasks(manager.store, handled);
  report.interrupted.push(...interrupted);
  report.counts = {
    attached: report.attached.length,
    finalized: report.finalized.length,
    pending: report.pending.length,
    failed: report.failed.length + report.interrupted.length,
    requeued: report.requeued.length,
    interrupted: report.interrupted.length,
  };
  log(`Recovery report: attached=${report.counts.attached} finalized=${report.counts.finalized} pending=${report.counts.pending} failed=${report.counts.failed} requeued=${report.counts.requeued}`);
  if (report.attached.length) log(`Recovery attached: ${report.attached.join(', ')}`);
  if (report.finalized.length) log(`Recovery finalized: ${report.finalized.join(', ')}`);
  if (report.pending.length) log(`Recovery pending: ${report.pending.join(', ')}`);
  if (report.failed.length || report.interrupted.length) log(`Recovery failed: ${[...report.failed, ...report.interrupted].join(', ')}`);
  if (report.requeued.length) log(`Recovery requeued: ${report.requeued.join(', ')}`);
  return report;
}

/** New-lifecycle preparing runs have no external effect yet; a historical real run has a pid/scope/evidence. */
function isPreparing(task: Task): boolean {
  const run = task.run!;
  if (task.status !== 'running' && task.status !== 'cancelling') return false;
  if (task.executionRole === 'owner') return false;
  if (run.pid !== undefined || run.scopeUnit || run.stateDir || run.logs || run.nonce || run.logIdentity) return false;
  return true;
}
