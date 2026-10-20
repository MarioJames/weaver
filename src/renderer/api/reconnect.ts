/** Transport errors only. A user-initiated AbortError must never reconnect. */
export function isTransientError(error: unknown): boolean {
  const record = error && typeof error === 'object'
    ? error as { code?: unknown; name?: string; message?: string; status?: number } : {};
  const text = (record.message ?? String(error)).replace(/^Error: /, '');
  const code = (typeof record.code === 'string' ? record.code : undefined) ?? text.match(/^([A-Z][A-Z_0-9]+):/)?.[1];
  if ([502, 503, 504].includes(record.status ?? 0)) return true;
  if (code) return /^(TIMEOUT|NETWORK|HTTP_50[234]|APP_NOT_RUNNING|CONTROL_PLANE_UNAVAILABLE|IPC_UNAVAILABLE|ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|ENOTFOUND|ETIMEDOUT|DEADLINE_EXCEEDED|ERR_NETWORK)$/.test(code);
  if (record.name === 'AbortError') return false;
  return record.name === 'TimeoutError' || /failed to fetch|fetch failed|network request failed|networkerror|load failed/i.test(text);
}

export interface ConnectionState { status: 'idle' | 'reconnecting' | 'connected'; attempt: number }
interface Job {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

/** One clock for all failed readers, including readers joining an ongoing outage. */
export class Reconnector {
  private jobs = new Set<Job>();
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private running = false;
  private status: ConnectionState['status'] = 'idle';

  constructor(
    private publish: (state: ConnectionState) => void,
    private hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  ) {}

  private emit(status: ConnectionState['status']) {
    this.status = status;
    this.publish({ status, attempt: this.attempt });
  }

  recover<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.jobs.delete(job);
        job.cleanup();
        reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
        if (!this.jobs.size) {
          clearTimeout(this.timer);
          this.timer = undefined;
          this.attempt = 0;
          this.emit('idle');
        }
      };
      const job: Job = { run, resolve: value => resolve(value as T), reject, cleanup: () => signal?.removeEventListener('abort', abort) };
      if (!this.jobs.size && this.status !== 'reconnecting') {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.attempt = 0;
      }
      this.jobs.add(job);
      signal?.addEventListener('abort', abort, { once: true });
      this.emit('reconnecting');
      this.arm();
    });
  }

  private arm() {
    if (this.timer || this.running || !this.jobs.size || this.hidden()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.retryNow();
    }, [1000, 2000, 4000, 8000][this.attempt] ?? 15000);
  }

  async retryNow() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running || this.hidden() || !this.jobs.size) return;
    this.running = true;
    this.attempt++;
    this.emit('reconnecting');
    let recovered = false;
    await Promise.all([...this.jobs].map(async job => {
      try {
        const value = await job.run();
        if (this.jobs.delete(job)) { recovered = true; job.cleanup(); job.resolve(value); }
      } catch (error) {
        if (!isTransientError(error) && this.jobs.delete(job)) { job.cleanup(); job.reject(error); }
      }
    }));
    this.running = false;
    if (this.jobs.size) this.arm();
    else if (recovered) {
      this.attempt = 0;
      this.emit('connected');
      this.timer = setTimeout(() => { this.timer = undefined; this.emit('idle'); }, 2000);
    } else {
      this.attempt = 0;
      this.emit('idle');
    }
  }

  visibilityChanged() {
    if (this.status !== 'reconnecting') return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.hidden()) void this.retryNow();
  }

  dispose() {
    clearTimeout(this.timer);
    for (const job of this.jobs) { job.cleanup(); job.reject(new DOMException('Disposed', 'AbortError')); }
    this.jobs.clear();
  }
}
