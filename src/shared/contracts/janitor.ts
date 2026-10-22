/** One allow-listed temp entry the sweep considered: removed, would remove in a dry run, skipped for a reason, or failed. */
export interface JanitorSweepEntry {
  name: string;
  path: string;
  action: 'removed' | 'would-remove' | 'skipped' | 'failed';
  code: string;
  reason: string;
  newestMtime: string | null;
  ageMs: number | null;
}

/** The record of one sweep, persisted in weaver.db and returned by the on-demand CLI command. */
export interface JanitorSweepResult {
  version: 1;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  tmpRoot: string;
  prefixes: string[];
  ttlMs: number;
  scanned: number;
  removed: number;
  skipped: number;
  failed: number;
  entries: JanitorSweepEntry[];
  /** Prefix matches beyond the bounded entry record. */
  omitted: number;
}

export interface JanitorSweepSummary {
  summary: true;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  tmpRoot: string;
  scanned: number;
  removed: number;
  skipped: number;
  failed: number;
  omitted: number;
}

export interface JanitorStatus {
  settings: import('./policy').JanitorSettings;
  started: boolean;
  nextSweepAt: string | null;
  /** Newest first. The newest record (and as many older ones as fit the transport budget) carry full entries. */
  history: (JanitorSweepResult | JanitorSweepSummary)[];
}
