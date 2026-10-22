import { closeSync, fstatSync, openSync, readSync, statSync, type FSWatcher, watch } from 'node:fs';
import { decodeLines } from './scope';

export interface LogFileIdentity {
  dev: number;
  ino: number;
}

export type IntegrityReason = 'replaced' | 'truncated';

export interface LogTailerOptions {
  /** Byte offset to start reading from (replay cursor). */
  offset?: number;
  /** Poll fallback interval in ms (fs.watch is unreliable for appends). */
  pollMs?: number;
  /** Expected file identity; integrity is checked before every read. */
  identity?: LogFileIdentity;
  onIntegrityError?: (reason: IntegrityReason, detail: string) => void;
  /**
   * Injected clock/timer for tests. Defaults to global setInterval/clearInterval.
   * Signature mirrors setInterval so tests can drive polling deterministically.
   */
  setPoll?: (fn: () => void, ms: number) => unknown;
  clearPoll?: (timer: unknown) => void;
}

/**
 * Read-only file tailer (§5): opens a log file O_RDONLY from a given byte
 * offset, emits complete newline-terminated lines via fs.watch + polling
 * fallback, and verifies dev/ino + size before every read. Line splitting
 * reuses decodeLines' 8MiB semantics. Does not parse vendor protocols.
 */
export class LogTailer {
  private fd: number | undefined;
  private watcher: FSWatcher | undefined;
  private pollTimer: unknown;
  private offset: number;
  private readonly pollMs: number;
  private readonly identity: LogFileIdentity | undefined;
  private readonly onIntegrityError: ((reason: IntegrityReason, detail: string) => void) | undefined;
  private readonly setPoll: (fn: () => void, ms: number) => unknown;
  private readonly clearPoll: (timer: unknown) => void;
  private pending = Buffer.alloc(0);
  private stopped = false;
  private failed = false;

  constructor(
    private readonly path: string,
    private readonly onLine: (line: Buffer, endOffset: number) => void,
    options: LogTailerOptions = {},
  ) {
    this.offset = options.offset ?? 0;
    this.pollMs = options.pollMs ?? 250;
    this.identity = options.identity;
    this.onIntegrityError = options.onIntegrityError;
    this.setPoll = options.setPoll ?? ((fn, ms) => setInterval(fn, ms));
    this.clearPoll = options.clearPoll ?? (timer => clearInterval(timer as ReturnType<typeof setInterval>));
  }

  /** Open the file and start watch + poll. Reads from the initial offset. */
  start(): void {
    if (this.fd !== undefined || this.stopped) return;
    this.fd = openSync(this.path, 'r');
    try {
      this.watcher = watch(this.path, () => {
        void this.pump();
      });
      this.watcher.on('error', () => {
        /* poll fallback keeps correctness; ignore watcher errors */
      });
    } catch {
      this.watcher = undefined;
    }
    this.pollTimer = this.setPoll(() => {
      void this.pump();
    }, this.pollMs);
    void this.pump();
  }

  private integrity(): IntegrityReason | undefined {
    if (this.fd === undefined) return undefined;
    try {
      const live = fstatSync(this.fd);
      if (this.identity && (live.dev !== this.identity.dev || live.ino !== this.identity.ino)) {
        return 'replaced';
      }
    } catch {
      return 'replaced';
    }
    try {
      const st = statSync(this.path);
      if (this.identity && (st.dev !== this.identity.dev || st.ino !== this.identity.ino)) {
        return 'replaced';
      }
      if (st.size < this.offset) return 'truncated';
    } catch {
      return 'replaced';
    }
    return undefined;
  }

  private fail(reason: IntegrityReason, detail: string): void {
    if (this.failed) return;
    this.failed = true;
    try {
      this.onIntegrityError?.(reason, detail);
    } finally {
      this.close();
    }
  }

  private pump(): Promise<void> | void {
    if (this.fd === undefined || this.stopped || this.failed) return;
    const bad = this.integrity();
    if (bad) {
      this.fail(bad, `${bad}: ${this.path} at offset ${this.offset}`);
      return;
    }
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      let n: number;
      try {
        n = readSync(this.fd, buf, 0, buf.length, this.offset);
      } catch {
        return;
      }
      if (n <= 0) break;
      this.offset += n;
      chunks.push(buf.subarray(0, n));
    }
    if (chunks.length === 0) return;
    const data = Buffer.concat([this.pending, ...chunks]);
    this.pending = Buffer.alloc(0);
    // Feed complete segments; keep the trailing unterminated tail buffered.
    const lastNewline = data.lastIndexOf(10);
    if (lastNewline < 0) {
      this.pending = data;
      return;
    }
    // Byte offset of data[0] in the file: reads advanced this.offset past
    // both the previously buffered tail and the new chunks.
    const baseOffset = this.offset - data.length;
    // Precompute each complete line's end offset (past its '\n') so the
    // callback reports exact per-line positions even across pumps.
    const endOffsets: number[] = [];
    for (let i = 0; i <= lastNewline; i++) {
      if (data[i] === 10) endOffsets.push(baseOffset + i + 1);
    }
    let emitted = 0;
    const push = (text: string): void => {
      // NB: if decodeLines drops an oversized (>8MiB) line, later offsets
      // shift by the dropped physical lines; endOffset stays exact in the
      // normal case and conservative (never past the true end) otherwise.
      const endOffset = endOffsets[emitted] ?? this.offset;
      emitted += 1;
      this.onLine(Buffer.from(text, 'utf8'), endOffset);
    };
    const overflow = (): void => {
      /* decodeLines reports >8MiB lines; drop the oversized line like scope.ts */
    };
    const decoder = decodeLines(push, overflow);
    decoder.write(data.subarray(0, lastNewline + 1));
    decoder.end();
    this.pending = data.subarray(lastNewline + 1);
  }

  /** Current trailing unterminated bytes (at most 8KiB), without consuming. */
  unterminatedTail(maxBytes = 8 * 1024): Buffer {
    return this.pending.subarray(Math.max(0, this.pending.length - maxBytes));
  }

  /** Current read offset (committed read position, includes buffered tail). */
  position(): number {
    return this.offset;
  }

  close(): void {
    if (this.stopped && this.fd === undefined) return;
    this.stopped = true;
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    this.watcher = undefined;
    if (this.pollTimer !== undefined) {
      try {
        this.clearPoll(this.pollTimer);
      } catch {
        /* ignore */
      }
      this.pollTimer = undefined;
    }
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = undefined;
    }
  }
}
