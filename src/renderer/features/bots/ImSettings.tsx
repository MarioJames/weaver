import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Input, InputPassword, Spin, Tag, Text, TextArea, Tooltip } from '@lobehub/ui/base-ui';
import { Check } from 'lucide-react';
import { Icon } from '@lobehub/ui';
import { notifyError } from '../../api/notify';
import { TimeText } from '../../ui/TimeText';
import { NamedSelect, NamedSwitch } from '../../ui/NamedControls';
import { tagColor } from '../../format/tag-colors';
import type { ImSettingsSnapshot, ImStatus } from '../../../shared/contracts/im';
import { imEngineEfforts, isImEngineKind } from '../../../shared/im-engines';
import { ModelPicker } from '../engines/ModelPicker';
import { WorkspacePicker } from '../tasks/WorkspacePicker';
import { MinutesInput } from '../settings/SettingRows';
import { botStyles } from './bot-style';
import { BotChannel, BotSetting } from './BotSettingRows';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import {
  adoptServer, conflictNote, createRequestGate, draftOf, IDLE_RANGE, IM_ENGINE_KINDS, imModelDiscoveryEngine, keepImDraft, modifiedEdit,
  peekImDraft, savePlan, switchDraftEngine, workspaceListError, IM_WORKSPACE_LIMIT, type ImDraft, type ImEdit,
} from './im-state';
import { IM_STABLE_POLL_MS, IM_TRANSITION_POLL_MS, nextImPollDelay } from './im-polling';

const CONNECTION: Record<ImStatus['connection'], { label: string; color?: string }> = {
  disabled: { label: '未启用', color: tagColor('neutral') },
  connecting: { label: '连接中', color: tagColor('inProgress') },
  connected: { label: '已连接', color: tagColor('success') },
  error: { label: '连接异常', color: tagColor('error') },
};

const AGENT: Record<ImStatus['agentState'], { label: string; color: string; description: string }> = {
  disabled: { label: '未启动', color: tagColor('neutral'), description: '启用 Bot 并保存后启动 Agent。' },
  starting: { label: '启动中', color: tagColor('inProgress'), description: 'Agent 正在启动，完成后可接收消息。' },
  ready: { label: '待命', color: tagColor('success'), description: 'Agent 已就绪，可接收消息；尚无手机会话时也会保持待命。' },
  busy: { label: '回复中', color: tagColor('inProgress'), description: 'Agent 正在处理消息。' },
  closing: { label: '结束中', color: tagColor('inProgress'), description: '正在结束旧会话，请等待状态更新。' },
  error: { label: '启动异常', color: tagColor('error'), description: '可点「重建连接与会话」重试；有未保存修改时请先保存。' },
};

/** Agent readiness comes only from the service lifecycle, independently of the Feishu connection. */
export function AgentStatus({ status, controlId, action }: { status: ImStatus; controlId: string; action?: ReactNode }) {
  const agent = AGENT[status.agentState];
  return <BotSetting label="Agent 状态" htmlFor={controlId} desc={<>{status.agentMessage && <>{status.agentMessage}<br /></>}{agent.description}</>}>
    <Tag size="small" color={agent.color} role="status" aria-label={`Agent 状态：${agent.label}`}>{agent.label}</Tag>
    {action}
  </BotSetting>;
}

/** 后台轮询只吸收真实状态与修订，配置写入一律走显式保存。稳定态低频，过渡态短周期见 im-polling。 */
const POLL_MS = IM_STABLE_POLL_MS;
const TRANSITION_POLL_MS = IM_TRANSITION_POLL_MS;

const CHANNEL_DESC = '每个 Bot 是独立单聊的 Agent，直接选用已启用的引擎、模型和思考力度。换引擎、模型、力度或工作空间会结束旧对话并重建 Agent，网络正常的飞书连接保持不断；后台运行不用开着终端标签页。普通聊天只在当前对话回复，不建任务；实际工作可跨引擎派发，仍走 Weaver 任务面板。';

interface BotOption { value: string; label: string; disabled: boolean }

export interface ImSettingsViewProps {
  id: string;
  loading: boolean;
  loadError: string;
  saved?: ImSettingsSnapshot;
  values?: ImDraft;
  edit?: ImEdit;
  conflict: boolean;
  fieldErrors: Record<string, string>;
  saveError: string;
  saving: boolean;
  savedTick: boolean;
  refreshing: boolean;
  reconnecting: boolean;
  forceReading: boolean;
  dirty: boolean;
  engineOptions: BotOption[];
  engineUsable: boolean;
  discoveryEngine: string;
  efforts?: readonly string[];
  openCodeVariant: boolean;
  effortOptions: BotOption[];
  onRetryLoad: () => void;
  onReloadLatest: () => void;
  onRefreshStatus: () => void;
  onReconnect: () => void;
  onUpdate: (patch: Partial<ImDraft>) => void;
  onEngineChange: (engine: string) => void;
  onRemoveWorkspace: (index: number) => void;
  onAddWorkspace: (path: string) => void;
  onTimeoutError: (message: string) => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function ImSettingsView({
  id, loading, loadError, saved, values, edit, conflict, fieldErrors, saveError, saving, savedTick, refreshing, reconnecting, forceReading, dirty,
  engineOptions, engineUsable, discoveryEngine, efforts, openCodeVariant, effortOptions,
  onRetryLoad, onReloadLatest, onRefreshStatus, onReconnect, onUpdate, onEngineChange, onRemoveWorkspace, onAddWorkspace, onTimeoutError, onDiscard, onSave,
}: ImSettingsViewProps) {
  const lockFields = saving || forceReading;
  const status = saved?.status;
  const connection = CONNECTION[status?.connection ?? 'disabled'];
  const configuredSecret = saved?.config.appSecretConfigured ?? false;
  const statusDesc = !status || status.connection === 'disabled'
    ? '未启用。打开开关、完成配置并保存后，这里显示真实连接与会话状态。'
    : <>{status.connection === 'error' && status.message ? `${status.message} ` : ''}活跃会话 {status.activeSessions}，忙碌 {status.busySessions}{status.lastMessageAt && <><br />最近消息 <TimeText value={status.lastMessageAt} /></>}{status.lastReplyAt && <>，最近回复 <TimeText value={status.lastReplyAt} /></>}</>;

  return <BotChannel channel="feishu" title="飞书 IM" desc={CHANNEL_DESC}>
    {!saved || !values
      ? loading
        ? <div className={botStyles.loading}><Spin size="small" aria-label="正在读取飞书 IM 设置" /><Text fontSize={12}>正在读取飞书 IM 设置…</Text></div>
        : <div className={botStyles.loading}><Text fontSize={12} role="alert">{loadError}</Text><Button size="small" onClick={onRetryLoad}>重试</Button></div>
      : <>
          {conflict && edit && <BotSetting label="配置在别处被修改" htmlFor={`${id}-conflict`} desc={conflictNote(edit, saved)} role="alert">
            <Button id={`${id}-conflict`} size="small" loading={forceReading} disabled={saving || loading} onClick={onReloadLatest}>放弃修改并载入最新</Button>
          </BotSetting>}
          <BotSetting label="连接状态" htmlFor={`${id}-refresh`} desc={statusDesc}>
            <Tag size="small" color={connection.color}>{connection.label}</Tag>
            <Button id={`${id}-refresh`} size="small" loading={refreshing} disabled={lockFields} onClick={onRefreshStatus}>刷新状态</Button>
          </BotSetting>
          <AgentStatus status={saved.status} controlId={`${id}-reconnect`} action={dirty
            ? <Tooltip title="先保存修改，再重建连接。"><span><Button id={`${id}-reconnect`} size="small" disabled>重建连接与会话</Button></span></Tooltip>
            : <Tooltip title="会关闭当前引擎进程与会话上下文，再按已保存配置建立新的连接和会话。"><span><Button id={`${id}-reconnect`} size="small" loading={reconnecting} disabled={lockFields || !saved.config.enabled} onClick={onReconnect}>重建连接与会话</Button></span></Tooltip>} />
          <BotSetting label="启用飞书 IM" htmlFor={`${id}-enabled`} desc="保存后立即生效：保存为关闭即断开连接并结束现有手机对话会话；已派发的任务照常在任务面板继续，不受会话清理影响。">
            <NamedSwitch id={`${id}-enabled`} aria-label="启用飞书 IM" checked={values.enabled} disabled={lockFields} onChange={checked => onUpdate({ enabled: checked })} />
          </BotSetting>
          <BotSetting label="App ID" htmlFor={`${id}-appid`} desc="飞书开放平台企业自建应用的 App ID：cli_ 开头加 16 位十六进制字符。" error={fieldErrors.appId}>
            <Input id={`${id}-appid`} aria-label="App ID" value={values.appId} placeholder="例如：cli_a1b2c3d4e5f6a7b8" style={{ inlineSize: '100%', maxInlineSize: 320 }} disabled={lockFields} onChange={event => onUpdate({ appId: event.target.value })} />
          </BotSetting>
          <BotSetting label="App Secret" htmlFor={`${id}-secret`} desc={configuredSecret ? '已保存一份 Secret，不再回显；留空保存保持不变，粘贴新值即覆盖。「清除已保存」在保存时删除它。' : '粘贴开放平台的应用 Secret，只在保存时提交，之后不再回显。'} error={fieldErrors.secret}>
            <InputPassword id={`${id}-secret`} aria-label="App Secret" value={values.secret} placeholder={configuredSecret ? '已保存；粘贴新的 Secret 可覆盖' : '粘贴应用 Secret'} style={{ inlineSize: '100%', maxInlineSize: 320 }} disabled={lockFields} visibilityToggle onChange={event => onUpdate({ secret: event.target.value })} />
            {configuredSecret && (values.clearSecret
              ? <Button size="small" disabled={lockFields} onClick={() => onUpdate({ clearSecret: false })}>撤销清除</Button>
              : <Tooltip title="随下次「保存修改」删除已存的 Secret：保存后手机链路立即失效，直到粘贴新的 Secret。"><span><Button size="small" disabled={lockFields} onClick={() => onUpdate({ clearSecret: true })}>清除已保存</Button></span></Tooltip>)}
          </BotSetting>
          <BotSetting label="open_id 白名单" htmlFor={`${id}-openids`} desc="只接受这些飞书用户发来的单聊文本消息，每行一个。open_id 的获取方式见接入文档，不做自动绑定。" error={fieldErrors.openIds}>
            <TextArea id={`${id}-openids`} aria-label="open_id 白名单，每行一个" value={values.openIdsText} placeholder={'ou_xxxxxxxxxxxxxxxx\n（每行一个）'} autoSize={{ minRows: 2, maxRows: 6 }} disabled={lockFields} style={{ inlineSize: '100%', maxInlineSize: 360 }} onChange={event => onUpdate({ openIdsText: event.target.value })} />
          </BotSetting>
          <BotSetting label="引擎" htmlFor={`${id}-engine`} desc="选用已安装且已启用的引擎；这里只控制 Bot 聊天，不依赖父 Agent 或 worker 配置。" error={fieldErrors.engine || (values.engine && !engineUsable ? '已保存的引擎已失效、未启用或暂不支持，请重新选择。' : '')}>
            <NamedSelect id={`${id}-engine`} aria-label="引擎" value={values.engine || undefined} options={engineOptions} style={{ inlineSize: '100%', maxInlineSize: 320 }} popupMatchSelectWidth={false} disabled={lockFields} placeholder="选择已启用的引擎" onChange={engine => { if (typeof engine === 'string') onEngineChange(engine); }} />
          </BotSetting>
          <BotSetting label="模型" htmlFor={`${id}-model`} desc="从引擎提供的模型中选择，也可手动填写；切换引擎后需重新明确模型。" error={fieldErrors.model}>
            <fieldset disabled={lockFields} inert={lockFields} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0, inlineSize: '100%', maxInlineSize: 360 }}>
              <ModelPicker id={`${id}-model`} label="模型" engine={engineUsable ? discoveryEngine : ''} value={values.model} placeholder="例如：gpt-6.1-sol 或 claude-opus-5-5" onChange={model => { if (!lockFields) onUpdate({ model }); }} />
            </fieldset>
          </BotSetting>
          <BotSetting label="思考力度" htmlFor={`${id}-effort`} desc={efforts ? 'Bot 独立使用的思考力度；保存后随模型一起生效。' : openCodeVariant ? 'OpenCode 的 variant 由模型定义，可直接填写；保存后随模型一起生效。' : '先选择一个支持飞书对话的引擎。'} error={fieldErrors.effort}>
            {efforts
              ? <NamedSelect id={`${id}-effort`} aria-label="思考力度" value={values.effort || undefined} options={effortOptions} style={{ inlineSize: '100%', maxInlineSize: 320 }} disabled={lockFields || !engineUsable} placeholder="先选择引擎" onChange={effort => { if (typeof effort === 'string') onUpdate({ effort }); }} />
              : <div className={botStyles.controlStack}>
                  <Input id={`${id}-effort`} aria-label="思考力度" value={values.effort} placeholder={openCodeVariant ? '例如：high 或该模型接受的 variant' : '先选择引擎'} style={{ inlineSize: '100%', maxInlineSize: 320 }} disabled={lockFields || !engineUsable} onChange={event => onUpdate({ effort: event.target.value })} />
                  {openCodeVariant && engineUsable && <Text type="secondary" fontSize={12} className={botStyles.wrap}>填写该模型接受的 variant。</Text>}
                </div>}
          </BotSetting>
          <BotSetting label="工作空间" htmlFor={`${id}-workspaces`} desc={`Bot 可访问列表中的全部目录，并按任务目标在相应目录创建主 Agent 和任务。最多 ${IM_WORKSPACE_LIMIT} 个，选择 Weaver 所在机器上已存在的项目目录；保存后生效。`} error={fieldErrors.workspaces}>
            <div className={botStyles.workspaces}>
              {values.workspaces.length
                ? <ul aria-label="已配置工作空间" className={botStyles.list}>
                    {values.workspaces.map((path, index) => <li key={`${index}-${path}`} className={botStyles.directory}>
                      <Text fontSize={12}>{path}</Text>
                      <Button size="small" disabled={lockFields} aria-label={`移除工作空间 ${path}`} onClick={() => onRemoveWorkspace(index)}>移除</Button>
                    </li>)}
                  </ul>
                : <Text type="secondary" fontSize={12}>尚未添加工作空间。浏览本机目录后添加，启用 Bot 前至少配置一个。</Text>}
              <WorkspacePicker id={`${id}-workspaces`} label="添加工作空间" placeholder="浏览本机目录并添加" confirmLabel="添加此目录" value="" disabled={lockFields || values.workspaces.length >= IM_WORKSPACE_LIMIT} onChange={onAddWorkspace} />
              {values.workspaces.length >= IM_WORKSPACE_LIMIT && <Text type="secondary" fontSize={12}>已达 {IM_WORKSPACE_LIMIT} 个上限，移除后可继续添加。</Text>}
            </div>
          </BotSetting>
          <BotSetting label="空闲超时（分钟）" htmlFor={`${id}-idle`} desc={`最后一条用户消息后静默超过该时长，会结束旧上下文并立即建立新会话保持待命。${IDLE_RANGE.min} 到 ${IDLE_RANGE.max} 分钟，默认 30。`} error={fieldErrors.timeout}>
            {/* 受控同步：框里此刻的数（含敲错/清空的 null）每一次敲击都回写草稿，保存计划与放弃/重载见到的都是同一个可见值。 */}
            <MinutesInput id={`${id}-idle`} label="空闲超时（分钟）" value={values.idleTimeoutMinutes} min={IDLE_RANGE.min} max={IDLE_RANGE.max} step={5} disabled={lockFields} onError={onTimeoutError} onDraftChange={value => onUpdate({ idleTimeoutMinutes: value })} onCommit={value => onUpdate({ idleTimeoutMinutes: value })} />
          </BotSetting>
          <BotSetting
            label="保存" htmlFor={`${id}-save`}
            desc="以上字段一起保存，保存后立即生效（含启停连接）；引擎、模型、力度或工作空间变化会结束旧上下文并重建 Agent，健康且凭据相同的飞书连接保持，凭据或启停变化以及显式「重建连接与会话」会完整重建。失败时草稿原样保留。未保存的修改切到其他页面后仍保留，回到本页继续编辑，只有保存成功或「放弃修改」会清掉它们。"
            error={saveError}
          >
            <Button id={`${id}-save`} type="primary" size="small" loading={saving} disabled={!dirty || forceReading} onClick={onSave}>保存修改</Button>
            <Button size="small" disabled={!dirty || lockFields} onClick={onDiscard}>放弃修改</Button>
            {savedTick && <Text type="success" fontSize={12} role="status"><Icon icon={Check} size="small" /> 已保存</Text>}
          </BotSetting>
        </>}
  </BotChannel>;
}

/**
 * 飞书 IM 设置：一个分组里的显式保存草稿加一条只读状态。
 * - 正在使用的形状全部来自 shared/contracts/im，`window.weaver` 的方法名与后端契约一致。
 * - 每次远端快照经 `adoptServer` 接合：无草稿整幅采纳；有草稿保留其基线修订并只吸收状态，
 *   保存带草稿基线的修订号，冲突靠后端裁决并提供「放弃修改并载入最新」恢复。
 * - 每条请求经 `createRequestGate` 收束生命周期：同类同时只有一个在飞请求，各自负责自己的 spinner
 *   （后台轮询或别的请求推进落地线也不会把 refreshing/reconnecting 卡成永久 true）；
 *   全局落地线只放最新结果写进页面：晚到的旧响应（含保存前的旧读）绝不覆盖新保存。
 * - 「放弃修改并载入最新」进行中锁住全部输入与按钮，强制读取不会丢掉读取期间敲进去的内容；
 *   明确成功后整幅采纳读取结果，并清空此前保存/字段的过期错误，失败则草稿与反馈原样保留。
 * - 空闲超时的分钟框受控同步进草稿（见 MinutesInput 的 onDraftChange）：用户可见的数字本身就是
 *   保存计划的输入——非法可见值让校验拦下整个保存并在字段报错，修成合法数后按所见准确写入，
 *   「放弃修改」与「放弃修改并载入最新」也随草稿复位把框里的数送回已保存值。
 * - 未保存草稿在页面切换之间留在内存（见 im-state），只有保存成功或放弃才清除；
 *   文档关闭提醒跟着 holder 走，卸载本组件不会解除。
 */
export function ImSettings({ policy }: { policy: PolicyDraft }) {
  const id = useId();
  const gate = useRef(createRequestGate()).current;
  const [saved, setSaved] = useState<ImSettingsSnapshot>();
  const savedRef = useRef<ImSettingsSnapshot | undefined>(undefined);
  const [edit, setEditState] = useState<ImEdit | undefined>(() => peekImDraft());
  const editRef = useRef<ImEdit | undefined>(edit);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [forceReading, setForceReading] = useState(false);
  const mounted = useRef(true);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const savingRef = useRef(false);
  const forceReadingRef = useRef(false);
  /** 轮询在飞标记：poll 不计入互斥 busy，这里单独防止慢响应重叠。 */
  const pollInFlightRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(savedTimer.current); };
  }, []);

  const setEdit = useCallback((next: ImEdit | undefined) => {
    keepImDraft(next);
    editRef.current = next;
    setEditState(next);
  }, []);

  /** 每次成功读到的快照都走同一条接合路径，基线规则不会被其他调用点绕开。 */
  const applySnapshot = useCallback((next: ImSettingsSnapshot, force: boolean) => {
    const outcome = adoptServer(next, force ? undefined : editRef.current);
    savedRef.current = outcome.saved;
    setSaved(outcome.saved);
    setConflict(outcome.conflict);
    if (outcome.edit !== editRef.current) setEdit(outcome.edit);
  }, [setEdit]);

  /** 首次加载/重试与「放弃修改并载入最新」：各自一类，收尾时复位自己那盏 spinner。 */
  const read = useCallback(async (force = false) => {
    const flight = gate.begin(force ? 'force' : 'load');
    if (force) { forceReadingRef.current = true; setForceReading(true); } else setLoading(true);
    setLoadError('');
    try {
      const next = await window.weaver.getImSettings();
      if (!mounted.current || !flight.lands()) return;
      applySnapshot(next, force);
      // 「放弃修改并载入最新」明确成功：整幅采纳当前读取结果，此前保存/字段的过期错误一并清掉，只留下这份读取；
      // 失败路径不清——草稿、错误与恢复反馈都保留，用户仍可重试。
      if (force) { setSaveError(''); setFieldErrors({}); }
    } catch (error) {
      if (!mounted.current || !flight.lands()) return;
      if (force) notifyError(error, '载入最新失败，草稿保留原样，可重试');
      else setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      const idle = flight.end();
      if (mounted.current && idle) {
        if (force) { forceReadingRef.current = false; setForceReading(false); } else setLoading(false);
      }
    }
  }, [applySnapshot, gate]);

  /** 静默重读：后台轮询与保存失败后的核对；失败不打断输入，保持已知状态。同一时刻只允许一个轮询在飞。 */
  const silentRead = useCallback(async () => {
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    const flight = gate.begin('poll');
    try {
      const next = await window.weaver.getImSettings();
      if (!mounted.current || !flight.lands()) return;
      applySnapshot(next, false);
    } catch { /* 下一次轮询再试。 */ } finally {
      pollInFlightRef.current = false;
      flight.end();
    }
  }, [applySnapshot, gate]);

  const refreshStatus = useCallback(async () => {
    const flight = gate.begin('refresh');
    setRefreshing(true);
    try {
      const next = await window.weaver.getImSettings();
      if (!mounted.current || !flight.lands()) return;
      applySnapshot(next, false);
    } catch (error) {
      if (mounted.current && flight.lands()) notifyError(error, '状态刷新失败');
    } finally {
      const idle = flight.end();
      if (mounted.current && idle) setRefreshing(false);
    }
  }, [applySnapshot, gate]);

  const reconnect = useCallback(async () => {
    const flight = gate.begin('reconnect');
    setReconnecting(true);
    try {
      const next = await window.weaver.reconnectIm();
      if (!mounted.current || !flight.lands()) return;
      applySnapshot(next, false);
    } catch (error) {
      if (mounted.current && flight.lands()) notifyError(error, '重新连接失败');
    } finally {
      const idle = flight.end();
      if (mounted.current && idle) setReconnecting(false);
    }
  }, [applySnapshot, gate]);

  const save = useCallback(async () => {
    const current = savedRef.current;
    const pending = editRef.current;
    if (!current || !pending || savingRef.current) return;
    const plan = savePlan(pending, policy.snapshot?.config);
    setFieldErrors(plan.errors);
    setSaveError('');
    // 没有可提交的输入（分钟框此刻无数）就不发请求；校验错误由上面一步整体拦下并留在各字段。
    if (Object.keys(plan.errors).length || !plan.input) return;
    const flight = gate.begin('save');
    setSaving(true);
    savingRef.current = true;
    try {
      const next = await window.weaver.saveImSettings(plan.input);
      if (!mounted.current || !flight.lands()) return;
      savedRef.current = next;
      setSaved(next);
      setEdit(undefined);
      setConflict(false);
      setFieldErrors({});
      setSavedTick(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => { if (mounted.current) setSavedTick(false); }, 2000);
    } catch (error) {
      if (!mounted.current || !flight.lands()) return;
      setSaveError(error instanceof Error ? error.message : String(error));
      // 结果不确定时重读一次核对：接合规则把真实状态带进页面，Secret 操作的草稿如实保留。
      void silentRead();
    } finally {
      savingRef.current = false;
      const idle = flight.end();
      if (mounted.current && idle) setSaving(false);
    }
  }, [policy.snapshot, setEdit, silentRead, gate]);

  // 自适应轮询：过渡态（connecting / starting / closing）短周期跟进保存与重建后的状态机，
  // 稳定态恢复低频；互斥请求在飞或已有轮询在飞时不重叠，只推迟下一次；失败由 silentRead 吞错后按计划继续。
  // 状态翻转（保存/重建落地新状态）会重启本 effect，把已排队的长周期换成短周期；卸载清理 timer，不写已卸载状态。
  const pollStatusKey = saved?.status ? `${saved.status.connection}/${saved.status.agentState}` : 'none';
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick(): Promise<void> {
      if (cancelled || !mounted.current) return;
      if (typeof document !== 'undefined' && document.hidden) {
        schedule(POLL_MS);
        return;
      }
      if (gate.busy() || pollInFlightRef.current) {
        schedule(TRANSITION_POLL_MS);
        return;
      }
      await silentRead();
      if (cancelled || !mounted.current) return;
      schedule(nextImPollDelay(savedRef.current?.status, POLL_MS, TRANSITION_POLL_MS));
    }
    function schedule(delay: number): void {
      if (cancelled) return;
      timer = setTimeout(() => { void tick(); }, delay);
    }
    schedule(nextImPollDelay(savedRef.current?.status, POLL_MS, TRANSITION_POLL_MS));
    const onVisible = () => {
      if (typeof document === 'undefined' || document.hidden || !mounted.current) return;
      if (gate.busy() || pollInFlightRef.current) return;
      // 切回可见时尽快跟进一次，复用同一条落地线与草稿接合，不另起请求体系。
      void silentRead();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [silentRead, gate, pollStatusKey]);

  useEffect(() => { void read(false); }, [read]);

  const values = useMemo<ImDraft | undefined>(() => {
    if (!saved) return undefined;
    return edit?.values ?? draftOf(saved.config);
  }, [saved, edit]);
  const dirty = useMemo(() => !!edit && modifiedEdit(edit), [edit]);
  // 文档关闭提醒跟着草稿 holder（im-state）走：切页卸载本组件后依然有效，本组件不再自挂 beforeunload。

  const update = useCallback((patch: Partial<ImDraft>) => {
    const current = editRef.current;
    const base = savedRef.current;
    if (!base || savingRef.current || forceReadingRef.current) return;
    // 已有活动草稿直接续写；否则以当前显示的已保存配置为基线新开一份，之后基线不再被偷换。
    const next: ImEdit = current && modifiedEdit(current)
      ? { ...current, values: { ...current.values, ...patch } }
      : { values: { ...draftOf(base.config), ...patch }, base: base.config, revision: base.revision };
    setEdit(next);
  }, [setEdit]);

  const discard = useCallback(() => {
    setEdit(undefined);
    setFieldErrors({});
    setSaveError('');
    setConflict(false);
  }, [setEdit]);

  const removeWorkspace = useCallback((index: number) => {
    if (!values || savingRef.current || forceReadingRef.current) return;
    update({ workspaces: values.workspaces.filter((_, at) => at !== index) });
    setFieldErrors(current => ({ ...current, workspaces: '' }));
  }, [update, values]);

  const addWorkspace = useCallback((path: string) => {
    if (savingRef.current || forceReadingRef.current) return;
    const current = editRef.current?.values.workspaces ?? savedRef.current?.config.workspaces ?? [];
    const next = [...current, path];
    const message = workspaceListError(next);
    setFieldErrors(state => ({ ...state, workspaces: message }));
    if (!message) update({ workspaces: next });
  }, [update]);

  const setTimeoutError = useCallback((message: string) => {
    setFieldErrors(current => {
      const next = { ...current };
      if (message) next.timeout = message;
      else delete next.timeout;
      return next;
    });
  }, []);

  const config = policy.snapshot?.config;
  const engineOptions = useMemo(() => {
    if (!config) return [];
    const options = Object.entries(config.engines).map(([engineId, engine]) => {
      const supported = IM_ENGINE_KINDS.has(engine.kind);
      const suffix = !supported ? '（暂不支持飞书对话）' : !engine.enabled ? '（未启用）' : '';
      return { value: engineId, label: `${engineId}${suffix}`, disabled: !supported || !engine.enabled };
    });
    const savedId = values?.engine;
    if (savedId && !config.engines[savedId]) options.push({ value: savedId, label: `${savedId}（已失效）`, disabled: true });
    return options;
  }, [config, values?.engine]);
  const selectedEngine = values?.engine ? config?.engines[values.engine] : undefined;
  const engineUsable = !!selectedEngine && selectedEngine.enabled && isImEngineKind(selectedEngine.kind);
  // 模型发现只用目录 canonical id（别名按 kind 映射，如 ocode→opencode、pi_alt→pi、qoder kind→qoder）；
  // 保存与运行仍用原 policy engine ID（values.engine）。
  const discoveryEngine = values?.engine ? imModelDiscoveryEngine(values.engine, config) : '';
  const efforts = selectedEngine && isImEngineKind(selectedEngine.kind) ? imEngineEfforts(selectedEngine.kind) : undefined;
  const openCodeVariant = selectedEngine?.kind === 'opencode';
  const effortOptions = (efforts ?? []).map(value => ({ value, label: value, disabled: false }));
  if (values?.effort && efforts && !efforts.includes(values.effort)) effortOptions.push({ value: values.effort, label: !values.engine && values.effort === 'medium' ? 'medium' : `${values.effort}（请选择引擎支持的力度）`, disabled: true });

  const changeEngine = useCallback((engine: string) => {
    if (!values) return;
    update(switchDraftEngine(values, engine, config));
  }, [values, config, update]);

  return <ImSettingsView
    id={id}
    loading={loading}
    loadError={loadError}
    saved={saved}
    values={values}
    edit={edit}
    conflict={conflict}
    fieldErrors={fieldErrors}
    saveError={saveError}
    saving={saving}
    savedTick={savedTick}
    refreshing={refreshing}
    reconnecting={reconnecting}
    forceReading={forceReading}
    dirty={dirty}
    engineOptions={engineOptions}
    engineUsable={engineUsable}
    discoveryEngine={discoveryEngine}
    efforts={efforts}
    openCodeVariant={openCodeVariant}
    effortOptions={effortOptions}
    onRetryLoad={() => void read(false)}
    onReloadLatest={() => void read(true)}
    onRefreshStatus={() => void refreshStatus()}
    onReconnect={() => void reconnect()}
    onUpdate={update}
    onEngineChange={changeEngine}
    onRemoveWorkspace={removeWorkspace}
    onAddWorkspace={addWorkspace}
    onTimeoutError={setTimeoutError}
    onDiscard={discard}
    onSave={() => void save()}
  />;
}
