import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AsyncRunner } from '../../src/main/owner-host';

/** Fake only systemd's host receipt; let the real host drain its engine on stop. */
export function fakeRunnerFactory() {
  let child: ChildProcess | undefined;
  const invocation = `inv-${randomUUID()}`;
  const runner: AsyncRunner = async ({ file, args }) => {
    if (file === 'systemd-run') {
      const cmd = args.slice(args.indexOf('--') + 1);
      child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => {});
      return { code: 0, stdout: '', stderr: '' };
    }
    if (file === 'systemctl' && args[1] === 'show') {
      const alive = !!child && child.exitCode === null && child.signalCode === null;
      if (!alive) return { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive', stderr: '' };
      return { code: 0, stdout: `Id=${args[2]}\nLoadState=loaded\nActiveState=active\nInvocationID=${invocation}\nMainPID=${child!.pid}\nControlGroup=/fake`, stderr: '' };
    }
    if (file === 'systemctl' && args[1] === 'stop') {
      const current = child;
      if (current && current.exitCode === null && current.signalCode === null) {
        // Subscribe before signalling. Killing the host first or accepting a stop ACK
        // leaves resident engines orphaned when no real cgroup manager is involved.
        try {
          const closed = once(current, 'close', { signal: AbortSignal.timeout(10_000) });
          current.kill('SIGTERM');
          await closed;
        } catch (error) {
          if (current.exitCode === null && current.signalCode === null) {
            const closed = once(current, 'close', { signal: AbortSignal.timeout(2000) });
            current.kill('SIGKILL');
            await closed;
          }
          throw error;
        }
      }
      child = undefined;
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected external call: ${file} ${args.join(' ')}`);
  };
  return { runner };
}
