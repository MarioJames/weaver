import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import type { PiModelCheck } from '../../engines/pi-model-check';
import type { StartCliAgent } from '../launch';
import type { PreparedCliAgent } from './launch';
import type { CliRun, RunLaunchRecord, StartCliRunFn } from './run';
import type { CliAgentInput } from './types';
import type { ManagedProcess } from '../worker';
import type { KillOwnedScopeResult } from './scope';

/** Events a launched agent emits that the task manager listens to; they are passed through unchanged. */
const FORWARDED = ['first-output', 'stderr-tail', 'vendor-error', 'engine-model', 'identity', 'error'] as const;
const DRAIN_MS = 2_000;

const ended = (stream: Readable): Promise<void> => new Promise(resolve => {
  if (stream.readableEnded || stream.destroyed) { resolve(); return; }
  const timer = setTimeout(resolve, DRAIN_MS);
  stream.once('end', () => { clearTimeout(timer); resolve(); });
});

/**
 * A pi launch that first confirms the configured model exists. The launcher contract is synchronous, so this returns at once
 * with a process-shaped object: if the check fails it reports one configuration error ('error' then 'close', no pi started and
 * nothing written to stderr, which the manager would classify), otherwise it starts the real agent and relays it.
 */
class GuardedPiAgent extends EventEmitter implements ManagedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private inner?: ManagedProcess;
  private cancelled = false;
  private closed = false;

  constructor(private readonly launch: StartCliAgent, private readonly input: CliAgentInput, private readonly check: PiModelCheck, private readonly beforeSpawn?: (prepared: PreparedCliAgent) => void) {
    super();
    void this.begin();
  }

  get pid(): number | undefined { return this.inner?.pid; }
  get scopeUnit(): string | undefined { return this.inner?.scopeUnit; }
  get evidence(): ManagedProcess['evidence'] { return this.inner?.evidence; }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.inner) return this.inner.kill(signal);
    this.cancelled = true;
    return true;
  }

  private async begin(): Promise<void> {
    let problem: string | undefined;
    try { problem = this.input.channel ? undefined : await this.check(this.input.model); } catch (error) {
      problem = `无法确认 pi 是否提供模型 ${this.input.model}：${error instanceof Error ? error.message : String(error)}，未启动 pi`;
    }
    if (this.cancelled) { this.finish(null, 'SIGTERM'); return; }
    if (!problem) {
      try { this.inner = this.launch(this.input, this.beforeSpawn); } catch (error) { problem = error instanceof Error ? error.message : String(error); }
    }
    if (problem || !this.inner) {
      this.emit('error', new Error(problem));
      this.finish(1, null);
      return;
    }
    this.relay(this.inner);
  }

  private relay(inner: ManagedProcess): void {
    for (const name of FORWARDED) inner.on(name, (...args: unknown[]) => { this.emit(name, ...args); });
    inner.stdout.pipe(this.stdout);
    inner.stderr.pipe(this.stderr);
    // The manager reads the final result from stdout before it sees 'close', so close waits for the relayed streams to end.
    inner.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      void Promise.all([ended(this.stdout), ended(this.stderr)]).then(() => this.finish(code, signal));
    });
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    // 'close' follows the streams' end on the next turn, so the manager has consumed everything the guard relayed.
    void Promise.all([ended(this.stdout), ended(this.stderr)]).then(() => { this.emit('close', code, signal); });
  }
}

/** Legacy engine routes check the global catalog; channel routes compile their own native model definitions. */
export function guardPiLaunch(launch: StartCliAgent, check: PiModelCheck): StartCliAgent {
  return (input, beforeSpawn) => input.engine === 'pi' ? new GuardedPiAgent(launch, input, check, beforeSpawn) : launch(input, beforeSpawn);
}

const RUN_FORWARDED = ['batch', 'final', 'identity', 'integrity', 'error'] as const;

/**
 * File-mode pi guard: pi first confirms the configured model, then re-checks
 * the shutdown gate before calling startCliRun. A closed gate starts nothing,
 * calls no beforeSpawn, and reports PREFLIGHT_ABORTED on 'error'. Non-pi
 * inputs call through synchronously.
 */
class GuardedPiRun extends EventEmitter implements CliRun {
  private inner: CliRun | undefined;
  private cancelled = false;
  private invocation: string | undefined;
  private closed = false;
  private detached = false;
  readonly launch: RunLaunchRecord;
  readonly evidence: CliRun['evidence'];

  constructor(
    private readonly startRun: StartCliRunFn,
    private readonly input: CliAgentInput & { runId: string },
    private readonly beforeSpawn: (record: RunLaunchRecord) => void,
    private readonly check: PiModelCheck,
    private readonly gate: () => boolean,
  ) {
    super();
    // Placeholder identity until the real run exists; only error paths observe it.
    this.launch = {
      unit: '',
      stateDir: input.stateDir,
      nonce: '',
      logs: { stdout: '', stderr: '', exit: '', exitTmp: '' },
      logIdentity: { stdout: { dev: 0, ino: 0 }, stderr: { dev: 0, ino: 0 } },
      promptPath: '',
    };
    this.evidence = {
      engine: input.engine,
      requestedModel: input.model,
      requestedEffort: input.effort,
      workspace: input.workspace,
      role: input.role,
      terminal: 'pending',
    };
    void this.begin();
  }

  get unit(): string {
    return this.inner?.unit ?? '';
  }

  setInvocation(id: string): void {
    this.invocation = id;
    this.inner?.setInvocation(id);
  }

  setCancelled(): void {
    this.cancelled = true;
    this.inner?.setCancelled();
  }

  async terminate(signal: 'SIGTERM' | 'SIGKILL'): Promise<KillOwnedScopeResult> {
    if (this.inner) return this.inner.terminate(signal);
    return { ok: false, reason: 'not-started' };
  }

  detach(): void {
    if (this.closed || this.detached) {
      try { this.inner?.detach(); } catch { /* ignore */ }
      return;
    }
    this.detached = true;
    this.cancelled = true;
    try { this.inner?.detach(); } catch { /* ignore */ }
    try { this.inner?.removeAllListeners(); } catch { /* ignore */ }
    this.inner = undefined;
    // Drop pending preflight continuations (begin() checks detached after its
    // await) and never emit again; also release manager-side listeners.
    this.removeAllListeners();
  }

  private abort(message: string, code?: string): void {
    if (this.closed || this.detached) return;
    this.closed = true;
    const error = new Error(message);
    if (code) (error as NodeJS.ErrnoException).code = code;
    queueMicrotask(() => {
      this.emit('error', error);
    });
  }

  private async begin(): Promise<void> {
    let problem: string | undefined;
    try {
      problem = this.input.channel ? undefined : await this.check(this.input.model);
    } catch (error) {
      problem = `无法确认 pi 是否提供模型 ${this.input.model}：${error instanceof Error ? error.message : String(error)}，未启动 pi`;
    }
    // A detach during the async model check must win: start nothing and emit nothing.
    if (this.detached || this.closed) return;
    if (!problem && !this.gate()) {
      this.abort('pi preflight aborted: shutdown gate closed before start; pi was not started and beforeSpawn was not called', 'PREFLIGHT_ABORTED');
      return;
    }
    if (problem) {
      this.abort(problem);
      return;
    }
    if (this.cancelled) {
      this.abort('pi run cancelled before start', 'PREFLIGHT_ABORTED');
      return;
    }
    try {
      this.inner = this.startRun(this.input, this.beforeSpawn);
    } catch (error) {
      this.abort(error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.detached || this.closed) {
      try { this.inner.detach(); } catch { /* ignore */ }
      try { this.inner.removeAllListeners(); } catch { /* ignore */ }
      this.inner = undefined;
      return;
    }
    if (this.invocation) this.inner.setInvocation(this.invocation);
    if (this.cancelled) this.inner.setCancelled();
    for (const name of RUN_FORWARDED) this.inner.on(name, (...args: unknown[]) => this.emit(name, ...args));
  }
}

/** Wraps a file-mode starter so pi runs only after its model check and an open gate; every other engine starts at once. */
export function guardPiRun(startRun: StartCliRunFn, check: PiModelCheck, gate: () => boolean): StartCliRunFn {
  return (input, beforeSpawn) => (input.engine === 'pi' ? new GuardedPiRun(startRun, input, beforeSpawn, check, gate) : startRun(input, beforeSpawn));
}
