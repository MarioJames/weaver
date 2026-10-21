import { command } from '../../api/commands';
import { isTransientError } from '../../api/reconnect';
import type { CommandResponse } from '../../../shared/contracts/commands';

/** One schedule mutation: the stable command id and the exact argument snapshot are fixed at submit time. */
export interface ScheduleMutation { command: string; args: Record<string, unknown>; commandId: string }

/** A new intent gets a fresh id; resuming an sitting one reuses the id and the args snapshot verbatim. */
export function newMutationIntent(name: string, args: Record<string, unknown>): ScheduleMutation {
  return { command: name, args: structuredClone(args), commandId: crypto.randomUUID() };
}

/** True when the transport lost the verdict (NETWORK/TIMEOUT and friends), the gateway reports an
 * unresolved receipt, or the error carries no server classification. The mutation MAY have applied:
 * the page must keep this exact intent (same commandId, same args) until operations.get settles it. */
export function isUncertainResult(error: unknown): boolean {
  if (isTransientError(error)) return true;
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (code === 'COMMAND_INDETERMINATE') return true;
  return typeof code !== 'string';
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function uncertainReason(error: unknown): string {
  return `${errorMessage(error)}。这次操作可能已生效；先核对结果，再决定续用同一请求。`;
}

/** What `operations.get` answers for one commandId. */
export interface CommandReceiptState { state: 'settled' | 'indeterminate'; response?: CommandResponse }

interface OperationGetResult { commandId: string; state: 'settled' | 'indeterminate'; response?: CommandResponse }

export const readMutationReceipt = (commandId: string): Promise<CommandReceiptState> =>
  command<OperationGetResult>('operations.get', { commandId }).then(result => ({
    state: result?.state === 'settled' ? 'settled' as const : 'indeterminate' as const,
    response: result.response,
  }));

export type MutationVerdict =
  | { state: 'applied'; response: CommandResponse }
  | { state: 'failed'; response: CommandResponse }
  | { state: 'unresolved'; reason: string };

/** A settled receipt that recorded a server rejection replays as a definite classification. */
export function receiptFailure(response: CommandResponse): Error {
  const code = response.error?.code ?? 'COMMAND_FAILED';
  return Object.assign(new Error(`${code}: ${response.error?.message ?? '操作失败'}`), { code, retryable: response.error?.retryable ?? false });
}

/** Same id in, same verdict out: a settled receipt replays its stored response, and an
 * unreadable one must never be mistaken for an applied or failed operation. */
export async function verifyMutation(commandId: string, readReceipt: (id: string) => Promise<CommandReceiptState> = readMutationReceipt): Promise<MutationVerdict> {
  try {
    const receipt = await readReceipt(commandId);
    if (receipt.state === 'settled' && receipt.response) return receipt.response.ok ? { state: 'applied', response: receipt.response } : { state: 'failed', response: receipt.response };
    return { state: 'unresolved', reason: '服务记录了这次命令，但还没有最终结果；稍后可以再核对。' };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'NOT_FOUND') return { state: 'unresolved', reason: '服务没有这次操作的回执：它当时可能根本没送达，可以重发同一请求。' };
    return { state: 'unresolved', reason: `核对没有完成（${errorMessage(error)}）；稍后可以再核对。` };
  }
}

/** One unconfirmed intent holding the page: any new mutation waits until this one has a verdict. */
export interface UnconfirmedIntent {
  mutation: ScheduleMutation;
  /** The user-facing name of the operation whose verdict went missing. */
  context: string;
  /** The latest explanation for why the result is unknown. */
  reason: string;
  /** Success handling captured at dispatch time, e.g. closing the form. */
  applied?: (result: unknown) => void;
}

export interface MutationGateHooks {
  send: (mutation: ScheduleMutation) => Promise<unknown>;
  readReceipt?: (commandId: string) => Promise<CommandReceiptState>;
  busy: (value: boolean) => void;
  checking: (value: boolean) => void;
  pending: (value: UnconfirmedIntent | undefined) => void;
  /** Runs after every settle, so list/data views re-read once the outcome is known. */
  settle: () => void;
  rejected: (error: unknown, context: string) => void;
  applied: (result: unknown, intent: UnconfirmedIntent, confirmed: boolean) => void;
}

/**
 * One schedule mutation at a time, with its stable id kept while the verdict is unknown.
 * Definite rejections close the conversation and free the page for a corrected intent;
 * an uncertain transport result parks the intent until 核对 (operations.get) or 重发同一请求 resolves it.
 */
export class ScheduleMutationGate {
  private locked = false;
  private verifying = false;
  private question?: UnconfirmedIntent;

  constructor(private readonly hooks: MutationGateHooks) {}

  paused(): boolean { return this.locked || !!this.question; }

  /** Dispatch a new intent; refused while an earlier intent still needs a verdict. */
  async run(name: string, args: Record<string, unknown>, context: string, applied?: (result: unknown) => void): Promise<boolean> {
    if (this.paused()) return false;
    return await this.applyMutation(newMutationIntent(name, args), context, applied, false);
  }

  /** Verify the parked intent's receipt without re-sending anything. */
  async verify(): Promise<boolean> {
    const intent = this.question;
    if (!intent || this.verifying || this.locked) return false;
    this.verifying = true;
    this.hooks.checking(true);
    try {
      const verdict = await verifyMutation(intent.mutation.commandId, this.hooks.readReceipt);
      if (verdict.state === 'applied') {
        this.confirmIntent();
        this.hooks.applied(verdict.response.data, intent, true);
        this.hooks.settle();
        return true;
      }
      if (verdict.state === 'failed') {
        this.confirmIntent();
        this.hooks.rejected(receiptFailure(verdict.response), intent.context);
        this.hooks.settle();
        return false;
      }
      this.hooks.pending({ ...intent, reason: verdict.reason });
      return false;
    } finally {
      this.verifying = false;
      this.hooks.checking(false);
    }
  }

  /** Re-send the parked intent verbatim: the gateway replays the stored receipt or, when nothing
   * ever arrived, executes it exactly once. A new indeterminate answer leaves the intent parked. */
  async resend(): Promise<boolean> {
    const intent = this.question;
    if (!intent || this.verifying || this.locked) return false;
    return await this.applyMutation(intent.mutation, intent.context, intent.applied, false);
  }

  private confirmIntent(): void {
    this.question = undefined;
    this.hooks.pending(undefined);
  }

  private async applyMutation(mutation: ScheduleMutation, context: string, applied?: (result: unknown) => void, confirmed = false): Promise<boolean> {
    this.locked = true;
    this.hooks.busy(true);
    try {
      const result = await this.hooks.send(mutation);
      this.confirmIntent();
      this.hooks.applied(result, { mutation, context, reason: '', applied }, confirmed);
      this.hooks.settle();
      return true;
    } catch (error) {
      if (!isUncertainResult(error)) {
        this.confirmIntent();
        this.hooks.rejected(error, context);
        this.hooks.settle();
        return false;
      }
      this.question = { mutation, context, reason: uncertainReason(error), applied };
      this.hooks.pending(this.question);
      this.hooks.settle();
      return false;
    } finally {
      this.locked = false;
      this.hooks.busy(false);
    }
  }
}
