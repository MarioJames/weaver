import { useCallback, useEffect, useRef, useState } from 'react';
import type { FreeChannelStatus } from '../../../shared/contracts/monitoring';
import { notifyError } from '../../api/notify';

const POLL_MS = 30_000;

export interface FreeProbe {
  status?: FreeChannelStatus;
  /** True once a read has failed and none has succeeded since; the failure itself is reported by the client. */
  unavailable: boolean;
  /** Workers with an immediate probe in flight. A worker is never probed twice at once. */
  probing: ReadonlySet<string>;
  probeNow: (worker: string) => Promise<void>;
}

/**
 * Probe status lives in the main process and reading it never calls a provider, so a page may poll it.
 * `revision` re-reads after a policy save (the schedule and eligibility depend on it).
 * An immediate probe outlives the panel that started it, so switching workers keeps its loading state.
 */
export function useFreeProbe(revision?: number): FreeProbe {
  const [status, setStatus] = useState<FreeChannelStatus>();
  const [unavailable, setUnavailable] = useState(false);
  const [probing, setProbing] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);
  const running = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let current = true;
    const load = () => { void window.weaver.workerProbeStatus().then(next => { if (current) { setStatus(next); setUnavailable(false); } }).catch(() => { if (current) setUnavailable(true); }); };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { current = false; clearInterval(timer); };
  }, [revision]);
  const probeNow = useCallback(async (worker: string) => {
    if (running.current.has(worker)) return;
    running.current.add(worker);
    setProbing(new Set(running.current));
    try {
      const next = await window.weaver.workerProbe({ worker });
      if (mounted.current) { setStatus(next); setUnavailable(false); }
    } catch (error) {
      notifyError(error, '探测失败');
    } finally {
      running.current.delete(worker);
      if (mounted.current) setProbing(new Set(running.current));
    }
  }, []);
  return { status, unavailable, probing, probeNow };
}
