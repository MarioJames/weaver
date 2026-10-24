export interface OpenCodeConsoleOrg {
  accountID: string;
  accountEmail: string;
  accountUrl: string;
  orgID: string;
  orgName: string;
  active: boolean;
}
export interface OpenCodeConsoleAccounts {
  orgs: OpenCodeConsoleOrg[];
  consoleManagedProviders: string[];
  activeOrgName?: string;
  switchableOrgCount: number;
  detail?: string;
}
export interface OpenCodeConsoleLogin {
  id: string;
  status: 'starting' | 'authorizing' | 'succeeded' | 'failed' | 'cancelled';
  verificationUrl?: string;
  userCode?: string;
  detail?: string;
}
export interface OpenCodeAccountSwitchInput {
  accountID: string;
  orgID: string;
  expectedActive: { accountID: string; orgID: string } | null;
}
