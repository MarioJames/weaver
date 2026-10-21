import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Minimal atomic file replace shared by the private IM stores: the payload is written to a unique random
 * temp file created 0600 with 'wx' and renamed over the target, so readers never see a torn file. Only a
 * temp file this call created is ever cleaned up — 'wx' refusing a name that already exists (EEXIST) means
 * the file was not created here and is left untouched. Single-writer by contract: no cross-process locking
 * is claimed or provided.
 */
export function atomicReplaceFile(path: string, payload: string, ioError: () => Error): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(temp, payload, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // An existing file at the temp name (EEXIST) predates this call and must survive; any other failure
    // may have left a partially written file behind, which this call owns and removes.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { try { unlinkSync(temp); } catch { /* nothing this call created remains */ } }
    throw ioError();
  }
  try {
    renameSync(temp, path);
  } catch {
    try { unlinkSync(temp); } catch { /* best effort; the created temp is removed if possible */ }
    throw ioError();
  }
}
