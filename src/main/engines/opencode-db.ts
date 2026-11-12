import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** OpenCode 2.2 moved inference credentials from auth.json into this table. */
export interface OpenCodeCredential {
  id: string;
  integrationID: string;
  label: string;
  active: boolean;
  type: 'key' | 'oauth' | 'external';
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  metadata?: Record<string, unknown>;
}

const MAX_TOKEN = 16384;
const text = (value: unknown, max = MAX_TOKEN): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value) ? value : undefined;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function openCodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCODE_DB;
  if (override === ':memory:' || (override && path.isAbsolute(override))) return override;
  const home = env.HOME || homedir();
  const dataDir = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== '' ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return path.join(dataDir, 'opencode', override || 'opencode.db');
}

function database(file: string): DatabaseSync | undefined {
  try {
    if (file === ':memory:') return new DatabaseSync(file);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) return;
    return new DatabaseSync(file, { readOnly: true });
  } catch { return; }
}

/** Reads credential rows from an OpenCode 2.2 database. Returns undefined when the file/schema is unusable. */
export function readOpenCodeCredentials(file: string): OpenCodeCredential[] | undefined {
  const db = database(file);
  if (!db) return;
  try {
    const rows = db.prepare(
      'SELECT id, integration_id, label, value, active, time_created FROM credential ORDER BY active DESC, time_created DESC, id DESC',
    ).all() as Array<Record<string, unknown>>;
    const credentials: OpenCodeCredential[] = [];
    for (const row of rows) {
      const id = text(row.id, 256);
      const integrationID = text(row.integration_id, 256);
      const label = typeof row.label === 'string' && row.label.length > 0 && row.label.length <= 256 && !/[\x00-\x1f\x7f]/.test(row.label) ? row.label : undefined;
      if (!id || !integrationID || !label || typeof row.value !== 'string' || row.value.length > 64 * 1024) continue;
      let value: Record<string, unknown>;
      try { value = object(JSON.parse(row.value)) ?? {}; } catch { continue; }
      if (value.type !== 'key' && value.type !== 'oauth' && value.type !== 'external') continue;
      const credential: OpenCodeCredential = {
        id, integrationID, label, active: row.active === 1 || row.active === true, type: value.type,
      };
      if (value.type === 'key') {
        const key = text(value.key);
        if (!key) continue;
        credential.key = key;
      } else if (value.type === 'oauth') {
        const access = text(value.access);
        const refresh = typeof value.refresh === 'string' && value.refresh.length <= MAX_TOKEN ? value.refresh : undefined;
        const expires = typeof value.expires === 'number' && Number.isSafeInteger(value.expires) && value.expires >= 0 ? value.expires : undefined;
        if (!access) continue;
        credential.access = access;
        if (refresh !== undefined) credential.refresh = refresh;
        if (expires !== undefined) credential.expires = expires;
      }
      const metadata = object(value.metadata);
      if (metadata) credential.metadata = metadata;
      credentials.push(credential);
    }
    return credentials;
  } catch {
    return;
  } finally { db.close(); }
}

export function openCodeGoCredential(file: string): OpenCodeCredential | undefined {
  return readOpenCodeCredentials(file)?.find(row => row.integrationID === 'opencode-go' && (row.type === 'key' || row.type === 'oauth'));
}
