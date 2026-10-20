import { LADDER_RESET_MS, PROBE_MS, STALL_LADDER, VENDOR_LADDER_MINUTES } from '../domain/penalties';
import type { VendorLimit } from '../storage/vendor-limits';

/** When one ladder stage ends and when its first recovery probe is due; both null waits for the user. */
export interface Armed { blockedUntil: number | null; nextProbeAt: number | null }

/** Nominal deadline and first recovery probe of a stall-ladder stage; a stage without minutes waits on a passing probe alone. */
export function armStall(level: number, now: number): Armed {
  const minutes = STALL_LADDER[level - 1];
  if (minutes === null) return { blockedUntil: null, nextProbeAt: now + PROBE_MS };
  const at = now + minutes! * 60_000;
  return { blockedUntil: at, nextProbeAt: at };
}

/** A ladder that was triggered before and has been quiet for the whole reset window starts over. */
export const ladderQuiet = (lastTriggerAt: number | null, now: number): boolean =>
  lastTriggerAt !== null && now - lastTriggerAt >= LADDER_RESET_MS;

/** The last trigger is known and still inside the reset window, so the ladder level still counts. */
export const ladderLive = (lastTriggerAt: number | null, now: number): boolean =>
  lastTriggerAt !== null && now - lastTriggerAt < LADDER_RESET_MS;

/**
 * The level one more trigger lands on. The current level only counts while the last trigger is still inside the
 * reset window; an unknown trigger time starts over. The trigger time itself is the caller's to stamp.
 */
export function nextLevel(level: number, lastTriggerAt: number | null, now: number, cap: number): number {
  const base = ladderLive(lastTriggerAt, now) ? level : 0;
  return Math.min(base + 1, cap);
}

/** One step of the vendor rate-limit ladder: the new level and how many minutes it waits. */
export interface VendorStep { level: number; minutes: number }

/**
 * The single rule for stepping a worker's vendor rate-limit ladder, shared by the dispatch-failure path and the
 * free-channel probe: one level up while the last step is inside the reset window, level 1 otherwise, capped at
 * the ladder's length. The caller stamps the new trigger time.
 */
export function nextVendorStep(previous: VendorLimit | undefined, now: number): VendorStep {
  const level = nextLevel(previous?.level ?? 0, previous?.lastTriggerAt ?? null, now, VENDOR_LADDER_MINUTES.length);
  return { level, minutes: VENDOR_LADDER_MINUTES[level - 1]! };
}
