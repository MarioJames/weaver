/** Minutes a level 1 or 2 penalty waits before its recovery probe; null is level 3. */
export const STALL_LADDER: (number | null)[] = [5, 10, null];
/** Level 3 is probed on this cadence and never expires just because time passed. */
export const PROBE_MS = 10 * 60_000;
/** Consecutive passing probes needed before a level 3 penalty lifts on its own. */
export const PROBE_SUCCESSES = 3;
export const LADDER_RESET_MS = 2 * 60 * 60_000;
/** Vendor rate limit ladder in minutes, level 1..3; shared with the free-channel probe monitor. */
export const VENDOR_LADDER_MINUTES = [10, 30, 60] as const;
