import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import type { PiModelCheck } from '../../engines/pi-model-check';
import type { StartCliAgent } from '../launch';
import type { CliAgentInput } from './types';
import type { ManagedProcess } from '../worker';

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

  constructor(private readonly launch: StartCliAgent, private readonly input: CliAgentInput, private readonly check: PiModelCheck) {
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
    try { problem = await this.check(this.input.model); } catch (error) {
      problem = `无法确认 pi 是否提供模型 ${this.input.model}：${error instanceof Error ? error.message : String(error)}，未启动 pi`;
    }
    if (this.cancelled) { this.finish(null, 'SIGTERM'); return; }
    if (!problem) {
      try { this.inner = this.launch(this.input); } catch (error) { problem = error instanceof Error ? error.message : String(error); }
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

/** Wraps a launcher so pi runs only after its configured model is confirmed; every other engine is launched as before. */
export function guardPiLaunch(launch: StartCliAgent, check: PiModelCheck): StartCliAgent {
  return input => input.engine === 'pi' ? new GuardedPiAgent(launch, input, check) : launch(input);
}
