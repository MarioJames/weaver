import type { QuotaEngine, QuotaSchedule } from '../../shared/contracts/quota';
import { quotaRefreshTargets } from '../policy/quota';
import { quotaSettings } from '../../shared/policy/settings';
import { type Config } from '../../shared/contracts/policy';

export interface QuotaSchedulerOptions {
  config: () => Config;
  /** Probes one engine and merges the result into policy blocks. */
  refresh: (engine: QuotaEngine) => Promise<void>;
  now?: () => number;
  log?: (error: unknown) => void;
}

/** Reads the saved settings on every tick, so a policy save takes effect without restarting the timer. */
export class QuotaScheduler {
  private lastRunAt: number | null = null;
  private firstRunAt: number | null = null;
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly clock: () => number;

  constructor(private readonly options: QuotaSchedulerOptions) {
    this.clock = options.now ?? Date.now;
  }

  status(): QuotaSchedule {
    const settings = quotaSettings(this.options.config());
    const next = this.lastRunAt === null ? this.firstRunAt ?? this.clock() : this.lastRunAt + settings.interval_minutes * 60_000;
    return {
      enabled: settings.auto_refresh,
      intervalMinutes: settings.interval_minutes,
      lastRunAt: this.lastRunAt === null ? null : new Date(this.lastRunAt).toISOString(),
      nextRunAt: settings.auto_refresh ? new Date(next).toISOString() : null,
    };
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    const config = this.options.config();
    const settings = quotaSettings(config);
    const now = this.clock();
    if (!settings.auto_refresh || this.lastRunAt !== null && now - this.lastRunAt < settings.interval_minutes * 60_000) return Promise.resolve();
    this.lastRunAt = now;
    this.running = (async () => {
      for (const engine of quotaRefreshTargets(config)) {
        try { await this.options.refresh(engine); }
        catch (error) { (this.options.log ?? console.error)(error); }
      }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  /** The first run waits one period so a just-started process does not probe providers immediately. */
  start(everyMs = 60_000): void {
    this.firstRunAt = this.clock() + everyMs;
    this.timer = setInterval(() => { void this.tick(); }, everyMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
}
