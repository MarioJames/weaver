import type { OpenCodeConsoleOrg } from '../../shared/contracts/opencode-accounts';
import type { QuotaPersistence } from './quota-snapshot';
import type { TaskStore } from '../store';

export interface OpenCodePoolFailure { kind: 'quota' | 'rate_limit' | 'auth'; at: number; until: number; revision: number }
export interface OpenCodePoolSavedAccount {
  key: string; account: OpenCodeConsoleOrg; probe?: QuotaPersistence;
  goReady: boolean; managedAt: number; configNext: number;
  failure?: OpenCodePoolFailure; seenRuns: string[]; ladder?: { level: number; lastTriggerAt: number };
}
export interface OpenCodePoolPersistence {
  load(): { accounts: OpenCodePoolSavedAccount[] } | undefined;
  save(value: { accounts: OpenCodePoolSavedAccount[] }): void;
}

const KEY = 'opencode-account-pool';
/** Safe observations and failure pacing only. Native credentials stay solely in the native DB. */
export function dbOpenCodePoolStore(store: Pick<TaskStore, 'getValue' | 'putValue'>): OpenCodePoolPersistence {
  return {
    load: () => store.getValue<ReturnType<OpenCodePoolPersistence['load']>>(KEY),
    save: value => store.putValue(KEY, value),
  };
}
