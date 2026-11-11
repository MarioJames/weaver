import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { findExecutableSync } from '../../system/executables';

/** The opencode on PATH could not be identified as a supported major version. */
export class OpencodeVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpencodeVersionError';
  }
}

const SUPPORTED = new Set([1, 2]);
const PROBE_TIMEOUT_MS = 10_000;
/** Keyed by resolved path, mtime and size, so replacing the binary in place (an upgrade) is probed again. */
const cache = new Map<string, number>();

/**
 * Major version of the `opencode` found on `pathEnv` (v1 prints `1.19.3`, v2 prints `opencode v2.2.6`).
 * The CLI changed incompatibly between 1 and 2 (variant, directory and plugin flags), so the launcher
 * must know which one it is about to run. Anything that is not v1 or v2 is an error rather than a guess.
 */
export function opencodeMajor(pathEnv: string = process.env.PATH ?? ''): number {
  const binary = findExecutableSync('opencode', pathEnv);
  if (!binary) throw new OpencodeVersionError('opencode CLI was not found on PATH; cannot choose between opencode v1 and v2 flags');
  const stat = statSync(binary);
  const key = `${binary}\0${stat.mtimeMs}\0${stat.size}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  let output: string;
  try {
    output = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new OpencodeVersionError(`opencode --version failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); cannot choose between opencode v1 and v2 flags`);
  }
  const match = /(\d+)\.\d+\.\d+/.exec(output);
  if (!match) throw new OpencodeVersionError(`opencode --version printed "${output.trim().slice(0, 80)}", could not read a version; cannot choose between opencode v1 and v2 flags`);
  const major = Number(match[1]);
  if (!SUPPORTED.has(major)) throw new OpencodeVersionError(`opencode ${match[0]} is not supported: Weaver supports opencode v1 and v2`);
  cache.set(key, major);
  return major;
}
