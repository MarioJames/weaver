import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QuotaFailure, QuotaRenewalPending } from './credentials';

export const OPENCODE_CONSOLE_ORIGIN = 'https://opencode.ai/console';
export const OPENCODE_CONSOLE_STATUS_PATH = '/api/go/status';

export interface OpenCodeConsoleIdentity {
  token: string;
  orgId: string;
  origin: string;
  account: string;
  fingerprint: string;
  renewable: boolean;
  expiresAt: number | null;
}

const nonemptyToken = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(value) ? value : undefined;
const nonemptyId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value.trim()) ? value.trim() : undefined;

export function openCodeDataDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir();
  const dataDir = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== '' ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return dataDir;
}

export function openCodeConsoleDbPath(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCODE_DB;
  if (override === ':memory:' || (override && path.isAbsolute(override))) return override;
  return path.join(openCodeDataDir(env), 'opencode', override || 'opencode.db');
}

function normalizeOrigin(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function expiryMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  // Native token_expiry is milliseconds (current installations); older rows may hold seconds.
  if (value >= 1_000_000_000_000) return value <= 8_640_000_000_000_000 ? value : null;
  if (value >= 1_000_000_000 && value < 1_000_000_000_000) return value * 1000;
  return null;
}

/**
 * Reads only the currently active native Console login from opencode.db.
 * Returns null ONLY when there is genuinely no native Console login: the DB
 * file is missing, or the state table holds zero rows / no active account id
 * (the caller then keeps the verified API-key file path). Any present-but-
 * unusable Console state (ambiguous rows, missing org, unreadable tables or
 * fields, foreign origin, bad token/expiry) throws a safe QuotaFailure and
 * must NOT fall back to another cached key.
 * Never reads email or refresh-token values; renewal need is a boolean CASE only.
 */
export function readOpenCodeConsole(env: NodeJS.ProcessEnv, now: number): OpenCodeConsoleIdentity | null {
  return readConsole(env, now);
}

/** Internal only: callers must first verify this account/org pair against native listOrgs. Never changes the active cursor. */
export function readOpenCodeConsoleAccount(env: NodeJS.ProcessEnv, now: number, accountID: string, orgID: string): OpenCodeConsoleIdentity {
  if (!nonemptyId(accountID) || !nonemptyId(orgID)) throw new QuotaFailure('unsupported', '原生 Console 账号参数无效');
  const result = readConsole(env, now, { accountID, orgID });
  if (!result) throw new QuotaFailure('unauthenticated', '未找到原生 Console 登录');
  return result;
}

function readConsole(env: NodeJS.ProcessEnv, now: number, selected?: { accountID: string; orgID: string }): OpenCodeConsoleIdentity | null {
  const file = openCodeConsoleDbPath(env);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    // node:sqlite reports the same ERR_SQLITE_ERROR/"unable to open database
    // file" for a missing file and for permission/corruption failures, so a
    // missing file is confirmed via metadata only; anything else is unsafe.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    try {
      statSync(file);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return null;
    }
    throw new QuotaFailure('unsupported', '无法安全读取原生 Console 登录');
  }
  try {
    try {
      db.exec('PRAGMA query_only = ON');
    } catch {
      // readOnly already prevents writes; query_only is a best-effort guard.
    }
    let activeAccountId = selected?.accountID;
    let activeOrgId = selected?.orgID;
    if (!selected) {
      let stateRows: Array<{ active_account_id: unknown; active_org_id: unknown }>;
      try {
        stateRows = db.prepare('SELECT active_account_id, active_org_id FROM account_state LIMIT 2').all() as Array<{ active_account_id: unknown; active_org_id: unknown }>;
      } catch {
        throw new QuotaFailure('unsupported', '无法安全读取原生 Console 登录');
      }
      if (stateRows.length === 0) return null;
      if (stateRows.length !== 1) throw new QuotaFailure('unsupported', '原生 Console 登录账户不明确，不会使用其他账号凭据');
      const rawAccountId: unknown = stateRows[0].active_account_id;
      // Only a genuinely absent cursor (NULL or blank) means "no active login" and
      // keeps the verified API-key path. A present-but-invalid cursor is unusable
      // Console state and must fail closed, never falling back to another key.
      if (rawAccountId === null || rawAccountId === undefined) return null;
      if (typeof rawAccountId === 'string' && rawAccountId.trim() === '') return null;
      activeAccountId = nonemptyId(rawAccountId);
      if (!activeAccountId) throw new QuotaFailure('unsupported', '原生 Console 登录账户不明确，不会使用其他账号凭据');
      activeOrgId = nonemptyId(stateRows[0].active_org_id);
      if (!activeOrgId) throw new QuotaFailure('unsupported', '原生 Console 登录组织缺失，不会使用其他账号凭据');
    }
    if (!activeAccountId || !activeOrgId) throw new QuotaFailure('unsupported', '原生 Console 账号组织无效');
    let rows: Array<{ url: unknown; access_token: unknown; token_expiry: unknown; has_refresh: unknown }>;
    try {
      rows = db.prepare(
        "SELECT url, access_token, token_expiry, CASE WHEN refresh_token IS NOT NULL AND refresh_token != '' THEN 1 ELSE 0 END AS has_refresh FROM account WHERE id = ?",
      ).all(activeAccountId) as Array<{ url: unknown; access_token: unknown; token_expiry: unknown; has_refresh: unknown }>;
    } catch {
      throw new QuotaFailure('unsupported', '无法安全读取原生 Console 登录');
    }
    if (rows.length !== 1) throw new QuotaFailure('unauthenticated', '原生 Console 登录无效，请在 OpenCode 中重新登录后手动刷新');
    const row = rows[0];
    const origin = normalizeOrigin(row.url);
    if (origin !== OPENCODE_CONSOLE_ORIGIN) {
      throw new QuotaFailure('unsupported', '原生 Console 登录来源不受支持，不会发送凭据');
    }
    const token = nonemptyToken(row.access_token);
    if (!token) throw new QuotaFailure('unauthenticated', '原生 Console 登录无效，请在 OpenCode 中重新登录后手动刷新');
    const account = createHash('sha256')
      .update('opencode-console')
      .update('\0')
      .update(activeAccountId)
      .update('\0')
      .update(activeOrgId)
      .update('\0')
      .update(origin)
      .digest('hex');
    const expires = expiryMs(row.token_expiry);
    if (expires === null && row.token_expiry !== null && row.token_expiry !== undefined) {
      throw new QuotaFailure('unsupported', '无法确认 OpenCode Console 登录有效期');
    }
    if (expires !== null && expires <= now) {
      if (row.has_refresh === 1) throw new QuotaRenewalPending(account);
      throw new QuotaFailure('unauthenticated', '原生 Console 登录已过期，请在 OpenCode 中重新登录后手动刷新');
    }
    const fingerprint = createHash('sha256').update(account).update('\0').update(token).digest('hex');
    return { token, orgId: activeOrgId, origin, account, fingerprint, renewable: row.has_refresh === 1, expiresAt: expires };
  } finally {
    try {
      db.close();
    } catch {
      // Read-only handle; nothing to flush.
    }
  }
}
