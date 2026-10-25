export { RpcError, parseRpcBody } from '../shared/contracts/rpc';

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
