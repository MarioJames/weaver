import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { QuotaEngine } from '../../shared/contracts/quota';
import { object, readObject } from './credentials';

const MAX_FILE_BYTES = 256 * 1024;
const OFFICIAL_HOST = /(?:^|\.)anthropic\.com$/i;
const CLOUD_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const filled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
const truthy = (value: unknown): boolean => value === true || typeof value === 'string' && /^(?:1|true|yes|on)$/i.test(value.trim());

/**
 * Claude Code: cc-switch (and a hand-edited setup) points the CLI at another provider through the
 * `env` block of settings.json. Only key names and the base-URL host are examined; no token value is read out.
 * The Weaver process environment is deliberately ignored: it says nothing about what the CLI itself will use.
 */
async function claudeThirdParty(env: NodeJS.ProcessEnv): Promise<boolean> {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || homedir(), '.claude');
  for (const name of ['settings.json', 'settings.local.json']) {
    let root;
    try { root = await readObject(path.join(dir, name)); } catch { continue; }
    const block = object(root.env);
    if (!block) continue;
    if (filled(block.ANTHROPIC_AUTH_TOKEN) || filled(block.ANTHROPIC_API_KEY)) return true;
    if (CLOUD_FLAGS.some(key => truthy(block[key]))) return true;
    const base = block.ANTHROPIC_BASE_URL;
    if (filled(base)) {
      try { if (!OFFICIAL_HOST.test(new URL(String(base).trim()).hostname)) return true; }
      catch { return true; }
    }
  }
  return false;
}

async function readText(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES * 4) return undefined;
    return (await handle.readFile({ encoding: 'utf8' }));
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}

/** The `model_provider` key of a codex config.toml. It must sit before the first table header. */
export function codexModelProvider(toml: string): string | undefined {
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) return undefined;
    const match = /^model_provider\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')\s*(?:#.*)?$/.exec(line);
    if (match) return (match[1] ?? match[2]).trim();
  }
  return undefined;
}

/** Codex: a `model_provider` other than the built-in `openai` (which cc-switch writes for third-party relays) bypasses the ChatGPT login. */
async function codexThirdParty(env: NodeJS.ProcessEnv): Promise<boolean> {
  const dir = env.CODEX_HOME || path.join(env.HOME || homedir(), '.codex');
  const text = await readText(path.join(dir, 'config.toml'));
  if (text === undefined) return false;
  const provider = codexModelProvider(text);
  return provider !== undefined && provider !== '' && provider !== 'openai';
}

/** True when the engine's CLI is currently set up for a provider whose usage the native quota endpoint cannot describe. */
export async function usesThirdPartyProvider(engine: QuotaEngine, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (engine === 'claude') return claudeThirdParty(env);
  if (engine === 'codex') return codexThirdParty(env);
  return false;
}
