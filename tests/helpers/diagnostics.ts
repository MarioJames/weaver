import type { TaskDiagnostics } from '../../src/main/application/tasks/queries';
import { unblockEngine } from '../../src/main/application/engines/unblock';
import { unblockWorker } from '../../src/main/application/workers/unblock';
import { PolicyBlockService, type BlockPolicy } from '../../src/main/policy/blocks';
import type { StallMonitor } from '../../src/main/stall';

/** What the runtime hands the command face: the monitor's own answers plus the application engine unblock. */
export function engineDiagnostics(policy: BlockPolicy, monitor: StallMonitor, options: { onChanged?: () => void; log?: (message: string) => void } = {}): TaskDiagnostics {
  const blocks = new PolicyBlockService(() => policy, options);
  return {
    taskHealth: task => monitor.taskHealth(task),
    status: () => monitor.status(),
    unblock: engine => unblockEngine({ blocks, stall: monitor }, engine),
    unblockWorker: worker => unblockWorker({ blocks, stall: monitor }, worker),
  };
}
