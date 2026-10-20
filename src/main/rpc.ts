import { RPC_METHODS, type RpcMethod } from '../shared/contracts/rpc';

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Browser and Unix method calls share one allowlist, the RPC contract table. There is no reflective dispatch. */
export function parseRpcBody(value: unknown): { method: string; args: unknown[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError('INVALID_REQUEST', 'Request must be a JSON object');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.hasOwn(record, 'method') || !Object.hasOwn(record, 'args')) {
    throw new RpcError('INVALID_REQUEST', 'Request must contain only method and args');
  }
  const method = record.method;
  const args = record.args;
  if (typeof method !== 'string' || !Object.hasOwn(RPC_METHODS, method)) throw new RpcError('INVALID_REQUEST', 'Unknown method');
  if (!Array.isArray(args) || args.length !== RPC_METHODS[method as RpcMethod].arity) throw new RpcError('INVALID_REQUEST', 'Invalid argument arity');
  return { method, args };
}

export function statusFor(code: string): number {
  if (code === 'INVALID_HOST' || code === 'INVALID_ORIGIN' || code === 'INVALID_FETCH_SITE') return 403;
  if (code === 'METHOD_NOT_ALLOWED') return 405;
  if (code === 'UNSUPPORTED_MEDIA_TYPE') return 415;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'APP_STARTING' || code === 'APP_DRAINING') return 503;
  if (code === 'REVISION_CONFLICT' || code === 'QUOTA_POLICY_CONFLICT') return 409;
  if (code === 'INTERNAL_ERROR' || code === 'PERSISTENCE_ERROR') return 500;
  return 400;
}
