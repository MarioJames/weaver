import type { QuotaEngine } from '../../shared/contracts/quota';

/** The engines whose native quota the prober observes. */
export const QUOTA_ENGINES: QuotaEngine[] = ['codex', 'claude', 'grok'];
