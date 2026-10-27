import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowLeft, Bot, LogIn, MessageSquare, MoreHorizontal, Plus, RefreshCw, Trash2, Upload, UserRound } from 'lucide-react';
import { TitleWithTips } from '@lobehub/ui/dashboard';
import { PageHeader } from '../../app/PageHeader';
import { ActionIcon, Button, DropdownMenu, Empty, Modal, Skeleton, Tag, Text, Tooltip, toast } from '@lobehub/ui';
import type { Channel, ChannelsSnapshot } from '../../../shared/contracts/channels';
import type { EngineProbeRecord } from '../../../shared/engines';
import { QUOTA_KINDS } from '../../../shared/policy/settings';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { navigate, useRoute } from '../../app/router';
import { notifyError } from '../../api/notify';
import { AgentChip } from '../../ui/AgentChip';
import { EntityLink } from '../../ui/EntityLink';
import { GroupHeading } from '../../ui/GroupHeading';
import { MasterDetail } from '../../ui/MasterDetail';
import { CompactMetrics } from '../../ui/CompactMetrics';
import { NamedSelect, NamedSwitch } from '../../ui/NamedControls';
import { Pane } from '../../ui/Pane';
import { SelectableList } from '../../ui/SelectableList';
import { SaveBar } from '../../ui/SaveBar';
import { SettingGroup } from '../../ui/SettingGroup';
import { styles } from '../../ui/styles';
import { resourceStyles } from '../../ui/resource-style';
import { useDraftGuard } from '../../ui/useDraftGuard';
import { tagColor } from '../../format/tag-colors';
import { QuotaSummary } from '../engines/QuotaSummary';
import {
  channelDefaultProtocol, channelDraftCanSave, channelDraftDirty, channelDraftFor, channelImportInput, channelImportNotice,
  channelMetrics, channelQuota, channelQuotaHeadline, channelReferences, channelSaveInput, channelUsers, directApiAllowed,
  mergeChannelPolicy, subscriptionAllowed, type ChannelDraft, type ChannelMetric,
} from './channels-view';
import { ChannelEditor } from './ChannelEditor';
import { ChannelImportModal } from './ChannelImportModal';
import { ChannelLoginDialog } from './ChannelLoginDialog';
import { channelStyles } from './channels-style';

const NARROW_QUERY = '(max-width: 1023.98px)';
const COMPACT_ACTIONS_QUERY = '(max-width: 1279.98px)';

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [query]);
  return matches;
}

function useNarrow(): boolean {
  return useMedia(NARROW_QUERY);
}

export function ChannelsPage({ policy }: { policy: PolicyDraft }) {
  const route = useRoute();
  const routedId = route.page === 'channels' ? route.id : undefined;
  const narrow = useNarrow();
  const compactActions = useMedia(COMPACT_ACTIONS_QUERY);
  const [probes, setProbes] = useState<EngineProbeRecord[]>([]);
  const [probeFailure, setProbeFailure] = useState('');
  const [snapshot, setSnapshot] = useState<ChannelsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState('all');
  const [engineFilter, setEngineFilter] = useState('all');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ChannelDraft>();
  const [showList, setShowList] = useState(false);
  const [loginChannel, setLoginChannel] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [importEngine, setImportEngine] = useState('all');
  const [sourceDir, setSourceDir] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [imChannel, setImChannel] = useState<string>();
  const locked = useRef(false);
  const readGeneration = useRef(0);
  const mounted = useRef(true);
  const addReturn = useRef<string | undefined>(undefined);
  const previousActive = useRef<string | undefined>(undefined);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readGeneration.current++; }; }, []);
  useEffect(() => {
    let current = true;
    void window.weaver.scanEngines().then(result => { if (current) setProbes(result.probes); }).catch(() => { if (current) setProbeFailure('无法确认 CLI 安装状态；登录或执行失败时请检查 Weaver 所在机器的 CLI 安装。'); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    let current = true;
    void window.weaver.getImSettings().then(next => { if (current) setImChannel(next.config.channel); }).catch(() => { /* Bot 引用只是补充信息，读取失败时不阻塞本页。 */ });
    return () => { current = false; };
  }, []);

  const config = snapshot?.policy.config ?? policy.snapshot?.config;
  const revision = snapshot?.policy.revision ?? policy.snapshot?.revision;
  const engineKind = useCallback((id: string) => config?.engines[id]?.kind ?? '', [config]);
  const accept = useCallback((next: ChannelsSnapshot) => {
    setSnapshot(next);
    const before = policy.snapshot?.config;
    policy.rebase(next.policy, doc => ({ ...doc, config: before ? mergeChannelPolicy(doc.config, before, next.policy.config) : { ...doc.config, channels: next.policy.config.channels }, blocks: next.policy.blocks }));
  }, [policy.rebase, policy.snapshot]);
  const load = useCallback(async (silent = false) => {
    if (locked.current) return false;
    const generation = ++readGeneration.current;
    if (!silent) { setLoading(true); setLoadFailed(false); }
    try {
      const next = await window.weaver.getChannels();
      if (generation === readGeneration.current) { accept(next); setLoadFailed(false); return true; }
      return false;
    } catch (error) {
      if (!silent && generation === readGeneration.current) { setLoadFailed(true); notifyError(error, '账号与渠道读取失败'); }
      return false;
    } finally {
      if (generation === readGeneration.current) setLoading(false);
    }
  }, [accept]);
  const initialLoad = useRef(false);
  useEffect(() => { if (!initialLoad.current) { initialLoad.current = true; void load(); } }, [load]);
  useEffect(() => {
    if (draft || adding || importing || deleting || loginChannel) return;
    const timer = setInterval(() => void load(true), 30_000);
    return () => clearInterval(timer);
  }, [load, draft, adding, importing, deleting, loginChannel]);

  async function mutate<T extends ChannelsSnapshot>(id: string, context: string, fn: () => Promise<T>, done?: (next: T) => void): Promise<T | undefined> {
    if (locked.current || policy.busy) return undefined;
    locked.current = true; readGeneration.current++; setLoading(false); setBusy(id);
    try {
      const next = await fn();
      if (!mounted.current) return undefined;
      accept(next);
      done?.(next);
      return next;
    } catch (error) {
      if (mounted.current) notifyError(error, context);
      return undefined;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy('');
    }
  }

  const engineOptions = useMemo(() => Object.entries(config?.engines ?? {}).map(([id, engine]) => ({
    value: id,
    label: `${id} · ${engine.kind}${probes.find(probe => probe.id === id)?.status === 'missing' ? '（未安装）' : probes.find(probe => probe.id === id)?.status === 'probe_failed' ? '（安装探测失败）' : ''}`,
  })), [config, probes]);
  const grouped = useMemo(() => {
    const groups = new Map<string, [string, Channel][]>();
    for (const entry of Object.entries(config?.channels ?? {})) {
      const [id, channel] = entry;
      if (filter !== 'all' && channel.kind !== filter) continue;
      if (engineFilter !== 'all' && channel.engine !== engineFilter) continue;
      const items = groups.get(channel.engine) ?? [];
      items.push(entry);
      groups.set(channel.engine, items);
    }
    return [...groups.entries()].map(([engine, items]) => ({ engine, items }));
  }, [config, filter, engineFilter]);
  const firstVisible = grouped[0]?.items[0]?.[0];
  const channelCount = Object.keys(config?.channels ?? {}).length;
  const routedChannel = !adding && routedId ? config?.channels[routedId] : undefined;
  const missing = !adding && !!config && !!routedId && !routedChannel;
  const activeId = adding ? undefined : routedChannel ? routedId : !routedId ? firstVisible : undefined;
  const activeChannel = activeId && config ? config.channels[activeId] : undefined;
  const activeDraft = adding ? draft : draft && activeId && draft.id === activeId ? draft : undefined;
  const dirty = channelDraftDirty(activeDraft);
  const guard = useDraftGuard(dirty);

  useEffect(() => {
    if (route.page !== 'channels' || routedId || adding || !config) return;
    if (narrow && showList) return;
    const first = grouped[0]?.items[0]?.[0];
    if (first) navigate({ page: 'channels', id: first }, { replace: true });
  }, [route.page, routedId, adding, config, grouped, narrow, showList]);

  useEffect(() => {
    if (adding) return;
    if (previousActive.current !== undefined && previousActive.current !== activeId) setDraft(undefined);
    previousActive.current = activeId;
  }, [activeId, adding]);

  function blankDraft(): ChannelDraft {
    const subscriptionEngine = engineOptions.find(option => subscriptionAllowed(engineKind(option.value)));
    const engine = subscriptionEngine?.value ?? engineOptions[0]?.value ?? '';
    return channelDraftFor({
      label: '', engine, enabled: true,
      kind: subscriptionEngine ? 'subscription' : 'api',
      ...(engineKind(engine) === 'dsh' ? { provider: 'deepseek-official' } : {}),
    });
  }

  function select(id: string) {
    if (id === activeId && !adding) { setShowList(false); return; }
    guard.guard(() => {
      setDraft(undefined);
      setAdding(false);
      setShowList(false);
      navigate({ page: 'channels', id });
    });
  }

  function beginAdd() {
    if (!engineOptions.length) return;
    guard.guard(() => {
      addReturn.current = activeId;
      setDraft(blankDraft());
      setAdding(true);
      setShowList(false);
      navigate({ page: 'channels' }, { replace: true });
    });
  }

  function leaveAdd() {
    const target = narrow ? undefined : addReturn.current;
    setDraft(undefined);
    setAdding(false);
    if (narrow) setShowList(true);
    navigate(target ? { page: 'channels', id: target } : { page: 'channels' }, { replace: true });
  }

  function discardDraft() {
    if (adding) leaveAdd();
    else setDraft(undefined);
  }

  function backToList() {
    guard.guard(() => {
      setDraft(undefined);
      setAdding(false);
      setShowList(true);
      navigate({ page: 'channels' }, { replace: true });
    });
  }

  async function saveDraft(form: ChannelDraft) {
    if (revision === undefined) return;
    const kind = engineKind(form.channel.engine);
    const channel: Channel = {
      ...form.channel,
      label: form.channel.label.trim(),
      ...(form.channel.kind === 'api' && directApiAllowed(kind) ? { protocol: form.channel.protocol ?? channelDefaultProtocol(kind) } : {}),
    };
    const wasAdd = !form.id;
    await mutate('save', '账号或渠道保存失败', () => window.weaver.saveChannel(channelSaveInput(revision, form.id, channel, form.apiKey, form.nativeConfig, form.replaceConfig)), next => {
      setDraft(undefined);
      toast.success({ title: '账号配置已保存', placement: 'bottom-right' });
      if (wasAdd) {
        addReturn.current = undefined;
        setAdding(false);
        navigate({ page: 'channels', id: next.savedChannel }, { replace: true });
        if (next.policy.config.channels[next.savedChannel]?.kind === 'subscription') setLoginChannel(next.savedChannel);
      }
    });
  }

  async function toggleChannel(id: string) {
    const channel = config?.channels[id];
    if (!channel || revision === undefined) return;
    await mutate(id, '启用状态保存失败', () => window.weaver.saveChannel({ revision, id, channel: { ...channel, enabled: !channel.enabled } }), next => {
      const enabled = next.policy.config.channels[id]?.enabled;
      if (enabled === undefined) return;
      setDraft(current => current && current.id === id ? { ...current, initial: { ...current.initial, enabled }, channel: { ...current.channel, enabled } } : current);
    });
  }

  async function toggleQuotaRefresh(id: string) {
    const channel = config?.channels[id];
    if (!channel || revision === undefined) return;
    await mutate(`quota:${id}`, '额度刷新设置保存失败', () => window.weaver.saveChannel({ revision, id, channel: { ...channel, quota_refresh: channel.quota_refresh === false } }), next => {
      const quotaRefresh = next.policy.config.channels[id]?.quota_refresh;
      setDraft(current => current && current.id === id ? { ...current, initial: { ...current.initial, quota_refresh: quotaRefresh }, channel: { ...current.channel, quota_refresh: quotaRefresh } } : current);
    });
  }

  function refreshQuota(id: string) {
    void mutate(`quota:${id}`, '账号额度刷新失败', () => window.weaver.refreshChannelQuota({ channel: id }));
  }

  async function runImport() {
    if (revision === undefined) return;
    await mutate('import', '导入未完成', () => window.weaver.importChannels(channelImportInput(revision, importEngine, sourceDir, replaceExisting)), next => {
      setImporting(false);
      const result = next.importResult;
      const report = { title: '本次导入结果', description: channelImportNotice(result), placement: 'bottom-right' as const };
      if (result.failures.length) toast.warning({ ...report, title: '导入有未完成项' });
      else if (result.added + result.existing + result.updated === 0) toast.info(report);
      else toast.success(report);
    });
  }

  function confirmDelete(id: string) {
    if (revision === undefined) return;
    void mutate('delete', '账号或渠道删除失败', () => window.weaver.deleteChannel({ revision, id }), () => {
      toast.success({ title: '渠道已删除', placement: 'bottom-right' });
      setDeleting(undefined);
      setDraft(undefined);
      if (id === routedId) navigate({ page: 'channels' }, { replace: true });
    });
  }

  const metrics = config ? channelMetrics(config, snapshot) : undefined;
  const deletingChannel = deleting && config ? config.channels[deleting] : undefined;
  const deletingBot = !!deleting && imChannel === deleting;
  const deletingUsers = deleting && config ? channelUsers(config, deleting) : [];
  const deletingBlocked = deletingUsers.length > 0 || deletingBot;
  const mobileView = narrow && (showList || (!activeId && !adding && !missing)) ? 'list' : 'main';

  function paneTitle(content: ReactNode) {
    return <div {...stylex.props(channelStyles.headerRow)}>
      {narrow && <Button className={stylex.props(channelStyles.mobileBack).className} size="small" type="text" icon={ArrowLeft} aria-label="返回账号与渠道列表" onClick={backToList} />}
      {content}
    </div>;
  }

  const list = <Pane label="账号与渠道列表" toolbar={<div {...stylex.props(channelStyles.filters)}>
    <div {...stylex.props(channelStyles.filterItem)}><NamedSelect className={stylex.props(channelStyles.filterSelect).className} aria-label="账号或渠道类型筛选" value={filter} options={[{ value: 'all', label: '全部' }, { value: 'subscription', label: '官方订阅' }, { value: 'api', label: 'API' }]} onChange={value => setFilter(String(value))} /></div>
    <div {...stylex.props(channelStyles.filterItem)}><NamedSelect className={stylex.props(channelStyles.filterSelect).className} aria-label="账号或渠道引擎筛选" value={engineFilter} options={[{ value: 'all', label: '全部引擎' }, ...engineOptions]} onChange={value => setEngineFilter(String(value))} /></div>
  </div>}>
    {loading && !config ? <div {...stylex.props(channelStyles.listEmpty)}><Skeleton.Text animated rows={6} /></div>
      : !config ? <div {...stylex.props(channelStyles.listEmpty)}>
        <Text type="secondary">{loadFailed ? '上次读取失败。' : '尚未读取账号与渠道。'}</Text>
        <Button size="small" icon={RefreshCw} loading={loading} onClick={() => void load()}>刷新</Button>
      </div>
        : !channelCount ? <div {...stylex.props(channelStyles.listEmpty)}>
          <Text type="secondary">添加官方订阅可直接登录独立账号；API 渠道填写连接配置。Qoder API 请通过原生 /model 配置 BYOK 后导入。</Text>
          <Button size="small" icon={Plus} disabled={!engineOptions.length || !!busy || policy.busy} onClick={beginAdd}>添加账号</Button>
        </div>
          : !grouped.length ? <div {...stylex.props(channelStyles.listEmpty)}>
            <Text type="secondary">没有符合筛选条件的账号或渠道。</Text>
            <Button size="small" onClick={() => { setFilter('all'); setEngineFilter('all'); }}>清除筛选</Button>
          </div>
            : <SelectableList
              label="账号与渠道"
              sections={grouped.map(group => ({ key: group.engine, heading: <GroupHeading label={group.engine} count={group.items.length} />, items: group.items.map(([id]) => id) }))}
              getKey={id => id}
              selectedKey={adding ? undefined : activeId}
              onSelect={select}
              renderItem={id => {
                const channel = config?.channels[id];
                if (!channel) return null;
                const headline = channelQuotaHeadline(id, channel, snapshot?.configurations[id]);
                return <div {...stylex.props(channelStyles.listRow)}>
                  <span {...stylex.props(channelStyles.switchWrap)} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                    <NamedSwitch size="small" aria-label={`启用 ${channel.label}`} checked={channel.enabled} loading={busy === id} disabled={!!busy || policy.busy} onChange={() => void toggleChannel(id)} />
                  </span>
                  <div {...stylex.props(channelStyles.listCopy)}>
                    <AgentChip kind={config?.engines[channel.engine]?.kind} name={channel.label || '未命名'} />
                    <Text type={headline.tone} className={stylex.props(channelStyles.summary).className}>{channel.kind === 'subscription' ? '官方订阅' : 'API'} · {headline.text}</Text>
                  </div>
                </div>;
              }}
            />}
  </Pane>;

  const detail = activeChannel && config ? (() => {
    const state = snapshot?.configurations[activeId!];
    const engine = config.engines[activeChannel.engine];
    const kind = engine?.kind ?? '';
    const record = channelQuota(activeId!, activeChannel, state);
    const canQueryQuota = activeChannel.kind === 'subscription' && (QUOTA_KINDS as readonly string[]).includes(kind);
    const refs = channelReferences(config, activeId!);
    const botUses = imChannel === activeId;
    const referenceNames = [...channelUsers(config, activeId!), ...(botUses ? ['Bot · 飞书 IM'] : [])];
    const probe = probes.find(item => item.id === activeChannel.engine);
    const displayDraft = activeDraft ?? channelDraftFor(activeChannel, activeId);
    const editing = !adding;
    const allowedEngines = editing ? engineOptions.map(option => option.value) : engineOptions.filter(option => displayDraft.channel.kind === 'subscription' ? subscriptionAllowed(engineKind(option.value)) : directApiAllowed(engineKind(option.value))).map(option => option.value);
    const canSave = channelDraftCanSave(displayDraft, editing, allowedEngines, kind);
    const loginDisabled = !!busy || policy.busy || !!state?.hasCredentials;
    const deleteDisabled = !!busy || referenceNames.length > 0;
    const deleteTitle = referenceNames.length ? `仍被 ${referenceNames.join('、')} 引用，先移除引用再删除。` : '删除此账号或渠道';
    const loginTitle = state?.hasCredentials ? '已有凭据的账号不能原地更换身份；需要更换时新建账号。' : '登录官方账号';
    return <Pane
      label="账号或渠道详情"
      title={paneTitle(<>
        <span title={activeChannel.label} {...stylex.props(channelStyles.headerName)}>{activeChannel.label}</span>
        <Tag size="small" color={tagColor('neutral')}>{activeChannel.kind === 'subscription' ? '官方订阅' : 'API'}</Tag>
        <span {...stylex.props(channelStyles.headerEngine)}>{activeChannel.engine}</span>
      </>)}
      actions={<>
        <NamedSwitch size="small" aria-label={`启用 ${activeChannel.label}`} checked={activeChannel.enabled} loading={busy === activeId} disabled={!!busy || policy.busy} onChange={() => void toggleChannel(activeId!)} />
        {compactActions
          ? <DropdownMenu placement="bottomRight" items={[
            ...(activeChannel.kind === 'subscription' ? [{
              key: 'login',
              label: '登录官方账号',
              desc: state?.hasCredentials ? '已有凭据，不能原地更换身份' : undefined,
              disabled: loginDisabled,
              onClick: () => setLoginChannel(activeId),
            }] : []),
            {
              key: 'delete',
              label: '删除',
              desc: referenceNames.length ? `仍被 ${referenceNames.join('、')} 引用` : undefined,
              danger: true,
              disabled: deleteDisabled,
              onClick: () => guard.guard(() => setDeleting(activeId)),
            },
          ]}>
            <ActionIcon icon={MoreHorizontal} aria-label="更多操作" title="更多操作" />
          </DropdownMenu>
          : <>
            {activeChannel.kind === 'subscription' && <Button size="small" type="text" icon={LogIn} disabled={loginDisabled} title={loginTitle} onClick={() => setLoginChannel(activeId)}>登录官方账号</Button>}
            <Tooltip title={deleteTitle}>
              <span {...stylex.props(channelStyles.switchWrap)}>
                <Button size="small" type="text" danger icon={Trash2} disabled={deleteDisabled} onClick={() => guard.guard(() => setDeleting(activeId))}>删除</Button>
              </span>
            </Tooltip>
          </>}
      </>}
      footer={dirty ? <SaveBar dirty saving={busy === 'save'} saveDisabled={!canSave || !!busy} onSave={() => void saveDraft(displayDraft)} onDiscard={discardDraft} /> : undefined}
    >
      <div {...stylex.props(channelStyles.mainBody)}>
        <SettingGroup title="凭据" tips="原生登录凭据或 API 连接保存在 Weaver 私有目录，秘密不会回显。CLI 安装状态来自本机探测。">
          <div {...stylex.props(channelStyles.credential)}>
            <Text strong>{activeChannel.kind === 'subscription' ? state?.hasCredentials ? '原生登录凭据已配置' : '等待官方账号登录' : state?.hasApiKey ? 'API 密钥已配置' : state?.hasCredentials ? '原生认证已配置' : state?.hasConfig ? '原生配置已提供' : '尚未配置连接'}</Text>
            {activeChannel.kind === 'api' && <Text type="secondary" className={stylex.props(styles.meta, styles.wrap).className}>{[activeChannel.provider, activeChannel.baseUrl, activeChannel.protocol].filter(Boolean).join(' · ') || '编辑渠道以配置 provider 与 endpoint。'}</Text>}
            <Text type="secondary" className={stylex.props(styles.meta, styles.wrap).className}>{state?.hasConfig ? '已有原生配置覆写，秘密内容不回显。' : '使用引擎原生配置。'}</Text>
            {state?.detail && <Text type="warning" className={stylex.props(styles.meta, styles.wrap).className}>{state.detail}</Text>}
            {activeChannel.kind === 'subscription' && !state?.hasCredentials && <Text type="secondary" className={stylex.props(styles.meta, styles.wrap).className}>点击「登录官方账号」完成此账号的独立认证，再分配给 Agent。</Text>}
            {probe?.status === 'missing' && <Text type="warning" className={stylex.props(styles.meta, styles.wrap).className}>未在此机器找到 CLI，请安装对应引擎后重新打开此页面。</Text>}
            {probe?.status === 'probe_failed' && <Text type="warning" className={stylex.props(styles.meta, styles.wrap).className}>CLI 安装探测失败，请检查本机命令后重试。</Text>}
            {probeFailure && <Text type="warning" className={stylex.props(styles.meta, styles.wrap).className}>{probeFailure}</Text>}
          </div>
        </SettingGroup>
        <SettingGroup title="额度" tips="只展示官方只读额度；过期观测不代表当前可用。刷新与自动刷新只影响此渠道。">
          <div {...stylex.props(styles.stack)}>
            {activeChannel.kind === 'api'
              ? <Text type="secondary" className={stylex.props(styles.meta).className}>API 渠道不显示官方订阅额度。</Text>
              : !canQueryQuota
                ? <Text type="secondary" className={stylex.props(styles.meta).className}>该引擎没有官方只读额度接口。</Text>
                : record
                  ? <QuotaSummary engine={record.engine} record={record} now={Date.now()} busy={busy === `quota:${activeId}` ? record.engine : null} policyBusy={!!busy || policy.busy} onRefresh={() => refreshQuota(activeId!)} recovery={record.status === 'unauthenticated' ? '请检查此账号的登录状态；需要更换身份时新建账号。' : undefined} refreshLabel={`刷新 ${activeChannel.label} 额度`} />
                  : <>
                    <Text type="secondary" className={stylex.props(styles.meta).className}>尚无该账号的额度观测。</Text>
                    <div><Button size="small" disabled={!!busy || policy.busy} loading={busy === `quota:${activeId}`} onClick={() => refreshQuota(activeId!)}>刷新账号额度</Button></div>
                  </>}
            {canQueryQuota && <div {...stylex.props(channelStyles.quotaActions)}>
              <NamedSwitch size="small" aria-label={`${activeChannel.label} 自动刷新额度`} checked={activeChannel.quota_refresh !== false} disabled={!!busy || policy.busy} onChange={() => void toggleQuotaRefresh(activeId!)} />
              <Text type="secondary" className={stylex.props(styles.meta).className}>自动刷新额度</Text>
            </div>}
          </div>
        </SettingGroup>
        <SettingGroup title="配置" tips="修改先进入草稿，保存后用于新任务；执行引擎和类型创建后不能更换。">
          <ChannelEditor draft={displayDraft} editing={editing} engineOptions={engineOptions} engineKind={engineKind} hasConfig={!!state?.hasConfig} hasKey={!!state?.hasApiKey} busy={!!busy || policy.busy} onChange={setDraft} />
        </SettingGroup>
        <SettingGroup title="关系" tips="父 Agent、子 Agent 和 Bot 引用此渠道后会使用它的身份；删除前需先移除引用。">
          <div {...stylex.props(styles.stack)}>
            <div {...stylex.props(channelStyles.row)}>
              <span {...stylex.props(channelStyles.rowLabel)}>父 Agent</span>
              <span {...stylex.props(channelStyles.linkList)}>{refs.owners.length ? refs.owners.map(id => <EntityLink key={id} route={{ page: 'owners', id }} icon={<UserRound size={14} aria-hidden="true" />}>{id}</EntityLink>) : <Text type="secondary" className={stylex.props(styles.meta).className}>无</Text>}</span>
            </div>
            <div {...stylex.props(channelStyles.row)}>
              <span {...stylex.props(channelStyles.rowLabel)}>子 Agent</span>
              <span {...stylex.props(channelStyles.linkList)}>{refs.workers.length ? refs.workers.map(id => <EntityLink key={id} route={{ page: 'workers', id }} icon={<Bot size={14} aria-hidden="true" />}>{id}</EntityLink>) : <Text type="secondary" className={stylex.props(styles.meta).className}>无</Text>}</span>
            </div>
            {botUses && <div {...stylex.props(channelStyles.row)}>
              <span {...stylex.props(channelStyles.rowLabel)}>Bot</span>
              <span {...stylex.props(channelStyles.linkList)}><EntityLink route={{ page: 'bots' }} icon={<MessageSquare size={14} aria-hidden="true" />}>Bot · 飞书 IM</EntityLink></span>
            </div>}
          </div>
        </SettingGroup>
      </div>
    </Pane>;
  })() : null;

  const addOrEmpty = adding ? (() => {
    const formDraft = activeDraft ?? blankDraft();
    const editing = false;
    const kind = engineKind(formDraft.channel.engine);
    const allowedEngines = engineOptions.filter(option => formDraft.channel.kind === 'subscription' ? subscriptionAllowed(engineKind(option.value)) : directApiAllowed(engineKind(option.value))).map(option => option.value);
    const canSave = channelDraftCanSave(formDraft, editing, allowedEngines, kind);
    return <Pane
      label="添加账号"
      title={paneTitle(<span {...stylex.props(channelStyles.headerName)}>添加账号</span>)}
      footer={dirty ? <SaveBar dirty saving={busy === 'save'} saveDisabled={!canSave || !!busy} onSave={() => void saveDraft(formDraft)} onDiscard={discardDraft} /> : undefined}
    >
      <div {...stylex.props(channelStyles.mainBody)}>
        <SettingGroup title="配置" tips="新建账号先填写名称与连接方式；保存官方订阅后会立即打开登录对话框。">
          <ChannelEditor draft={formDraft} editing={editing} engineOptions={engineOptions} engineKind={engineKind} hasConfig={false} hasKey={false} busy={!!busy || policy.busy} onChange={setDraft} />
        </SettingGroup>
      </div>
    </Pane>;
  })() : <Pane
    label="账号或渠道详情"
    title={paneTitle(<span {...stylex.props(channelStyles.headerName)}>{missing ? '未找到' : '账号或渠道'}</span>)}
  >
    {loading && !config ? <div {...stylex.props(channelStyles.mainBody)}><Skeleton.Text animated rows={6} /></div>
      : missing ? <div {...stylex.props(channelStyles.emptyPane)}><Empty title="未找到这个账号或渠道" description="它可能已被删除，或链接中的 ID 有误。" action={<Button onClick={backToList}>返回列表</Button>} /></div>
        : !config ? <div {...stylex.props(channelStyles.emptyPane)}><Empty title="账号与渠道尚未读取" description={loadFailed ? '请求失败，请刷新后重试。' : '正在读取账号与渠道。'} action={<Button icon={RefreshCw} loading={loading} onClick={() => void load()}>刷新</Button>} /></div>
          : <div {...stylex.props(channelStyles.emptyPane)}><Empty title={channelCount ? '选择一个账号或渠道' : '添加第一个账号或渠道'} description={channelCount ? '从左侧列表选择以查看凭据、额度和配置。' : '添加官方订阅可直接登录独立账号；API 渠道填写连接配置。'} action={<Button type="primary" icon={Plus} disabled={!engineOptions.length || !!busy || policy.busy} onClick={beginAdd}>添加账号</Button>} /></div>}
  </Pane>;

  return <section {...stylex.props(channelStyles.page)} aria-label="账号与渠道内容">
    <PageHeader
      title={<TitleWithTips title="账号与渠道" tips="选择官方订阅账号或 API 渠道，再分配给父、子 Agent。每个渠道使用独立配置。" />}
      action={<>
        <Button icon={RefreshCw} loading={loading} disabled={!!busy} onClick={() => void load()}>刷新</Button>
        <Button icon={Upload} disabled={!!busy || policy.busy} onClick={() => { readGeneration.current++; setLoading(false); setReplaceExisting(false); setImporting(true); }}>导入</Button>
        <Button type="primary" icon={Plus} disabled={!engineOptions.length || !!busy || policy.busy} onClick={beginAdd}>添加账号</Button>
      </>}
    />
    {metrics && <ChannelMetrics metrics={metrics} filter={filter} onFilter={setFilter} />}
    <div {...stylex.props(channelStyles.master)}>
      <MasterDetail list={list} main={<div {...stylex.props(channelStyles.detailFrame)}>{detail ?? addOrEmpty}</div>} listWidth={320} listLabel="账号与渠道列表" mainLabel="账号或渠道详情" mobileView={mobileView} />
    </div>
    <ChannelImportModal open={importing} busy={busy} revision={revision} engineOptions={engineOptions} sourceDir={sourceDir} importEngine={importEngine} replaceExisting={replaceExisting} onSource={setSourceDir} onEngine={setImportEngine} onReplace={setReplaceExisting} onCancel={() => { if (!busy) setImporting(false); }} onImport={() => void runImport()} />
    {loginChannel && config?.channels[loginChannel] && <ChannelLoginDialog key={`login:${loginChannel}`} channel={loginChannel} label={config.channels[loginChannel].label} onClose={() => setLoginChannel(undefined)} onSucceeded={async () => { if (!await load()) throw new Error('未能刷新账号凭据状态，请重试。'); }} />}
    <Modal className={stylex.props(resourceStyles.modal).className} classNames={{ body: stylex.props(resourceStyles.modalBody).className, footer: stylex.props(resourceStyles.modalFooter).className }} draggable={false} open={!!deleting} title="删除渠道" okText="删除" cancelText="取消" okButtonProps={{ danger: true, disabled: !!busy || !deleting || deletingBlocked }} confirmLoading={busy === 'delete'} onCancel={() => { if (!busy) setDeleting(undefined); }} onOk={() => deleting && confirmDelete(deleting)}>
      <Text>{deletingBlocked ? `「${deletingChannel?.label ?? deleting}」仍被 ${[...deletingUsers, ...(deletingBot ? ['Bot · 飞书 IM'] : [])].join('、')} 引用，请先更换引用。` : `删除渠道「${deletingChannel?.label ?? deleting}」及其托管配置后不能撤销；之后无法再用它派发任务，来源 CLI 目录不受影响。`}</Text>
    </Modal>
    {guard.dialog}
  </section>;
}

function ChannelMetrics({ metrics, filter, onFilter }: { metrics: ReturnType<typeof channelMetrics>; filter: string; onFilter: (value: string) => void }) {
  const items: { key: string; label: string; metric: ChannelMetric; value: string }[] = [
    { key: 'total', label: '账号与渠道', metric: metrics.total, value: 'all' },
    { key: 'subscriptions', label: '官方订阅', metric: metrics.subscriptions, value: 'subscription' },
    { key: 'api', label: 'API', metric: metrics.api, value: 'api' },
    { key: 'quota', label: '额度可用', metric: metrics.quota, value: '' },
  ];
  return <CompactMetrics
    label="账号与渠道指标"
    items={items.map(item => ({
      label: item.label,
      value: item.metric.value,
      hint: item.metric.hint,
      ...(item.metric.tone === 'warning' ? { valueTone: 'warning' as const } : {}),
      ...(item.value
        ? { onClick: () => onFilter(item.value), pressed: filter === item.value }
        : {}),
    }))}
  />;
}
