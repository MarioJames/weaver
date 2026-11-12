import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findEngineExecutable, runCapture, type CaptureResult } from './probe';
import {
  openCodeDbPath,
  openCodeGoCredential,
  readOpenCodeCredentials,
  type OpenCodeCredential,
} from './opencode-db';

export { openCodeDbPath, openCodeGoCredential, readOpenCodeCredentials };
export type { OpenCodeCredential };

/**
 * OpenCode 2.2 keeps inference credentials in the `credential` table. These
 * helpers only read that table; they never switch the native cursor or write the
 * source database. A login/import is ready only when the private root has an
 * active `opencode-go` credential and `opencode models` can list a model for it.
 */
export interface OpenCodeIdentity {
  accountID?: string;
  orgID?: string;
  email?: string;
  credentialID: string;
  label: string;
}

const text = (value: unknown, max = 256): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value) ? value : undefined;

/**
 * Stable identity from a private root. Account/org identify a Console login; a
 * credential-only database uses its credential ID. The account tables are legacy
 * data retained by OpenCode 2.2 and are read only, never switched.
 */
export function openCodeIdentity(root: string): OpenCodeIdentity | undefined {
  const file = join(root, 'opencode.db');
  const credentials = readOpenCodeCredentials(file);
  if (!credentials) return;
  const go = credentials.find(row => row.integrationID === 'opencode-go' && (row.type === 'key' || row.type === 'oauth'));
  if (!go) return;
  let db: DatabaseSync | undefined;
  let accountID: string | undefined;
  let orgID: string | undefined;
  let email: string | undefined;
  try {
    const info = lstatSync(file);
    if (info.isFile() && !info.isSymbolicLink()) {
      db = new DatabaseSync(file, { readOnly: true });
      const state = db.prepare('SELECT active_account_id, active_org_id FROM account_state WHERE id = 1').get() as Record<string, unknown> | undefined;
      accountID = text(state?.active_account_id);
      orgID = text(state?.active_org_id);
      if (accountID) {
        const account = db.prepare('SELECT email FROM account WHERE id = ?').get(accountID) as Record<string, unknown> | undefined;
        email = typeof account?.email === 'string' && account.email.length <= 2048 ? account.email : undefined;
      }
    }
  } catch { /* Older/partial databases still identify the credential itself. */ }
  finally { try { db?.close(); } catch { /* read-only handle */ } }
  const meta = go.metadata ?? {};
  accountID ??= text(meta.accountID) ?? text(meta.accountId);
  orgID ??= text(meta.orgID) ?? text(meta.orgId);
  email ??= typeof meta.email === 'string' && meta.email.length <= 2048 ? meta.email : undefined;
  if (!accountID && !orgID && go.type === 'oauth') {
    // No separate account row: the OAuth credential itself is the stable login.
    accountID = go.id;
  }
  return { ...(accountID ? { accountID } : {}), ...(orgID ? { orgID } : {}), ...(email ? { email } : {}), credentialID: go.id, label: go.label };
}

/** Stable subject used by relogin. A credential-only root falls back to its credential ID. */
export function openCodeIdentitySubject(root: string): string | undefined {
  const identity = openCodeIdentity(root);
  if (!identity) return;
  if (identity.accountID || identity.orgID) return `opencode:${identity.accountID ?? ''}:${identity.orgID ?? ''}`;
  return `opencode:credential:${identity.credentialID}`;
}

export interface OpenCodeModelCheck {
  find?: typeof findEngineExecutable;
  capture?: (executable: string, args: readonly string[], timeoutMs: number, maxBytes: number, env: NodeJS.ProcessEnv) => Promise<CaptureResult>;
  timeoutMs?: number;
}

/** Runs the native 2.2 model catalog in the caller's private-root environment. */
export async function openCodeGoModelsReady(env: NodeJS.ProcessEnv, options: OpenCodeModelCheck = {}): Promise<boolean> {
  try {
    const executable = await (options.find ?? findEngineExecutable)('opencode', env.PATH ?? '');
    if (!executable) return false;
    const result = await (options.capture ?? runCapture)(executable, ['models', '--standalone'], options.timeoutMs ?? 20_000, 256 * 1024, env);
    if (result.code !== 0 || result.error || result.timedOut || result.overflow) return false;
    return result.stdout.split(/\r?\n/).some(line => line.trim().startsWith('opencode-go/'));
  } catch { return false; }
}
