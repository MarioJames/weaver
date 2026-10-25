import { useSyncExternalStore } from 'react';
import type { HelloInput, HelloResult } from '../../../shared/engines';

export interface HelloRun { running: boolean; startedAt: number; route: string; result?: HelloResult }

/**
 * say hi runs keyed by worker id, outside any component: polling continues when the
 * form switches to another worker, and switching back shows the progress or the answer.
 */
const runs = new Map<string, HelloRun>();
const listeners = new Set<() => void>();
function set(key: string, run: HelloRun): void {
  runs.set(key, run);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useHelloRun(key: string): HelloRun | undefined {
  const read = () => runs.get(key);
  return useSyncExternalStore(subscribe, read, read);
}

export async function startHello(key: string, input: HelloInput, route: string, pollMs = 1500): Promise<void> {
  if (runs.get(key)?.running) return;
  const startedAt = Date.now();
  set(key, { running: true, startedAt, route });
  const finish = (result: HelloResult) => set(key, { running: false, startedAt, route, result });
  try {
    let job = await window.weaver.sayHi(input);
    while (job.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      job = await window.weaver.sayHiResult(job.id);
    }
    finish(job.result ?? { ok: false, error: '探测结束但没有结果。', durationMs: Date.now() - startedAt, checkedAt: new Date().toISOString() });
  } catch (error) {
    finish({ ok: false, error: error instanceof Error ? error.message : String(error), durationMs: 0, checkedAt: new Date().toISOString() });
  }
}

/** Diagnostic identity includes every mutable route field, separate from the role's policy. */
export function helloRouteKey(role: string, route: Pick<HelloInput, 'channel' | 'model' | 'effort'>): string {
  return JSON.stringify([role, route.channel, route.model.trim(), route.effort.trim()]);
}
