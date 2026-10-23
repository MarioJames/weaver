/**
 * Waiting keepalive (pure scheduling layer).
 *
 * While one Bot turn is still running and no visible content has reached the
 * streaming card, the service nudges the chat with a short independent text
 * message: first after 5s of silence, again after 15s, then every 30s until the
 * turn ends. Any visible append or a waiting-queue change resets the timer to
 * the first 5s tier; cancel stops it for the rest of the turn.
 *
 * The machine owns no transport, card or session objects: depth/valid/send and
 * the timer functions are injected, so the full cadence is testable without
 * real time. Copy lives in the exported constant tables below and is always
 * plain text (the channel renders `{ text }` without Markdown).
 */

export const KEEPALIVE_DELAYS_MS = [5_000, 15_000, 30_000] as const;

export type KeepaliveTier = 0 | 1 | 2;

/** Queued copy acknowledges the real number of still-waiting messages. */
export const KEEPALIVE_QUEUED_COPY = [
  '还有 {count} 条在后面排队，我按顺序来，不会漏。',
  '后面还有 {count} 条，收到，一条条接着处理。',
  '队列里还有 {count} 条，我按先来后到继续。',
  '看到还有 {count} 条在等，处理完当前这条就接着来。',
  '还有 {count} 条排着，别急，我会按顺序过一遍。',
  '后面排了 {count} 条，我一条条来，不会跳过。',
] as const;

/** Exactly one message is waiting behind the current turn. */
export const KEEPALIVE_SINGLE_COPY = [
  '后面还有 1 条，处理完这条就接着看。',
  '收到，后一条已经排上，这条结束就继续。',
  '还有 1 条在等，我按顺序接着处理。',
  '队列里还有 1 条，这条之后就看它。',
  '知道后面还有 1 条，不会漏掉。',
  '下一条已经在排队，这条处理完就继续。',
] as const;

/** Idle/thinking copy, grouped by silence tier: 5s, 15s, then every 30s. */
export const KEEPALIVE_IDLE_COPY = [
  [
    '还在想，先别走。',
    '我还在处理，有新内容会继续更新。',
    '先报个平安：还在跑。',
    '在看，暂时没有新内容，但没停。',
    '这条正在处理中，稍等一下。',
    '还在这儿琢磨，有新内容就继续写。',
  ],
  [
    '还是没新内容，但我没停。',
    '这条比预想的长，我还在。',
    '还在跑，暂时没有能贴出来的内容。',
    '没有偷懒，只是这一步还没出结果。',
    '继续处理中，先留个脚印。',
    '还没到能收尾的时候，我盯着呢。',
  ],
  [
    '还在跑，我也在等它出结果。',
    '没新内容不代表卡死，我还在看着。',
    '这轮确实有点久，先报个平安，还在。',
    '我知道等得有点久，但这边还在继续。',
    '还没收工，有新内容我会继续写。',
    '还在处理，暂时没什么可汇报的，但没停。',
  ],
] as const;

export interface KeepaliveTimers {
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Real timers stay unref'd so waiting keepalive never holds the process open. */
export const SYSTEM_KEEPALIVE_TIMERS: KeepaliveTimers = {
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimer(handle) {
    if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface KeepaliveOptions {
  /** Current waiting depth, excluding the message being processed. */
  depth(): number;
  /** Re-checked immediately before every push; false cancels the machine. */
  valid?(): boolean;
  /** Independent text notice. false or a rejected promise cancels the machine. */
  send(text: string): void | boolean | Promise<void | boolean>;
  timers?: KeepaliveTimers;
}

const COPY_KEYS = ['queued', 'single', 'idle-0', 'idle-1', 'idle-2'] as const;
type CopyKey = (typeof COPY_KEYS)[number];

function depthOf(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function isThenable(value: unknown): value is Promise<void | boolean> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

export class Keepalive {
  private readonly timers: KeepaliveTimers;
  private readonly cursors: Record<CopyKey, number> = { queued: 0, single: 0, 'idle-0': 0, 'idle-1': 0, 'idle-2': 0 };
  private handle: unknown;
  private active = false;
  private tier: KeepaliveTier = 0;
  private lastText = '';

  constructor(private readonly options: KeepaliveOptions) {
    this.timers = options.timers ?? SYSTEM_KEEPALIVE_TIMERS;
  }

  /** Begin waiting after the parent send starts. No-op while already running. */
  start(): void {
    this.active = true;
    this.tier = 0;
    this.arm();
  }

  /** Visible content or a queue-length change: back to the 5s tier. */
  touch(): void {
    if (!this.active) return;
    this.tier = 0;
    this.arm();
  }

  /** Stop for the rest of this turn; later touches never revive it. */
  cancel(): void {
    this.active = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.handle === undefined) return;
    this.timers.clearTimer(this.handle);
    this.handle = undefined;
  }

  private arm(): void {
    this.clearTimer();
    this.handle = this.timers.setTimer(() => {
      this.handle = undefined;
      this.fire();
    }, KEEPALIVE_DELAYS_MS[this.tier]);
  }

  private fire(): void {
    if (!this.active) return;
    if (this.options.valid && !this.options.valid()) {
      this.cancel();
      return;
    }
    const text = this.nextText(depthOf(this.options.depth()));
    this.lastText = text;
    let sent: void | boolean | Promise<void | boolean>;
    try {
      sent = this.options.send(text);
    } catch {
      this.cancel();
      return;
    }
    if (sent === false) {
      this.cancel();
      return;
    }
    if (isThenable(sent)) {
      void Promise.resolve(sent).then(ok => { if (ok === false) this.cancel(); }, () => this.cancel());
    }
    this.tier = this.tier === 0 ? 1 : 2;
    this.arm();
  }

  private nextText(depth: number): string {
    if (depth > 1) return this.pick(KEEPALIVE_QUEUED_COPY, 'queued', depth);
    if (depth === 1) return this.pick(KEEPALIVE_SINGLE_COPY, 'single', depth);
    const key = `idle-${this.tier}` as CopyKey;
    return this.pick(KEEPALIVE_IDLE_COPY[this.tier], key, depth);
  }

  private pick(list: readonly string[], key: CopyKey, count: number): string {
    let index = this.cursors[key] % list.length;
    let text = list[index]!.replaceAll('{count}', String(count));
    if (text === this.lastText) {
      index = (index + 1) % list.length;
      text = list[index]!.replaceAll('{count}', String(count));
    }
    this.cursors[key] = index + 1;
    return text;
  }
}
