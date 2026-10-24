/**
 * The one table of RPC methods the browser (HTTP /api/rpc) and the CLI (Unix socket) may call.
 * main/rpc.ts derives its allowlist and arity from it, main/transport/handlers.ts must supply a handler for every
 * method, the CLI catalog maps its direct-RPC commands through `cli`, and the renderer client reads `retryable` and
 * `timeoutMs` from it.
 *
 *   arity      exact number of positional arguments
 *   retryable  a read the client may repeat after a transient transport failure
 *   cli        the logical CLI command that calls this method directly (policy, engine, quota, probe commands)
 *   mutation   whether that CLI command changes state (only for methods with `cli`)
 *   timeoutMs  client-side deadline when the default RPC deadline is too short
 */
export interface RpcMethodSpec {
  readonly arity: 0 | 1;
  readonly retryable?: true;
  readonly cli?: string;
  readonly mutation?: boolean;
  readonly timeoutMs?: number;
}

export const RPC_METHODS = {
  getOpenCodeAccountQuotas: { arity: 0, retryable: true },
  refreshOpenCodeAccountQuotas: { arity: 1, mutation: true, timeoutMs: 180_000 },
  listOpenCodeAccounts: { arity: 0, timeoutMs: 90_000 },
  startOpenCodeLogin: { arity: 0, mutation: true },
  getOpenCodeLogin: { arity: 1, retryable: true },
  cancelOpenCodeLogin: { arity: 1, mutation: true, timeoutMs: 30_000 },
  switchOpenCodeAccount: { arity: 1, mutation: true, timeoutMs: 180_000 },
  getImSettings: { arity: 0, retryable: true },
  saveImSettings: { arity: 1, mutation: true },
  reconnectIm: { arity: 0, mutation: true },
  command: { arity: 1 },
  getPolicy: { arity: 0, retryable: true, cli: 'policy.get', mutation: false },
  policyHistory: { arity: 0, cli: 'policy.history', mutation: false },
  policyRollback: { arity: 1, cli: 'policy.rollback', mutation: true },
  validatePolicy: { arity: 1, retryable: true, cli: 'policy.validate', mutation: false },
  savePolicy: { arity: 1, cli: 'policy.save', mutation: true },
  previewRoute: { arity: 1, retryable: true, cli: 'policy.preview', mutation: false },
  scanEngines: { arity: 0, cli: 'engines.scan', mutation: false },
  listEngineModels: { arity: 1, retryable: true, cli: 'engines.models', mutation: false, timeoutMs: 40_000 },
  getQuota: { arity: 0, retryable: true, cli: 'quota.get', mutation: false },
  refreshQuota: { arity: 1, cli: 'quota.refresh', mutation: true },
  getStall: { arity: 0, retryable: true },
  workerProbe: { arity: 1, cli: 'workers.probe', mutation: true, timeoutMs: 130_000 },
  workerProbeStatus: { arity: 0, retryable: true, cli: 'workers.probe-status', mutation: false },
  startEngineCleanup: { arity: 1 },
  getEngineCleanup: { arity: 1, retryable: true },
  sayHi: { arity: 1 },
  sayHiResult: { arity: 1, retryable: true },
  setEngineEnabled: { arity: 1, cli: 'engines.set-enabled', mutation: true },
  listTasks: { arity: 0, retryable: true },
  getTask: { arity: 1, retryable: true },
  createTask: { arity: 1 },
  startTask: { arity: 1 },
  cancelTask: { arity: 1 },
  capabilities: { arity: 0, retryable: true },
  serverInfo: { arity: 0 },
  janitorSweep: { arity: 1, cli: 'janitor.sweep', mutation: true },
  janitorStatus: { arity: 0, retryable: true, cli: 'janitor.status', mutation: false },
} as const satisfies Record<string, RpcMethodSpec>;

export type RpcMethod = keyof typeof RPC_METHODS;
type CliOf<S> = S extends { readonly cli: infer C extends string } ? C : never;
/** Logical CLI commands that are one direct RPC call. */
export type RpcCliCommand = { [M in RpcMethod]: CliOf<(typeof RPC_METHODS)[M]> }[RpcMethod];

export interface RpcCliBinding { method: RpcMethod; arity: 0 | 1; mutation: boolean }

/** The RPC method behind a CLI command, or undefined when the command is not a direct RPC call. */
export function findRpcForCommand(command: string): RpcCliBinding | undefined {
  for (const method of Object.keys(RPC_METHODS) as RpcMethod[]) {
    const spec: RpcMethodSpec = RPC_METHODS[method];
    if (spec.cli === command) return { method, arity: spec.arity, mutation: spec.mutation === true };
  }
  return undefined;
}

/** The RPC method behind a direct-RPC CLI command; an unknown name does not type-check. */
export function rpcForCommand(command: RpcCliCommand): RpcCliBinding {
  const binding = findRpcForCommand(command);
  if (!binding) throw new Error(`No RPC method for command ${command}`);
  return binding;
}
