/**
 * What every polling monitor shares and nothing more: one tick in flight at a time, a timer, the probes it can
 * abort, and a stop fence. Work that awaited past a stop sees a different fence and must write nothing.
 */
export class MonitorLifecycle {
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly aborts = new Set<AbortController>();
  private fence = 0;
  private halted = false;

  /** `ready` is the app's own gate (false while starting or draining); a monitor without one is only fenced by stop(). */
  constructor(private readonly ready?: () => boolean) {}

  /** False once stop() ran: a stopped monitor only resumes when start() is called again. */
  get stopped(): boolean { return this.halted; }
  /** Bumped by stop(); capture it before awaiting and pass it to writable() afterwards. */
  get generation(): number { return this.fence; }
  /** The tick in flight, if any. */
  get inFlight(): Promise<void> | undefined { return this.running; }

  active(): boolean {
    return !this.ready || this.ready();
  }

  /** May this work still write? Its own stop() counts as much as the app draining. */
  writable(fence: number): boolean {
    return !this.halted && fence === this.fence && this.active();
  }

  /** Concurrent ticks collapse into the one in flight. */
  coalesce(run: () => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    this.running = run().finally(() => { this.running = undefined; });
    return this.running;
  }

  /** Re-arms a stopped monitor and ticks on the interval, with an immediate first tick when asked. */
  start(everyMs: number, tick: () => Promise<void>, onError: (error: unknown) => void, immediate = false): void {
    this.halted = false;
    if (immediate) void tick().catch(onError);
    this.timer = setInterval(() => { void tick().catch(onError); }, everyMs);
    this.timer.unref();
  }

  /** Runs one abortable greeting; stop() aborts it, and `aborted` tells the caller its answer is not evidence. */
  async abortable<T>(work: (signal: AbortSignal) => Promise<T>, fallback: (error: unknown) => T): Promise<{ value: T; aborted: boolean }> {
    const controller = new AbortController();
    this.aborts.add(controller);
    try {
      return { value: await work(controller.signal), aborted: controller.signal.aborted };
    } catch (error) {
      return { value: fallback(error), aborted: controller.signal.aborted };
    } finally {
      this.aborts.delete(controller);
    }
  }

  /** Fences everything that awaited before this call, aborts probes in flight and waits for the tick that is running. */
  async stop(): Promise<void> {
    this.halted = true;
    this.fence += 1;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.aborts) controller.abort();
    await this.running;
  }
}
