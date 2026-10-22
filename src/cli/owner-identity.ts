import { LocalIPCError, readPrivateFile } from '../main/local-ipc';

/** The logical owner identity one CLI process acts as: a durable owner row plus its private credential. */
export interface OwnerAuth {
  ownerId: string;
  token: string;
}

const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_TOKEN = /^[a-f0-9]{64}$/;

export function assertOwnerAuth(value: unknown): OwnerAuth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalIPCError('INVALID_ARGUMENT', 'ownerAuth must be an object with ownerId and token');
  const record = value as Record<string, unknown>;
  if (typeof record.ownerId !== 'string' || !OWNER_ID.test(record.ownerId)) throw new LocalIPCError('INVALID_ARGUMENT', 'ownerAuth.ownerId must be a UUID');
  if (typeof record.token !== 'string' || !OWNER_TOKEN.test(record.token)) throw new LocalIPCError('INVALID_ARGUMENT', 'ownerAuth.token must be 64 lowercase hex characters');
  return { ownerId: record.ownerId.toLowerCase(), token: record.token };
}

function sameOwnerAuth(left: OwnerAuth, right: OwnerAuth): boolean {
  return left.ownerId === right.ownerId && left.token === right.token;
}

/**
 * Read the private `{version:1,ownerId,token}` file through the same ownership, permission,
 * symlink and size checks as the control endpoint. Errors never echo the file body.
 */
export async function readOwnerCredential(path: string): Promise<OwnerAuth> {
  let text: string;
  try {
    text = await readPrivateFile(path);
  } catch (error) {
    if (error instanceof LocalIPCError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new LocalIPCError('INVALID_ARGUMENT', `Owner credential file not found: ${path}`);
    if (code === 'ELOOP') throw new LocalIPCError('UNSAFE_ENDPOINT', `Owner credential file must be a regular file, not a symbolic link: ${path}`);
    throw new LocalIPCError('INVALID_ARGUMENT', `Owner credential file could not be read (${code ?? 'error'}): ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LocalIPCError('INVALID_ARGUMENT', 'Owner credential file must contain valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LocalIPCError('INVALID_ARGUMENT', 'Owner credential file must contain a JSON object');
  if ((parsed as Record<string, unknown>).version !== 1) throw new LocalIPCError('INVALID_ARGUMENT', 'Owner credential file must declare version 1');
  return assertOwnerAuth(parsed);
}

/** Put the credential on the logical request envelope only; args carry command fields. */
export function applyOwnerAuth(request: Record<string, unknown>, ownerAuth: OwnerAuth | undefined): void {
  const existing = request.ownerAuth;
  if (existing !== undefined) {
    const carried = assertOwnerAuth(existing);
    if (!ownerAuth) { request.ownerAuth = carried; return; }
    if (!sameOwnerAuth(carried, ownerAuth)) throw new LocalIPCError('INVALID_ARGUMENT', 'Input ownerAuth conflicts with --owner-file');
    request.ownerAuth = ownerAuth;
    return;
  }
  if (ownerAuth) request.ownerAuth = { ownerId: ownerAuth.ownerId, token: ownerAuth.token };
}

/** A request value that is not an envelope must not smuggle ownerAuth through args. */
export function rejectOwnerAuthArg(args: Record<string, unknown>): void {
  if (args.ownerAuth !== undefined) throw new LocalIPCError('INVALID_ARGUMENT', 'ownerAuth belongs at the request top level, not in args; pass --owner-file');
}
