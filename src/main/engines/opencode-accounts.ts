import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { openCodeConsoleDbPath } from '../quota/opencode-console';
import type { OpenCodeAccountRef } from '../../shared/contracts/opencode-account-quotas';
import { randomBytes, randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { startOwnedScope, confirmScopeAbsent, type OwnedScope } from '../adapters/cli/scope';
import { findEngineExecutable } from './probe';
import { RpcError } from '../rpc';
import type { OpenCodeAccountSwitchInput, OpenCodeConsoleAccounts, OpenCodeConsoleLogin, OpenCodeConsoleOrg } from '../../shared/contracts/opencode-accounts';

const ORIGIN = 'https://opencode.ai/console';
const EFFECT = '仅之后新启动进程生效，长驻进程需要重新启动；已有任务和外部服务保留旧配置。';
const unavailable = () => new RpcError('OPENCODE_UNAVAILABLE', '无法读取 OpenCode 原生账号接口，请确认已安装支持 Console API 的版本。');
const invalid = () => new RpcError('INVALID_REQUEST', '账号操作参数无效，请重新读取账号列表。');
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(); return v as Record<string, unknown>; };
const id = (v: unknown): string => { if (typeof v !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(v)) throw invalid(); return v; };
export function parseOpenCodeSwitch(value: unknown): OpenCodeAccountSwitchInput {
  const input = record(value);
  if (Object.keys(input).some(k => !['accountID', 'orgID', 'expectedActive'].includes(k)) || !Object.hasOwn(input, 'expectedActive')) throw invalid();
  let expectedActive: OpenCodeAccountSwitchInput['expectedActive'] = null;
  if (input.expectedActive !== null) { const active = record(input.expectedActive); if (Object.keys(active).some(k => !['accountID', 'orgID'].includes(k))) throw invalid(); expectedActive = { accountID: id(active.accountID), orgID: id(active.orgID) }; }
  return { accountID: id(input.accountID), orgID: id(input.orgID), expectedActive };
}
export function parseOpenCodeLoginId(value: unknown): string {
  const input = record(value);
  if (Object.keys(input).length !== 1 || typeof input.id !== 'string' || input.id !== 'current' && !/^[0-9a-f-]{36}$/.test(input.id)) throw invalid();
  return input.id;
}
/** Only the official device authorization page may cross the process boundary. */
export function officialVerificationUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://opencode.ai' || url.username || url.password || url.hash) return;
    if (url.href.length > 2048) return;
    return url.href;
  } catch { return; }
}
interface ProcessHandle { scope: OwnedScope; closed: Promise<number | null>; done: boolean; failed: boolean }
interface Helper { request(path: string, body?: unknown): Promise<unknown>; close(): Promise<void> }
export interface OpenCodeAccountsOptions {
  env?: NodeJS.ProcessEnv;
  start?: typeof startOwnedScope;
  find?: typeof findEngineExecutable;
  fetch?: typeof fetch;
  loginTimeoutMs?: number;
  helperTimeoutMs?: number;
  changed?: (snapshot: OpenCodeConsoleAccounts) => Promise<void>;
  observed?: (snapshot: OpenCodeConsoleAccounts) => void;
  mutationGuard?: () => (() => void);
  accessGuard?: () => void;
  confirmAbsent?: typeof confirmScopeAbsent;
}
export class OpenCodeAccounts {
  private login?: OpenCodeConsoleLogin;
  private loginProcess?: ProcessHandle;
  private loginWork?: Promise<void>;
  private busy = false;
  private loginPending = false;
  private loginRelease?: () => void;
  private closing = false;
  private readonly processes = new Set<ProcessHandle>();
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly options: OpenCodeAccountsOptions = {}) { this.env = { ...(options.env ?? process.env) }; delete this.env.ELECTRON_RUN_AS_NODE; }
  get ownedPids(): ReadonlySet<number> { return new Set([...this.processes].flatMap(p => p.scope.pid === undefined ? [] : [p.scope.pid])); }
  private async launch(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<ProcessHandle> {
    this.options.accessGuard?.();
    const executable = await (this.options.find ?? findEngineExecutable)('opencode', this.env.PATH ?? '');
    if (!executable || this.closing) throw unavailable();
    const scope = (this.options.start ?? startOwnedScope)({ command: [executable, ...args], cwd: process.cwd(), env: { ...this.env, ...extra }, stdin: null, unit: `dev-weaver-opencode-accounts-${randomUUID()}` });
    const handle: ProcessHandle = { scope, done: false, failed: false, closed: Promise.resolve(null) };
    handle.closed = new Promise(resolve => { scope.on('error', () => { handle.failed = true; scope.kill('SIGKILL'); }); scope.once('close', (code: number | null) => { handle.done = true; resolve(code); }); });
    this.processes.add(handle);
    return handle;
  }
  private async stop(handle: ProcessHandle): Promise<void> {
    if (!handle.done) handle.scope.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([handle.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => { handle.scope.kill('SIGKILL'); reject(new RpcError('OPENCODE_CLEANUP', 'OpenCode 自有进程未能确认停止；请重新读取状态。')); }, 12_000); })]); }
    finally { if (timer) clearTimeout(timer); }
    if (await (this.options.confirmAbsent ?? confirmScopeAbsent)(handle.scope.unit) !== true) throw new RpcError('OPENCODE_CLEANUP', '无法确认 OpenCode 自有进程树已停止，请重新读取状态。');
    this.processes.delete(handle);
  }
  private async helper(): Promise<Helper> {
    const password = randomBytes(32).toString('hex');
    const handle = await this.launch(['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'], { OPENCODE_SERVER_USERNAME: 'weaver', OPENCODE_SERVER_PASSWORD: password });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const base = await new Promise<string>((resolve, reject) => {
        let output = '';
        const read = (chunk: Buffer) => {
          output = (output + stripVTControlCharacters(chunk.toString())).slice(-8192);
          const announced = output.match(/opencode server listening on (https?:\/\/[^\s]+)/i);
          if (!announced) return;
          try { const url = new URL(announced[1]); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw unavailable(); resolve(url.origin); } catch { reject(unavailable()); }
        };
        handle.scope.stdout.on('data', read); handle.scope.stderr.on('data', read);
        handle.closed.then(() => reject(unavailable()));
        timer = setTimeout(() => reject(unavailable()), this.options.helperTimeoutMs ?? 20_000);
      });
      if (timer) clearTimeout(timer);
      return {
        request: async (path, body) => {
          try {
            const response = await (this.options.fetch ?? fetch)(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Basic ${Buffer.from(`weaver:${password}`).toString('base64')}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(20_000) });
            if (!response.ok || !response.body) throw unavailable();
            const reader = response.body.getReader(); let result = ''; let size = 0;
            try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1024 * 1024) throw unavailable(); result += Buffer.from(part.value).toString('utf8'); } } finally { await reader.cancel().catch(() => {}); }
            return JSON.parse(result) as unknown;
          } catch { throw unavailable(); }
        },
        close: () => this.stop(handle),
      };
    } catch { await this.stop(handle); throw unavailable(); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async snapshot(): Promise<OpenCodeConsoleAccounts> {
    const helper = await this.helper();
    try {
      const raw = record(await helper.request('/experimental/console/orgs'));
      const metadata = record(await helper.request('/experimental/console'));
      if (!Array.isArray(raw.orgs) || raw.orgs.length > 1000 || !Array.isArray(metadata.consoleManagedProviders) || !metadata.consoleManagedProviders.every(p => typeof p === 'string' && p.length < 256) || !Number.isSafeInteger(metadata.switchableOrgCount) || Number(metadata.switchableOrgCount) < 0) throw unavailable();
      const orgs: OpenCodeConsoleOrg[] = raw.orgs.map(value => { const o = record(value); if (typeof o.active !== 'boolean' || !['accountEmail', 'accountUrl', 'orgName'].every(k => typeof o[k] === 'string' && (o[k] as string).length < 2048)) throw unavailable(); return { accountID: id(o.accountID), orgID: id(o.orgID), accountEmail: o.accountEmail as string, accountUrl: o.accountUrl as string, orgName: o.orgName as string, active: o.active }; }).filter(o => o.accountUrl.replace(/\/+$/, '') === ORIGIN);
      if (orgs.filter(o => o.active).length > 1) throw unavailable();
      const snapshot: OpenCodeConsoleAccounts = { orgs, consoleManagedProviders: metadata.consoleManagedProviders as string[], ...(typeof metadata.activeOrgName === 'string' ? { activeOrgName: metadata.activeOrgName.slice(0, 2048) } : {}), switchableOrgCount: metadata.switchableOrgCount as number, detail: `${metadata.consoleManagedProviders.includes('opencode-go') ? '' : '无法确认 Go 推理凭证已由当前组织管理，仍可能使用既有 API key。'}${EFFECT} 原生列表可能省略暂时无法连接的账号。` };
      this.options.observed?.(snapshot);
      return snapshot;
    } catch { throw unavailable(); }
    finally { await helper.close(); }
  }
  async list(): Promise<OpenCodeConsoleAccounts> { if (this.busy || this.loginPending) throw new RpcError('CONFLICT', '账号操作进行中，请等待完成后刷新。'); this.busy = true; try { return await this.snapshot(); } finally { this.busy = false; } }
  private runningLogin(): boolean { return !!this.login && ['starting', 'authorizing'].includes(this.login.status); }
  startLogin(): OpenCodeConsoleLogin {
    if (this.closing) throw unavailable();
    if (this.loginPending) return { ...this.login! };
    if (this.busy) throw new RpcError('CONFLICT', '账号操作进行中，请稍后登录。');
    this.loginRelease = this.options.mutationGuard?.();
    this.login = { id: randomUUID(), status: 'starting', detail: '原生 CLI 会尝试打开浏览器，也可使用下方官方链接。' };
    this.loginPending = true;
    this.loginWork = this.runLogin(this.login).finally(() => { this.loginPending = false; this.loginRelease?.(); this.loginRelease = undefined; });
    return { ...this.login };
  }
  getLogin(value: unknown): OpenCodeConsoleLogin | null { const key = parseOpenCodeLoginId(value); if (key === 'current' && !this.login) return null; if (!this.login || key !== 'current' && this.login.id !== key) throw new RpcError('NOT_FOUND', '登录记录不存在，请重新开始登录。'); return { ...this.login }; }
  async cancelLogin(value: unknown): Promise<OpenCodeConsoleLogin> {
    const existing = this.getLogin(value);
    if (!existing) throw new RpcError('NOT_FOUND', '登录记录不存在。');
    if (this.runningLogin()) { this.login!.status = 'cancelled'; this.login!.detail = '登录已取消；若授权刚完成，原生状态可能已更新，请刷新账号列表。'; if (this.loginProcess) await this.stop(this.loginProcess); await this.loginWork; }
    return { ...this.login! };
  }
  private async runLogin(job: OpenCodeConsoleLogin): Promise<void> {
    let handle: ProcessHandle | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      handle = await this.launch(['console', 'login', ORIGIN, '--pure']); this.loginProcess = handle;
      if (job.status === 'cancelled' || this.closing) { await this.stop(handle); return; }
      let output = ''; let observedSuccess = false;
      const read = (chunk: Buffer) => {
        output = (output + stripVTControlCharacters(chunk.toString())).slice(-8192);
        if (/Logged in as [^\r\n]+/.test(output)) observedSuccess = true;
        const candidate = output.match(/Go to:\s*(https:\/\/[^\s]+)/)?.[1];
        const code = output.match(/Enter code:\s*([A-Za-z0-9-]{4,32})(?=\s|$)/)?.[1];
        const url = candidate && officialVerificationUrl(candidate);
        if (url && this.runningLogin()) { job.verificationUrl = url; if (code) job.userCode = code; job.status = 'authorizing'; }
      };
      handle.scope.stdout.on('data', read); handle.scope.stderr.on('data', read);
      timer = setTimeout(() => { if (this.runningLogin()) { job.status = 'failed'; job.detail = '登录超时，已终止原生登录进程；请刷新账号列表确认当前状态。'; } void this.stop(handle!).catch(() => { job.detail = '登录超时，无法确认自有进程已停止；请重新读取状态。'; }); }, this.options.loginTimeoutMs ?? 10 * 60_000);
      const code = await handle.closed;
      if (this.runningLogin()) { job.status = code === 0 && !handle.failed && observedSuccess ? 'succeeded' : 'failed'; job.detail = job.status === 'succeeded' ? `原生登录已完成。${EFFECT}` : '原生登录未完成，请重试；若已授权请刷新账号列表确认当前状态。'; if (job.status === 'succeeded') { try { await this.options.changed?.(await this.snapshot()); } catch { job.detail += ' 账号已更新，但额度刷新失败，请手动刷新。'; } } }
    } catch { if (job.status !== 'cancelled') { job.status = 'failed'; job.detail = '无法完成原生登录，请检查 OpenCode 安装后重试。'; } }
    finally { if (timer) clearTimeout(timer); if (handle) { try { await this.stop(handle); } catch { job.detail = '无法确认原生登录进程已停止，请重新读取状态。'; } } this.loginProcess = undefined; }
  }
  async switchAccount(value: unknown): Promise<OpenCodeConsoleAccounts> {
    const input = parseOpenCodeSwitch(value);
    if (this.busy || this.loginPending) throw new RpcError('CONFLICT', '账号操作进行中，请等待登录或切换完成。');
    const release = this.options.mutationGuard?.();
    this.busy = true; let switched = false;
    try {
      const helper = await this.helper();
      try {
        const raw = record(await helper.request('/experimental/console/orgs'));
        if (!Array.isArray(raw.orgs)) throw unavailable();
        const orgs = raw.orgs.map(record); const active = orgs.filter(o => o.active === true);
        if (active.length > 1 || (input.expectedActive === null ? active.length !== 0 : active.length !== 1 || active[0].accountID !== input.expectedActive.accountID || active[0].orgID !== input.expectedActive.orgID)) throw new RpcError('CONFLICT', '当前账号已变化，请刷新列表后重新选择。');
        if (!orgs.some(o => o.accountID === input.accountID && o.orgID === input.orgID && typeof o.accountUrl === 'string' && o.accountUrl.replace(/\/+$/, '') === ORIGIN)) throw invalid();
        // Mark the uncertain write boundary before awaiting: a transport error may follow a committed native write.
        switched = true;
        if (await helper.request('/experimental/console/switch', { accountID: input.accountID, orgID: input.orgID }) !== true) throw unavailable();
      } finally { await helper.close(); }
      const snapshot = await this.snapshot();
      if (!snapshot.orgs.some(o => o.active && o.accountID === input.accountID && o.orgID === input.orgID)) throw unavailable();
      try { await this.options.changed?.(snapshot); } catch { snapshot.detail += ' 账号已切换，但额度刷新失败，请手动刷新。'; }
      return snapshot;
    } catch (error) { if (switched) throw new RpcError('OPENCODE_STATE_UNCERTAIN', `原生账号可能已经切换，但复验未完成；请重新读取当前状态。${EFFECT}`); if (error instanceof RpcError) throw error; throw unavailable(); }
    finally { this.busy = false; release?.(); }
  }
  async close(): Promise<void> { this.closing = true; if (this.runningLogin()) { this.login!.status = 'cancelled'; this.login!.detail = '服务关闭，登录已取消；请刷新原生状态。'; } await Promise.all([...this.processes].map(p => this.stop(p))); await this.loginWork; }
}

/** Synchronous launch-time cursor check: IDs only, no account token columns are read. */
export function readOpenCodeActiveRef(env: NodeJS.ProcessEnv = process.env): OpenCodeAccountRef | null {
  const file = openCodeConsoleDbPath(env);
  if (file === ':memory:') throw new Error('内存 OpenCode 数据库无法用于跨进程账号切换。');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT active_account_id, active_org_id FROM account_state WHERE id = 1').get();
    if (!row?.active_account_id || !row.active_org_id) return null;
    return { accountID: id(row.active_account_id), orgID: id(row.active_org_id) };
  } catch { throw new Error('无法确认 OpenCode 当前账号，已阻止账号归因启动。'); }
  finally { db.close(); }
}
