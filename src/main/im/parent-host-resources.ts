import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defaultAsyncRunner, type AsyncRunner, type RunnerResult } from '../owner-host';
import { atomicReplaceFile } from './atomic-file';
import { parentError } from './parent-agent';

export const resourceError = () => parentError('engine', 'Bot host resource ownership or cleanup could not be confirmed');
export const bootIdentity = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
export function processStart(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19]; } catch { return undefined; }
}
export interface HostRecord {
  version: 1; epoch: string; unit: string; createdAt: string; ownerPid: number; ownerStart: string; boot: string;
  endpoint: string; label: string; launched: boolean;
  /** Absent means the legacy Herdr lane lifecycle. 'background' skips Herdr lane/server actions only. */
  launchMode?: 'background';
  server?: { socket: string; identity: string };
  allocating?: boolean; closing?: boolean;
  lane?: { workspaceId?: string; tabId?: string; paneId?: string; createdWorkspace: boolean };
  invocation?: string; cgroup?: string; mainPid?: number; mainStart?: string;
}
/**
 * Validate the launch mode before any destructive action. Legacy records omit
 * launchMode and keep exact Herdr lane/server cleanup. Background records must
 * carry no legacy lane/server/allocating fields; anything else is untrusted
 * and must never skip ownership checks.
 */
export function recordLaunchKind(record: HostRecord): 'background' | 'herdr' {
  const mode: unknown = record.launchMode;
  if (mode === undefined) return 'herdr';
  if (mode !== 'background') throw resourceError();
  if (record.lane !== undefined || record.server !== undefined || record.allocating) throw resourceError();
  return 'background';
}
export function saveHostRecord(dir: string, record: HostRecord): void {
  atomicReplaceFile(join(dir, 'record.json'), JSON.stringify(record), resourceError);
}
export async function resourceRun(file: string, args: string[], runner: AsyncRunner = defaultAsyncRunner): Promise<RunnerResult> {
  return runner({ file, args, timeout: 12_000 });
}
function decode(result: RunnerResult): any {
  try { return JSON.parse(result.stdout || result.stderr); } catch { throw resourceError(); }
}
export async function herdrServer(runner?: AsyncRunner): Promise<{ socket: string; identity: string }> {
  const result = await resourceRun('herdr', ['--session', 'default', 'status', 'server', '--json'], runner);
  const value = decode(result);
  const server = value.result ?? value;
  if (result.code !== 0 || !server.running || typeof server.socket !== 'string') throw resourceError();
  const info = lstatSync(server.socket, { bigint: true });
  if (!info.isSocket() || info.uid !== BigInt(process.getuid!())) throw resourceError();
  return { socket: server.socket, identity: `${info.dev}:${info.ino}:${info.ctimeNs}` };
}
export async function inspectHostUnit(record: HostRecord, runner?: AsyncRunner): Promise<Record<string, string> | undefined> {
  const result = await resourceRun('systemctl', ['--user', 'show', record.unit, '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'InvocationID', '-p', 'MainPID', '-p', 'ControlGroup', '--no-pager'], runner);
  const info = Object.fromEntries(result.stdout.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (info.LoadState === 'not-found') return undefined;
  if (result.code !== 0 || info.Id !== record.unit || !info.ActiveState) throw resourceError();
  if (record.invocation && info.InvocationID && record.invocation !== info.InvocationID) throw resourceError();
  if (info.ActiveState === 'inactive' || info.ActiveState === 'failed') {
    if (info.ControlGroup && existsSync(join('/sys/fs/cgroup', info.ControlGroup))) throw resourceError();
    return undefined;
  }
  if (record.boot !== bootIdentity()) throw resourceError();
  if (!info.InvocationID || !/^[0-9]+$/.test(info.MainPID)) throw resourceError();
  if (record.cgroup && info.ControlGroup && record.cgroup !== info.ControlGroup) throw resourceError();
  if (!record.invocation && (!info.ControlGroup || info.MainPID === '0')) throw resourceError();
  if (!record.invocation) {
    // A crash before receipt persistence still requires the exact internal entry + epoch + endpoint.
    let argv: string[];
    try { argv = readFileSync(`/proc/${info.MainPID}/cmdline`, 'utf8').split('\0'); } catch { throw resourceError(); }
    const marker = argv.indexOf('__weaver-im-parent-host');
    if (marker < 0 || argv[marker + 1] !== record.endpoint || argv[marker + 2] !== record.epoch || record.boot !== bootIdentity()) throw resourceError();
  }
  const pid = Number(info.MainPID);
  const currentStart = pid ? processStart(pid) : undefined;
  if (record.mainPid && ((pid && record.mainPid !== pid) || currentStart && record.mainStart !== currentStart)) throw resourceError();
  return info;
}
async function closeLane(record: HostRecord, runner?: AsyncRunner): Promise<void> {
  // Background mode has no Herdr surface by construction (validated above); skip without touching Herdr.
  if (recordLaunchKind(record) === 'background') return;
  const lane = record.lane;
  if (!lane) { if (record.launched || record.allocating) throw resourceError(); return; }
  const kind = lane.tabId ? 'tab' : lane.createdWorkspace && lane.workspaceId ? 'workspace' : undefined;
  const id = lane.tabId ?? lane.workspaceId;
  if (!kind || !id) throw resourceError();
  const get = () => resourceRun('herdr', ['--session', 'default', kind, 'get', id], runner);
  const before = await get(); const parsed = decode(before);
  if (parsed.error?.code === `${kind}_not_found`) return;
  if (before.code !== 0 || parsed.error || !record.server) throw resourceError();
  const server = await herdrServer(runner);
  if (server.socket !== record.server.socket || server.identity !== record.server.identity) throw resourceError();
  const metadata = parsed.result?.[kind];
  if (!metadata || metadata.workspace_id !== lane.workspaceId || (kind === 'tab' && metadata.tab_id !== lane.tabId)) throw resourceError();
  await resourceRun('herdr', ['--session', 'default', kind, 'close', id], runner);
  const after = decode(await get());
  if (after.error?.code !== `${kind}_not_found`) throw resourceError();
}
/** Stop only a verified invocation. Successful return proves the whole cgroup and exact owned lane are gone. */
export async function cleanupHostRecord(dir: string, record: HostRecord, runner?: AsyncRunner): Promise<void> {
  // Reject unknown or contradictory modes before mutating the journal or touching any resource.
  recordLaunchKind(record);
  record.closing = true; saveHostRecord(dir, record);
  // Revoke pairing before touching the launch surface. A delayed service also has a socket condition.
  try {
    const endpoint = lstatSync(record.endpoint);
    if (!endpoint.isSocket() || endpoint.uid !== process.getuid?.()) throw resourceError();
    unlinkSync(record.endpoint);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Reject an already replaced unit before manipulating the lane. Persist initial proof before further awaits.
  let info = await inspectHostUnit(record, runner);
  if (info && !record.invocation) {
    record.invocation = info.InvocationID; record.cgroup = info.ControlGroup;
    record.mainPid = Number(info.MainPID); record.mainStart = processStart(record.mainPid);
    saveHostRecord(dir, record);
  }
  // Close the launch surface before final inspection, preventing further pane commands.
  await closeLane(record, runner);
  info = await inspectHostUnit(record, runner);
  if (info) {
    record.invocation ??= info.InvocationID;
    record.cgroup ??= info.ControlGroup;
    record.mainPid ??= Number(info.MainPID);
    record.mainStart ??= processStart(record.mainPid);
    saveHostRecord(dir, record);
    const stopped = await resourceRun('systemctl', ['--user', 'stop', record.unit], runner);
    if (stopped.code !== 0) throw resourceError();
  }
  // The pane is now gone and pairing is revoked; allow queued DBus launch/teardown to settle.
  await new Promise(resolve => setTimeout(resolve, 150));
  info = await inspectHostUnit(record, runner);
  if (info || record.cgroup && existsSync(join('/sys/fs/cgroup', record.cgroup))) throw resourceError();
  rmSync(dir, { recursive: true });
}
export function readHostRecords(root: string): Array<{ dir: string; record: HostRecord }> {
  return readdirSync(root).map(name => {
    if (!/^[0-9a-f-]{36}$/.test(name)) throw resourceError();
    const dir = join(root, name);
    const entry = lstatSync(dir); const file = lstatSync(join(dir, 'record.json'));
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) || !file.isFile() || file.isSymbolicLink() || file.uid !== entry.uid || (file.mode & 0o077) || file.size > 64 * 1024) throw resourceError();
    const record = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as HostRecord;
    if (record.version !== 1 || record.epoch !== name || record.unit !== `weaver-im-host-${name}.service` || record.endpoint !== join(dir, 's') || !Number.isSafeInteger(record.ownerPid) || typeof record.ownerStart !== 'string') throw resourceError();
    // Reject untrusted modes at read time so they can never be treated as skippable background history.
    recordLaunchKind(record);
    return { dir, record };
  });
}
