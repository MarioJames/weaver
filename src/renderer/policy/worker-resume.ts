import { command } from '../api/commands';
import { notifyError } from '../api/notify';
import type { Block } from '../../shared/contracts/policy';
import { VENDOR_BLOCK_BY, isEngineBlock } from '../../shared/policy/blocks';
import type { PolicyDraft } from './usePolicyDraft';

/**
 * 「恢复派发」 for one worker, the same call on the sub-agent page and the engines page: the server lifts that worker's
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
