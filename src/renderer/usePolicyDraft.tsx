import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Block, Config } from '../main/policy/routing';
import type { Issue, PolicySnapshot, RoutePreview } from '../shared/policy';

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
  const [message, setMessage] = useState('');
  const dirty = useMemo(() => Boolean(snapshot && config && (JSON.stringify(config) !== JSON.stringify(snapshot.config) || JSON.stringify(blocks) !== JSON.stringify(snapshot.blocks))), [snapshot, config, blocks]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const accept = useCallback((next: PolicySnapshot) => {
    setSnapshot(next);
    setConfig(structuredClone(next.config));
    setBlocks(structuredClone(next.blocks));
    setConflict(false);
    setIssues([]);
    setSaveError('');
  }, []);

  const load = useCallback(async (force = false) => {
    if (!window.weaver) { setLoadError('控制面不可用。请通过 weaver web 打开这个页面。'); setLoading(false); return false; }
    if (dirtyRef.current && !force) return false;
    setLoading(true); setLoadError('');
    try { accept(await window.weaver.getPolicy()); setMessage(force ? '已重新加载已保存配置。' : ''); return true; }
    catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setLoading(false); }
  }, [accept]);

  const applyServerSnapshot = useCallback((next: PolicySnapshot) => {
    if (dirtyRef.current) return false;
    accept(next);
    return true;
  }, [accept]);

  useEffect(() => { void load(false); }, [accept]);

  const save = useCallback(async () => {
    if (!window.weaver || !snapshot || !config || busy) return false;
    setBusy(true); setSaveError(''); setIssues([]); setMessage('');
    try {
      const found = await window.weaver.validatePolicy(config);
      if (found.length) { setIssues(found); setSaveError('配置还不能保存。'); return false; }
      const enabledWithoutProbe = Object.entries(config.engines).filter(([id, engine]) => engine.enabled && snapshot.config.engines[id]?.enabled !== true).map(([id]) => id);
      if (enabledWithoutProbe.length) { setSaveError(`不能通过策略保存启用引擎 ${enabledWithoutProbe.join('、')}。请到引擎页探测后再启用。草稿已保留。`); return false; }
      accept(await window.weaver.savePolicy({ revision: snapshot.revision, config, blocks }));
      setMessage('策略已保存。启用引擎不会创建角色。是否真实执行以任务记录的 execution 和引擎就绪状态为准。');
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setSaveError(text);
      if (text.includes('reload') || text.includes('changed') || text.includes('Settings changed')) setConflict(true);
      return false;
    } finally { setBusy(false); }
  }, [accept, blocks, busy, config, snapshot]);

  const preview = useCallback(async (input: { owner: string; class: string; tag?: string; runningCount: number }) => {
    if (!window.weaver) throw new Error('控制面不可用');
    return window.weaver.previewRoute(input);
  }, []);

  return { snapshot, config, setConfig, blocks, setBlocks, loading, busy, loadError, saveError, issues, conflict, message, dirty, load, save, preview, setMessage, applyServerSnapshot };
}

export type PolicyDraft = ReturnType<typeof usePolicyDraft>;
export type { RoutePreview };
