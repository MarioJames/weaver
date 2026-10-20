import type { PolicyStore } from '../../src/main/policy/store';
import { previewRoute } from '../../src/main/policy/preview';

/** The route a dispatch would take against the store's saved policy at `at` (default: now). */
export function previewOn(policy: PolicyStore, value: unknown, at: number = Date.now()) {
  const live = policy.snapshot();
  return previewRoute(live.config, live.blocks, at, value);
}
