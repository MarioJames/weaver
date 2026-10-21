import { dateText } from '../quota/quota-view';
import { isTransientError, useNotifyError } from '../../api/notify';
import { useEffect, useRef, useState } from 'react';
import { Button, Modal, Tag, Text, Tooltip } from '@lobehub/ui/base-ui';
import type { Config } from '../../../shared/contracts/policy';
import type { Task } from '../../../shared/contracts/tasks';
import { command } from '../../api/commands';
import { ownerLabel } from '../tasks/task-view';
import { EngineIcon } from '../../ui/EngineIcon';
import { NamedSelect } from '../../ui/NamedControls';
import { tagColor } from '../../format/tag-colors';
import { styles } from './owner-inspector-style';

/** The continuation fields this row shows. */
interface Continuation { lastActivityAt?: string; policy: { idleRotationMinutes: number | null } }
/** The started host, reported either flat or under ownerHost while the contract settles. */
interface LaunchedHost { agentName?: string; ownerHost?: { agentName?: string } }
type Launch = LaunchedHost & ({ ok: true } | { ok: false; code: string; message: string });
interface ContinuationResult { launch?: Launch }
interface OwnerProfile { id: string; kind?: string }

/** Same default the server applies when a task carries no idle policy. */
const DEFAULT_IDLE_MINUTES = 60;

const enabledOwners = (config: Config): OwnerProfile[] => Object.entries(config.owners)
  .filter(([, owner]) => owner.enabled)
  .map(([id, owner]) => ({ id, kind: config.engines[owner.engine]?.kind }));

/** The profile the task runs under: the frozen dispatch, or the registered owner when it is a policy key. */
function currentProfile(task: Task, profiles: OwnerProfile[]): string | undefined {
  const dispatched = task.dispatch?.owner ?? task.ownerId;
  return profiles.some(profile => profile.id === dispatched) ? dispatched : undefined;
}

const launchedAgent = (host: LaunchedHost, fallback: string): string => host.agentName ?? host.ownerHost?.agentName ?? fallback;

export function OwnerInspector({ task, busy, action, owners, now = Date.now() }: {
  task: Task;
  busy: boolean;
  action: (fn: () => Promise<unknown>) => Promise<boolean>;
  /** Enabled owner profiles; read from the saved policy when the caller has none. */
  owners?: OwnerProfile[];
  now?: number;
}) {
  const [live, setLive] = useState<Continuation>();
  const [fetched, setFetched] = useState<OwnerProfile[]>();
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<string>();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');
  const [started, setStarted] = useState('');
  const locked = useRef(false);
  const profiles = owners ?? fetched ?? [];
  const needsPolicy = owners === undefined;
  useEffect(() => {
    // The task carries these fields already; this read only keeps them current, so a failure stays quiet.
    let current = true;
    void command<Continuation>('owners.continuation.get', { taskId: task.id }).then(result => { if (current) setLive(result); }).catch(() => {});
    return () => { current = false; };
  }, [task.id, task.revision, task.ownerEpoch]);
  useEffect(() => {
    if (!needsPolicy) return;
    let current = true;
    const request = window.weaver?.getPolicy();
    if (!request) return;
    request.then(snapshot => { if (current) setFetched(enabledOwners(snapshot.config)); }).catch(() => {});
    return () => { current = false; };
  }, [needsPolicy]);

  const blocked = task.status === 'running' || task.status === 'cancelling' || Boolean(task.scheduled);
  const lastActivity = Date.parse(live?.lastActivityAt ?? task.ownerLastActivityAt ?? task.createdAt);
  const idleMinutes = Number.isFinite(lastActivity) ? Math.max(0, Math.floor((now - lastActivity) / 60_000)) : 0;
  // A read that came back is authoritative: a null interval means the reminder is off, not unknown.
  const configured = live ? live.policy.idleRotationMinutes : task.continuationPolicy?.idleRotationMinutes;
  const interval = configured === undefined ? DEFAULT_IDLE_MINUTES : configured;
  const due = !blocked && interval !== null && idleMinutes >= interval;
  const owner = ownerLabel(task);
  const kind = profiles.find(item => item.id === currentProfile(task, profiles))?.kind;
  const blockedReason = blocked ? `${task.executionRole === 'owner' ? '父 Agent' : '子 Agent'} 执行中，完成或取消后再接续。`
    : !task.ownerId ? '任务尚未登记父 Agent，无法接续。'
      : profiles.length === 0 ? '父 Agent 配置里还没有启用的父 Agent。' : '';

  async function run(commandName: string, extra: Record<string, unknown>) {
    if (locked.current || busy || sending) return;
    locked.current = true; setSending(true); setFailure('');
    let result: ContinuationResult | undefined;
    let notice = '';
    try {
      const applied = await action(async () => {
        try { result = await command<ContinuationResult>(commandName, { taskId: task.id, expectedRevision: task.revision ?? 0, ...extra }, true); }
        catch (cause) { if (!isTransientError(cause)) notice = cause instanceof Error ? cause.message : String(cause); throw cause; }
      });
      const launch = result?.launch;
      if (notice) setFailure(notice);
      else if (launch && !launch.ok) setFailure(`Herdr 启动失败：${launch.message}`);
      else if (applied) {
        setOpen(false);
        // Only a reported host is claimed as started; a rotation without one says just that.
        setStarted(launch?.ok === true ? `已在 Herdr 中启动 ${launchedAgent(launch, profile ?? owner)}` : '父 Agent 已轮换');
      }
    } finally { setSending(false); locked.current = false; }
  }

  return <section aria-label="父 Agent 接续" className={styles.stack}>
    <div className={styles.row}>
      <span className={styles.lead}>
        <EngineIcon kind={kind} size={16} />
        <Text className={styles.owner}>{owner}</Text>
        {blocked ? <Tag size="small" color={tagColor('inProgress')}>{task.executionRole === 'owner' ? '父 Agent' : '子 Agent'} 执行中，暂不可接续</Tag>
          : due ? <Tag size="small" color={tagColor('warning')}>{`已空闲 ${idleMinutes} 分钟，建议接续`}</Tag>
            : <Tag size="small" color={tagColor('success')}>可接续</Tag>}
      </span>
      <span className={styles.action}>
        {blockedReason
          ? <Tooltip title={blockedReason}><span><Button type="primary" disabled>接续给…</Button></span></Tooltip>
          : <Button type="primary" disabled={busy || sending} onClick={() => { setOpen(true); setFailure(''); setProfile(currentProfile(task, profiles)); }}>接续给…</Button>}
      </span>
    </div>
    {task.ownerHost && <Text className={styles.host}>{`已在 Herdr 启动 ${task.ownerHost.agentName} · ${dateText(task.ownerHost.launchedAt)}`}</Text>}
    {started && <Text type="success" role="status">{started}</Text>}
    <Modal open={open} title="接续给新的父 Agent" okText="启动新的父 Agent" cancelText="取消"
      confirmLoading={sending} okButtonProps={{ disabled: !profile || sending }} maskClosable={!sending} keyboard={!sending}
      onCancel={() => setOpen(false)} onOk={() => void run('owners.switch', { profileId: profile, reason: 'manual', launch: true })}>
      <ContinuationDialog profiles={profiles} value={profile} sending={sending} failure={failure}
        onChange={setProfile} onRetry={() => void run('owners.launch', {})} />
    </Modal>
  </section>;
}

/** Every enabled profile as a dialog option, marked with its engine. */
export const ownerOptions = (profiles: OwnerProfile[]) => profiles.map(item => ({
  value: item.id,
  label: <span className={styles.option}><EngineIcon kind={item.kind} />{item.id}</span>,
}));

/** The dialog body, kept apart from its portal so it renders and reads on its own. */
export function ContinuationDialog({ profiles, value, sending, failure, onChange, onRetry }: {
  profiles: OwnerProfile[];
  value?: string;
  sending: boolean;
  failure: string;
  onChange: (next?: string) => void;
  onRetry: () => void;
}) {
  useNotifyError(failure, '操作失败', {label:'重试启动',run:onRetry});
  return <div className={styles.dialog}>
    <NamedSelect aria-label="接手父 Agent" className={styles.pick} placeholder="选择接手父 Agent" disabled={sending} value={value}
      options={ownerOptions(profiles)}
      onChange={next => onChange(typeof next === 'string' ? next : undefined)} />
    <Text type="secondary">Weaver 会生成接续说明，并在 Herdr 中启动新的父 Agent 接手这个任务。</Text>

  </div>;
}
