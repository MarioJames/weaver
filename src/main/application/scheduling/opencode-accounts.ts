import type { TaskLaunchGuard } from '../../manager';
import { readdirSync, readlinkSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Task } from '../../../shared/contracts/tasks';
import type { OpenCodeAccountRef, OpenCodeAccountQuotas } from '../../../shared/contracts/opencode-account-quotas';
import type { OpenCodeConsoleAccounts } from '../../../shared/contracts/opencode-accounts';
import type { OpenCodeQuotaPool } from '../../quota/opencode-pool';

export interface OpenCodeRunAccount extends OpenCodeAccountRef { generation: number }
export const isOpenCodeTask = (task: Task): boolean => (task.dispatch?.execution ?? task.run?.execution) === 'real' && (task.dispatch?.engineKind ?? task.dispatch?.adapter ?? (task.run?.adapter === 'opencode' ? 'opencode' : task.dispatch?.engine ?? task.run?.engine)) === 'opencode';
export const isConsoleGoTask = (task: Task): boolean => isOpenCodeTask(task) && (task.dispatch?.model ?? task.run?.model ?? '').startsWith('opencode-go/');
const same = (a: OpenCodeAccountRef | null | undefined, b: OpenCodeAccountRef | null | undefined) => a === b || !!a && !!b && a.accountID === b.accountID && a.orgID === b.orgID;

/** Only executable symlinks are read; never cmdline, environment or credentials. */
export function externalOpenCodeBusy(ignoredPids: ReadonlySet<number> = new Set(), platform = process.platform): string | undefined {
 if (platform !== 'linux') return '此平台无法确认外部 OpenCode 进程空闲，自动切换暂停。';
 try {
  for (const value of readdirSync('/proc')) {
   if (!/^\d+$/.test(value) || ignoredPids.has(Number(value))) continue;
   try { if (process.getuid && statSync(`/proc/${value}`).uid !== process.getuid()) continue; if (/^opencode(?:-.*)?$/.test(basename(readlinkSync(`/proc/${value}/exe`)))) return '外部 OpenCode 进程仍在运行，等待其退出后切换账号。'; }
   catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') return '无法确认外部 OpenCode 进程空闲，自动切换暂停。'; }
  }
 } catch { return '无法确认外部 OpenCode 进程空闲，自动切换暂停。'; }
 return;
}
interface Options {
 pool: Pick<OpenCodeQuotaPool, 'get' | 'refresh' | 'setActive' | 'setSwitching' | 'candidate' | 'recordFailure' | 'hasFailure'>;
 native: { list(): Promise<OpenCodeConsoleAccounts>; switchAccount(input: { accountID: string; orgID: string; expectedActive: OpenCodeAccountRef | null }): Promise<OpenCodeConsoleAccounts> };
 tasks(): Task[];
 readActive(): OpenCodeAccountRef | null;
 busyReason?(): string | undefined;
 externalBusy?(): string | undefined;
 wake(): void;
 now?(): number;
}
/** One global cursor gate shared by admission, manual changes and every owned OpenCode launch. */
export class OpenCodeAccountAdmission implements TaskLaunchGuard {
 private generation = 0;
 private mutation = false;
 private automaticPermit = false;
 private leases = 0;
 private work?: Promise<void>;
 private timer?: ReturnType<typeof setTimeout>;
 private closed = false;
 private uncertain = false;
 private discovered = false;
 private refreshRequested = false;
 private lastRefreshAt = 0;
 private readonly verifiedPairs = new Set<string>();
 private waitingForIdle = false;
 private verifyTarget?: OpenCodeAccountRef;
 constructor(private readonly options: Options) {}
 private busyReason(): string | undefined {
  if (this.options.tasks().some(t => isOpenCodeTask(t) && (t.status === 'running' || t.status === 'cancelling' || !!t.run && !t.run.finalizedAt))) return '已有 OpenCode 任务尚未结束，等待真实进程回收后切换账号。';
  if (this.leases) return 'OpenCode 连通性或恢复探测仍在进行，等待结束后切换账号。';
  return this.options.busyReason?.() ?? this.options.externalBusy?.();
 }
 /** A manual mutation holds the same gate until its native job actually finishes. */
 beginMutation(): () => void {
  if (this.automaticPermit) { this.automaticPermit = false; return () => {}; }
  if (this.closed || this.mutation) throw new Error('OpenCode 账号操作进行中，请等待完成。');
  const reason = this.busyReason(); if (reason) throw new Error(reason);
  this.mutation = true; this.options.pool.setSwitching(true, '正在更新原生账号，请等待。');
  return () => { this.mutation = false; this.options.pool.setSwitching(false); this.options.wake(); };
 }
 lease(): () => void {
  if (this.closed || this.mutation || this.uncertain) throw new Error('OpenCode 账号正在切换或状态待确认，暂不能启动探测。');
  this.leases++;
  let released = false; return () => { if (!released) { released = true; this.leases--; this.activityChanged(); this.options.wake(); } };
 }
 observe(snapshot: OpenCodeConsoleAccounts): void {
  const selected = snapshot.orgs.find(o => o.active); const ref = selected ? { accountID: selected.accountID, orgID: selected.orgID } : null;
  if (!same(this.options.pool.get().active, ref)) this.generation++;
  this.options.pool.setActive(ref);
  this.uncertain = !!this.verifyTarget && same(ref, this.verifyTarget) && !snapshot.consoleManagedProviders.includes('opencode-go');
  if (!this.uncertain) this.verifyTarget = undefined;
 }
 private rememberReady(): void {
  this.lastRefreshAt = (this.options.now ?? Date.now)();
  for (const item of this.options.pool.get().accounts) if (item.goReady) this.verifiedPairs.add(JSON.stringify([item.account.accountID, item.account.orgID]));
 }
 private proven(snapshot: OpenCodeAccountQuotas): boolean {
  const current = snapshot.accounts.find(a => same(a.account, snapshot.active));
  return !!current && (this.options.pool.hasFailure(current.account) || !current.quota.stale && current.quota.status === 'exhausted' || !!current.cooldownUntil && Date.parse(current.cooldownUntil) > (this.options.now ?? Date.now)());
 }
 admit(task: Task): string | undefined {
  if (!isOpenCodeTask(task)) return;
  if (this.closed || this.mutation) return '正在等待 OpenCode 账号操作完成。';
  if (this.uncertain) { this.schedule(); return '原生账号切换状态尚未确认，正在重新读取，请等待。'; }
  if (!isConsoleGoTask(task)) return;
  if (!this.discovered) { this.schedule(); return '正在首次确认 OpenCode Console 账号额度；未知额度不自动禁用任务。'; }
  const snapshot = this.options.pool.get();
  const current = snapshot.accounts.find(item => same(item.account, snapshot.active));
  if (snapshot.accounts.length >= 2 && current && (!current.goReady || current.quota.stale) && this.verifiedPairs.has(JSON.stringify([current.account.accountID, current.account.orgID])) && (this.options.now ?? Date.now)() - this.lastRefreshAt >= 60_000 && !this.proven(snapshot)) {
   this.refreshRequested = true; this.schedule(); return '正在更新当前账号的额度与 Go 凭证证明，请稍候。';
  }
  if (snapshot.accounts.length < 2 || !snapshot.active || !this.proven(snapshot)) return;
  this.schedule();
  return snapshot.detail ?? '当前 OpenCode Go 账号已耗尽或冷却，正在等待可用账号及所有 OpenCode 进程空闲。';
 }
 capture(task: Task): OpenCodeRunAccount | undefined {
  if (!isOpenCodeTask(task)) return;
  const reason = this.admit(task); if (reason) throw new Error(reason);
  const snapshot = this.options.pool.get();
  if (!isConsoleGoTask(task) || !snapshot.active || !snapshot.accounts.some(item => same(item.account, snapshot.active) && item.goReady)) return;
  const actual = this.options.readActive();
  if (!same(actual, snapshot.active)) { this.uncertain = true; this.schedule(); throw new Error('原生当前账号已变化，等待重新读取后启动。'); }
  return { ...snapshot.active, generation: this.generation };
 }
 beforeSpawn(task: Task): void {
  if (!isOpenCodeTask(task)) return;
  if (this.closed || this.mutation || this.uncertain) throw new Error('OpenCode 账号状态暂不允许启动，已阻止旧账号进程。');
  const captured = task.run?.consoleAccount;
  if (captured && (captured.generation !== this.generation || !same(captured, this.options.pool.get().active) || !same(captured, this.options.readActive()))) throw new Error('OpenCode 账号在启动前变化，已阻止错误账号执行。');
 }
 recordFailure(task: Task): boolean {
  const ref = task.run?.consoleAccount; const kind = task.failure?.kind;
  if (!isConsoleGoTask(task) || !ref || !kind || !['quota', 'rate_limit', 'auth'].includes(kind) || this.options.pool.get().accounts.length < 2) return false;
  if (!this.options.pool.get().accounts.some(item => same(item.account, ref))) return true;
  this.options.pool.recordFailure(ref, { kind: kind as 'quota' | 'rate_limit' | 'auth', runID: task.run!.id, ...(task.failure?.retryAt ? { retryAt: task.failure.retryAt } : {}) });
  this.options.wake(); return true;
 }
 private schedule(): void {
  if (this.closed || this.work || this.timer) return;
  const discovering = !this.discovered || this.refreshRequested;
  this.work = this.reconcile().catch(() => { this.options.pool.setSwitching(false, '自动账号切换未完成，请刷新账号额度确认当前状态。'); }).finally(() => {
   this.work = undefined; this.options.wake();
   if (!discovering && !this.closed && !this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.options.wake(); }, 60_000); this.timer.unref?.(); }
  });
 }
 private async reconcile(): Promise<void> {
  if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  if (!this.discovered || this.refreshRequested) { this.refreshRequested = false; try { await this.options.pool.refresh(); } finally { this.discovered = true; this.rememberReady(); } return; }
  if (this.uncertain) { this.observe(await this.options.native.list()); if (!this.uncertain) await this.options.pool.refresh(); return; }
  const snapshot = this.options.pool.get(); if (!snapshot.active || !this.proven(snapshot)) return;
  const reason = this.busyReason();
  if (reason) { this.waitingForIdle = true; this.options.pool.setSwitching(false, reason); return; }
  this.waitingForIdle = false;
  this.mutation = true;
  let target: OpenCodeAccountRef | undefined;
  try {
   this.options.pool.setSwitching(true, '正在查找其他近期确认有额度的 Go 账号。');
   let candidate = this.options.pool.candidate(snapshot.active);
   if (!candidate) { await this.options.pool.refresh(); candidate = this.options.pool.candidate(snapshot.active); }
   if (this.closed) return;
   if (!this.proven(this.options.pool.get())) return;
   const changedReason = this.busyReason(); if (changedReason) { this.waitingForIdle = true; this.options.pool.setSwitching(false, changedReason); return; }
   if (!candidate) { this.options.pool.setSwitching(false, '全部账号额度耗尽、冷却或尚未确认可用；任务等待刷新恢复。'); return; }
   target = { accountID: candidate.account.accountID, orgID: candidate.account.orgID };
   if (!same(this.options.readActive(), snapshot.active)) { this.uncertain = true; return; }
   this.options.pool.setSwitching(true, '正在切换 OpenCode Go 账号，等待原生配置复验。');
   this.verifyTarget = target;
   this.automaticPermit = true;
   let operation: Promise<OpenCodeConsoleAccounts>;
   try { operation = this.options.native.switchAccount({ ...target, expectedActive: snapshot.active }); }
   finally { this.automaticPermit = false; }
   const result = await operation;
   const active = result.orgs.find(o => o.active);
   if (!same(active, target) || !result.consoleManagedProviders.includes('opencode-go')) { this.uncertain = true; throw new Error('Go 配置无法确认'); }
   const verified = this.options.pool.get().accounts.find(item => same(item.account, target));
   if (!verified?.goReady || verified.quota.stale || verified.quota.status !== 'available' || verified.cooldownUntil) { this.uncertain = true; throw new Error('目标账号近期额度尚未确认'); }
   this.observe(result);
  } catch {
   this.uncertain = true;
   if (target) this.options.pool.recordFailure(target, { kind: 'rate_limit', runID: `switch-${(this.options.now ?? Date.now)()}`, retryAt: new Date((this.options.now ?? Date.now)() + 60_000).toISOString() });
   this.options.pool.setSwitching(false, '原生账号可能已变更，但 Go 复验失败；等待重新读取，不自动反向切换。');
  } finally { this.mutation = false; this.automaticPermit = false; this.options.pool.setSwitching(false, this.options.pool.get().detail); }
 }
 cursorUnavailable(): void { this.uncertain = true; this.options.pool.setActive(null); this.options.pool.setSwitching(false, '无法确认原生账号游标；其他引擎可继续使用，OpenCode 等待刷新恢复。'); }
 activityChanged(): void {
  if (this.waitingForIdle && !this.busyReason()) { this.waitingForIdle = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.options.wake(); }
 }
 refreshed(): void { this.discovered = true; this.rememberReady(); if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } this.options.wake(); }
 stop(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
 async close(): Promise<void> { this.stop(); await this.work; }
}
