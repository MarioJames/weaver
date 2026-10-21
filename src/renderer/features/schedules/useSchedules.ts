import { command } from '../../api/commands';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduleDefinition } from '../../../shared/contracts/schedules';

/**
 * The schedule list store. The first load turns a failure into an error state with retry; a
 * failed background refresh keeps the previous list and flags how it got stale. Responses are
 * ticketed so a slow older read never overwrites a newer one, and unmount ignores everything.
 * Live updates ride onTasksChanged (agent runs are tasks); a slow tick keeps nextRun moving.
 */
export function useSchedules() {
  const [schedules, setSchedules] = useState<ScheduleDefinition[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [problem, setProblem] = useState('');
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  const ticket = useRef(0);
  const hasData = useRef(false);
  const load = useCallback(async () => {
    const current = ++ticket.current;
    try {
      const result = await command<{ schedules: ScheduleDefinition[] }>('schedules.list', {});
      if (!mounted.current || current !== ticket.current) return;
      hasData.current = true;
      setSchedules(result.schedules);
      setError('');
      setStale(false);
      setProblem('');
    } catch (cause) {
      if (!mounted.current || current !== ticket.current) return;
      const message = String(cause);
      if (!hasData.current) setError(message);
      else { setStale(true); setProblem(message); }
    } finally {
      if (mounted.current && current === ticket.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    if (!window.weaver) return () => { mounted.current = false; };
    const invalidate = () => { void load(); };
    const unsubscribe = window.weaver.onTasksChanged(invalidate);
    const timer = setInterval(invalidate, 30_000);
    const visible = () => { if (document.visibilityState === 'visible') invalidate(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted.current = false;
      ticket.current++;
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load, attempt]);
  return {
    schedules,
    loading,
    error,
    stale,
    /** Why the last background refresh failed, shown next to the stale note. */
    problem,
    /** A background refresh after an action; loading stays false so the list never flashes. */
    refresh: load,
    /** First-load recovery: reloads through the effect, which also resubscribes the change channel. */
    retry: () => { setLoading(true); setAttempt(value => value + 1); },
  };
}
