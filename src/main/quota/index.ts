import type { EngineQuotaRecord, QuotaEngine, QuotaRefreshInput, QuotaSnapshot, QuotaStatus } from '../../shared/contracts/quota';
import { QUOTA_FRESH_MS } from '../../shared/contracts/quota';
import { VERSION } from '../../shared/version';
import { QuotaFailure, QuotaRenewalPending, readNativeCredential, type NativeCredential } from './credentials';
import { THIRD_PARTY_DETAIL } from '../../shared/contracts/quota';
import { normalizeUsage, PROVIDERS } from './providers';
import { usesThirdPartyProvider } from './third-party';

const ENGINES: QuotaEngine[] = ['codex', 'claude', 'grok'];
const OBSERVED: QuotaStatus[] = ['available', 'exhausted', 'unknown'];
const MIN_INTERVAL_MS = 60_000;
const MAX_BODY_BYTES = 256 * 1024;

/** What the prober keeps across restarts: the last observation per engine plus its credential and pacing state. */
export interface QuotaPersistence {
  records: Partial<Record<QuotaEngine, EngineQuotaRecord>>;
  fingerprints: Partial<Record<QuotaEngine, string>>;
  lastAccounts: Partial<Record<QuotaEngine, string>>;
  nextRequests: Partial<Record<QuotaEngine, number>>;
}

/** Where the prober persists its snapshot: a DatabaseSync-backed adapter in product, nothing in tests. */
export interface QuotaSnapshotStore { load(): QuotaPersistence | undefined; save(snapshot: QuotaPersistence): void }

/** The weaver.db quota tables: one observation row per engine plus the prober's own pacing keys. */
export function dbQuotaStore(db: import('node:sqlite').DatabaseSync): QuotaSnapshotStore {
  return {
    load(): QuotaPersistence | undefined {
      const records: QuotaPersistence['records'] = {};
      for (const row of db.prepare('SELECT engine,body FROM quota_records').all() as Record<string, unknown>[]) {
        const engine = String(row.engine) as QuotaEngine;
        if (ENGINES.includes(engine)) records[engine] = JSON.parse(String(row.body)) as EngineQuotaRecord;
      }
      const state: QuotaPersistence = { records, fingerprints: {}, lastAccounts: {}, nextRequests: {} };
      for (const row of db.prepare('SELECT key,body FROM quota_state').all() as Record<string, unknown>[]) {
        const key = String(row.key);
        if (!(key in state)) continue;
        Object.assign(state[key as keyof QuotaPersistence] as Record<string, unknown>, JSON.parse(String(row.body)));
      }
      return state;
    },
    save(snapshot: QuotaPersistence): void {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM quota_records');
        const insertRecord = db.prepare('INSERT INTO quota_records(engine,body) VALUES (?,?)');
        for (const [engine, record] of Object.entries(snapshot.records)) if (record) insertRecord.run(engine, JSON.stringify(record));
        db.exec('DELETE FROM quota_state');
        const insertState = db.prepare('INSERT INTO quota_state(key,body) VALUES (?,?)');
        for (const key of ['fingerprints', 'lastAccounts', 'nextRequests'] as const) insertState.run(key, JSON.stringify(snapshot[key]));
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ } throw error; }
    },
  };
}

/** Dependency overrides are internal to the main process and tests, never accepted over RPC. */
export interface QuotaProberOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Restart-durable observations; product passes the weaver.db adapter. */
  snapshotStore?: QuotaSnapshotStore;
}

function initial(engine: QuotaEngine): EngineQuotaRecord {
  return { engine, source: PROVIDERS[engine].source, status: 'unknown', checkedAt: null, observedAt: null, stale: true, windows: [], detail: '尚未探测额度', retryAt: null };
}

function retryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) && ms <= 8640000000000000 - now ? now + ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

export class QuotaProber {
  private readonly records = new Map(ENGINES.map(engine => [engine, initial(engine)]));
  private readonly fingerprints = new Map<QuotaEngine, string>();
  private readonly lastAccounts = new Map<QuotaEngine, string>();
  private readonly nextRequests = new Map<QuotaEngine, number>();
  private readonly inflight = new Map<QuotaEngine, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: () => Date;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly snapshotStore?: QuotaSnapshotStore;
  private closed = false;

  constructor(options: QuotaProberOptions = {}) {
    this.env = options.env ?? process.env;
    this.clock = options.now ?? (() => new Date());
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.max(1, Math.min(8_000, options.timeoutMs ?? 8_000));
    this.snapshotStore = options.snapshotStore;
    const restored = options.snapshotStore?.load();
    if (restored) {
      for (const engine of ENGINES) {
        const record = restored.records[engine];
        if (record) this.records.set(engine, record);
        const fingerprint = restored.fingerprints[engine];
        if (fingerprint !== undefined) this.fingerprints.set(engine, fingerprint);
        const account = restored.lastAccounts[engine];
        if (account !== undefined) this.lastAccounts.set(engine, account);
        const next = restored.nextRequests[engine];
        if (next !== undefined) this.nextRequests.set(engine, next);
      }
    }
  }

  private persist(): void {
    this.snapshotStore?.save({
      records: Object.fromEntries([...this.records].filter(([engine]) => ENGINES.includes(engine))) as QuotaPersistence['records'],
      fingerprints: Object.fromEntries(this.fingerprints) as QuotaPersistence['fingerprints'],
      lastAccounts: Object.fromEntries(this.lastAccounts) as QuotaPersistence['lastAccounts'],
      nextRequests: Object.fromEntries(this.nextRequests) as QuotaPersistence['nextRequests'],
    });
  }

  get(): QuotaSnapshot {
    const now = this.clock().getTime();
    return { records: ENGINES.map(engine => {
      const record = structuredClone(this.records.get(engine)!);
      const measured = record.windows.filter(w => w.scope === 'account' && w.usedPercent !== null);
      const onlyExpiredWindows = record.statusBasis !== 'account_restriction' && measured.length > 0 && measured.every(w => w.resetsAt !== null && Date.parse(w.resetsAt) <= now);
      record.stale ||= !record.observedAt || now - Date.parse(record.observedAt) >= QUOTA_FRESH_MS || onlyExpiredWindows;
      if (record.retryAt && Date.parse(record.retryAt) <= now) record.retryAt = null;
      return record;
    }) };
  }

  async refresh(input: QuotaRefreshInput): Promise<QuotaSnapshot> {
    if (this.closed) throw new Error('额度探测器已关闭');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'engine') || input.engine !== undefined && !ENGINES.includes(input.engine)) throw new Error('额度刷新参数无效');
    await Promise.all((input.engine ? [input.engine] : ENGINES).map(engine => this.refreshOne(engine)));
    return this.get();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.inflight.values());
  }

  private refreshOne(engine: QuotaEngine): Promise<void> {
    const active = this.inflight.get(engine);
    if (active) return active;
    const job = this.execute(engine).finally(() => { if (this.inflight.get(engine) === job) this.inflight.delete(engine); });
    this.inflight.set(engine, job);
    return job;
  }

  private async execute(engine: QuotaEngine): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new QuotaFailure('error', this.closed ? '额度探测已关闭' : '额度接口请求超时')); controller.signal.addEventListener('abort', abort, { once: true }); });
    let fingerprint: string | undefined;
    const started = this.clock().getTime();
    try {
      const result = await Promise.race([this.probe(engine, controller.signal, value => { fingerprint = value; }), interrupted]);
      if (result && !this.closed) { this.records.set(engine, result); this.persist(); }
    } catch (error) {
      if (this.closed) return;
      const failure = error instanceof QuotaFailure ? error : new QuotaFailure('error', '额度接口请求失败');
      const previous = this.records.get(engine)!;
      if (failure.retryAt !== null) this.nextRequests.set(engine, Math.max(this.nextRequests.get(engine) ?? 0, failure.retryAt));
      const cooldown = this.nextRequests.has(engine) ? new Date(this.nextRequests.get(engine)!).toISOString() : null;
      if (failure instanceof QuotaRenewalPending) {
        // The native CLI renews its short-lived access token on the next run, so a lapsed token is a wait, not a logout: keep the same account's last observation as stale.
        const sameAccount = this.lastAccounts.get(engine) === failure.account;
        const observation = sameAccount && OBSERVED.includes(previous.status) ? previous : undefined;
        this.records.set(engine, {
          ...initial(engine), status: observation?.status ?? 'unknown',
          ...(observation?.statusBasis ? { statusBasis: observation.statusBasis } : {}),
          checkedAt: new Date(started).toISOString(),
          observedAt: sameAccount ? previous.observedAt : null,
          windows: sameAccount ? previous.windows : [], stale: true, detail: observation?.detail ?? '', retryAt: cooldown,
        });
        this.persist();
        return;
      }
      const sameCredential = fingerprint !== undefined && fingerprint === this.fingerprints.get(engine);
      this.records.set(engine, {
        ...initial(engine), status: failure.status, checkedAt: new Date(started).toISOString(),
        observedAt: sameCredential ? previous.observedAt : null,
        windows: sameCredential ? previous.windows : [], stale: true, detail: failure.message,
        retryAt: cooldown,
      });
      this.persist();
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }

  private async probe(engine: QuotaEngine, signal: AbortSignal, identify: (fingerprint: string) => void): Promise<EngineQuotaRecord | undefined> {
    const now = this.clock().getTime();
    // The native endpoint reports the subscription, not the provider the CLI is actually switched to; do not read or show it.
    if (await usesThirdPartyProvider(engine, this.env)) throw new QuotaFailure('unsupported', THIRD_PARTY_DETAIL);
    const credential = await readNativeCredential(engine, this.env, now);
    identify(credential.fingerprint);
    if (signal.aborted || this.closed) throw new QuotaFailure('error', '额度探测已取消');
    this.lastAccounts.set(engine, credential.account);
    if (this.fingerprints.get(engine) !== credential.fingerprint) {
      this.records.set(engine, initial(engine));
      this.fingerprints.set(engine, credential.fingerprint);
    }
    this.persist();
    const next = this.nextRequests.get(engine) ?? 0;
    if (next > now) {
      const record = this.records.get(engine)!;
      record.retryAt = new Date(next).toISOString();
      return undefined;
    }
    this.nextRequests.set(engine, now + MIN_INTERVAL_MS);
    this.persist();
    const payload = await this.request(engine, credential, signal);
    if (signal.aborted || this.closed) throw new QuotaFailure('error', '额度探测已取消');
    const checkedAt = this.clock().toISOString();
    const measurement = normalizeUsage(engine, payload, this.clock().getTime());
    // Supplier-controlled model/product strings must not echo a known native credential.
    const secrets = [credential.token, credential.accountId].filter((value): value is string => !!value);
    measurement.windows = measurement.windows.map((row, index) => row.model && secrets.some(secret => row.model!.includes(secret)) || secrets.some(secret => row.label.includes(secret))
      ? { ...row, id: `${engine}:redacted:${index}`, label: '额度窗口', scope: row.scope === 'model' ? 'unknown' : row.scope, model: null }
      : row);
    return { engine, source: PROVIDERS[engine].source, ...measurement, checkedAt, observedAt: checkedAt, stale: false, retryAt: new Date(this.nextRequests.get(engine)!).toISOString() };
  }

  private async request(engine: QuotaEngine, credential: NativeCredential, signal: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${credential.token}`, Accept: 'application/json', 'User-Agent': `Weaver/${VERSION}` };
    if (engine === 'codex') headers['ChatGPT-Account-Id'] = credential.accountId!;
    if (engine === 'claude') headers['anthropic-beta'] = 'oauth-2025-04-20';
    if (engine === 'grok') headers['x-xai-token-auth'] = 'xai-grok-cli';
    const response = await this.fetcher(PROVIDERS[engine].url, { method: 'GET', headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    if (response.redirected) { void response.body?.cancel().catch(() => undefined); throw new QuotaFailure('error', '额度接口拒绝重定向'); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) throw new QuotaFailure('unauthenticated', '原生登录无效或无权读取额度，请在对应工具中确认登录');
      if (response.status === 429) throw new QuotaFailure('error', '额度探测接口限流，请稍后重试', retryAfter(response.headers.get('Retry-After'), this.clock().getTime()));
      throw new QuotaFailure('error', '额度接口暂时不可用');
    }
    const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (!contentType || contentType !== 'application/json' && !contentType.endsWith('+json')) { void response.body?.cancel().catch(() => undefined); throw new QuotaFailure('error', '额度接口返回了非 JSON 数据'); }
    const reader = response.body?.getReader();
    if (!reader) throw new QuotaFailure('error', '额度接口没有返回数据');
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) throw new QuotaFailure('error', '额度响应超过大小限制');
        chunks.push(value);
      }
      try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch { throw new QuotaFailure('error', '额度接口返回了无效 JSON'); }
    } finally { signal.removeEventListener('abort', cancel); cancel(); }
  }
}
