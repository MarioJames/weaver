import type { Owner } from '../contracts/policy';

/** Weights are integers 0..10. Omitted means 5 (the middle). Higher is tried first; 0 never dispatches. This is priority, not a probability. */
export const WEIGHT_MAX = 10;
export const DEFAULT_WEIGHT = 5;
export function effectiveWeight(owner: Owner, workerId: string): number {
  const weights = owner.worker_weights;
  if (!weights || !Object.hasOwn(weights, workerId)) return DEFAULT_WEIGHT;
  return weights[workerId]!;
}
