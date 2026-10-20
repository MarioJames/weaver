import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Find a command on PATH without a shell. One rule serves both entry points:
 *  - the name is a bare command name (no path separator, no `..`);
 *  - empty PATH segments are skipped (they would mean "the current directory");
 *  - on Windows each PATHEXT extension is tried in order;
 *  - a candidate must pass the X_OK check and, once symlinks are resolved, be a regular file
 *    (so a directory or a link to one is skipped, and a plain file without the execute bit is not accepted);
 *  - the answer is the resolved real path, or undefined when nothing on PATH qualifies.
 */

/** Extensions tried after the bare name: PATHEXT on Windows, nothing elsewhere. */
export function executableExtensions(platform: NodeJS.Platform = process.platform, pathExt: string | undefined = process.env.PATHEXT): string[] {
  return platform === 'win32' ? (pathExt ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
}

/** Every path worth checking for `name`, in PATH order. Throws on a name that is not a bare command name. */
export function executableCandidates(name: string, pathEnv: string, extensions: string[] = executableExtensions()): string[] {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) throw new Error('Executable name must be a bare command name');
  const candidates: string[] = [];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) candidates.push(path.join(dir, name + extension));
  }
  return candidates;
}

export function findExecutableSync(name: string, pathEnv: string = process.env.PATH ?? ''): string | undefined {
  for (const candidate of executableCandidates(name, pathEnv)) {
    try {
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (statSync(resolved).isFile()) return resolved;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

export async function findExecutable(name: string, pathEnv: string = process.env.PATH ?? ''): Promise<string | undefined> {
  for (const candidate of executableCandidates(name, pathEnv)) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      if ((await stat(resolved)).isFile()) return resolved;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}
