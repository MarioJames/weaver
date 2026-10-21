import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { absoluteExistingWorkspace } from '../workspace';

export class ImWorkspacesError extends Error {
  constructor(readonly code: 'IM_WORKSPACES_INVALID' | 'IM_WORKSPACES_UNAVAILABLE') {
    super('IM workspaces must be distinct existing project directories outside credential state.');
  }
}

/** Structural validation only: missing/moved directories remain visible for correction after load. */
export function parseImWorkspaces(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new ImWorkspacesError('IM_WORKSPACES_INVALID');
  const paths = Array.from(value, path => {
    if (typeof path !== 'string' || !path || path.length > 2000 || path.trim() !== path || /[\x00-\x1f\x7f]/.test(path) || !isAbsolute(path)) throw new ImWorkspacesError('IM_WORKSPACES_INVALID');
    return path;
  });
  if (new Set(paths).size !== paths.length) throw new ImWorkspacesError('IM_WORKSPACES_INVALID');
  return paths;
}

function inside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path));
}

function credentialRoots(): string[] {
  const home = homedir();
  // Same shield as parent/CLI launchers; custom native config homes are protected too. No contents read.
  const lexical = ['.codex', '.claude', '.grok', '.pi', '.opencode', '.qoder', '.qoder-cli', '.zcode', '.ssh'].map(name => join(home, name)).concat([
    join(home, '.config', 'opencode'), join(home, '.config', 'agents-cooperation'),
    ...[process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].filter((p): p is string => !!p).map(p => resolve(p)),
  ]);
  // Keep the spelling even for absent roots, and additionally shield each existing root's target.
  // Only path metadata is resolved: no credential files or directory contents are read.
  return [...new Set(lexical.flatMap(root => {
    try { return [root, realpathSync(root)]; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [root];
      throw new ImWorkspacesError('IM_WORKSPACES_UNAVAILABLE');
    }
  }))];
}

/** Recheck at every save and immediately before launch. Never creates input paths or reads their contents. */
export function resolveImWorkspaces(value: unknown, required = true): string[] {
  const paths = parseImWorkspaces(value);
  if (!paths.length) {
    if (required) throw new ImWorkspacesError('IM_WORKSPACES_INVALID');
    return [];
  }
  const roots = credentialRoots();
  const rejectCredentials = (path: string) => {
    if (roots.some(root => inside(path, root))) throw new ImWorkspacesError('IM_WORKSPACES_INVALID');
  };
  const canonical = paths.map(path => {
    rejectCredentials(resolve(path));
    let resolved: string;
    try { resolved = absoluteExistingWorkspace(path); }
    catch { throw new ImWorkspacesError('IM_WORKSPACES_UNAVAILABLE'); }
    rejectCredentials(resolved);
    return resolved;
  });
  // Also bound the resolved spelling, and reject symlink/relative-spelling aliases of the same directory.
  return parseImWorkspaces(canonical);
}
