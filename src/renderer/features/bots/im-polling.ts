import type { ImStatus } from '../../../shared/contracts/im';

/** 过渡态短周期：保存/重建后自主跟进 connecting 与 Agent starting/closing。 */
export const IM_TRANSITION_POLL_MS = 1_000;
/** 稳定态低频：沿用既有 30s 节奏。 */
export const IM_STABLE_POLL_MS = 30_000;

/**
 * 是否处于需要短周期跟进的过渡态。
 * 后端将模型变更收敛为仅重建 Agent 时，connection 可保持 connected，
 * 此时仍需按 agentState starting/closing 短周期跟进，因此两侧独立判断。
 */
export function isImTransitional(status: ImStatus | undefined): boolean {
  if (!status) return false;
  return status.connection === 'connecting' || status.agentState === 'starting' || status.agentState === 'closing';
}

/** 按最新状态选择下一次轮询延迟：过渡态短周期，其余稳定态低频。 */
export function nextImPollDelay(
  status: ImStatus | undefined,
  stableMs: number = IM_STABLE_POLL_MS,
  transitionMs: number = IM_TRANSITION_POLL_MS,
): number {
  return isImTransitional(status) ? transitionMs : stableMs;
}
