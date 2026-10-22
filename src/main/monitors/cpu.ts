import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunningCommand } from '../../shared/contracts/monitoring';

export interface CpuSample {
  at: number;
  cpu: number | null;
  /** Cumulative CPU of the worker root's process tree, including descendants moved to another cgroup. */
  treeCpu?: number | null;
  /** The oldest live command under the vendor CLI at this sample; null means none was found. */
  command?: RunningCommand | null;
  /** True when that command has outlived herdr.max_command_minutes. */
  commandTimedOut?: boolean;
}
/** Cumulative CPU of one worker scope in nanoseconds, or null when it cannot be read. */
export type CpuReader = (scopeUnit: string) => Promise<number | null>;

function runSystemctl(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile('systemctl', ['--user', ...args], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? '' });
    });
  });
}

function cgroupUsage(controlGroup: string): number | null {
  if (!controlGroup.startsWith('/') || controlGroup.includes('..')) return null;
  let text: string;
  try { text = readFileSync(join('/sys/fs/cgroup', controlGroup, 'cpu.stat'), 'utf8'); } catch { return null; }
  const usage = /^usage_usec (\d+)$/m.exec(text);
  return usage ? Number(usage[1]) * 1000 : null;
}

/** Cumulative scope CPU via systemd, falling back to the cgroup's own counter. */
export const systemdCpuUsage: CpuReader = async scopeUnit => {
  const unit = scopeUnit.endsWith('.scope') ? scopeUnit : `${scopeUnit}.scope`;
  const direct = await runSystemctl(['show', unit, '-p', 'CPUUsageNSec', '--value']);
  const value = direct.stdout.trim();
  if (direct.code === 0 && /^\d+$/.test(value)) return Number(value);
  const group = await runSystemctl(['show', unit, '-p', 'ControlGroup', '--value']);
  if (group.code !== 0) return null;
  return cgroupUsage(group.stdout.trim());
};
