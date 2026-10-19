import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../../shared/types';
import type { WorkPackage } from '../../shared/commands';
import { workerInstruction } from './instruction';
import { assertFrozenWorkspace } from '../workspace';
import { isRealEngineKind, type RealEngineKind } from '../workspace';
import type { StartCliAgent } from './launch';
import type { ManagedProcess, WorkerAdapter } from './worker';

/** Production adapter. Mock runs only when the dispatch record says mock. */
export class RoutingWorkerAdapter implements WorkerAdapter {
  readonly id = 'routing';
  constructor(
    private readonly mock: WorkerAdapter,
    private readonly launch: StartCliAgent | undefined,
    private readonly stateRoot: string,
    private readonly packageById: (id: string) => WorkPackage | undefined = () => undefined,
  ) {}
  canLaunchReal(): boolean { return typeof this.launch === 'function'; }
  start(task: Task): ManagedProcess {
    if (task.dispatch?.execution !== 'real') return this.mock.start(task);
    const kind = task.dispatch.engineKind ?? '';
    if (!isRealEngineKind(kind)) throw new Error(`Refusing to launch engine ${task.dispatch.engine}. Mock was not substituted.`);
    if (!this.launch) throw new Error(`Real launcher for ${kind} is not available. Mock was not substituted.`);
    const workspace = task.dispatch.workspace;
    if (!workspace) throw new Error('Real dispatch has no frozen workspace. Mock was not substituted.');
    assertFrozenWorkspace(task.dispatch);
    const pkg = task.packageId ? this.packageById(task.packageId) : undefined;
    if (!pkg) throw new Error('Real dispatch requires its frozen work package');
    const instruction = workerInstruction(task, pkg);
    const stateDir = join(this.stateRoot, task.id);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    return this.launch({
      engine: kind as RealEngineKind,
      model: task.dispatch.model,
      effort: task.dispatch.effort,
      workspace,
      instruction,
      stateDir,
      name: task.id,
      role: 'worker',
    });
  }
}
