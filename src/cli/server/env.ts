import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { embeddedApp } from '../../main/embedded';
import type { OutputFormat } from '../output';

export type ServerAction = 'status' | 'start' | 'stop' | 'install' | 'uninstall';
export const UNIT_MARKER = 'Managed by weaver server install';

export interface Envelope { apiVersion: string; commandId: string | null; ok: boolean; data?: unknown; error?: { code: string; message: string; retryable?: boolean } }
export interface ServerInfo {
  pid: number;
  url: string;
  port: number;
  dataDir: string;
  version: string;
  startedAt: string;
  runningWorkers: number;
  managedBy: 'systemd' | 'launchd' | null;
}
export interface ServiceState { installed: boolean; manager: 'systemd' | 'launchd' | null; path: string }
export interface RunResult { code: number | null; stdout: string; stderr: string }
export interface ServerArgs { action: ServerAction; port: number; dataDir: string; output: OutputFormat; force: boolean; cancelWorkers: boolean; timeoutMs: number }

/** Everything this module reaches outside itself, so tests never touch systemctl, launchd, or a real home. */
export interface ServerEnv {
  platform: string;
  home: string;
  env: Record<string, string | undefined>;
  uid: number;
  pid: number;
  standalone: boolean;
  execPath: string;
  execArgv: readonly string[];
  entryPath: string;
  cwd: string;
  defaultPort: number;
  defaultDataDir: string;
  request(dataDir: string, payload: unknown, timeoutMs: number): Promise<Envelope>;
  output(format: OutputFormat, envelope: Envelope): void;
  run(file: string, args: readonly string[]): Promise<RunResult>;
  spawnServer(command: readonly string[], dataDir: string, logPath: string): Promise<{ code: number | null }>;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}


export function serverEnv(links: { request: ServerEnv['request']; output: ServerEnv['output']; defaultPort: number; defaultDataDir: string }, overrides: Partial<ServerEnv> = {}): ServerEnv {
  const base: ServerEnv = {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    uid: process.getuid?.() ?? 0,
    pid: process.pid,
    standalone: Boolean(embeddedApp()),
    execPath: process.execPath,
    execArgv: process.execArgv,
    entryPath: process.argv[1] ?? '',
    cwd: process.cwd(),
    defaultPort: links.defaultPort,
    defaultDataDir: links.defaultDataDir,
    request: links.request,
    output: links.output,
    run: (file, args) => new Promise<RunResult>(resolveRun => {
      const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => { stdout += chunk; });
      child.stderr?.on('data', chunk => { stderr += chunk; });
      child.on('error', error => resolveRun({ code: null, stdout, stderr: error.message }));
      child.on('close', code => resolveRun({ code, stdout, stderr }));
    }),
    spawnServer: async (command, dataDir, logPath) => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const log = openSync(logPath, 'a', 0o600);
      try {
        const child = spawn(command[0]!, [...command.slice(1)], { cwd: process.cwd(), detached: true, stdio: ['ignore', log, log], shell: false });
        child.unref();
        return await new Promise<{ code: number | null }>(resolveSpawn => {
          child.on('error', () => resolveSpawn({ code: null }));
          child.on('close', code => resolveSpawn({ code }));
        });
      } finally { closeSync(log); }
    },
    kill: pid => { process.kill(pid, 'SIGTERM'); },
    sleep: ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
    now: () => Date.now(),
  };
  return { ...base, ...overrides };
}
