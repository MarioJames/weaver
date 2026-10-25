import { command } from '../api/commands';
import { notifyError } from '../api/notify';
import type { PolicyDraft } from './usePolicyDraft';
import { STALL_BLOCK_BY, VENDOR_BLOCK_BY, isEngineBlock, isQuotaBlock } from '../../shared/policy/blocks';
import type { Block } from '../../shared/contracts/policy';
import type { EngineStallStatus } from '../../shared/contracts/monitoring';
import type { StallEngineState } from '../api/client';
import type { StatusTone } from '../format/status-colors';
import { compactTime } from '../format/timezone';

type EngineBlockState = StallEngineState & Partial<Pick<EngineStallStatus, 'blockedUntil'>>;

/** One category, one bounded reason and one explicit recovery condition for every pause. */
export function engineBlockText(block: Block, now: number, state?: EngineBlockState) {
  const stall = block.by === STALL_BLOCK_BY;
  const category = stall ? `卡住惩罚${state?.level ? ` 第 ${state.level} 级` : ''}`
    : isQuotaBlock(block) ? '额度耗尽'
    : block.by === VENDOR_BLOCK_BY ? '限流'
    : '手动暂停';
  const fullReason = block.reason.replace(/\s+/g, ' ').trim();
  const plain = fullReason.replace(/^(?:限流|额度耗尽)：\s*/, '');
  const reason = plain.length > 120 ? `${plain.slice(0,119)}…` : plain;
  const deadline = block.release_at ?? (stall && state?.level && state.level <= 2 ? state.blockedUntil : undefined);
  const time = deadline ? Date.parse(deadline) : NaN;
  let release = '需手动恢复';
  if (Number.isFinite(time) && time > now) {
    release = `${compactTime(time, now)} 自动解除`;
  } else if (stall && state && state.level >= 1 && state.level <= 2) release = '探测通过后解除';
  const tone: StatusTone = category === '手动暂停' ? 'default' : 'warning';
  return { category, reason, fullReason, release, tone };
}

/** Resume dispatch removes exactly one block: the one with the same engine, model and worker. Whole-engine, model and worker blocks of one engine are separate bans. */
export function removeBlock(blocks: Block[], target: Block): Block[] {
  return blocks.filter(item => !(item.engine === target.engine && item.channel === target.channel && item.model === target.model && item.worker === target.worker));
}


/**
 * 「恢复派发」 for one worker, the shared call from Agent recovery controls: the server lifts that worker's
 * bans (and the engine-wide "all limited" ban that no longer holds), resets what the monitors kept for it and re-routes
 * queued tasks. The saved policy is then read again; a page draft is kept and only its blocks follow the server.
 * A failure is a floating notice, never page content. Resolves true when the worker was resumed and the page refreshed.
 */
export async function resumeWorker(worker: string, policy: Pick<PolicyDraft, 'rebase'>): Promise<boolean> {
  try { await command('workers.unblock', { worker }, true); }
  catch (error) { notifyError(error, '恢复派发失败'); return false; }
  try {
    if (!window.weaver) throw new Error('控制面不可用。请通过 weaver web 打开这个页面。');
    const next = await window.weaver.getPolicy();
    policy.rebase(next, doc => ({ ...doc, blocks: next.blocks }));
  } catch (error) { notifyError(error, '已恢复派发，但刷新配置失败'); return false; }
  return true;
}

/**
 * What 「恢复派发」 does for a worker whose pause is the block `hit`. The server lifts a ban that names the worker (and the
 * whole-engine vendor ban that rested on it), so that is the call whenever the shown block is the worker's own or the
 * engine-wide vendor ban over worker bans. A ban that reaches the worker through its whole engine or one model names no
 * worker: the server leaves those alone, so the button removes exactly that block from the saved policy, as it always did.
 */
export function resumeAction(blocks: Block[], worker: string, hit: Block): 'unblock' | 'remove' {
  if (hit.worker === worker) return 'unblock';
  return isEngineBlock(hit) && hit.by === VENDOR_BLOCK_BY && blocks.some(block => block.worker === worker) ? 'unblock' : 'remove';
}
