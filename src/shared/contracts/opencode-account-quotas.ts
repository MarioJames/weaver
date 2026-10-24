import type { OpenCodeConsoleOrg } from './opencode-accounts';
import type { EngineQuotaRecord } from './quota';

export interface OpenCodeAccountRef { accountID: string; orgID: string }
export interface OpenCodeAccountQuota {
  account: OpenCodeConsoleOrg;
  quota: EngineQuotaRecord;
  goReady: boolean;
  cooldownUntil: string | null;
}
export interface OpenCodeAccountQuotas {
  accounts: OpenCodeAccountQuota[];
  active: OpenCodeAccountRef | null;
  switching: boolean;
  detail?: string;
}
