import { useCallback, useEffect, useRef, useState } from 'react';
import { LogIn, Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { PageHeader } from '@lobehub/ui/dashboard';
import { Empty } from '@lobehub/ui';
import { Alert, Button, Modal, Skeleton, Tag, Text } from '@lobehub/ui/base-ui';
import type { Channel, ChannelsSnapshot, ImportChannelsResult } from '../../../shared/contracts/channels';
import type { EngineProbeRecord } from '../../../shared/engines';
import { QUOTA_KINDS } from '../../../shared/policy/settings';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { NamedSelect, NamedSwitch } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { resourceStyles } from '../../ui/resource-style';
import { tagColor } from '../../format/tag-colors';
import { QuotaSummary } from '../engines/QuotaSummary';
import { channelImportInput, channelImportNotice, channelQuota, channelSaveInput, channelUsers, mergeChannelPolicy, subscriptionAllowed } from './channels-view';
import { ChannelLoginDialog } from './ChannelLoginDialog';
import { ChannelEditor } from './ChannelEditor';
import { ChannelImportModal } from './ChannelImportModal';
import { channelStyles } from './channels-style';

export function ChannelsPage({ policy }: { policy: PolicyDraft }) {
  const [probes, setProbes] = useState<EngineProbeRecord[]>([]);
  const [probeFailure, setProbeFailure] = useState('');
  useEffect(() => { let current = true; void window.weaver.scanEngines().then(result => { if (current) setProbes(result.probes); }).catch(() => { if (current) setProbeFailure('无法确认 CLI 安装状态；登录或执行失败时请检查 Weaver 所在机器的 CLI 安装。'); }); return () => { current = false; }; }, []);
  const [snapshot, setSnapshot] = useState<ChannelsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  const locked = useRef(false);
  const readGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readGeneration.current++; }; }, []);
  const [filter, setFilter] = useState('all');
  const [engineFilter, setEngineFilter] = useState('all');
  const [editor, setEditor] = useState<{ id?: string; channel: Channel }>();
  const [pendingEditor, setPendingEditor] = useState<{ id?: string; channel: Channel }>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [loginChannel, setLoginChannel] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [importEngine, setImportEngine] = useState('all');
  const [sourceDir, setSourceDir] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [notice, setNotice] = useState('');
  const [importResult, setImportResult] = useState<ImportChannelsResult['importResult']>();
  const config = snapshot?.policy.config ?? policy.snapshot?.config;
  const accept = useCallback((next: ChannelsSnapshot) => {
    setSnapshot(next);
    const before = policy.snapshot?.config;
    policy.rebase(next.policy, doc => ({ ...doc, config: before ? mergeChannelPolicy(doc.config, before, next.policy.config) : { ...doc.config, channels: next.policy.config.channels }, blocks: next.policy.blocks }));
  }, [policy.rebase, policy.snapshot]);
  const load = useCallback(async (silent = false) => {
    if (locked.current) return false;
    const generation = ++readGeneration.current;
    if (!silent) { setLoading(true); setFailure(''); }
    try { const next = await window.weaver.getChannels(); if (generation === readGeneration.current) { accept(next); return true; } return false; }
    catch (error) { if (!silent && generation === readGeneration.current) setFailure(error instanceof Error ? error.message : String(error)); return false; }
    finally { if (generation === readGeneration.current) setLoading(false); }
  }, [accept]);
  // The page owns channel reads; policy revision changes should not erase an open editor.
  const initialLoad = useRef(false);
  useEffect(() => { if (!initialLoad.current) { initialLoad.current = true; void load(); } }, [load]);
  useEffect(() => {
    if (editor || importing || deleting) return;
    const timer = setInterval(() => void load(true), 30_000);
    return () => clearInterval(timer);
  }, [load, editor, importing, deleting]);
  async function mutate<T extends ChannelsSnapshot>(id: string, fn: () => Promise<T>, success: string | ((next: T) => string), done?: (next: T) => void) {
    if (locked.current || policy.busy) return;
    locked.current = true; readGeneration.current++; setLoading(false); setBusy(id); setFailure(''); setNotice('');
    try { const next = await fn(); if (!mounted.current) return; accept(next); setNotice(typeof success === 'function' ? success(next) : success); done?.(next); }
    catch (error) { if (mounted.current) setFailure(error instanceof Error ? error.message : String(error)); }
    finally { locked.current = false; if (mounted.current) setBusy(''); }
  }
  const revision = snapshot?.policy.revision ?? policy.snapshot?.revision;
  const engineOptions = Object.entries(config?.engines ?? {}).map(([id, engine]) => ({ value: id, label: `${id} · ${engine.kind}${probes.find(probe => probe.id === id)?.status === 'missing' ? '（未安装）' : probes.find(probe => probe.id === id)?.status === 'probe_failed' ? '（安装探测失败）' : ''}` }));
  const rows = Object.entries(config?.channels ?? {}).filter(([, channel]) => (filter === 'all' || channel.kind === filter) && (engineFilter === 'all' || channel.engine === engineFilter));
  function openEditor(target: { id?: string; channel: Channel }) {
    if (editor && editor.id !== target.id) { setPendingEditor(target); setEditorOpen(false); return; }
    readGeneration.current++; setLoading(false); setFailure('');
    if (!editor) setEditor(target);
    setEditorOpen(true);
  }
  const newChannel = () => {
    const engine = engineOptions.find(option => subscriptionAllowed(config?.engines[option.value]?.kind ?? ''))?.value ?? engineOptions[0]?.value ?? '';
    openEditor({ channel: { label: '', engine, kind: subscriptionAllowed(config?.engines[engine]?.kind ?? '') ? 'subscription' : 'api', enabled: true } });
  };
  return <section className={resourceStyles.page} aria-label="账号与渠道内容">
    <PageHeader title="账号与渠道" description="选择官方订阅账号或 API 渠道，再分配给父、子 Agent。每个渠道使用独立配置。" action={<Button type="primary" icon={Plus} disabled={!engineOptions.length || !!busy || policy.busy} onClick={newChannel}>添加账号</Button>} />
    <div className={resourceStyles.toolbar}>
      <NamedSelect aria-label="渠道类型筛选" value={filter} options={[{ value: 'all', label: '全部类型' }, { value: 'subscription', label: '官方订阅' }, { value: 'api', label: 'API' }]} onChange={value => setFilter(String(value))} />
      <NamedSelect aria-label="渠道引擎筛选" value={engineFilter} options={[{ value: 'all', label: '全部引擎' }, ...engineOptions]} onChange={value => setEngineFilter(String(value))} />
      <Button icon={Upload} disabled={!!busy || policy.busy} onClick={() => { readGeneration.current++; setLoading(false); setFailure(''); setReplaceExisting(false); setImporting(true); }}>导入已有账号或渠道</Button>
      {editor && !editorOpen && <Button onClick={() => setEditorOpen(true)}>继续未保存的账号：{editor.channel.label || '新增账号'}</Button>}
      <Button icon={RefreshCw} loading={loading} disabled={!!busy} onClick={() => void load()}>重新读取</Button>
    </div>
    {failure && !editorOpen && !importing && !deleting && <Alert type="error" title="操作未完成" description={`${failure}。表单内容已保留；若配置已变化，请重新读取后重试。`} action={<Button size="small" disabled={!!busy} onClick={() => void load()}>重新读取</Button>} />}
    {probeFailure && <Text type="warning">{probeFailure}</Text>}
    {notice && <Text role="status" type="secondary">{notice}</Text>}
    {importResult && <Alert type={importResult.failures.length ? 'warning' : 'info'} title={importResult.failures.length ? '导入有未完成项' : '本次导入结果'} description={channelImportNotice(importResult)} /> }
    {loading && !snapshot ? <Skeleton.Text animated rows={5} /> : !snapshot && failure ? <Text type="secondary">尚未读取账号状态，请重新读取后重试。</Text> : !rows.length ? <Empty
      title={Object.keys(config?.channels ?? {}).length ? '没有匹配的渠道' : '添加第一个账号或渠道'}
      description="添加官方订阅可直接登录独立账号；API 渠道填写连接配置。Qoder API 请通过原生 /model 配置 BYOK 后导入。"
      action={<Button icon={Plus} disabled={!engineOptions.length || !!busy} onClick={newChannel}>添加账号</Button>} /> : <div className={resourceStyles.list}>
      {rows.map(([id, channel]) => {
        const state = snapshot?.configurations[id];
        const users = config ? channelUsers(config, id) : [];
        const engine = config?.engines[channel.engine];
        const probe = probes.find(item => item.id === channel.engine);
        const record = channelQuota(id, channel, state);
        const canQueryQuota = channel.kind === 'subscription' && (QUOTA_KINDS as readonly string[]).includes(engine?.kind ?? '');
        return <article key={id} aria-label={channel.label} className={channelStyles.row}>
          <div className={styles.tight}>
            <Text strong className={styles.wrap}>{channel.label}</Text>
            <span className={styles.row}><Tag size="small" color={tagColor('neutral')}>{channel.kind === 'subscription' ? '官方订阅' : 'API'}</Tag><Text type="secondary">{channel.engine}</Text></span>
            {probe?.status === 'missing' && <Text type="warning" className={styles.meta}>未在此机器找到 CLI，请安装对应引擎后重新打开此页面。</Text>}
            {probe?.status === 'probe_failed' && <Text type="warning" className={styles.meta}>CLI 安装探测失败，请检查本机命令后重试。</Text>}
            <Text type="secondary" className={`${styles.meta} ${styles.wrap}`}>{users.length ? users.join('、') : '尚未分配给 Agent'}</Text>
          </div>
          <div className={styles.tight}>
            <Text>{channel.kind === 'subscription' ? state?.hasCredentials ? '原生登录凭据已配置' : '等待官方账号登录' : state?.hasApiKey ? 'API 密钥已配置' : state?.hasCredentials ? '原生认证已配置' : state?.hasConfig ? '原生配置已提供' : '尚未配置连接'}</Text>
            {channel.kind === 'api' && <Text type="secondary" className={`${styles.meta} ${styles.wrap}`}>{[channel.provider, channel.baseUrl, channel.protocol].filter(Boolean).join(' · ') || '编辑渠道以配置 provider 与 endpoint'}</Text>}
            <Text type="secondary" className={styles.meta}>{state?.hasConfig ? '已有原生配置覆写 · 不回显秘密内容' : '使用引擎原生配置'}</Text>
            {state?.detail && <Text type="warning" className={`${styles.meta} ${styles.wrap}`}>{state.detail}</Text>}
            {channel.kind === 'subscription' && !state?.hasCredentials && <Text type="secondary" className={styles.meta}>点击「登录官方账号」完成此账号的独立认证，再分配给 Agent。</Text>}
          </div>
          <div className={styles.tight}>
            {record ? <QuotaSummary engine={record.engine} record={record} now={Date.now()} busy={busy === `quota:${id}` ? record.engine : null} policyBusy={!!busy || policy.busy} onRefresh={() => void mutate(`quota:${id}`, () => window.weaver.refreshChannelQuota({ channel: id }), '已刷新所选账号额度。')} recovery={record.status === 'unauthenticated' ? '请检查此账号的登录状态；需要更换身份时新建账号。' : undefined} refreshLabel={`刷新 ${channel.label} 额度`} />
              : <><Text type="secondary">{channel.kind === 'api' ? 'API 渠道不显示官方订阅额度' : !canQueryQuota ? '该引擎没有官方只读额度接口' : '尚无该账号的额度观测'}</Text>{canQueryQuota && <Button size="small" disabled={!!busy || policy.busy} loading={busy === `quota:${id}`} onClick={() => void mutate(`quota:${id}`, () => window.weaver.refreshChannelQuota({ channel: id }), '已刷新所选账号额度。')}>刷新账号额度</Button>}</>}
            {canQueryQuota && <span className={resourceStyles.rowActions}><NamedSwitch size="small" aria-label={`${channel.label} 自动刷新额度`} checked={channel.quota_refresh !== false} disabled={!!busy || policy.busy} onChange={checked => revision !== undefined && void mutate(id, () => window.weaver.saveChannel({ revision, id, channel: { ...channel, quota_refresh: checked } }), '已更新额度刷新设置。')} /><Text type="secondary" className={styles.meta}>自动刷新</Text></span>}
          </div>
          <div className={resourceStyles.rowActions}>
            <NamedSwitch size="small" aria-label={`启用 ${channel.label}`} checked={channel.enabled} loading={busy === id} disabled={!!busy || policy.busy} onChange={enabled => revision !== undefined && void mutate(id, () => window.weaver.saveChannel({ revision, id, channel: { ...channel, enabled } }), enabled ? '渠道已启用；实际执行仍需可用凭据与引擎。' : '渠道已停用。')} />
            {channel.kind === 'subscription' && !state?.hasCredentials && subscriptionAllowed(engine?.kind ?? '') && <Button size="small" type="text" icon={LogIn} disabled={!!busy} onClick={() => setLoginChannel(id)}>登录官方账号</Button>}
            <Button size="small" type="text" icon={Pencil} disabled={!!busy} onClick={() => openEditor({ id, channel: { ...channel } })}>编辑</Button>
            <Button size="small" type="text" danger icon={Trash2} disabled={!!busy} onClick={() => { readGeneration.current++; setLoading(false); setFailure(''); setDeleting(id); }}>删除</Button>
          </div>
        </article>;
      })}
    </div>}
    <Modal open={!!pendingEditor} title="已有未保存的账号草稿" draggable={false} onCancel={() => setPendingEditor(undefined)} footer={<>
      <Button onClick={() => { setPendingEditor(undefined); setEditorOpen(true); }}>继续原草稿</Button>
      <Button danger onClick={() => { if (pendingEditor) { readGeneration.current++; setLoading(false); setFailure(''); setEditor(pendingEditor); setPendingEditor(undefined); setEditorOpen(true); } }}>放弃原草稿并切换</Button>
    </>}>
      <Text>「{editor?.channel.label || '新增账号'}」有未保存的输入。要打开「{pendingEditor?.channel.label || '新增账号'}」，请先选择继续原草稿或放弃后切换。</Text>
    </Modal>
    {editor && revision !== undefined && config && <ChannelEditor open={editorOpen} key={`editor:${editor.id ?? 'new'}`} value={editor.channel} editing={!!editor.id} engineOptions={engineOptions} engineKind={id => config.engines[id]?.kind ?? ''} hasConfig={!!(editor.id && snapshot?.configurations[editor.id]?.hasConfig)} hasKey={!!(editor.id && snapshot?.configurations[editor.id]?.hasApiKey)} busy={!!busy} failure={failure} onReload={() => void load()} onCancel={() => { if (!busy) setEditorOpen(false); }} onDiscard={() => { if (!busy) { setEditor(undefined); setEditorOpen(false); setFailure(''); } }} onSave={(channel, apiKey, nativeConfig, replaceConfig) => void mutate('save', async () => {
      const next = await window.weaver.saveChannel(channelSaveInput(revision, editor.id, channel, apiKey, nativeConfig, replaceConfig));
      if (mounted.current && !editor.id && channel.kind === 'subscription') setLoginChannel(next.savedChannel);
      return next;
    }, '账号配置已保存。', () => { setEditor(undefined); setEditorOpen(false); })} />}
    <ChannelImportModal open={importing} busy={busy} revision={revision} engineOptions={engineOptions} importResult={importResult} sourceDir={sourceDir} importEngine={importEngine} replaceExisting={replaceExisting} failure={failure} onSource={setSourceDir} onEngine={setImportEngine} onReplace={setReplaceExisting} onCancel={() => { if (!busy) setImporting(false); }} onImport={() => revision !== undefined && void mutate('import', () => { setImportResult(undefined); return window.weaver.importChannels(channelImportInput(revision, importEngine, sourceDir, replaceExisting)); }, next => { setImportResult(next.importResult); return ''; }, next => { if (!next.importResult.failures.length && next.importResult.added + next.importResult.existing + next.importResult.updated > 0) setImporting(false); })} onReload={() => void load()} />
    {loginChannel && config?.channels[loginChannel] && <ChannelLoginDialog key={`login:${loginChannel}`} channel={loginChannel} label={config.channels[loginChannel].label} onClose={() => setLoginChannel(undefined)} onSucceeded={async () => { if (!await load()) throw new Error('未能重新读取账号凭据状态，请重试。'); }} />}
    <Modal className={resourceStyles.modal} classNames={{ body: resourceStyles.modalBody, footer: resourceStyles.modalFooter }} draggable={false} open={!!deleting} title="删除渠道" okText="删除" cancelText="取消" okButtonProps={{ danger: true, disabled: !!busy || !deleting || !!(config && channelUsers(config, deleting).length) }} confirmLoading={busy === 'delete'} onCancel={() => { if (!busy) setDeleting(undefined); }} onOk={() => revision !== undefined && deleting && void mutate('delete', () => window.weaver.deleteChannel({ revision, id: deleting }), '渠道已删除。', () => setDeleting(undefined))}>
      <Text>{deleting && config && channelUsers(config, deleting).length ? `以下角色仍引用该渠道，请先在角色配置中更换：${channelUsers(config, deleting).join('、')}` : '删除这条渠道及其托管配置，不修改来源 CLI 目录。此操作不能撤销。'}</Text>
      {failure && <Text type="danger" role="alert" className={styles.wrap}>{failure}</Text>}
    </Modal>
  </section>;
}
