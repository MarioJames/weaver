import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { TaskDispatch } from '../shared/contracts/tasks';
import type { RealEngineKind } from '../shared/contracts/tasks';

/** Kinds with a real worker launcher. Claude Code stays deferred. */
export const REAL_ENGINE_KINDS = ['opencode', 'pi', 'grok', 'codex', 'qodercli', 'zcode'] as const;

export function isRealEngineKind(kind: string): kind is RealEngineKind {
  return (REAL_ENGINE_KINDS as readonly string[]).includes(kind);
}

/** Absolute existing directory. Relative paths are rejected so the server cwd cannot become the project. */
export function absoluteExistingWorkspace(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000 || !isAbsolute(raw)) {
    throw new Error('Workspace must be an absolute project directory. This server does not substitute its own repository or working directory.');
  }
  let resolved: string;
  try { resolved = realpathSync(raw); }
  catch { throw new Error(`Workspace does not exist: ${raw}. Create the project directory and dispatch again. No model was launched.`); }
  const info = statSync(resolved, { throwIfNoEntry: false });
  if (!info) throw new Error(`Workspace does not exist: ${raw}. Create the project directory and dispatch again. No model was launched.`);
  if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}. No model was launched.`);
  return resolved;
}

export function workspaceIdentity(path: string): string {
  const info = statSync(path);
  return `${info.dev}:${info.ino}`;
}
/** Recheck both canonical path and directory identity immediately before launch. */
export function assertFrozenWorkspace(dispatch: TaskDispatch): void {
  const path = absoluteExistingWorkspace(dispatch.workspace);
  if (path !== dispatch.workspace || (dispatch.workspaceIdentity && workspaceIdentity(path) !== dispatch.workspaceIdentity)) {
    throw new Error('Frozen workspace changed or was replaced; cancel this queued dispatch and create a new task for the intended directory.');
  }
}

/** Local trusted-user directory browser: names and paths only, never file contents. */
export function listWorkspaceDirectories(raw?: unknown) {
  const path = absoluteExistingWorkspace(raw === undefined ? process.cwd() : raw);
  const entries = readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path, parent: dirname(path) === path ? null : dirname(path), directories: entries };
}
