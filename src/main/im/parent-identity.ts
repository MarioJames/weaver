import { IM_MASTER_READY_MARKER } from './bootstrap';

/** Hidden identity turn budget: one bounded master initialization send per host. */
export const PARENT_IDENTITY_MS = 90_000;
/**
 * Outer host startup budget: native engine handshake (30s) + identity turn (90s)
 * + small margin for IPC teardown. No new RPC config; tests override via internals.
 */
export const HOST_STARTUP_MS = 125_000;

/** Strict ready gate: only the trimmed marker proves the Master finished initialization. */
export function isMasterReadyText(text: string): boolean {
  return text.trim() === IM_MASTER_READY_MARKER;
}

/**
 * Test-only shortening of the identity budget via the init env (never lengthens
 * production beyond the fixed default). Reads WEAVER_PARENT_IDENTITY_MS.
 */
export function identityTimeoutMs(env?: NodeJS.ProcessEnv): number {
  const raw = Number(env?.WEAVER_PARENT_IDENTITY_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.max(Math.floor(raw), 50), PARENT_IDENTITY_MS);
  return PARENT_IDENTITY_MS;
}
