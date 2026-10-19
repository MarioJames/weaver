import { QuotaPanel } from '../components/QuotaPanel';
import { NamedSwitch } from '../components/NamedControls';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Text } from '@lobehub/ui/base-ui';
import { ENGINE_CATALOG, catalogEntry, engineDisableConflict, readinessFor, type EngineProbeRecord, type EngineReadiness } from '../../shared/engines';
import type { Config, Engine } from '../../main/policy/routing';
import type { PolicyDraft } from '../usePolicyDraft';
import { styles } from '../style';

function probeLabel(status: string): string {
  if (status === 'installed') return '已安装';
  if (status === 'missing') return '未找到';
  if (status === 'probe_failed') return '探测失败';
  if (status === 'loading') return '正在探测';
  return '尚未探测';
}

function mergeProbes(current: EngineProbeRecord[], probe: EngineProbeRecord | null): EngineProbeRecord[] {
  const next = probe ? [...current.filter(item => item.id !== probe.id), probe] : current;
  return ENGINE_CATALOG.map(entry => next.find(item => item.id === entry.id)).filter((item): item is EngineProbeRecord => Boolean(item));
}

/** Newest saved snapshot only. An unsaved draft is not a snapshot and must not count. */
export function savedEngineReadiness(probes: EngineProbeRecord[], snapshot: { revision: number; config: Config } | undefined, written?: { revision: number; config: Config }): EngineReadiness[] {
  const saved = !snapshot ? written : !written || snapshot.revision >= written.revision ? snapshot : written;
  return saved ? readinessFor(probes, saved.config) : [];
}

export function EnginesPage({ policy }: { policy: PolicyDraft }) {
  const [probes, setProbes] = useState<EngineProbeRecord[]>([]);
  const [probedAt, setProbedAt] = useState('');
  const [written, setWritten] = useState<{ revision: number; config: Config }>();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState('');
  const scan = useCallback(async () => {
    if (!window.weaver) { setScanError('控制面不可用。请通过 weaver web 打开这个页面后再探测。'); return; }
    setScanning(true); setScanError('');
    try {
      const result = await window.weaver.scanEngines();
      setProbes(result.probes); setProbedAt(result.probedAt);
    } catch (error) { setScanError(error instanceof Error ? error.message : String(error)); }
    finally { setScanning(false); }
  }, []);
  useEffect(() => { void scan(); }, [scan]);
  async function toggle(id: string, enabled: boolean) {
    if (!window.weaver || !policy.snapshot || policy.dirty || busyId) return;
    setBusyId(id); setActionError('');
    try {
      const result = await window.weaver.setEngineEnabled({ id, enabled, revision: policy.snapshot.revision });
      setProbes(mergeProbes(probes, result.probe));
      setWritten({ revision: result.snapshot.revision, config: result.snapshot.config });
      if (!policy.applyServerSnapshot(result.snapshot)) setActionError('引擎状态已写入。当前草稿仍保留，重新加载后可看到最新启用状态。');
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(''); }
  }
  const readiness = useMemo(() => savedEngineReadiness(probes, policy.snapshot, written), [probes, policy.snapshot, written]);
  const saved = policy.config?.engines ?? {};
  const unsupported = Object.entries(saved).filter(([id]) => !catalogEntry(id));
  return <div className={styles.page}>
    <div className={styles.spread}>
      <Text type="secondary">本机命令与版本。启用不会创建角色，也不会自动派发。</Text>
      <Button type="primary" loading={scanning} onClick={() => void scan()}>重新探测</Button>
    </div>
    {scanError && <div role="alert" className={styles.stack}><Text type="danger">{scanError}</Text><Text type="secondary">{probes.length ? `显示 ${probedAt ? new Date(probedAt).toLocaleTimeString() : '上次'} 的探测结果。` : '还没有可用的探测结果。'}</Text><Button onClick={() => void scan()}>重试探测</Button></div>}
    {policy.dirty && <Text role="status">有未保存草稿。先保存或放弃，再启用或停用引擎。</Text>}
    {actionError && <Text role="alert" type="danger">{actionError}</Text>}
    {!scanning && !scanError && !probes.length && <Text type="secondary">没有探测记录。</Text>}
    <QuotaPanel policy={policy} />
    <div className={styles.engines}>
      {ENGINE_CATALOG.map(entry => {
        const probe = probes.find(item => item.id === entry.id);
        const ready = readiness.find(item => item.id === entry.id);
        const record = saved[entry.id] as Engine | undefined;
        const status = probe?.status ?? (scanning ? 'loading' : 'unknown');
        const kindMismatch = Boolean(record && record.kind !== entry.kind);
        const enabled = record?.enabled === true;
        const conflict = policy.snapshot ? engineDisableConflict(policy.snapshot.config, entry.id) : undefined;
        const blocked = !policy.snapshot || policy.dirty || busyId !== '' || (enabled ? Boolean(conflict) : probe?.status !== 'installed' || kindMismatch);
        return <section key={entry.id} aria-label={entry.id} className={styles.engine}>
          <Text style={{ fontWeight: 600 }} className={styles.wrap}>{entry.id}</Text>
          <Text>{probeLabel(status)}</Text>
          <Text className={styles.wrap} type="secondary">{probe?.version || entry.command}</Text>
          <NamedSwitch aria-label={`启用 ${entry.id}`} checked={enabled} disabled={blocked} onChange={checked => void toggle(entry.id, checked)} />
          <details className={styles.wrap}>
            <summary>详情</summary>
            <Text className={styles.wrap}>命令 {entry.command} · 目录类型 {entry.kind}</Text>
            {record && <Text className={styles.wrap}>已保存类型 {record.kind}{kindMismatch ? '，与目录不一致，不会改探测命令，也不会改写这条记录。' : ''}</Text>}
            <Text className={styles.wrap}>{probe?.path || '没有可执行文件路径'} · {probe ? new Date(probe.probedAt).toLocaleString() : '尚未探测'}</Text>
            {probe?.detail && <Text type="secondary" className={styles.wrap}>{probe.detail}</Text>}
            <Text type="secondary">{adapterLine(ready)}</Text>
            {conflict && <Text role="status">{conflict}</Text>}
            <Text type="secondary">已安装 {ready ? yes(ready.installed) : '未知'} · 已启用 {ready ? yes(ready.enabled) : '未知'} · 已有负责人 {ready ? yes(ready.ownerConfigured) : '未知'} · 已有工作代理 {ready ? yes(ready.workerConfigured) : '未知'}</Text>
            {record && policy.config && (record.kind === 'claude' || record.kind === 'codex') && <div className={styles.row}><NamedSwitch aria-label={`允许 ${entry.id} 原生子代理`} checked={record.native_subagents === true} onChange={checked => { if (!policy.config) return; policy.setConfig({ ...policy.config, engines: { ...policy.config.engines, [entry.id]: { ...record, native_subagents: checked } } }); }} /><Text>允许原生子代理。这不代表本机已经具备该能力。</Text></div>}
          </details>
        </section>;
      })}
      {unsupported.map(([id, record]) => {
        const conflict = policy.snapshot ? engineDisableConflict(policy.snapshot.config, id) : undefined;
        return <section key={id} aria-label={id} className={styles.engine}>
          <Text style={{ fontWeight: 600 }} className={styles.wrap}>{id}</Text>
          <Text>暂不支持探测</Text>
          <Text type="secondary">已保存类型 {record.kind}</Text>
          <Text type="secondary">{record.enabled ? '草稿启用' : '草稿停用'}</Text>
          <details className={styles.wrap}>
            <summary>详情</summary>
            <Text>这条记录会原样保留。不能从这里启用，探测也不会删除或改写它。</Text>
            {conflict && <Text role="status">{conflict}</Text>}
            {record.enabled && !conflict && policy.config && <Button size="small" disabled={policy.dirty} onClick={() => { if (!policy.config) return; policy.setConfig({ ...policy.config, engines: { ...policy.config.engines, [id]: { ...record, enabled: false } } }); }}>在草稿中停用</Button>}
          </details>
        </section>;
      })}
    </div>
  </div>;
}

function yes(value: boolean): string { return value ? '是' : '否'; }

function adapterLine(ready: EngineReadiness | undefined): string {
  if (ready?.adapterStatus === 'deferred') return 'Claude Code 本轮暂缓，不会发起付费调用。版本不能说明已登录。';
  if (ready?.adapterStatus === 'real' && ready.realExecution) return '真实适配器已配置。探测版本不能说明已登录。';
  if (ready?.adapterStatus === 'real') return '此引擎有真实适配器。启用引擎并单独配置角色后才会真实执行。版本不能说明已登录。';
  if (ready?.adapterStatus === 'not_implemented') return '此引擎没有真实适配器。版本不能说明已登录。';
  return '版本不能说明已登录或模型可用。';
}
