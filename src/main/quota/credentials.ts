import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { QuotaEngine, QuotaStatus } from '../../shared/contracts/quota';
import { parseProviderTimestamp } from './timestamps';

const MAX_FILE_BYTES = 256 * 1024;
export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const nonempty = (value: unknown, max = 16384): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value) ? value : undefined;
const hasText = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

export class QuotaFailure extends Error {
  constructor(readonly status: QuotaStatus, message: string, readonly retryAt: number | null = null) { super(message); }
}

/** A lapsed short-lived access token whose entry still holds a refresh token. The native CLI renews it on its next run, so this is a wait, not a logout. */
export class QuotaRenewalPending extends QuotaFailure {
  constructor(readonly account: string) { super('unknown', '原生访问令牌已到期，等待原生 CLI 续期后再读取'); }
}
export interface NativeCredential { token: string; accountId?: string; fingerprint: string; account: string; opencodeKind?: 'api' | 'console'; orgId?: string; origin?: string }

export async function readObject(file: string): Promise<JsonObject> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new QuotaFailure('unsupported', '认证文件类型或大小不受支持');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new QuotaFailure('unsupported', '认证文件超过大小限制');
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { throw new QuotaFailure('unsupported', '认证文件格式不受支持'); }
    const root = object(parsed);
    if (!root) throw new QuotaFailure('unsupported', '认证文件格式不受支持');
    return root;
  } catch (error) {
    if (error instanceof QuotaFailure) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new QuotaFailure('unauthenticated', '未找到原生登录凭据');
    throw new QuotaFailure('unsupported', '无法安全读取原生认证文件');
  } finally { await handle?.close().catch(() => undefined); }
}

function jwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part || !/^[\w-]+$/.test(part))) return null;
  try {
    const claims = object(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    const exp = claims?.exp;
    return typeof exp === 'number' && Number.isSafeInteger(exp) && exp > 0 && exp <= 8640000000000 ? exp * 1000 : null;
  } catch { return null; }
}

/**
 * OpenCode credential priority follows the real native login: the currently active
 * Console account in opencode.db (SQLite, read-only) wins over a possibly stale
 * Go API key left in auth.json. A present-but-unusable Console state never falls
 * back to the file key, so two accounts are never silently mixed. Only when there
 * is no active Console login does the verified API-key file path apply.
 * Reads only, never refreshes, switches accounts, or writes credentials.
 */
async function readOpenCodeCredential(env: NodeJS.ProcessEnv, now: number): Promise<NativeCredential> {
  const { readOpenCodeConsole } = await import('./opencode-console');
  const consoleLogin = readOpenCodeConsole(env, now);
  if (consoleLogin) {
    return {
      token: consoleLogin.token,
      fingerprint: consoleLogin.fingerprint,
      account: consoleLogin.account,
      opencodeKind: 'console',
      orgId: consoleLogin.orgId,
      origin: consoleLogin.origin,
    };
  }
  const home = env.HOME || homedir();
  const dataDir = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== '' ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  let root: JsonObject;
  try {
    root = await readObject(path.join(dataDir, 'opencode', 'auth.json'));
  } catch (error) {
    if (error instanceof QuotaFailure && error.status === 'unauthenticated') {
      throw new QuotaFailure('unsupported', '尚未连接 OpenCode Go 订阅，无 Go 套餐额度可读；免费模型与按量余额没有官方只读额度接口');
    }
    throw error;
  }
  const providerId = object(root['opencode-go']) !== undefined ? 'opencode-go' : object(root.opencode) !== undefined ? 'opencode' : undefined;
  const entry = providerId !== undefined ? object(root[providerId]) : undefined;
  if (entry === undefined) {
    throw new QuotaFailure('unsupported', '尚未连接 OpenCode Go 订阅，无 Go 套餐额度可读；免费模型与按量余额没有官方只读额度接口');
  }
  if (entry.type !== 'api') throw new QuotaFailure('unsupported', 'OpenCode 当前登录方式没有 Go 套餐额度可读；连接 OpenCode Go 订阅后可查看套餐窗口');
  const token = nonempty(entry.key);
  if (!token) throw new QuotaFailure('unsupported', 'OpenCode Go API key 缺失或不可用，无法读取 Go 套餐额度');
  const account = createHash('sha256').update('opencode').update('\0').update(providerId!).digest('hex');
  return { token, fingerprint: createHash('sha256').update(account).update('\0').update(token).digest('hex'), account, opencodeKind: 'api' };
}

/** Reads only the current native session; never refreshes, switches accounts, or writes credentials. */
export async function readNativeCredential(engine: QuotaEngine, env: NodeJS.ProcessEnv, now: number): Promise<NativeCredential> {
  if (engine === 'opencode') return readOpenCodeCredential(env, now);
  const home = env.HOME || homedir();
  const file = engine === 'codex' ? path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json')
    : engine === 'claude' ? path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json')
      : path.join(home, '.grok', 'auth.json');
  const root = await readObject(file);
  let token: string | undefined;
  let accountId: string | undefined;
  let identity = '';
  let expires: number | undefined;
  let renewable = false;
  if (engine === 'codex') {
    if (root.auth_mode !== undefined && root.auth_mode !== 'chatgpt') throw new QuotaFailure('unsupported', '仅支持 Codex 原生 ChatGPT 登录');
    if (root.auth_mode === undefined && [root.OPENAI_API_KEY, root.personal_access_token, root.agent_identity, root.bedrock_api_key, root.bedrock_access_keys].some(value => value !== undefined && value !== null && value !== '')) throw new QuotaFailure('unsupported', 'Codex 当前认证模式不明确');
    const tokens = object(root.tokens);
    token = nonempty(tokens?.access_token);
    accountId = nonempty(tokens?.account_id, 256);
    if (!token || !accountId) throw new QuotaFailure('unsupported', '缺少完整的 Codex ChatGPT 登录凭据');
    const expiry = jwtExpiry(token);
    if (expiry === null) throw new QuotaFailure('unsupported', '无法确认 Codex 原生登录有效期');
    expires = expiry;
    if (hasText(tokens?.refresh_token)) renewable = true;
  } else if (engine === 'claude') {
    const oauth = object(root.claudeAiOauth);
    token = nonempty(oauth?.accessToken);
    if (!token) throw new QuotaFailure('unauthenticated', '缺少 Claude Code 原生登录凭据');
    if (hasText(oauth?.refreshToken)) renewable = true;
    if (oauth?.expiresAt !== undefined) {
      if (typeof oauth.expiresAt !== 'number' || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= 0) throw new QuotaFailure('unsupported', '无法确认 Claude Code 登录有效期');
      expires = oauth.expiresAt;
    }
  } else {
    const candidates = Object.entries(root).filter(([key, value]) => key.startsWith('https://auth.x.ai::') && key.length > 'https://auth.x.ai::'.length && object(value)?.auth_mode === 'oidc');
    if (candidates.length !== 1) throw new QuotaFailure('unsupported', 'Grok 原生登录账户不明确');
    const entry = object(candidates[0][1])!;
    if (entry.oidc_issuer !== undefined && entry.oidc_issuer !== 'https://auth.x.ai') throw new QuotaFailure('unsupported', 'Grok 登录来源不受支持');
    token = nonempty(entry.key);
    if (!token) throw new QuotaFailure('unauthenticated', '缺少 Grok 原生登录凭据');
    const expiry = parseProviderTimestamp(entry.expires_at);
    if (expiry === null) throw new QuotaFailure('unsupported', '无法确认 Grok 登录有效期');
    expires = expiry;
    identity = `${candidates[0][0]}\0${nonempty(entry.team_id, 256) ?? ''}`;
    if (hasText(entry.refresh_token)) renewable = true;
  }
  const account = createHash('sha256').update(engine).update('\0').update(accountId ?? '').update('\0').update(identity).digest('hex');
  if (expires !== undefined && expires <= now) {
    if (renewable) throw new QuotaRenewalPending(account);
    throw new QuotaFailure('unauthenticated', '原生登录已过期，请在对应工具中重新登录');
  }
  const fingerprint = createHash('sha256').update(account).update('\0').update(token).digest('hex');
  return { token, accountId, fingerprint, account };
}
