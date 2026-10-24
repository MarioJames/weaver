/** Feishu IM bridge contracts: private settings storage, public snapshots and save input. No secret ever appears in a public DTO. */

/** Full runtime configuration. `appSecretConfigured` is derived: it is true only when a secret is stored privately. */
export interface ImConfig {
  enabled: boolean;
  appId: string;
  appSecretConfigured: boolean;
  allowedOpenIds: string[];
  /** Actual policy channel ID; conversation parameters are independent of owner/worker profiles. */
  channel: string;
  model: string;
  effort: string;
  /** Configured project directories, canonicalized on save; never credential/config state. */
  workspaces: string[];
  idleTimeoutMinutes: number;
  /** Pinned owner profile for dispatch; '' means automatic (policy-based) selection. */
  ownerProfileId: string;
}

/** One owner profile the Bot settings can pin as the dispatch master. No secret ever appears here. */
export interface ImOwnerProfileOption {
  id: string;
  channel: string;
  engine: string;
  engineKind: string;
  model: string;
  effort: string;
  selectable: boolean;
  reason?: 'disabled' | 'channel_disabled' | 'engine_disabled' | 'not_launchable' | 'missing';
}

/** Live bridge status as the UI sees it. `message` is a fixed, safe string, never a vendor error. */
export interface ImStatus {
  agentState: 'disabled' | 'starting' | 'ready' | 'busy' | 'closing' | 'error';
  /** Fixed safe lifecycle message; never an underlying factory/close error. */
  agentMessage?: string;
  connection: 'disabled' | 'connecting' | 'connected' | 'error';
  message?: string;
  activeSessions: number;
  busySessions: number;
  lastMessageAt?: string;
  lastReplyAt?: string;
}

/** What the settings page renders: the public config plus the current revision it was read at. */
export interface ImSettingsSnapshot {
  revision: number;
  config: ImConfig;
  status: ImStatus;
  /** All owner profiles in the current policy (sorted by id), plus a `missing` entry when needed. */
  ownerProfiles: ImOwnerProfileOption[];
}

/**
 * A settings save under strict optimistic locking. `expectedRevision` must match the stored revision.
 * `appSecret` semantics: omitted keeps the stored secret, an empty string clears it, a new value replaces it.
 * Changing `appId` requires an explicit new secret or an explicit clear; the old secret never carries over.
 */
export interface SaveImSettingsInput {
  expectedRevision: number;
  config: Omit<ImConfig, 'appSecretConfigured'> & { appSecret?: string };
}
