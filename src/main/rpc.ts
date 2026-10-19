/** Browser and Unix method calls share this allowlist. There is no reflective dispatch. */
const ARITY: Record<string, number> = Object.create(null);
Object.assign(ARITY, {
  command: 1,
  getPolicy: 0,
  validatePolicy: 1,
  savePolicy: 1,
  previewRoute: 1,
  scanEngines: 0,
  getQuota: 0,
  refreshQuota: 1,
  sayHi: 1,
  setEngineEnabled: 1,
  listTasks: 0,
  createTask: 1,
  startTask: 1,
  cancelTask: 1,
  capabilities: 0,
});

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

export function parseRpcBody(value: unknown): { method: string; args: unknown[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError('INVALID_REQUEST', 'Request must be a JSON object');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.hasOwn(record, 'method') || !Object.hasOwn(record, 'args')) {
    throw new RpcError('INVALID_REQUEST', 'Request must contain only method and args');
  }
  const method = record.method;
  const args = record.args;
  if (typeof method !== 'string' || !Object.hasOwn(ARITY, method)) throw new RpcError('INVALID_REQUEST', 'Unknown method');
  if (!Array.isArray(args) || args.length !== ARITY[method]) throw new RpcError('INVALID_REQUEST', 'Invalid argument arity');
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
