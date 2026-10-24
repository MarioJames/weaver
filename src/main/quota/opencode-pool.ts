import { createHash } from 'node:crypto';
import type { OpenCodeConsoleAccounts, OpenCodeConsoleOrg } from '../../shared/contracts/opencode-accounts';
import type { OpenCodeAccountQuota, OpenCodeAccountQuotas, OpenCodeAccountRef } from '../../shared/contracts/opencode-account-quotas';
import { QUOTA_FRESH_MS } from '../../shared/contracts/quota';
import { nextVendorStep } from '../monitors/ladder';
import type { OpenCodePoolPersistence, OpenCodePoolSavedAccount } from '../storage/opencode-account-pool';
import { QuotaProber } from './index';
import { OPENCODE_CONSOLE_ORIGIN, openCodeConsoleDbPath, readOpenCodeConsoleAccount } from './opencode-console';
import { QuotaFailure, readNativeCredential } from './credentials';

export interface OpenCodeQuotaPoolOptions {
  env?: NodeJS.ProcessEnv;
  accounts: { list(): Promise<OpenCodeConsoleAccounts> };
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  persistence?: OpenCodePoolPersistence;
}
interface Entry extends OpenCodePoolSavedAccount { prober: QuotaProber; restored: boolean; present: boolean; credentialFingerprint?: string; credentialExpiry?: number | null; managedFingerprint?: string; inflight?: Promise<void> }
const validID = (value: unknown): value is string => typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,256}$/.test(value);
const same = (a: OpenCodeAccountRef | null | undefined, b: OpenCodeAccountRef | null | undefined) => !!a && !!b && a.accountID === b.accountID && a.orgID === b.orgID;
const safeOrg = (account: OpenCodeConsoleOrg): boolean => validID(account.accountID) && validID(account.orgID) && account.accountUrl.replace(/\/+$/, '') === OPENCODE_CONSOLE_ORIGIN;

/** One native account cursor, independent quota observations. This service never switches or writes native data. */
export class OpenCodeQuotaPool {
  private readonly entries = new Map<string, Entry>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private active: OpenCodeAccountRef | null = null;
  private switching = false;
  private detail?: string;
  private closed = false;
  private listing?: Promise<OpenCodeConsoleAccounts>;
  private readonly refreshes = new Set<Promise<OpenCodeAccountQuotas>>();
  private readonly refreshStop = new AbortController();
  private closeWork?: Promise<void>;
  private slots = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly options: OpenCodeQuotaPoolOptions) {
    this.env = { ...(options.env ?? process.env) };
    this.now = options.now ?? (() => new Date());
    const saved = options.persistence?.load();
    for (const row of saved?.accounts ?? []) {
      if (!row || !safeOrg(row.account) || row.key !== this.key(row.account)) continue;
      this.add(row.account, row);
    }
  }
  private key(ref: OpenCodeAccountRef): string {
    return createHash('sha256').update(JSON.stringify([openCodeConsoleDbPath(this.env), OPENCODE_CONSOLE_ORIGIN, ref.accountID, ref.orgID])).digest('hex');
  }
  private add(account: OpenCodeConsoleOrg, saved?: OpenCodePoolSavedAccount): Entry {
    const key = this.key(account);
    const entry: Entry = {
      key, account: { ...account }, probe: saved?.probe,
      goReady: saved?.goReady ?? false, managedAt: saved?.managedAt ?? 0, configNext: saved?.configNext ?? 0,
      failure: saved?.failure, seenRuns: saved?.seenRuns ?? [], ladder: saved?.ladder,
      restored: true, present: false, prober: undefined!,
    };
    entry.prober = new QuotaProber({
      env: this.env, now: this.now, fetch: this.options.fetch,
      credentialResolver: async (engine, env, now) => {
        if (engine !== 'opencode') return readNativeCredential(engine, env, now);
        if (!entry.present) throw new QuotaFailure('unsupported', '账号组织尚未经原生列表验证');
        const credential = readOpenCodeConsoleAccount(env, now, account.accountID, account.orgID);
        entry.credentialFingerprint = credential.fingerprint;
        entry.credentialExpiry = credential.expiresAt;
        return { ...credential, opencodeKind: 'console', orgId: account.orgID };
      },
      snapshotStore: {
        load: () => entry.probe,
        save: state => { entry.probe = state; this.persist(); },
      },
    });
    this.entries.set(key, entry);
    return entry;
  }
  private persist(): void {
    if (this.closed) return;
    this.options.persistence?.save({ accounts: [...this.entries.values()].map(({ key, account, probe, goReady, managedAt, configNext, failure, seenRuns, ladder }) => ({ key, account, probe, goReady, managedAt, configNext, failure, seenRuns, ladder })) });
  }
  private view(entry: Entry): OpenCodeAccountQuota {
    const now = this.now().getTime();
    const quota = entry.prober.get().records.find(record => record.engine === 'opencode')!;
    quota.stale ||= entry.restored || !entry.present;
    const failure = entry.failure;
    if (failure) {
      quota.stale = true;
      quota.status = failure.kind === 'quota' ? 'exhausted' : failure.kind === 'auth' ? 'unauthenticated' : quota.status;
      quota.detail = failure.kind === 'quota' ? '该账号已报告额度耗尽，等待重新探测确认恢复' : failure.kind === 'auth' ? '该账号认证失败，等待原生登录更新后重新探测' : '该账号已报告限流，等待冷却后重新探测';
    }
    return {
      account: { ...entry.account, active: same(entry.account, this.active) }, quota,
      goReady: entry.present && !entry.restored && entry.goReady && entry.managedFingerprint !== undefined && entry.managedFingerprint === entry.credentialFingerprint && typeof entry.credentialExpiry === 'number' && entry.credentialExpiry > now + 5000 && now - entry.managedAt < QUOTA_FRESH_MS,
      cooldownUntil: failure && failure.until > now ? new Date(failure.until).toISOString() : null,
    };
  }
  /** Pure cached projection: never launches a helper, reads credentials or accesses the network. */
  get(): OpenCodeAccountQuotas {
    return structuredClone({ accounts: [...this.entries.values()].map(entry => this.view(entry)), active: this.active, switching: this.switching, ...(this.detail ? { detail: this.detail } : {}) });
  }
  setSwitching(value: boolean, detail?: string): void { this.switching = value; this.detail = detail; }
  setActive(ref: OpenCodeAccountRef | null): void {
    if (ref && (!validID(ref.accountID) || !validID(ref.orgID))) throw new Error('OpenCode 账号参数无效');
    this.active = ref ? { accountID: ref.accountID, orgID: ref.orgID } : null;
  }
  candidate(excludingRef?: OpenCodeAccountRef): OpenCodeAccountQuota | undefined {
    for (const entry of this.entries.values()) {
      if (entry.failure || same(entry.account, excludingRef)) continue;
      const item = this.view(entry);
      if (item.goReady && !item.quota.stale && item.quota.status === 'available' && !item.cooldownUntil) return structuredClone(item);
    }
    return undefined;
  }
  hasFailure(ref: OpenCodeAccountRef): boolean {
    return !!this.entries.get(this.key(ref))?.failure;
  }
  recordFailure(ref: OpenCodeAccountRef, failure: { kind: 'quota' | 'rate_limit' | 'auth'; runID: string; retryAt?: string }): void {
    if (this.closed) throw new Error('OpenCode 额度池已关闭');
    if (!validID(ref.accountID) || !validID(ref.orgID) || !validID(failure.runID) || !['quota', 'rate_limit', 'auth'].includes(failure.kind)) throw new Error('OpenCode 账号失败参数无效');
    const entry = this.entries.get(this.key(ref));
    if (!entry) throw new Error('OpenCode 账号未在额度池中');
    if (entry.seenRuns.includes(failure.runID)) return;
    const previous = { failure: entry.failure, seenRuns: [...entry.seenRuns], ladder: entry.ladder };
    const now = this.now().getTime();
    const retry = failure.retryAt ? Date.parse(failure.retryAt) : NaN;
    let until = now + 60_000;
    if (failure.kind === 'rate_limit') {
      const step = nextVendorStep(entry.ladder, now);
      entry.ladder = { level: step.level, lastTriggerAt: now };
      until = now + step.minutes * 60_000;
    }
    if (Number.isFinite(retry) && retry > until) until = retry;
    entry.failure = { kind: failure.kind, at: now, until, revision: (entry.failure?.revision ?? 0) + 1 };
    entry.seenRuns.push(failure.runID);
    try { this.persist(); }
    catch (error) {
      entry.failure = previous.failure; entry.seenRuns = previous.seenRuns; entry.ladder = previous.ladder;
      throw error;
    }
  }
  refresh(input: { accountID?: string; orgID?: string } = {}): Promise<OpenCodeAccountQuotas> {
    const job = this.executeRefresh(input);
    this.refreshes.add(job);
    void job.then(() => this.refreshes.delete(job), () => this.refreshes.delete(job));
    return job;
  }
  /** Cancellation detaches a non-cooperative native list; its owner still closes the helper. */
  private waitListing(listing: Promise<OpenCodeConsoleAccounts>): Promise<OpenCodeConsoleAccounts> {
    const signal = this.refreshStop.signal;
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('OpenCode 额度池已关闭')); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      listing.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  private async executeRefresh(input: { accountID?: string; orgID?: string }): Promise<OpenCodeAccountQuotas> {
    if (this.closed) throw new Error('OpenCode 额度池已关闭');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['accountID', 'orgID'].includes(key)) ||
      (input.accountID !== undefined || input.orgID !== undefined) && (!validID(input.accountID) || !validID(input.orgID))) throw new Error('OpenCode 额度刷新参数无效');
    try {
      if (!this.listing) this.listing = this.options.accounts.list().finally(() => { this.listing = undefined; });
      const listed = await this.waitListing(this.listing);
      if (this.closed) return this.get();
      const orgs = listed.orgs.filter(safeOrg);
      const active = orgs.filter(org => org.active);
      this.active = active.length === 1 ? { accountID: active[0].accountID, orgID: active[0].orgID } : null;
      for (const entry of this.entries.values()) entry.present = false;
      for (const account of orgs) {
        const entry = this.entries.get(this.key(account)) ?? this.add(account);
        entry.account = { ...account }; entry.present = true;
      }
      const targets = [...this.entries.values()].filter(entry => entry.present && (!input.accountID || same(entry.account, input as OpenCodeAccountRef)));
      if (input.accountID && targets.length !== 1) throw new Error('OpenCode 账号组织不在原生列表中');
      await Promise.all(targets.map(entry => this.refreshEntry(entry)));
      this.detail = listed.detail;
      this.persist();
      return this.get();
    } catch {
      if (this.closed) return this.get();
      for (const entry of this.entries.values()) { entry.present = false; entry.goReady = false; }
      this.detail = '无法确认原生账号列表或额度，保留历史观测等待重试';
      this.persist();
      return this.get();
    }
  }
  private refreshEntry(entry: Entry): Promise<void> {
    if (entry.inflight) return entry.inflight;
    const job = this.execute(entry).finally(() => { if (entry.inflight === job) entry.inflight = undefined; });
    entry.inflight = job;
    return job;
  }
  private async execute(entry: Entry): Promise<void> {
    if (this.slots >= 3) await new Promise<void>(resolve => this.waiters.push(resolve));
    else this.slots++;
    try {
      if (this.closed) return;
      const now = this.now().getTime();
      if (entry.failure && entry.failure.until > now) return;
      const failure = entry.failure;
      const before = entry.prober.get().records.find(record => record.engine === 'opencode')!.observedAt;
      const snapshot = await entry.prober.refresh({ engine: 'opencode' });
      if (this.closed) return;
      const quota = snapshot.records.find(record => record.engine === 'opencode')!;
      const observed = quota.observedAt ? Date.parse(quota.observedAt) : 0;
      const measured = !quota.stale && quota.observedAt !== before;
      if (measured) entry.restored = false;
      if (!quota.stale && now >= entry.configNext) {
        entry.configNext = now + 60_000;
        entry.goReady = await entry.prober.consoleGoReady();
        const retryAt = entry.prober.get().records.find(record => record.engine === 'opencode')!.retryAt;
        if (retryAt) entry.configNext = Math.max(entry.configNext, Date.parse(retryAt) || 0);
        entry.managedAt = this.now().getTime();
        entry.managedFingerprint = entry.goReady ? entry.credentialFingerprint : undefined;
      } else if (quota.stale) entry.goReady = false;
      if (failure && entry.failure === failure && measured && observed > failure.at && quota.status === 'available' && entry.goReady) delete entry.failure;
      this.persist();
    } finally {
      const waiter = this.waiters.shift();
      if (waiter) waiter(); else this.slots--;
    }
  }
  async close(): Promise<void> {
    if (!this.closeWork) {
      this.closed = true;
      this.refreshStop.abort();
      this.closeWork = (async () => {
        await Promise.allSettled([...this.entries.values()].map(entry => entry.prober.close()));
        await Promise.allSettled([...this.refreshes]);
      })();
    }
    await this.closeWork;
  }
}
