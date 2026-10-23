import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseImWorkspaces, resolveImWorkspaces } from './workspaces';
import { atomicReplaceFile } from './atomic-file';
import { ImBootstrapBudgetError, validateImInstructionBudget } from './bootstrap';
import { object } from '../../shared/validation';
import type { ImConfig, SaveImSettingsInput } from '../../shared/contracts/im';

/**
 * The private settings store: one 0600 JSON file per data directory, replaced atomically. Writing is
 * single-writer by contract: save() re-reads the on-disk revision before its check, so two already
 * initialized instances in one process save strictly in sequence and a stale expectedRevision is rejected
 * with IM_SETTINGS_CONFLICT instead of clobbering the newer file. No cross-process lock exists and none is
 * claimed: two OS processes writing the same file concurrently are outside the contract. Secrets live only
 * here and in the private stored type — never in a public DTO, a snapshot, an error message or a log line.
 * Every failure mode is fail closed: a corrupt or unreadable file never falls back to defaults and is never
 * overwritten, and a failed save leaves memory untouched.
 */

/** What the store actually keeps: the full config including the secret itself. */
export type StoredImConfig = Omit<ImConfig, 'appSecretConfigured'> & { appSecret: string };

export interface StoredImSettings { revision: number; config: StoredImConfig }

/** Fixed safe error codes. Messages are static: no paths, no input values, no underlying Error.message. */
export type ImSettingsErrorCode = 'IM_SETTINGS_CORRUPT' | 'IM_SETTINGS_CONFLICT' | 'IM_SETTINGS_INVALID' | 'IM_SETTINGS_IO' | 'IM_BOOTSTRAP_TOO_LARGE';

export class ImSettingsError extends Error {
  constructor(readonly code: ImSettingsErrorCode, message: string) { super(message); this.name = 'ImSettingsError'; }
}

// The revision starts at 0: the first successful save passes expectedRevision 0 and produces revision 1.
const INITIAL_REVISION = 0;
const VERSION = 4;
const DEFAULT_IDLE_MINUTES = 30;
const APP_ID_MAX = 128;
const SECRET_MAX = 512;
const OPEN_ID_MAX = 128;
const OPEN_IDS_MAX = 1000;
const ENGINE_MAX = 128;
const MODEL_MAX = 200;
const EFFORT_MAX = 32;
const IDLE_MINUTES_MIN = 1;
const IDLE_MINUTES_MAX = 1440;

const APP_ID_RE = /^[A-Za-z0-9_-]+$/;
const OPEN_ID_RE = /^[A-Za-z0-9_-]+$/;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const OWNER_PROFILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const OWNER_PROFILE_ID_MAX = 128;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const EFFORT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

const CONFIG_KEYS = ['enabled', 'appId', 'allowedOpenIds', 'engine', 'model', 'effort', 'workspaces', 'idleTimeoutMinutes', 'ownerProfileId'] as const;
const STORED_CONFIG_KEYS = [...CONFIG_KEYS, 'appSecret'] as const;
const FILE_KEYS = ['version', 'revision', 'config'] as const;
const INPUT_KEYS = ['expectedRevision', 'config'] as const;

const defaultConfig = (): StoredImConfig => ({
  enabled: false, appId: '', appSecret: '', allowedOpenIds: [], engine: '', model: '', effort: 'medium', workspaces: [], idleTimeoutMinutes: DEFAULT_IDLE_MINUTES, ownerProfileId: '',
});

const emptySettings = (): StoredImSettings => ({ revision: INITIAL_REVISION, config: defaultConfig() });

const copy = (settings: StoredImSettings): StoredImSettings => structuredClone(settings);

/** Rejects objects with unknown fields, with the error kind the caller names (input vs stored file). */
function exactObject(value: unknown, keys: readonly string[], what: string, code: ImSettingsErrorCode): Record<string, unknown> {
  let item: Record<string, unknown>;
  try { item = object(value); }
  catch { throw new ImSettingsError(code, `${what} is malformed`); }
  for (const key of Object.keys(item)) if (!keys.includes(key)) throw new ImSettingsError(code, `${what} has unsupported fields`);
  return item;
}

function boundedText(value: unknown, what: string, max: number, code: ImSettingsErrorCode): string {
  if (typeof value !== 'string' || value.length > max || CONTROL_CHARS.test(value) || value.trim() !== value) throw new ImSettingsError(code, `${what} is malformed`);
  return value;
}

function boundedPattern(value: unknown, what: string, max: number, pattern: RegExp, code: ImSettingsErrorCode): string {
  const text = boundedText(value, what, max, code);
  if (text !== '' && !pattern.test(text)) throw new ImSettingsError(code, `${what} is malformed`);
  return text;
}

function storedWorkspaces(value: unknown, code: ImSettingsErrorCode): string[] {
  try { return parseImWorkspaces(value); }
  catch { throw new ImSettingsError(code, 'IM settings workspaces are malformed'); }
}

function storedOwnerProfileId(value: unknown, code: ImSettingsErrorCode): string {
  const text = boundedText(value, 'IM settings ownerProfileId', OWNER_PROFILE_ID_MAX, code);
  if (text !== '' && !OWNER_PROFILE_ID_RE.test(text)) throw new ImSettingsError(code, 'IM settings ownerProfileId is malformed');
  return text;
}

/** Validates the on-disk (or in-memory) stored config; every field must be present and well formed. */
function parseStoredConfig(value: unknown, code: ImSettingsErrorCode): StoredImConfig {
  const item = exactObject(value, STORED_CONFIG_KEYS, 'IM settings config', code);
  if (typeof item.enabled !== 'boolean') throw new ImSettingsError(code, 'IM settings enabled is malformed');
  const idle = item.idleTimeoutMinutes;
  if (typeof idle !== 'number' || !Number.isInteger(idle) || idle < IDLE_MINUTES_MIN || idle > IDLE_MINUTES_MAX) throw new ImSettingsError(code, 'IM settings idleTimeoutMinutes is malformed');
  if (!Array.isArray(item.allowedOpenIds) || item.allowedOpenIds.length > OPEN_IDS_MAX) throw new ImSettingsError(code, 'IM settings allowedOpenIds is malformed');
  const openIds = item.allowedOpenIds.map(id => {
    if (typeof id !== 'string' || id === '' || id.length > OPEN_ID_MAX || !OPEN_ID_RE.test(id)) throw new ImSettingsError(code, 'IM settings allowedOpenIds is malformed');
    return id;
  });
  if (new Set(openIds).size !== openIds.length) throw new ImSettingsError(code, 'IM settings allowedOpenIds is malformed');
  return {
    enabled: item.enabled,
    appId: boundedPattern(item.appId, 'IM settings appId', APP_ID_MAX, APP_ID_RE, code),
    appSecret: boundedText(item.appSecret, 'IM settings appSecret', SECRET_MAX, code),
    allowedOpenIds: openIds,
    engine: boundedPattern(item.engine, 'IM settings engine', ENGINE_MAX, ID_RE, code),
    model: boundedPattern(item.model, 'IM settings model', MODEL_MAX, MODEL_RE, code),
    effort: boundedPattern(item.effort, 'IM settings effort', EFFORT_MAX, EFFORT_RE, code),
    workspaces: storedWorkspaces(item.workspaces, code),
    idleTimeoutMinutes: idle,
    ownerProfileId: storedOwnerProfileId(item.ownerProfileId, code),
  };
}

/** The public projection: the secret becomes a boolean and nothing else crosses the boundary. */
export function publicImConfig(config: StoredImConfig): ImConfig {
  return {
    enabled: config.enabled,
    appId: config.appId,
    appSecretConfigured: config.appSecret !== '',
    allowedOpenIds: [...config.allowedOpenIds],
    engine: config.engine,
    model: config.model,
    effort: config.effort,
    workspaces: [...config.workspaces],
    idleTimeoutMinutes: config.idleTimeoutMinutes,
    ownerProfileId: config.ownerProfileId,
  };
}

export class ImSettingsStore {
  readonly path: string;
  private cached: StoredImSettings | null = null;

  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, 'im-settings.json');
    try { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); }
    catch { throw new ImSettingsError('IM_SETTINGS_IO', 'IM settings storage is unavailable'); }
  }

  /** The current stored settings, or the defaults when no file exists yet. The copy cannot be used to tamper with the store. */
  current(): StoredImSettings {
    return copy(this.load());
  }

  /**
   * Saves under the strict revision lock and returns the next stored settings. Resolution of `appSecret`:
   * omitted keeps the stored secret, an empty string clears it, a value replaces it. An `appId` change never
   * inherits the old secret: the input must bring a new secret or clear it explicitly. Enabling requires a
   * complete configuration. The revision is re-read from disk before the check, so another instance's earlier
   * save is detected as a conflict. A failed save leaves both the file and memory untouched.
   */
  save(input: SaveImSettingsInput): StoredImSettings {
    this.cached = null;
    const existing = this.load();
    const request = exactObject(input, INPUT_KEYS, 'IM settings input', 'IM_SETTINGS_INVALID');
    if (typeof request.expectedRevision !== 'number' || !Number.isInteger(request.expectedRevision)) throw new ImSettingsError('IM_SETTINGS_INVALID', 'IM settings expectedRevision is malformed');
    if (request.expectedRevision !== existing.revision) throw new ImSettingsError('IM_SETTINGS_CONFLICT', 'IM settings were changed elsewhere; reload and retry');

    const raw = exactObject(request.config, STORED_CONFIG_KEYS, 'IM settings input config', 'IM_SETTINGS_INVALID');
    const enabled = raw.enabled;
    if (typeof enabled !== 'boolean') throw new ImSettingsError('IM_SETTINGS_INVALID', 'IM settings enabled is malformed');
    if (typeof raw.idleTimeoutMinutes !== 'number' || !Number.isInteger(raw.idleTimeoutMinutes) || raw.idleTimeoutMinutes < IDLE_MINUTES_MIN || raw.idleTimeoutMinutes > IDLE_MINUTES_MAX) throw new ImSettingsError('IM_SETTINGS_INVALID', 'IM settings idleTimeoutMinutes is malformed');
    if (!Array.isArray(raw.allowedOpenIds) || raw.allowedOpenIds.length > OPEN_IDS_MAX) throw new ImSettingsError('IM_SETTINGS_INVALID', 'IM settings allowedOpenIds is malformed');
    const openIds = raw.allowedOpenIds.map(id => {
      if (typeof id !== 'string' || id === '' || id.length > OPEN_ID_MAX || !OPEN_ID_RE.test(id)) throw new ImSettingsError('IM_SETTINGS_INVALID', 'IM settings allowedOpenIds is malformed');
      return id;
    });
    if (new Set(openIds).size !== openIds.length) throw new ImSettingsError('IM_SETTINGS_INVALID', 'IM settings allowedOpenIds is malformed');

    const appId = boundedPattern(raw.appId, 'IM settings appId', APP_ID_MAX, APP_ID_RE, 'IM_SETTINGS_INVALID');
    const engine = boundedPattern(raw.engine, 'IM settings engine', ENGINE_MAX, ID_RE, 'IM_SETTINGS_INVALID');
    const model = boundedPattern(raw.model, 'IM settings model', MODEL_MAX, MODEL_RE, 'IM_SETTINGS_INVALID');
    const effort = boundedPattern(raw.effort, 'IM settings effort', EFFORT_MAX, EFFORT_RE, 'IM_SETTINGS_INVALID');
    const ownerProfileId = storedOwnerProfileId(raw.ownerProfileId, 'IM_SETTINGS_INVALID');
    // A saved, structurally valid directory may have disappeared or become protected. Turning the
    // Bot off must remain possible; only an identical CAS-baseline list can skip live resolution.
    const requestedWorkspaces = storedWorkspaces(raw.workspaces, 'IM_SETTINGS_INVALID');
    const unchangedWorkspaces = JSON.stringify(requestedWorkspaces) === JSON.stringify(existing.config.workspaces);
    let workspaces: string[];
    try { workspaces = !enabled && unchangedWorkspaces ? requestedWorkspaces : resolveImWorkspaces(requestedWorkspaces, enabled); }
    catch { throw new ImSettingsError('IM_SETTINGS_INVALID', 'IM settings workspaces are unavailable or malformed'); }

    // Secret semantics: keep, clear, or replace — an appId change forces an explicit decision.
    let appSecret: string;
    if (raw.appSecret === undefined) {
      if (appId !== existing.config.appId && existing.config.appSecret !== '') throw new ImSettingsError('IM_SETTINGS_INVALID', 'IM settings require a new appSecret or an explicit clear when appId changes');
      appSecret = existing.config.appSecret;
    } else if (raw.appSecret === '') {
      appSecret = '';
    } else {
      // Exactly the parseStoredConfig rule: a secret a fresh store could not read back is never written,
      // so a save that reports success can never reopen as IM_SETTINGS_CORRUPT.
      appSecret = boundedText(raw.appSecret, 'IM settings appSecret', SECRET_MAX, 'IM_SETTINGS_INVALID');
    }

    if (enabled && (appId === '' || appSecret === '' || engine === '' || model === '' || effort === '' || openIds.length === 0 || workspaces.length === 0))
      throw new ImSettingsError('IM_SETTINGS_INVALID', 'IM settings require appId, appSecret, engine, model, effort, allowlist and workspaces to enable');

    if (enabled || !unchangedWorkspaces) {
      try { validateImInstructionBudget(this.dataDir, workspaces, ownerProfileId); }
      catch { throw new ImSettingsError('IM_BOOTSTRAP_TOO_LARGE', new ImBootstrapBudgetError().message); }
    }

    const next: StoredImSettings = { revision: existing.revision + 1, config: { enabled, appId, appSecret, allowedOpenIds: openIds, engine, model, effort, workspaces, idleTimeoutMinutes: raw.idleTimeoutMinutes as number, ownerProfileId } };
    this.write(next);
    this.cached = next;
    return copy(next);
  }

  /** Loads once per process; a missing file yields the defaults, anything unreadable or malformed fails closed. */
  private load(): StoredImSettings {
    if (this.cached) return this.cached;
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.cached = emptySettings(); return this.cached; }
      throw new ImSettingsError('IM_SETTINGS_IO', 'IM settings could not be read');
    }
    try { chmodSync(this.path, 0o600); } catch { /* hardening only; the save path enforces the mode. */ }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new ImSettingsError('IM_SETTINGS_CORRUPT', 'IM settings storage is corrupt'); }
    const file = exactObject(parsed, FILE_KEYS, 'IM settings file', 'IM_SETTINGS_CORRUPT');
    if (file.version !== VERSION && file.version !== 2 && file.version !== 3) throw new ImSettingsError('IM_SETTINGS_CORRUPT', 'IM settings storage is corrupt');
    if (typeof file.revision !== 'number' || !Number.isInteger(file.revision) || file.revision < 0) throw new ImSettingsError('IM_SETTINGS_CORRUPT', 'IM settings storage is corrupt');
    // v2/v3 are normalized in memory only: reading never changes bytes or revision. The next successful
    // CAS save atomically writes v4 and increments once, preserving all private config fields.
    // v2 accepts only the original v2 key set (singular workspace, no ownerProfileId);
    // v3 accepts only the original v3 key set (no ownerProfileId). Either key present
    // where it did not exist is IM_SETTINGS_CORRUPT, never a tolerant default.
    let config = file.config;
    if (file.version === 2) {
      const legacyKeys: string[] = [...STORED_CONFIG_KEYS.filter(key => key !== 'workspaces' && key !== 'ownerProfileId'), 'workspace'];
      const legacy = exactObject(config, legacyKeys, 'IM settings config', 'IM_SETTINGS_CORRUPT');
      const { workspace, ...rest } = legacy;
      if (typeof workspace !== 'string') throw new ImSettingsError('IM_SETTINGS_CORRUPT', 'IM settings workspace is malformed');
      config = { ...rest, workspaces: workspace === '' ? [] : [workspace], ownerProfileId: '' };
    } else if (file.version === 3) {
      const v3Keys: string[] = STORED_CONFIG_KEYS.filter(key => key !== 'ownerProfileId');
      const current = exactObject(config, v3Keys, 'IM settings config', 'IM_SETTINGS_CORRUPT');
      config = { ...current, ownerProfileId: '' };
    }
    this.cached = { revision: file.revision, config: parseStoredConfig(config, 'IM_SETTINGS_CORRUPT') };
    return this.cached;
  }

  /** Atomic replace via the shared helper: a unique 0600 temp file per call, renamed over the target. */
  private write(settings: StoredImSettings): void {
    const payload = `${JSON.stringify({ version: VERSION, revision: settings.revision, config: settings.config }, null, 2)}\n`;
    atomicReplaceFile(this.path, payload, () => new ImSettingsError('IM_SETTINGS_IO', 'IM settings could not be saved'));
  }
}
