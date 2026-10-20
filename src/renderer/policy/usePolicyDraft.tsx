import { isTransientError } from '../api/notify';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Block, Config } from '../../shared/contracts/policy';
import type { Issue, PolicySnapshot } from '../../shared/contracts/policy';

export interface PolicyDocument { config: Config; blocks: Block[] }
export type PolicyUpdate = (current: PolicyDocument) => PolicyDocument;

const isConflict = (text: string) => text.includes('reload') || text.includes('changed') || text.includes('Settings changed');

export function usePolicyDraft() {
  const [snapshot, setSnapshot] = useState<PolicySnapshot>();
  const [config, setConfig] = useState<Config>();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [conflict, setConflict] = useState(false);
  const dirty = useMemo(() => Boolean(snapshot && config && (JSON.stringify(config) !== JSON.stringify(snapshot.config) || JSON.stringify(blocks) !== JSON.stringify(snapshot.blocks))), [snapshot, config, blocks]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const draftRef = useRef<PolicyDocument | undefined>(undefined);
  draftRef.current = config ? { config, blocks } : undefined;
  const commits = useRef<Promise<unknown>>(Promise.resolve());

  const accept = useCallback((next: PolicySnapshot) => {
    setSnapshot(next);
    setConfig(structuredClone(next.config));
    setBlocks(structuredClone(next.blocks));
    setConflict(false);
    setIssues([]);
    setSaveError('');
  }, []);

  /** Adopt a newer saved policy. A draft is kept and receives the same update instead of being replaced. */
  const rebase = useCallback((next: PolicySnapshot, update?: PolicyUpdate) => {
    const draft = draftRef.current;
    if (!dirtyRef.current || !draft || !update) { accept(next); return; }
    const merged = update(structuredClone(draft));
    setSnapshot(next);
    setConfig(merged.config);
    setBlocks(merged.blocks);
  }, [accept]);

  const load = useCallback(async (force = false) => {
    if (!window.weaver) { setLoadError('控制面不可用。请通过 weaver web 打开这个页面。'); setLoading(false); return false; }
    if (dirtyRef.current && !force) return false;
    setLoading(true); setLoadError('');
    try { const next=await window.weaver.getPolicy(); if (!force && dirtyRef.current) return false; accept(next); return true; }
    catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setLoading(false); }
  }, [accept]);

  const applyServerSnapshot = useCallback((next: PolicySnapshot) => {
    if (dirtyRef.current) return false;
    accept(next);
    return true;
  }, [accept]);

  useEffect(() => { void load(false); }, [load]);

  // Scheduled quota refresh can change blocks; a clean page follows the saved policy, a draft is never replaced.
  useEffect(() => {
    if (!window.weaver) return;
    const sync = () => {
      if (dirtyRef.current || busyRef.current) return;
      void window.weaver.getPolicy().then(next => { if (!dirtyRef.current && !busyRef.current) accept(next); }).catch(() => {});
    };
    const timer = setInterval(sync, 30_000);
    window.addEventListener('focus', sync);
    return () => { clearInterval(timer); window.removeEventListener('focus', sync); };
  }, [accept]);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!window.weaver || !snapshot || !config || busy) return false;
    setBusy(true); setSaveError(''); setIssues([]);
    try {
      const found = await window.weaver.validatePolicy(config);
      if (found.length) { setIssues(found); setSaveError('配置有错误，还不能保存。'); return false; }
      const enabledWithoutProbe = Object.entries(config.engines).filter(([id, engine]) => engine.enabled && snapshot.config.engines[id]?.enabled !== true).map(([id]) => id);
      if (enabledWithoutProbe.length) { setSaveError(`引擎 ${enabledWithoutProbe.join('、')} 需要在引擎页用启用开关打开，保存不会启用引擎。草稿已保留。`); return false; }
      accept(await window.weaver.savePolicy({ revision: snapshot.revision, config, blocks }));
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!isTransientError(error)) setSaveError(text);
      if (isConflict(text)) setConflict(true);
      return false;
    } finally { setBusy(false); }
  }, [accept, blocks, busy, config, snapshot]);

  /**
   * Save one change immediately on top of the saved policy, independent of the page draft.
   * A revision bumped meanwhile (for example by a scheduled quota block) is re-read and retried once.
   * Rejects with the server message; the caller shows it next to the control.
   */
  const commit = useCallback((update: PolicyUpdate): Promise<void> => {
    const run = async () => {
      if (!window.weaver) throw new Error('控制面不可用');
      let base = snapshotRef.current;
      if (!base) throw new Error('配置尚未读取');
      for (let attempt = 0; ; attempt++) {
        const next = update(structuredClone({ config: base.config, blocks: base.blocks }));
        try {
          const saved = await window.weaver.savePolicy({ revision: base.revision, config: next.config, blocks: next.blocks });
          rebase(saved, update);
          return;
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (attempt > 0 || !isConflict(text)) throw error;
          base = await window.weaver.getPolicy();
        }
      }
    };
    const job = commits.current.then(run, run);
    commits.current = job.catch(() => {});
    return job;
  }, [rebase]);

  return { snapshot, config, setConfig, blocks, setBlocks, loading, busy, loadError, saveError, issues, conflict, dirty, load, save, commit, rebase, applyServerSnapshot };
}

export type PolicyDraft = ReturnType<typeof usePolicyDraft>;
