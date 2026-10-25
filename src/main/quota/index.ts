import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareChannelRun, cleanupChannelRun, type ChannelBinding } from '../channels/runtime';
import type { EngineQuotaRecord, QuotaEngine, QuotaRefreshInput, QuotaSnapshot, QuotaStatus } from '../../shared/contracts/quota';
import { QUOTA_FRESH_MS } from '../../shared/contracts/quota';
import { VERSION } from '../../shared/version';
import { QuotaFailure, QuotaRenewalPending, object, readNativeCredential, type NativeCredential } from './credentials';
import { THIRD_PARTY_DETAIL } from '../../shared/contracts/quota';
import { normalizeConsoleStatus, normalizeUsage, PROVIDERS } from './providers';
import { OPENCODE_CONSOLE_ORIGIN } from './opencode-console';
import { usesThirdPartyProvider } from './third-party';
import { QUOTA_ENGINES as ENGINES } from '../domain/quota-engines';
import type { QuotaPersistence, QuotaSnapshotStore } from '../storage/quota-snapshot';

const OBSERVED: QuotaStatus[] = ['available', 'exhausted', 'unknown'];
const MIN_INTERVAL_MS = 60_000;
const MAX_BODY_BYTES = 256 * 1024;

/** Dependency overrides are internal to the main process and tests, never accepted over RPC. */
export interface QuotaProberOptions {
  channels?: () => Record<string, ChannelBinding>;
  root?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Restart-durable observations; product passes the weaver.db adapter. */
  snapshotStore?: QuotaSnapshotStore;
  /** Trusted main-process selection only; never exposed over RPC. */
  credentialResolver?: (engine: QuotaEngine, env: NodeJS.ProcessEnv, now: number) => Promise<NativeCredential>;
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
  private readonly channelFailures = new Map<string, EngineQuotaRecord>();
  private readonly channelProbers = new Map<string, {signature:string;prober:QuotaProber;root:string;cleanup:()=>void}>();
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
  private invalidationRevision = 0;

  constructor(private readonly options: QuotaProberOptions = {}) {
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

  /** Invalidate the account's observation and abort old HTTP work before it can restore a positive. */
  invalidateChannel(id:string):void {
    const cached=this.channelProbers.get(id);
    if(cached)cached.prober.invalidate();
    const binding=this.options.channels?.()[id];
    if(!binding)return;
    const engine=(binding.engineKind??binding.channel.engine) as QuotaEngine;
    const record={...initial(engine),channel:id,status:'error' as const,stale:true,detail:'账号认证失败，请刷新认证后重新获取额度'};
    this.channelFailures.set(id,record);
    const scoped=this.snapshotStore?.scope?.(id);const saved=scoped?.load();
    if(saved){saved.records[engine]=record;scoped?.save(saved);}
  }
  private invalidate():void {
    this.invalidationRevision++;
    for(const controller of this.controllers)controller.abort();
    for(const engine of ENGINES){const previous=this.records.get(engine)!;this.records.set(engine,{...previous,status:'error',stale:true});}
    this.persist();
  }

  get(): QuotaSnapshot {
    if (this.options.channels) return {records:Object.entries(this.options.channels()).map(([id,binding])=>{
      const kind=(binding.engineKind??binding.channel.engine) as QuotaEngine;
      const existing=this.channelFailures.get(id)??this.channelProbers.get(id)?.prober.get().records.find(record=>record.engine===kind)??this.options.snapshotStore?.scope?.(id).load()?.records[kind];
      const record:EngineQuotaRecord = {...(existing??{...initial((ENGINES.includes(binding.channel.engine as QuotaEngine)?binding.channel.engine:'codex') as QuotaEngine),engine:binding.channel.engine as QuotaEngine}),engine:kind,channel:id,...((binding.channel.kind==='api'||!ENGINES.includes(kind))?{source:'',status:'unsupported' as const,detail:binding.channel.kind==='api'?'API 渠道没有官方订阅额度接口':'该引擎没有可用的官方额度接口',stale:true,windows:[]}: {})};
      const measured=record.windows.filter(window=>window.scope==='account'&&window.usedPercent!==null);
      record.stale ||= !record.observedAt||this.clock().getTime()-Date.parse(record.observedAt)>=QUOTA_FRESH_MS||record.statusBasis!=='account_restriction'&&measured.length>0&&measured.every(window=>window.resetsAt!==null&&Date.parse(window.resetsAt)<=this.clock().getTime());
      if(record.retryAt&&Date.parse(record.retryAt)<=this.clock().getTime())record.retryAt=null;
      return record;
    })};
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
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'engine' && key !== 'channel') || input.engine !== undefined && !ENGINES.includes(input.engine)) throw new Error('额度刷新参数无效');
    if (this.options.channels) {
      const bindings=this.options.channels();
      if(input.channel&&!Object.hasOwn(bindings,input.channel)) throw new Error('额度渠道不存在');
      await Promise.all(Object.entries(bindings).filter(([id,binding])=>(!input.channel||input.channel===id)&&(!input.engine||input.engine===binding.channel.engine)).map(async ([id,binding])=>{
        if(!binding.channel.enabled||binding.channel.kind==='api'||!ENGINES.includes((binding.engineKind??binding.channel.engine) as QuotaEngine))return;
        const signature=createHash('sha256').update(JSON.stringify(binding)).digest('hex');
        let cached=this.channelProbers.get(id);
        if(cached?.signature!==signature){
          if(cached){await cached.prober.close();cached.cleanup();rmSync(cached.root,{recursive:true,force:true});}
          if(!this.options.root)throw new Error('渠道额度服务缺少独立临时根');
          mkdirSync(this.options.root,{recursive:true,mode:0o700});const root=mkdtempSync(join(this.options.root,'quota-'));
          try {const runtime=prepareChannelRun({...binding,model:'quota',stateDir:root,env:this.env});cached={signature,root,cleanup:()=>cleanupChannelRun(runtime),prober:new QuotaProber({...this.options,channels:undefined,snapshotStore:this.options.snapshotStore?.scope?.(id),env:runtime.env})};this.channelProbers.set(id,cached);}catch(error){rmSync(root,{recursive:true,force:true});this.channelProbers.delete(id);this.channelFailures.set(id,{...initial((binding.engineKind??binding.channel.engine) as QuotaEngine),channel:id,status:'unauthenticated',checkedAt:this.clock().toISOString(),detail:error instanceof Error?error.message:'渠道认证配置不可用'});return;}
        }
        this.channelFailures.delete(id);
        await cached!.prober.refresh({engine:(binding.engineKind??binding.channel.engine) as QuotaEngine});
      }));
      return this.get();
    }
    if(input.channel)throw new Error('渠道额度服务尚未接线');
    await Promise.all((input.engine ? [input.engine] : ENGINES).map(engine => this.refreshOne(engine)));
    return this.get();
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.channelProbers.values()].map(async cached=>{await cached.prober.close();cached.cleanup();rmSync(cached.root,{recursive:true,force:true});}));
    this.channelProbers.clear();
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
    const revision=this.invalidationRevision;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new QuotaFailure('error', this.closed ? '额度探测已关闭' : '额度接口请求超时')); controller.signal.addEventListener('abort', abort, { once: true }); });
    let fingerprint: string | undefined;
    let kind: 'console' | 'api' | undefined;
    const started = this.clock().getTime();
    try {
      const result = await Promise.race([this.probe(engine, controller.signal, (value, probedKind) => { fingerprint = value; kind = probedKind; }), interrupted]);
      if (result && !this.closed && revision===this.invalidationRevision) { this.records.set(engine, result); this.persist(); }
    } catch (error) {
      if (this.closed || revision!==this.invalidationRevision) return;
      const failure = error instanceof QuotaFailure ? error : new QuotaFailure('error', '额度接口请求失败');
      const previous = this.records.get(engine)!;
      if (failure.retryAt !== null) this.nextRequests.set(engine, Math.max(this.nextRequests.get(engine) ?? 0, failure.retryAt));
      const cooldown = this.nextRequests.has(engine) ? new Date(this.nextRequests.get(engine)!).toISOString() : null;
      if (failure instanceof QuotaRenewalPending) {
        // The native CLI renews its short-lived access token on the next run, so a lapsed token is a wait, not a logout: keep the same account's last observation as stale.
        const sameAccount = this.lastAccounts.get(engine) === failure.account;
        const observation = sameAccount && OBSERVED.includes(previous.status) ? previous : undefined;
        this.records.set(engine, {
          // Retaining the same account's observation keeps its real source too.
          ...initial(engine), source: sameAccount ? previous.source : initial(engine).source, status: observation?.status ?? 'unknown',
          ...(observation?.statusBasis ? { statusBasis: observation.statusBasis } : {}),
          checkedAt: new Date(started).toISOString(),
          observedAt: sameAccount ? previous.observedAt : null,
          windows: sameAccount ? previous.windows : [], stale: true, detail: observation?.detail ?? failure.message, retryAt: cooldown,
        });
        this.persist();
        return;
      }
      const sameCredential = fingerprint !== undefined && fingerprint === this.fingerprints.get(engine);
      // A stale retention keeps the real source of the observation; an identified
      // credential labels even its first failure with the correct source.
      const identified = engine === 'opencode' && kind !== undefined
        ? kind === 'console' ? PROVIDERS.opencodeConsole.source : PROVIDERS.opencode.source
        : undefined;
      this.records.set(engine, {
        ...initial(engine), source: identified ?? (sameCredential ? previous.source : initial(engine).source), status: failure.status, checkedAt: new Date(started).toISOString(),
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

  private async probe(engine: QuotaEngine, signal: AbortSignal, identify: (fingerprint: string, opencodeKind?: 'console' | 'api') => void): Promise<EngineQuotaRecord | undefined> {
    const now = this.clock().getTime();
    // The native endpoint reports the subscription, not the provider the CLI is actually switched to; do not read or show it.
    if (await usesThirdPartyProvider(engine, this.env)) throw new QuotaFailure('unsupported', THIRD_PARTY_DETAIL);
    const credential = await (this.options.credentialResolver ?? readNativeCredential)(engine, this.env, now);
    identify(credential.fingerprint, credential.opencodeKind);
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
    const isConsole = engine === 'opencode' && credential.opencodeKind === 'console';
    const measurement = isConsole ? normalizeConsoleStatus(payload) : normalizeUsage(engine, payload, this.clock().getTime());
    // Supplier-controlled model/product strings must not echo a known native credential.
    const secrets = [credential.token, credential.accountId, credential.orgId].filter((value): value is string => !!value);
    measurement.windows = measurement.windows.map((row, index) => row.model && secrets.some(secret => row.model!.includes(secret)) || secrets.some(secret => row.label.includes(secret))
      ? { ...row, id: `${engine}:redacted:${index}`, label: '额度窗口', scope: row.scope === 'model' ? 'unknown' : row.scope, model: null }
      : row);
    const source = isConsole ? PROVIDERS.opencodeConsole.source : PROVIDERS[engine].source;
    return { engine, source, ...measurement, checkedAt, observedAt: checkedAt, stale: false, retryAt: new Date(this.nextRequests.get(engine)!).toISOString() };
  }

  /** Uses the same bounded trusted HTTP boundary as quota; only a boolean leaves this method. */
  async consoleGoReady(): Promise<boolean> {
    if (this.closed) return false;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new QuotaFailure('error', 'Console 配置读取已取消'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const work = async () => {
        const credential = await (this.options.credentialResolver ?? readNativeCredential)('opencode', this.env, this.clock().getTime());
        if (controller.signal.aborted || this.closed || credential.opencodeKind !== 'console' || credential.origin !== OPENCODE_CONSOLE_ORIGIN || !credential.orgId) return false;
        const response = await this.fetchResponse(`${OPENCODE_CONSOLE_ORIGIN}/api/config`, {
          Authorization: `Bearer ${credential.token}`, 'x-org-id': credential.orgId, Accept: 'application/json', 'User-Agent': `Weaver/${VERSION}`,
        }, controller.signal);
        if (!response.ok) throw this.statusFailure(response, '原生 Console 配置无法读取', true);
        const payload = object(await this.readJson(response, controller.signal));
        const config = object(payload?.config);
        const provider = object(object(config?.provider)?.['opencode-go']);
        const key = object(provider?.options)?.apiKey;
        // Native SDK uses options.apiKey before auth.json. Other shapes are unverified.
        return typeof key === 'string' && key.length > 0 && key.length <= 16384 && !['public', 'opencode-oauth-dummy-key'].includes(key) && !/[\s\x00-\x1f\x7f]/.test(key) && !key.includes('{env:');
      };
      return await Promise.race([work(), interrupted]);
    } catch (error) {
      if (error instanceof QuotaFailure && error.retryAt !== null) {
        this.nextRequests.set('opencode', Math.max(this.nextRequests.get('opencode') ?? 0, error.retryAt));
        const record = this.records.get('opencode')!;
        record.retryAt = new Date(this.nextRequests.get('opencode')!).toISOString();
        this.persist();
      }
      return false;
    }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); this.controllers.delete(controller); }
  }

  /**
   * Only a bounded official EntitlementError marks OpenCode unsupported (valid key without a
   * Go subscription). Any other 403 (edge/WAF, oversized or non-JSON body) stays a plain error.
   * Body text never surfaces in the record.
   */
  private async isEntitlementError(response: Response, signal: AbortSignal): Promise<boolean> {
    const reader = response.body?.getReader();
    if (!reader) return false;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) return false;
        chunks.push(value);
      }
      const payload = object(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      return object(payload?.error)?.type === 'EntitlementError';
    } catch { return false; }
    finally { signal.removeEventListener('abort', cancel); cancel(); }
  }

  private async request(engine: QuotaEngine, credential: NativeCredential, signal: AbortSignal): Promise<unknown> {
    const isConsole = engine === 'opencode' && credential.opencodeKind === 'console';
    if (isConsole) return this.requestConsole(credential, signal);
    const headers: Record<string, string> = { Authorization: `Bearer ${credential.token}`, Accept: 'application/json', 'User-Agent': `Weaver/${VERSION}` };
    if (engine === 'codex') headers['ChatGPT-Account-Id'] = credential.accountId!;
    if (engine === 'claude') headers['anthropic-beta'] = 'oauth-2025-04-20';
    if (engine === 'grok') headers['x-xai-token-auth'] = 'xai-grok-cli';
    const response = await this.fetchResponse(PROVIDERS[engine].url, headers, signal);
    if (engine === 'opencode' && response.status === 403) {
      if (await this.isEntitlementError(response, signal)) throw new QuotaFailure('unsupported', '当前 key 没有 Go 订阅，无法读取 Go 套餐窗口；免费模型与按量余额没有官方只读额度接口');
      throw new QuotaFailure('error', '额度接口暂时不可用');
    }
    if (!response.ok) {
      throw this.statusFailure(response, '原生登录无效或无权读取额度，请在对应工具中确认登录');
    }
    return this.readJson(response, signal);
  }

  /**
   * Active Console login only: the token is sent solely to its own verified origin
   * (fixed official https://opencode.ai/console) at /api/go/status, never to the
   * public default host, never with cookies, never following redirects. A 401 is a
   * local login problem, a 403 is a scope/permission problem; neither falls back to
   * another cached account or key. Error bodies never surface in the record.
   */
  private async requestConsole(credential: NativeCredential, signal: AbortSignal): Promise<unknown> {
    if (credential.origin !== OPENCODE_CONSOLE_ORIGIN || !credential.orgId) {
      throw new QuotaFailure('unsupported', '原生 Console 登录来源不受支持，不会发送凭据');
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.token}`,
      'x-org-id': credential.orgId,
      'User-Agent': `Weaver/${VERSION}`,
      Accept: 'application/json',
    };
    const response = await this.fetchResponse(PROVIDERS.opencodeConsole.url, headers, signal);
    if (!response.ok) {
      throw this.statusFailure(response, '原生 Console 登录无效，请在 OpenCode 中重新登录后手动刷新', true);
    }
    return this.readJson(response, signal);
  }

  /** Single shared GET path for every trusted native source; source-specific URL/headers/status semantics stay with the callers. */
  private async fetchResponse(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    const response = await this.fetcher(url, { method: 'GET', headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    if (response.redirected) { void response.body?.cancel().catch(() => undefined); throw new QuotaFailure('error', '额度接口拒绝重定向'); }
    return response;
  }

  private statusFailure(response: Response, authDetail: string, consoleScope = false): QuotaFailure {
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new QuotaFailure('unauthenticated', authDetail);
    if (response.status === 403) {
      throw consoleScope
        ? new QuotaFailure('unsupported', '当前 Console 登录无 Go 额度读取权限；免费模型与按量余额没有官方只读额度接口')
        : new QuotaFailure('unauthenticated', authDetail);
    }
    if (response.status === 429) throw new QuotaFailure('error', '额度探测接口限流，请稍后重试', retryAfter(response.headers.get('Retry-After'), this.clock().getTime()));
    throw new QuotaFailure('error', '额度接口暂时不可用');
  }

  private async readJson(response: Response, signal: AbortSignal): Promise<unknown> {
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
