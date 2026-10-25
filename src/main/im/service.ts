import { join } from 'node:path';
import { roleEngine } from '../../shared/policy/channels';
import type { ChannelBinding } from '../channels/runtime';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveImWorkspaces } from './workspaces';
import type { PolicySnapshot } from '../../shared/contracts/policy';
import type { ImOwnerProfileOption, ImSettingsSnapshot, ImStatus, SaveImSettingsInput } from '../../shared/contracts/im';
import { OWNER_HOST_KINDS } from '../owner-host';
import { isImEngineKind, imEngineEffortAllowed, type ImEngineKind } from '../../shared/im-engines';
import { activeBlocks, availabilityOf } from '../../shared/policy/availability';
import type { NormalizedMessage, CardActionEvent } from '@larksuite/channel';
import { ImSettingsStore, publicImConfig, type StoredImConfig } from './settings';
import { ImInbox } from './inbox';
import { createBackgroundParentAgent } from './parent-background';
import { ConfirmedParentCancellation, ParentTurnNotSubmitted, ParentAgentError, type ParentAgentFactory, type ParentAgentSession, type ParentAgentFailureReason, type ParentAgentInput } from './parent-agent';
import { createImChannel, type ImChannelFactory, type ImChannel, type Delivery } from './channel';
import { ImBootstrapBudgetError, imInstructions } from './bootstrap';
import { extractInboundText } from './inbound';
import { PublicDeltaFilter, parseReply, replyCard, REPLY_BYTES, actionIdentity } from './cards';
import { createProgressBatchState, reduceProgressBatch } from './progress';
import { Keepalive, type KeepaliveTimers } from './keepalive';
import type { ParentProgressEvent } from './parent-agent';

const SAFE = 'IM 操作失败，请检查配置或重新连接。';
const TURN_FAIL_NOTICE = '本轮回复失败，未自动重新执行。请发送新消息重试。';
/** Fixed safe texts: no underlying errors, no paths, no user input echoes. */
const PERSIST_NOTICE = '消息已收到，但本地记录写入失败，未执行。请稍后重新发送。';
const CARD_PERSIST_TOAST = '操作已收到，但本地记录写入失败，请稍后重试。';
const WAIT_ACK_NOTICE = '已收到，旧会话正在收尾，新上下文将处理这条消息。';
const WAIT_FAIL_NOTICE = '旧会话关闭未完成，这条消息未能执行，也不会重复执行。请稍后重试。';
const STOP_READY_NOTICE = '当前没有正在生成的回复。';
const STOP_NOTICE = '已停止当前回复。已派发任务继续由 Weaver 管理。';
const ACTION_PERSIST_NOTICE = '操作已收到，但本地记录写入失败，未执行。请稍后重试。';
const RESET_FAIL_NOTICE = '会话切换未完成，请检查 Agent 状态或稍后重试。已派发任务继续运行。';
/** Fixed actionable agent errors: only the classified reason selects a text, never vendor output. */
const MISSING_BINARY_MESSAGE = 'Bot 引擎缺失，请安装对应 CLI 后重新连接。';
const AUTH_MESSAGE = 'Bot 引擎认证失败，请检查登录或密钥后重新连接。';
const PROTOCOL_MESSAGE = 'Bot 与引擎协议不兼容，请升级引擎后重新连接。';
const OWNER_PROFILE_MESSAGE = '所选调度主引擎不存在、已停用或无法作为父 Agent 启动，请改选或使用自动。';
export class ImServiceError extends Error {
  constructor(readonly code: string) {
    super(code === 'IM_BOOTSTRAP_TOO_LARGE' ? new ImBootstrapBudgetError().message : code === 'IM_OWNER_PROFILE_UNAVAILABLE' ? OWNER_PROFILE_MESSAGE : SAFE);
  }
}
interface Item { text: string }
type ClaimResult = 'claimed' | 'duplicate' | 'persistence';
type ParentOutcome = 'not-started' | 'not-submitted' | 'pending' | 'completed' | 'confirmed-cancellation' | 'failed';
interface Session { closeRejected?: boolean; failed?: boolean; gen: number; used: boolean; rotation?: Promise<void>; key: string; chat: string; user: string; epoch: string; valid: boolean; queue: Item[]; busy: boolean; deadline: number; parent?: ParentAgentSession; launching?: Promise<ParentAgentSession>; launchAbort?: AbortController; turn?: { id: string; abort: AbortController; delivery: Delivery; cancelled?: boolean; parentOutcome: ParentOutcome; keepalive?: Keepalive }; timer?: ReturnType<typeof setTimeout>; job?: Promise<void>; closing?: Promise<void>; retire?: 'idle' | 'other' }
interface ActionBinding { session: Session; generation: number; messageId: string; actionId: string; message: string; expires: number; consumed: boolean }
interface PendingWait { chat: string; user: string; gen: number; text: string; messageId: string; admittedAt: number; timer?: ReturnType<typeof setTimeout>; done: boolean }
export interface ImServiceOptions { dataDir: string; policy(): PolicySnapshot; channelConfig?: (id:string)=>ChannelBinding; parentFactory?: ParentAgentFactory; channelFactory?: ImChannelFactory; now?: () => number; taskStatus?: () => string; keepaliveTimers?: KeepaliveTimers }
export class ImService {
  private readonly settings: ImSettingsStore;
  private readonly inbox: ImInbox;
  private readonly now: () => number;
  private channel?: ImChannel;
  private readonly retiringChannels = new Set<ImChannel>();
  /** Agent/session generation: fences sessions, parents, queues, cards, pending waits and notices. */
  private agentGen = 0;
  /** Transport/channel generation: fences channel callbacks and WS lifecycle. */
  private transportGen = 0;
  /** transportGen value that owns the live channel object. */
  private channelOwnerGen = -1;
  private fingerprint = '';
  /** Hash of channel identity (appId + secret). Never logged or persisted; only compared in memory. */
  private channelHash = '';
  private serial: Promise<unknown> = Promise.resolve();
  private readonly sessions = new Map<string, Session>();
  private readonly actions = new Map<string, ActionBinding>();
  private readonly retiring = new Set<Session>();
  /** Bounded next-generation wait slot per key: one durably claimed message waiting for the old parent's real close. */
  private readonly pending = new Map<string, PendingWait>();
  private standby?: Session;
  private agentError = false;
  /** Classified reason behind agentError; cleared on every generation restart so stale async results cannot relabel a new generation. */
  private agentReason: ParentAgentFailureReason | undefined;
  private closed = false;
  private notices = 0;
  private status: ImStatus = { connection: 'disabled', agentState: 'disabled', activeSessions: 0, busySessions: 0 };
  constructor(private readonly options: ImServiceOptions) { this.settings = new ImSettingsStore(options.dataDir, (engine, model) => this.legacyChannel(engine, model)); this.inbox = new ImInbox(options.dataDir); this.now = options.now ?? Date.now; }
  private legacyChannel(engineId: string, model: string): string {
    const fallback = `default_${engineId}`;
    if (!this.options.channelConfig) return fallback;
    const { engines, channels } = this.options.policy().config;
    const engine = engines[engineId];
    const original = channels[fallback];
    if (!engine || !isImEngineKind(engine.kind) || !original?.enabled || original.engine !== engineId) return fallback;
    const configured = (id: string): boolean => {
      const { secret } = this.options.channelConfig!(id);
      return Boolean(secret.apiKey || secret.config || secret.authDir);
    };
    try {
      // Even incomplete user configuration on the default channel is an identity choice.
      if (configured(fallback)) return fallback;
      const provider = model.includes('/') ? model.split('/')[0] : undefined;
      const providerOf = (value: string | undefined) => engine.kind === 'dsh' && value === 'deepseek-official' ? 'deepseek' : value;
      const candidates = Object.entries(channels).filter(([id, channel]) =>
        id.startsWith('import_') && channel.engine === engineId && channel.kind === original.kind &&
        (provider ? providerOf(channel.provider) === providerOf(provider) : channel.kind === 'subscription' || engine.kind === 'dsh' && providerOf(channel.provider) === 'deepseek'));
      // Count identities before availability/credential checks: disabling an account must not
      // silently move its traffic to another one. Ambiguity requires an explicit channel choice.
      if (candidates.length !== 1) return '';
      const [id, channel] = candidates[0]!;
      if (!channel.enabled) return '';
      const { secret } = this.options.channelConfig(id);
      const usable = channel.kind === 'subscription' ? Boolean(secret.authDir)
        : engine.kind === 'dsh' || engine.kind === 'pi' ? Boolean(secret.apiKey) : configured(id);
      return usable ? id : '';
    } catch { return ''; }
  }
  snapshot(): ImSettingsSnapshot {
    let saved;
    try { saved = this.settings.current(); } catch (error) { throw new ImServiceError(this.safeCode(error)); }
    return { revision: saved.revision, config: publicImConfig(saved.config), status: { ...this.status, agentState: this.agentState(), agentMessage: this.agentError ? ImService.agentMessageFor(this.agentReason) : undefined, activeSessions: this.sessionCount(), busySessions: [...this.sessions.values(), ...this.retiring].filter(s => s.busy).length }, ownerProfiles: this.ownerProfiles(saved.config.ownerProfileId ?? '') };
  }
  /** Owner profiles for the Bot pin: sorted by id, with a `missing` entry when the saved pin vanished. */
  private ownerProfiles(savedOwner: string): ImOwnerProfileOption[] {
    const config = this.options.policy().config;
    const owners = config.owners ?? {};
    const engines = config.engines ?? {};
    const list: ImOwnerProfileOption[] = Object.entries(owners).map(([id, owner]) => {
      const engineId=config.channels[owner.channel]?.engine ?? '';
      const engine = (engines as Record<string, { enabled: boolean; kind: string }>)[engineId];
      let selectable = true;
      let reason: ImOwnerProfileOption['reason'];
      if (!owner.enabled) { selectable = false; reason = 'disabled'; }
      else if (!config.channels[owner.channel]?.enabled) { selectable=false; reason='channel_disabled'; }
      else if (!engine || !(OWNER_HOST_KINDS as readonly string[]).includes(engine.kind)) { selectable = false; reason = 'not_launchable'; }
      return { id, channel:owner.channel, engine: engineId, engineKind: engine?.kind ?? '', model: owner.model, effort: owner.effort, selectable, ...(selectable ? {} : { reason }) };
    }).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    if (savedOwner !== '' && !Object.hasOwn(owners, savedOwner)) {
      list.push({ id: savedOwner, channel:'', engine: '', engineKind: '', model: '', effort: '', selectable: false, reason: 'missing' });
    }
    return list;
  }
  private ownerSelectable(id: string): boolean {
    return this.ownerProfiles('').some(option => option.id === id && option.selectable);
  }
  start(): void { void this.reconnect().catch(() => this.failTransport()); }
  save(input: SaveImSettingsInput): Promise<ImSettingsSnapshot> {
    return this.lock(async () => {
      if (this.closed) throw new ImServiceError('IM_CLOSED');
      const old = this.settings.current().config;
      const config = { ...input?.config, appSecret: input?.config?.appSecret ?? old.appSecret } as StoredImConfig;
      const requestedOwner = typeof (input?.config as { ownerProfileId?: unknown })?.ownerProfileId === 'string'
        ? (input.config as { ownerProfileId: string }).ownerProfileId
        : undefined;
      const storedOwner = old.ownerProfileId ?? '';
      // A disabled save that keeps the stored pin must always stay possible (same rule as workspaces):
      // it skips the live selectability check so the Bot can always be turned off.
      const skipOwnerCheck = requestedOwner !== undefined && (input.config as { enabled?: unknown }).enabled === false && requestedOwner === storedOwner;
      if (requestedOwner !== undefined && requestedOwner !== '' && !skipOwnerCheck && !this.ownerSelectable(requestedOwner)) {
        throw new ImServiceError('IM_OWNER_PROFILE_UNAVAILABLE');
      }
      if (config.enabled) this.route(config);
      try { this.settings.save(input); } catch (error) { throw new ImServiceError(this.safeCode(error)); }
      const next = this.settings.current().config;
      // Enable/disable transitions always rebuild the full transport (disable fences immediately, enable builds standby).
      if (!old.enabled && !next.enabled) {
        // A failed disable cleanup leaves real residue behind; retry it instead of skipping.
        if (this.hasResidual()) await this.restartTransport(true);
        return this.snapshot();
      }
      if (old.enabled !== next.enabled) { await this.restartTransport(true); return this.snapshot(); }
      // Both enabled: compare the NEW effective runtime against the LIVE agent/transport.
      // Old-vs-new alone is unsound: a live policy change without reconcile resolves
      // both routes under the new policy and would hide drift from the running parent.
      let newFp = '';
      let newHash = '';
      let routable = true;
      try {
        newFp = this.route(next).fingerprint;
        newHash = ImService.channelHashOf(next);
      } catch { routable = false; }
      if (!routable) { await this.restartTransport(true); return this.snapshot(); }
      const sameLive = newFp === this.fingerprint && newHash === this.channelHash;
      if (sameLive) {
        // Healthy no-op saves keep parent/epoch/thread/queue/cards. Faults still recover explicitly.
        if (this.needsRecovery()) {
          if (!this.transportHealthy()) await this.restartTransport(true);
          else await this.restartAgents(true);
          return this.snapshot();
        }
        if (old.idleTimeoutMinutes !== next.idleTimeoutMinutes) this.retuneIdle(old.idleTimeoutMinutes, next.idleTimeoutMinutes);
        return this.snapshot();
      }
      // Credentials changed (or transport otherwise replaced) -> full channel rebuild,
      // even if an old parent close later fails the old channel is still revoked.
      if (newHash !== this.channelHash) { await this.restartTransport(true); return this.snapshot(); }
      // Same transport credentials but agent runtime changed (engine/model/effort/
      // workspaces/allowedOpenIds/ownerProfileId): reuse the healthy channel/WS, rebuild only agents.
      if (!this.transportHealthy()) { await this.restartTransport(true); return this.snapshot(); }
      await this.restartAgents(true); return this.snapshot();
    });
  }
  reconnect(): Promise<ImSettingsSnapshot> { return this.lock(async () => { if (this.closed) throw new ImServiceError('IM_CLOSED'); await this.restartTransport(true); return this.snapshot(); }); }
  reconcile(): Promise<void> {
    return this.lock(async () => {
      if (this.closed || !this.settings.current().config.enabled) return;
      let fp = '';
      let hash = '';
      try {
        const current = this.settings.current().config;
        fp = this.route(current).fingerprint;
        hash = ImService.channelHashOf(current);
      } catch {
        // Route-only failure: a healthy same-credential WS stays connected; only
        // agent admission/output is revoked and the old host is cleaned. Real
        // transport failures keep their explicit failTransport path elsewhere.
        if (this.channel && this.transportHealthy()) {
          // Clear the live fingerprint so a later policy restore is seen as drift
          // even if the old parent close also fails below.
          this.fingerprint = '';
          try { await this.restartAgents(); } catch { /* agent-only: precise refs kept, WS untouched */ }
        } else {
          try { await this.restartTransport(); } catch { /* fail-closed already marked */ }
        }
        return;
      }
      if (fp === this.fingerprint && hash === this.channelHash) return;
      if (hash === this.channelHash && this.transportHealthy()) {
        // Agent-only drift: a parent close failure must not escalate to a WS rebuild.
        try { await this.restartAgents(); } catch { /* precise parent refs kept, connection untouched */ }
      } else {
        try { await this.restartTransport(); } catch { /* full cleanup failure already marked */ }
      }
    });
  }
  close(): Promise<void> { this.closed = true; ++this.agentGen; ++this.transportGen; return this.lock(async () => { await this.releaseTransport(true); this.status.connection = 'disabled'; this.clearAgentFailure(); this.channelOwnerGen = -1; }); }
  private lock<T>(fn: () => Promise<T>): Promise<T> { const next = this.serial.then(fn, fn); this.serial = next.catch(() => {}); return next; }
  private safeCode(error: unknown): string { const code = (error as {code?:unknown})?.code; return typeof code === 'string' && /^IM_[A-Z_]+$/.test(code) ? code : 'IM_FAILED'; }
  /** Transport-only failure: WS/HTTP boundary. Agent-only failures never touch connection. */
  private failTransport(): void {
    this.status.message = SAFE; this.status.connection = 'error';
    for (const session of this.slots()) session.turn?.keepalive?.cancel();
  }
  /** Healthy transport keeps the same WS object usable for agent-only rebuilds. */
  private transportHealthy(): boolean { return !!this.channel && this.status.connection !== 'error'; }
  private isLiveChannel(channel: ImChannel, cGen: number): boolean {
    return !this.closed && this.channel === channel && this.transportGen === cGen && this.channelOwnerGen === cGen;
  }
  /** Fixed safe agent text selected only by classified reason; unknown reasons stay SAFE. */
  private static agentMessageFor(reason: ParentAgentFailureReason | undefined): string {
    if (reason === 'engine_missing') return MISSING_BINARY_MESSAGE;
    if (reason === 'auth') return AUTH_MESSAGE;
    if (reason === 'protocol') return PROTOCOL_MESSAGE;
    return SAFE;
  }
  private reasonOf(error: unknown): ParentAgentFailureReason {
    return error instanceof ParentAgentError ? error.reason : 'engine';
  }
  /**
   * Record the first agent failure of this generation. Generation-guarded and
   * first-wins: late async results from a retired generation, or a reason
   * regression inside the same generation, never relabel the live status and
   * never trigger an early replacement or replay. One exception: a generic
   * `engine` mark from a bare `unavailable` notification may be refined by the
   * in-flight turn's classified settlement (`auth`/`protocol`/...) in the same
   * generation, so a racing control loss does not hide the real failure reason.
   */
  private markAgentFailure(gen: number, reason: ParentAgentFailureReason): void {
    if (this.closed || gen !== this.agentGen) return;
    if (this.agentError) {
      if (this.agentReason === 'engine' && reason !== 'engine') {
        this.agentReason = reason;
        this.status.agentMessage = ImService.agentMessageFor(reason);
      }
      return;
    }
    this.agentError = true;
    this.agentReason = reason;
    this.status.agentMessage = ImService.agentMessageFor(reason);
  }
  private clearAgentFailure(): void {
    this.agentError = false;
    this.agentReason = undefined;
    this.status.agentMessage = undefined;
  }
  private static channelHashOf(config: StoredImConfig): string {
    return createHash('sha256').update(config.appId).update('\0').update(config.appSecret).digest('hex');
  }
  /**
   * Bot entry-Master startup cwd: the safe existing home canonical path, identical for all
   * seven engines. Project roots are never used as the startup cwd; they only travel in the
   * bootstrap context/whitelist and the fingerprint. Real task roots still come from the actual
   * target project, never from this startup cwd.
   */
  private static botHomeWorkspace(): string {
    try { return realpathSync(homedir()); } catch { throw new ImServiceError('IM_CONFIG_UNAVAILABLE'); }
  }
  /** No-op saves are only safe on a healthy live generation; faults must still rebuild explicitly. */
  private needsRecovery(): boolean {
    if (this.agentError) return true;
    if (this.status.connection === 'error') return true;
    if (!this.channel) return true;
    if (this.slots().some(s => s.failed)) return true;
    return false;
  }
  /**
   * Disabled generations must hold no live resources. Anything left (a failed
   * disable cleanup, a stuck channel/session) forces a retry instead of a skip.
   */
  private hasResidual(): boolean {
    if (this.channel) return true;
    if (this.retiringChannels.size) return true;
    if (this.agentError) return true;
    if (this.status.connection === 'error') return true;
    if (this.slots().some(s => s.failed || s.closeRejected)) return true;
    if (this.slots().length) return true;
    return false;
  }
  /**
   * Retune idle deadlines after a no-op save that only changed idleTimeoutMinutes.
   * Preserves the last admission moment (deadline - oldIdle) instead of extending
   * liveness as a new message would. Busy/queued sessions only shift the deadline;
   * starting blank sessions with deadline 0 keep 0 until launch reads the new config.
   */
  private retuneIdle(oldMinutes: number, newMinutes: number): void {
    if (oldMinutes === newMinutes) return;
    const delta = (newMinutes - oldMinutes) * 60_000;
    for (const session of this.slots()) {
      if (!session.valid || this.retiring.has(session)) continue;
      if (!session.used && session.deadline === 0) continue;
      session.deadline += delta;
      if (!session.busy && !session.queue.length) this.armIdle(session);
    }
  }
  private route(config: StoredImConfig): { input: Omit<ParentAgentInput, 'instructions'>; roots: string[]; fingerprint: string } {
    try {
      if (!/^cli_[a-zA-Z0-9]+$/.test(config.appId) || !config.appSecret || !config.allowedOpenIds.length || config.allowedOpenIds.some(id => !/^ou_[A-Za-z0-9_-]+$/.test(id))) throw 0;
      const policy = this.options.policy(); const engine = policy.config.engines[policy.config.channels[config.channel]?.engine ?? ''];
      const entity = { enabled: true, channel: config.channel, model: config.model, effort: config.effort, workers: [], max_parallel: 1 };
      // Independent chat: only the real channel availability (enabled + active engine/model
      // blocks) gates admission. Owner/worker presence never matters; worker-scoped blocks
      // never reach this owner-less entity. The kind allowlist is the single shared module.
      if (!engine || !isImEngineKind(engine.kind) || availabilityOf(policy.config, activeBlocks({ version: 1, blocks: policy.blocks }, this.now()), entity).status !== 'available') throw 0;
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(config.model) || !imEngineEffortAllowed(engine.kind, config.effort)) throw 0;
      const roots = resolveImWorkspaces(config.workspaces);
      const workspace = ImService.botHomeWorkspace();
      // Master does no real project work: no project root is passed as a writable engine root.
      const input = { channel: config.channel, ...(this.options.channelConfig?{channelConfig:this.options.channelConfig(config.channel),channelStateDir:join(this.options.dataDir,'agent-state','im')}:{}), engineKind: engine.kind as ImEngineKind, model: config.model, effort: config.effort, workspace, additionalWorkspaces: [] as string[] };
      // The pinned owner never gates admission: a later-invalid pin is reported via the
      // snapshot and the running Master, but chat itself stays available.
      return { input, roots, fingerprint: JSON.stringify([config.channel, input, roots, config.allowedOpenIds, config.ownerProfileId ?? '']) };
    } catch { throw new ImServiceError('IM_CONFIG_UNAVAILABLE'); }
  }
  private async restartAgents(retryClose = false): Promise<void> {
    ++this.agentGen;
    await this.releaseAgents(retryClose);
    this.clearAgentFailure();
    const config = this.settings.current().config;
    if (!config.enabled || this.closed) { this.fingerprint = ''; return; }
    // Agent-only path requires a healthy live transport; otherwise the caller routes to full rebuild.
    if (!this.transportHealthy()) { await this.restartTransport(retryClose); return; }
    try { this.fingerprint = this.route(config).fingerprint; }
    catch { this.fingerprint = ''; this.markAgentFailure(this.agentGen, 'engine'); return; }
    const gen = this.agentGen;
    // Reuse the same channel/WS: callbacks stay live and read the current agentGen on dispatch.
    this.standby = this.createSession(gen);
  }
  private async restartTransport(retryClose = false): Promise<void> {
    ++this.agentGen; ++this.transportGen;
    await this.releaseTransport(retryClose);
    this.clearAgentFailure();
    const config = this.settings.current().config;
    this.status = { ...this.status, connection: config.enabled ? 'connecting' : 'disabled', message: undefined };
    if (!config.enabled || this.closed) { this.fingerprint = ''; this.channelHash = ''; this.channelOwnerGen = -1; return; }
    try { this.fingerprint = this.route(config).fingerprint; this.channelHash = ImService.channelHashOf(config); } catch { this.markAgentFailure(this.agentGen, 'engine'); this.failTransport(); return; }
    const cGen = this.transportGen;
    const channel = (this.options.channelFactory ?? createImChannel)(config, {
      // Retained channel callbacks must read the CURRENT agent generation on dispatch,
      // never the captured old one, otherwise post-restart messages are swallowed.
      // Replaced/closed old channels are fenced by transport generation + identity.
      message: message => { if (this.isLiveChannel(channel, cGen)) this.message(message, this.agentGen); },
      card: event => this.isLiveChannel(channel, cGen) ? this.card(event, this.agentGen) : this.toast(false),
      menu: event => { if (this.isLiveChannel(channel, cGen)) this.menu(event, this.agentGen); },
      error: () => { if (this.isLiveChannel(channel, cGen)) this.failTransport(); },
      connecting: () => { if (this.isLiveChannel(channel, cGen)) this.status.connection = 'connecting'; },
      connected: () => { if (this.isLiveChannel(channel, cGen)) this.status.connection = 'connected'; },
    });
    this.channel = channel;
    this.channelOwnerGen = cGen;
    const gen = this.agentGen;
    this.standby = this.createSession(gen);
    // Startup is intentionally asynchronous: local settings and HTTP remain available during a handshake.
    void channel.connect().then(async () => { if (!this.isLiveChannel(channel, cGen)) await channel.close(); else this.status.connection = 'connected'; }).catch(() => { if (this.isLiveChannel(channel, cGen)) this.failTransport(); });
  }
  private async releaseAgents(retryClose = false): Promise<void> {
    // Config/permissions are already persisted by save() before this runs, so
    // revoking allowedOpenIds/workspaces fences old agents even if close fails.
    this.pending.forEach(wait => { wait.done = true; clearTimeout(wait.timer); });
    this.pending.clear();
    const sessions = this.slots();
    for (const session of sessions) this.invalidate(session);
    this.actions.clear();
    const jobs = sessions.map(s => this.closeSession(s, true, retryClose));
    const results = await Promise.allSettled(jobs.map(job => this.boundedClose(job)));
    // Agent-only failure keeps the healthy WS/connection; no new parent is created
    // and new admissions stay fenced until an explicit retry closes the exact objects.
    if (results.some(r => r.status === 'rejected')) { this.agentError = true; this.agentReason ??= 'engine'; this.status.agentMessage ??= ImService.agentMessageFor(this.agentReason); throw new ImServiceError('IM_CLOSE_FAILED'); }
  }
  private async releaseTransport(retryClose = false): Promise<void> {
    const channel = this.channel; this.channel = undefined; this.channelOwnerGen = -1;
    if (channel) this.retiringChannels.add(channel);
    this.pending.forEach(wait => { wait.done = true; clearTimeout(wait.timer); });
    this.pending.clear();
    const sessions = this.slots();
    for (const session of sessions) this.invalidate(session);
    this.actions.clear();
    const jobs = [...[...this.retiringChannels].map(async old => { await old.close(); this.retiringChannels.delete(old); }), ...sessions.map(s => this.closeSession(s, true, retryClose))];
    const results = await Promise.allSettled(jobs.map(job => this.boundedClose(job)));
    if (results.some(r => r.status === 'rejected')) { this.agentError = true; this.agentReason ??= 'engine'; this.status.agentMessage ??= ImService.agentMessageFor(this.agentReason); this.failTransport(); throw new ImServiceError('IM_CLOSE_FAILED'); }
  }
  private invalidate(session: Session, retire: 'idle' | 'other' = 'other'): void {
    session.retire = retire;
    // Private startup cancellation: rebuilding or disabling during the extended identity
    // budget must not wait out the full startup and then hit the 60s close timeout.
    // Aborting the launch controller lets the default background factory revoke its socket
    // and startup intent and reject pending readiness; custom factories receive the same
    // signal option and may ignore it.
    try { session.launchAbort?.abort(); } catch { /* already aborted */ }
    if (this.standby === session) this.standby = undefined;
    this.retiring.add(session);
    session.valid = false; session.queue = []; clearTimeout(session.timer); session.turn?.keepalive?.cancel(); session.turn?.abort.abort(); session.turn?.delivery.abort.abort();
    // Deliberate teardown (stop/new_session/release) marks the turn so drain treats the abort as expected.
    if (session.turn) session.turn.cancelled = true;
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    for (const [key, binding] of this.actions) if (binding.session === session) this.actions.delete(key);
  }
  private async boundedClose(job: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([job, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ImServiceError('IM_CLOSE_TIMEOUT')), 60_000); })]); } finally { clearTimeout(timer); }
  }
  private async closeSession(session: Session, waitForJob = true, retryRejected = false): Promise<void> {
    // Pending work always shares one confirmation. Only an explicit new recovery operation
    // may retry an already rejected close against the exact same retained parent identity.
    if (retryRejected && session.closeRejected) { session.closing = undefined; session.closeRejected = false; }
    try { session.launchAbort?.abort(); } catch { /* already aborted */ }
    session.closing ??= (async () => { const parent = session.parent ?? await session.launching?.catch(() => undefined); await parent?.close(); })().catch(error => {
      session.closeRejected = true; session.failed = true; throw error;
    });
    await session.closing;
    if (waitForJob) await session.job;
    this.retiring.delete(session);
  }
  private slots(): Session[] { return [...new Set([...this.sessions.values(), ...this.retiring, ...(this.standby ? [this.standby] : [])])]; }
  private agentState(): ImStatus['agentState'] {
    const slots = this.slots();
    if (this.agentError || slots.some(s => s.failed)) return 'error';
    if (this.retiring.size || this.retiringChannels.size) return 'closing';
    if (!slots.length) return 'disabled';
    if (slots.some(s => !s.parent)) return 'starting';
    if (slots.some(s => s.busy)) return 'busy';
    return 'ready';
  }
  private currentSlot(session: Session): boolean {
    return !this.closed && session.gen === this.agentGen && session.valid && (this.standby === session || this.sessions.get(session.key) === session);
  }
  private createSession(gen: number, key = '', chat = '', user = ''): Session {
    const session: Session = { gen, used: false, key, chat, user, epoch: randomUUID(), valid: true, busy: false, queue: [], deadline: 0 };
    if (key) this.sessions.set(key, session); else this.standby = session;
    const launchAbort = new AbortController();
    session.launchAbort = launchAbort;
    session.launching = Promise.resolve().then(() => {
      const current = this.settings.current().config;
      const route = this.route(current);
      // A queued start fenced before invoking the factory must not create a stale process.
      if (!this.currentSlot(session)) throw new ImServiceError('IM_STALE_START');
      const input = { ...route.input, instructions: imInstructions(this.options.dataDir, route.input.engineKind, session.epoch, route.roots, current.ownerProfileId ?? '') };
      // The default background factory and custom injected factories both receive the
      // private launch signal (options, never the serialized ParentAgentInput); custom
      // factories keep working with one arg and may ignore cancellation. The signal lets a rebuild/disable during the
      // extended identity budget revoke the socket/startup intent and close the exact owned
      // host resource instead of waiting out startup plus the close timeout.
      type CancellableFactory = ParentAgentFactory & ((input: ParentAgentInput, opts?: { signal?: AbortSignal }) => Promise<ParentAgentSession>);
      if (this.options.parentFactory) return (this.options.parentFactory as CancellableFactory)(input, { signal: launchAbort.signal });
      return createBackgroundParentAgent(input, { dataDir: this.options.dataDir, signal: launchAbort.signal });
    });
    void session.launching.then(parent => {
      session.parent = parent;
      if (!this.currentSlot(session)) { void this.closeSession(session).catch(() => { this.markAgentFailure(session.gen, 'engine'); }); return; }
      // unavailable is a control/engine failure notification, never a close confirmation.
      // Invalidate first; do not wait on drain from this observer (send may settle only in close).
      void parent.unavailable?.then(() => {
        if (!this.currentSlot(session) || session.parent !== parent) return;
        this.markAgentFailure(session.gen, 'engine'); session.failed = true;
        if (session.busy) this.notice(session.chat, TURN_FAIL_NOTICE, session.gen);
        this.invalidate(session);
        void this.boundedClose(this.closeSession(session, false)).catch(() => {
          this.markAgentFailure(session.gen, 'engine');
        });
      });
      this.clearAgentFailure();
      if (!session.used) session.deadline = this.now() + this.settings.current().config.idleTimeoutMinutes * 60_000;
      this.armIdle(session);
    }, (error) => { if (this.currentSlot(session)) { session.failed = true; this.markAgentFailure(session.gen, this.reasonOf(error)); } });
    return session;
  }
  private acquireSession(key: string, chat: string, user: string, gen: number): Session {
    const existing = this.sessions.get(key); if (existing) return existing;
    const standby = this.standby;
    if (standby && this.currentSlot(standby)) {
      this.standby = undefined; standby.key = key; standby.chat = chat; standby.user = user;
      this.sessions.set(key, standby); return standby;
    }
    return this.createSession(gen, key, chat, user);
  }
  private rotate(session: Session, gen: number): Promise<void> {
    session.rotation ??= this.boundedClose(this.closeSession(session, false)).then(() => {
      if (this.closed || gen !== this.agentGen) return;
      try { if (this.route(this.settings.current().config).fingerprint !== this.fingerprint) return; } catch { this.markAgentFailure(gen, 'engine'); return; }
      let replacement: Session | undefined;
      if (session.key) { if (!this.sessions.has(session.key)) replacement = this.createSession(gen, session.key, session.chat, session.user); }
      else if (!this.standby) replacement = this.createSession(gen);
      if (replacement) return replacement.launching!.then(() => undefined);
    });
    void session.rotation.catch(() => { this.markAgentFailure(gen, 'engine'); });
    return session.rotation;
  }
  private fresh(timestamp: unknown): boolean {
    let time = typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' && /^\d+$/.test(timestamp) ? Number(timestamp) : NaN;
    if (time < 1e12) time *= 1000;
    return Number.isFinite(time) && time >= this.now() - 300_000 && time <= this.now() + 60_000;
  }
  private freshMenu(timestamp: unknown): boolean {
    // Menu events only: seconds / milliseconds / bounded microseconds (16 digits) all normalize to
    // ms before the same freshness window; anything else fails and no cross-field fallback exists.
    let time = typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' && /^\d+$/.test(timestamp) ? Number(timestamp) : NaN;
    if (!Number.isFinite(time) || time <= 0) return false;
    if (time >= 1e15) time /= 1000;
    else if (time < 1e12) time *= 1000;
    return time >= this.now() - 300_000 && time <= this.now() + 60_000;
  }
  private admissible(user: string, gen: number): boolean {
    const config = this.settings.current().config;
    if (this.closed || gen !== this.agentGen || !config.enabled || !config.allowedOpenIds.includes(user)) return false;
    // Fail-closed on incomplete close: no new admission until the exact objects are retried.
    if (this.slots().some(s => s.failed || s.closeRejected)) return false;
    try { if (this.route(config).fingerprint === this.fingerprint) return true; } catch { /* fail closed */ }
    // Immediately fence all old agent turns; serialized cleanup/reconnect follows.
    // Reconcile already marks its precise failure; an Agent-only close failure here
    // must not be upgraded to a connection error (real transport faults fail explicitly).
    ++this.agentGen; this.fingerprint = ''; void this.reconcile().catch(() => { this.markAgentFailure(this.agentGen, 'engine'); }); return false;
  }
  private claim(id: string): ClaimResult { try { return this.inbox.claim(id, this.now()) ? 'claimed' : 'duplicate'; } catch { return 'persistence'; } }
  private sessionCount(): number { return new Set([...this.sessions.keys(), ...[...this.retiring].map(s => s.key).filter(Boolean), ...this.pending.keys()]).size; }
  private capacity(session?: Session): boolean { return session ? session.valid && session.queue.length < 8 : !!this.standby || this.sessionCount() + this.slots().filter(s => !s.key).length < 16; }
  private notice(chat: string, text: string, gen: number): Promise<boolean> | undefined {
    if (gen !== this.agentGen || this.closed || !this.channel || this.notices >= 16) return undefined;
    const channel = this.channel;
    this.notices++;
    return channel.send(chat, text).then(() => true, () => { if (gen === this.agentGen && !this.closed) this.failTransport(); return false; }).finally(() => { this.notices--; });
  }
  private message(message: NormalizedMessage, gen: number): void {
    if (!this.admissible(message.senderId, gen)) return;
    const raw = message.raw as { sender?: {sender_type?:string;sender_id?:{open_id?:string}}; message?: {content?:string;message_id?:string;chat_id?:string;create_time?:string;message_type?:string;chat_type?:string} } | undefined;
    if (message.senderType !== 'user' || message.chatType !== 'p2p' || (message.rawContentType !== 'text' && message.rawContentType !== 'post') || !/^om_[A-Za-z0-9_-]+$/.test(message.messageId) || !/^oc_[A-Za-z0-9_-]+$/.test(message.chatId) || !this.fresh(message.createTime)) return;
    if (raw?.sender?.sender_type !== 'user' || raw.sender.sender_id?.open_id !== message.senderId || raw.message?.message_id !== message.messageId || raw.message.chat_id !== message.chatId || (raw.message.message_type !== 'text' && raw.message.message_type !== 'post') || raw.message.message_type !== message.rawContentType || raw.message.chat_type !== 'p2p' || typeof raw.message.content !== 'string' || !this.fresh(raw.message.create_time) || Number(raw.message.create_time) !== message.createTime) return;
    const inbound = extractInboundText(message);
    if (inbound.kind === 'silent') return;
    if (inbound.kind === 'feedback') {
      const feedbackClaim = this.claim(`message:${message.messageId}`);
      if (feedbackClaim === 'persistence') { this.notice(message.chatId, PERSIST_NOTICE, gen); return; }
      if (feedbackClaim !== 'claimed') return;
      this.notice(message.chatId, inbound.notice, gen);
      return;
    }
    const text = inbound.text;
    if (this.standby?.parent && this.standby.deadline <= this.now()) this.retireIdle(this.standby);
    const key = `${message.chatId}:${message.senderId}`; let session = this.sessions.get(key);
    if (session?.parent && !session.busy && !session.queue.length && session.deadline <= this.now()) { this.retireIdle(session); session = undefined; }
    const wait = this.pending.get(key);
    if (wait) { if (wait.messageId !== message.messageId) this.notice(message.chatId, '当前对话繁忙，请稍后重试。', gen); return; }
    const retired = [...this.retiring].find(old => old.key === key || !old.key);
    if (retired) {
      // Normal idle retirement in flight: durably claim this one message and hand it to the next
      // generation once the old parent really closed. Any other retirement keeps the old rejection.
      if (retired.retire === 'idle' && this.sessionCount() <= 16) {
        const claimResult = this.claim(`message:${message.messageId}`);
        if (claimResult === 'persistence') { this.notice(message.chatId, PERSIST_NOTICE, gen); return; }
        if (claimResult !== 'claimed') return;
        if (!retired.key) { retired.key = key; retired.chat = message.chatId; retired.user = message.senderId; }
        this.attachWait(retired, message.chatId, message.senderId, gen, text, message.messageId);
        this.notice(message.chatId, WAIT_ACK_NOTICE, gen);
        return;
      }
      this.notice(message.chatId, '旧会话仍在关闭，请稍后重试或检查连接状态。', gen);
      return;
    }
    if (!this.capacity(session)) { this.notice(message.chatId, '当前对话繁忙，请稍后重试。', gen); return; }
    const claimResult = this.claim(`message:${message.messageId}`);
    if (claimResult === 'persistence') { this.notice(message.chatId, PERSIST_NOTICE, gen); return; }
    if (claimResult !== 'claimed') return;
    if (!session) session = this.acquireSession(key, message.chatId, message.senderId, gen);
    this.enqueue(session, text, gen);
  }
  private attachWait(retired: Session, chat: string, user: string, gen: number, text: string, messageId: string): void {
    const wait: PendingWait = { chat, user, gen, text, messageId, admittedAt: this.now(), done: false };
    this.recordMessageAt(wait.admittedAt);
    this.pending.set(retired.key, wait);
    wait.timer = setTimeout(() => { this.pending.delete(retired.key); if (!wait.done && wait.gen === this.agentGen && !this.closed) this.notice(wait.chat, WAIT_FAIL_NOTICE, wait.gen); wait.done = true; }, 60_000);
    wait.timer.unref?.();
    void (retired.rotation ?? retired.closing)?.then(() => this.executeWait(retired.key, wait), () => { this.pending.delete(retired.key); clearTimeout(wait.timer); if (!wait.done) this.notice(wait.chat, WAIT_FAIL_NOTICE, wait.gen); wait.done = true; });
  }
  private executeWait(key: string, wait: PendingWait): void {
    this.pending.delete(key);
    if (wait.done) return;
    wait.done = true; clearTimeout(wait.timer);
    // Fenced claims (shutdown/policy/reconnect) are dropped without a late start, not executed.
    if (this.closed || wait.gen !== this.agentGen || !this.admissible(wait.user, wait.gen) || this.sessions.get(key)?.used) return;
    const session = this.acquireSession(key, wait.chat, wait.user, wait.gen);
    this.enqueue(session, wait.text, wait.gen, wait.admittedAt);
  }
  private recordMessageAt(at: number): void {
    if (!this.status.lastMessageAt || at >= Date.parse(this.status.lastMessageAt)) this.status.lastMessageAt = new Date(at).toISOString();
  }
  private enqueue(session: Session, text: string, gen: number, admittedAt = this.now()): void {
    session.used = true;
    session.deadline = admittedAt + this.settings.current().config.idleTimeoutMinutes * 60_000;
    this.recordMessageAt(admittedAt); clearTimeout(session.timer);
    session.queue.push({ text });
    session.turn?.keepalive?.touch();
    if (!session.busy) { session.busy = true; session.job = this.drain(session, gen).catch(() => { this.markAgentFailure(gen, 'engine'); }); }
  }
  private valid(session: Session, gen: number): boolean { return session.valid && this.sessions.get(session.key) === session && this.admissible(session.user, gen); }
  private async drain(session: Session, gen: number): Promise<void> {
    try {
      while (session.queue.length && this.valid(session, gen)) {
        const item = session.queue.shift()!;
        if (!session.parent) { session.parent = await session.launching!; }
        if (!this.valid(session, gen)) return;
        try {
          await this.turn(session, item.text, gen);
        } catch (error) {
          if (session.turn?.cancelled && !session.turn.delivery.failed && (session.turn.parentOutcome === 'not-started' || session.turn.parentOutcome === 'not-submitted' || session.turn.parentOutcome === 'completed' || session.turn.parentOutcome === 'confirmed-cancellation')) {
            // turn() has settled the parent send and SDK stream queue. Retire only this card,
            // then release the captured turn before allowing the already-claimed FIFO to continue.
            const cancelled = session.turn;
            if (gen === this.agentGen && this.channel && this.admissible(session.user, gen)) {
              await this.channel.retireCard(cancelled.delivery, () => this.admissible(session.user, gen));
            }
            if (session.turn === cancelled) session.turn = undefined;
            continue;
          }
          throw error;
        }
        session.turn = undefined;
      }
    } catch (error) {
      // A racing `unavailable` observer may have invalidated first with a generic mark; the
      // in-flight turn's classified settlement still refines the same-generation reason via
      // markAgentFailure's generic-to-specific upgrade. Notices stay valid-gated to avoid doubles.
      if (gen === this.agentGen && !this.closed) this.markAgentFailure(gen, this.reasonOf(error));
      if (this.valid(session, gen)) { this.notice(session.chat, TURN_FAIL_NOTICE, gen); }
      this.invalidate(session);
      await this.closeSession(session, false);
      this.retiring.delete(session);
    } finally {
      session.busy = false; session.turn = undefined;
      if (session.valid) this.armIdle(session);
    }
  }
  private armIdle(session: Session): void {
    clearTimeout(session.timer);
    if (!session.valid || session.busy || session.queue.length) return;
    const remaining = session.deadline - this.now();
    if (remaining <= 0) { this.retireIdle(session); return; }
    session.timer = setTimeout(() => this.armIdle(session), remaining); session.timer.unref?.();
  }
  private retireIdle(session: Session): void {
    if (session.retire) return;
    this.invalidate(session, 'idle');
    // waitForJob=false: armIdle runs inside the drain's own finally, awaiting job there would deadlock.
    void this.rotate(session, session.gen).catch(() => {});
  }
  private async turn(session: Session, text: string, gen: number): Promise<void> {
    const channel = this.channel!; const abort = new AbortController(); const id = randomUUID();
    const delivery: Delivery = { valid: () => this.valid(session, gen) && session.turn?.id === id && !abort.signal.aborted, failed: false, abort: new AbortController() };
    const turn: NonNullable<Session['turn']> = { id, abort, delivery, parentOutcome: 'not-started' };
    session.turn = turn;
    const filter = new PublicDeltaFilter(); let pending = ''; let total = 0; let wake: (() => void) | undefined; let done = false; let failure: unknown; let final = ''; let messageId = ''; let keepalive: Keepalive | undefined;
    // Batched progress display is driven by the pure reducer in progress.ts: status
    // fragments and body/status separators carry their own independent budget there
    // and never count toward the answer REPLY_BYTES (`total` only accumulates the
    // filtered body text). Status lines are transient streaming hints; the final
    // `setContent(parseReply(final))` closes with the answer text only.
    let batch = createProgressBatchState();
    const onProgress = (event: ParentProgressEvent): void => {
      if (done || !delivery.valid()) return;
      const out = reduceProgressBatch(batch, { type: 'progress', event });
      batch = out.state;
      if (out.append) { pending += out.append; keepalive?.touch(); wake?.(); }
    };
    delivery.abort.signal.addEventListener('abort', () => { abort.abort(); wake?.(); }, { once: true });
    const result = await channel.stream(session.chat, async controller => {
      messageId = controller.messageId;
      // CardKit startup can finish after stop or a generation fence. No parent turn exists yet.
      if (session.turn !== turn || turn.cancelled || delivery.failed || !delivery.valid()) throw new ImServiceError('IM_TURN_NOT_STARTED');
      turn.parentOutcome = 'pending';
      keepalive = new Keepalive({
        timers: this.options.keepaliveTimers,
        depth: () => session.queue.length,
        valid: () => !done && turn.parentOutcome === 'pending' && session.turn === turn && !turn.cancelled && delivery.valid(),
        send: notice => this.notice(session.chat, notice, gen) ?? false,
      });
      turn.keepalive = keepalive;
      abort.signal.addEventListener('abort', () => keepalive?.cancel(), { once: true });
      const started = session.parent!.send(text, abort.signal, delta => {
        if (done || !delivery.valid()) return;
        const visible = filter.push(delta); total += Buffer.byteLength(visible);
        if (total > REPLY_BYTES) { failure = new ImServiceError('IM_REPLY_LIMIT'); abort.abort(); wake?.(); return; }
        // Only already-filtered displayable body text enters the batch state machine.
        // Hidden weaver-actions payloads and empty deltas never close an open batch.
        if (!visible) return;
        const out = reduceProgressBatch(batch, { type: 'text', text: visible });
        batch = out.state;
        if (out.append) { pending += out.append; keepalive?.touch(); wake?.(); }
      }, { onProgress });
      keepalive.start();
      const work = started.then(value => { final = value; turn.parentOutcome = 'completed'; }, error => { failure = error; turn.parentOutcome = error instanceof ParentTurnNotSubmitted ? 'not-submitted' : error instanceof ConfirmedParentCancellation ? 'confirmed-cancellation' : 'failed'; }).finally(() => {
        // Turn-end closes an open tool batch on the success path only: when there
        // is no failure and the delivery is still valid, the end fragment joins
        // `pending` before `done` so the single append loop below streams it
        // through the live controller before the closing setContent.
        // Failure, stop and generation fences keep their existing behavior.
        if (!failure && delivery.valid()) {
          const endOut = reduceProgressBatch(batch, { type: 'end' });
          batch = endOut.state;
          if (endOut.append) pending += endOut.append;
        }
        done = true; keepalive?.cancel(); wake?.();
      });
      while (!done || pending) {
        if (!delivery.valid() || failure) { keepalive?.cancel(); abort.abort(); break; }
        if (pending) { const chunk = pending; pending = ''; await controller.append(chunk); }
        else await new Promise<void>(resolve => {
          const ready = () => { abort.signal.removeEventListener('abort', ready); if (wake === ready) wake = undefined; resolve(); };
          wake = ready;
          if (done || pending || abort.signal.aborted) ready(); else abort.signal.addEventListener('abort', ready, { once: true });
        });
      }
      await work;
      // Preserve the classified parent failure so the drain handler can select the fixed
      // safe status text; only a bare delivery fence stays a generic turn failure.
      if (failure) throw failure;
      if (!delivery.valid()) throw new ImServiceError('IM_TURN_FAILED');
      const parsed = parseReply(final); await controller.setContent(parsed.text || '本轮没有可显示的回复。');
    }, delivery).catch(error => { keepalive?.cancel(); abort.abort(); throw error; });
    if (!delivery.valid() || delivery.failed || !result || result !== messageId) throw new ImServiceError('IM_DELIVERY_FAILED');
    const parsed = parseReply(final); const buttons: {label:string;nonce:string;actionId:string}[] = [];
    this.pruneActions();
    for (const action of parsed.actions) {
      if (this.actions.size >= 256) break;
      const nonce = actionIdentity(); const actionId = actionIdentity();
      this.actions.set(nonce, { session, generation: gen, messageId, actionId, message: action.message, expires: this.now() + 30 * 60_000, consumed: false }); buttons.push({ label: action.label, nonce, actionId });
    }
    try { await channel.updateCard(messageId, replyCard(parsed.text, buttons), delivery); }
    catch { for (const button of buttons) this.actions.delete(button.nonce); throw new ImServiceError('IM_DELIVERY_FAILED'); }
    if (delivery.valid()) this.status.lastReplyAt = new Date(this.now()).toISOString();
  }
  private pruneActions(): void { for (const [key, value] of this.actions) if (value.expires <= this.now() || !value.session.valid) this.actions.delete(key); }
  private toast(ok: boolean): Record<string, unknown> { return { toast: { type: ok ? 'success' : 'warning', content: ok ? '已作为新消息发送' : '该选项已失效、已提交或无权使用，请重新发送消息。' } }; }
  private card(event: CardActionEvent, gen: number): Record<string, unknown> {
    if (!this.admissible(event.operator.openId, gen)) return this.toast(false);
    const value = event.action.value as {nonce?:unknown;actionId?:unknown} | null;
    if (!value || typeof value.nonce !== 'string' || typeof value.actionId !== 'string') return this.toast(false);
    const binding = this.actions.get(value.nonce);
    const raw = event.raw as {event_id?:unknown;header?:{event_id?:unknown;create_time?:unknown};context?:{open_message_id?:unknown;open_chat_id?:unknown}} | undefined;
    const eventId = raw?.header?.event_id ?? raw?.event_id;
    if (binding && !binding.session.busy && !binding.session.queue.length && binding.session.deadline <= this.now()) { this.retireIdle(binding.session); return this.toast(false); }
    if (!binding || binding.consumed || binding.expires <= this.now() || binding.actionId !== value.actionId || binding.generation !== gen || binding.session.user !== event.operator.openId || binding.session.chat !== event.chatId || binding.messageId !== event.messageId || raw?.context?.open_message_id !== binding.messageId || !this.valid(binding.session, gen) || !this.capacity(binding.session) || typeof eventId !== 'string') return this.toast(false);
    const claimResult = this.claim(`card:${eventId}`);
    if (claimResult === 'persistence') return { toast: { type: 'warning', content: CARD_PERSIST_TOAST } };
    if (claimResult !== 'claimed') return this.toast(false);
    // Synchronous single-use nonce consumption also blocks double clicks with distinct event ids.
    for (const candidate of this.actions.values()) if (candidate.messageId === binding.messageId && candidate.session === binding.session) candidate.consumed = true;
    this.enqueue(binding.session, binding.message, gen);
    return this.toast(true);
  }
  private menu(value: unknown, gen: number): void {
    const event = value as {app_id?:string;operator?:{operator_id?:{open_id?:string}};event_id?:string;uuid?:string;event_key?:string;create_time?:string;ts?:string;timestamp?:number};
    const user = event?.operator?.operator_id?.open_id;
    if (!user || !this.admissible(user, gen) || event.app_id !== this.settings.current().config.appId || !this.freshMenu(event.create_time) || !['new_session','stop','status'].includes(event.event_key ?? '')) return;
    const id = event.event_id ?? event.uuid; if (!id) return;
    const claimed = this.claim(`menu:${id}`);
    if (claimed === 'persistence') { this.notice(user, ACTION_PERSIST_NOTICE, gen); return; }
    if (claimed !== 'claimed') return;
    const matches = [...this.sessions.values()].filter(s => s.valid && s.user === user);
    if (matches.length !== 1) { this.notice(user, '请先发送单聊文本消息；当前没有唯一可管理的对话。', gen); return; }
    const session = matches[0]!;
    if (event.event_key === 'status') { this.notice(session.chat, `对话${session.busy ? '正在回复' : '空闲'}，排队 ${session.queue.length} 条。${this.options.taskStatus?.() ?? ''}`, gen); return; }
    if (event.event_key === 'stop') {
      // stop captures the turn synchronously and cancels only that turn/delivery; the session,
      // its context and the queued inputs stay for the next turn. A late stop finds no turn.
      const turn = session.turn;
      if (!turn || turn.cancelled) { this.notice(session.chat, STOP_READY_NOTICE, gen); return; }
      turn.cancelled = true; turn.abort.abort(); turn.delivery.abort.abort();
      this.notice(session.chat, STOP_NOTICE, gen);
      return;
    }
    // Only a real new_session resets the whole conversation: queue, actions and parent close.
    this.invalidate(session);
    void this.rotate(session, gen).then(() => this.notice(session.chat, '已结束旧上下文并初始化新会话待命。已派发任务继续运行。', gen)).catch(() => { this.markAgentFailure(gen, 'engine'); this.notice(session.chat, RESET_FAIL_NOTICE, gen); });
  }
}
