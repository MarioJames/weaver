import { isTransientError } from '../../api/notify';
import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button, Modal, Text, Tooltip } from '@lobehub/ui';
import type { Config } from '../../../shared/contracts/policy';
import type { Task } from '../../../shared/contracts/tasks';
import { command } from '../../api/commands';
import { ownerDisplayName } from './task-view';
import { EngineIcon } from '../../ui/EngineIcon';
import { NamedSelect } from '../../ui/NamedControls';
import { styles } from '../roles/owner-inspector-style';

interface Continuation { lastActivityAt?: string; policy: { idleRotationMinutes: number | null } }
interface LaunchedHost { agentName?: string; ownerHost?: { agentName?: string } }
type Launch = LaunchedHost & ({ ok: true } | { ok: false; code: string; message: string });
interface ContinuationResult { launch?: Launch }
interface OwnerProfile { id: string; kind?: string }

const enabledOwners = (config: Config): OwnerProfile[] => Object.entries(config.owners)
  .filter(([, owner]) => owner.enabled)
  .map(([id, owner]) => ({ id, kind: config.engines[config.channels[owner.channel]?.engine ?? '']?.kind }));

function currentProfile(task: Task, profiles: OwnerProfile[]): string | undefined {
  const dispatched = task.dispatch?.owner ?? task.ownerId;
  return profiles.some(profile => profile.id === dispatched) ? dispatched : undefined;
}

const launchedAgent = (host: LaunchedHost, fallback: string): string => host.agentName ?? host.ownerHost?.agentName ?? fallback;

export const ownerOptions = (profiles: OwnerProfile[]) => profiles.map(item => ({
  value: item.id,
  label: <span {...stylex.props(styles.option)}><EngineIcon kind={item.kind} />{item.id}</span>,
}));

/**
 * The session header's 接续 action: the continuation ability owned by this package.
 * It keeps the policy read quiet and reports launch failures on its own notice.
 */
export function ContinueSessionButton({ task, busy, action }: {
  task: Task;
  busy: boolean;
  action: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [profiles, setProfiles] = useState<OwnerProfile[]>([]);
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<string>();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');
  const [started, setStarted] = useState('');
  const locked = useRef(false);
  useEffect(() => {
    let current = true;
    const request = window.weaver?.getPolicy();
    if (!request) return;
    request.then(snapshot => { if (current) setProfiles(enabledOwners(snapshot.config)); }).catch(() => {});
    return () => { current = false; };
  }, [task.id]);
  useEffect(() => { if (open) { setFailure(''); setProfile(currentProfile(task, profiles)); } }, [open, task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = task.status === 'running' || task.status === 'cancelling' || Boolean(task.scheduled);
  const blockedReason = blocked ? '父 Agent 执行中，完成或取消后再接续。'
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
        setStarted(launch?.ok === true ? `已在 Herdr 中启动 ${launchedAgent(launch, profile ?? ownerDisplayName(task))}` : '父 Agent 已轮换');
      }
    } finally { setSending(false); locked.current = false; }
  }

  return <>
    {blockedReason
      ? <Tooltip title={blockedReason}><span><Button disabled>接续</Button></span></Tooltip>
      : <Button disabled={busy || sending} onClick={() => setOpen(true)}>接续</Button>}
    {started && <Text type="success" role="status">{started}</Text>}
    <Modal open={open} title="接续给新的父 Agent" okText="启动新的父 Agent" cancelText="取消"
      confirmLoading={sending} okButtonProps={{ disabled: !profile || sending }} maskClosable={!sending} keyboard={!sending}
      onCancel={() => setOpen(false)} onOk={() => void run('owners.switch', { profileId: profile, reason: 'manual', launch: true })}>
      <div {...stylex.props(styles.dialog)}>
        <NamedSelect aria-label="接手父 Agent" {...stylex.props(styles.pick)} placeholder="选择接手父 Agent" disabled={sending} value={profile}
          options={ownerOptions(profiles)}
          onChange={next => setProfile(typeof next === 'string' ? next : undefined)} />
        <Text type="secondary">Weaver 会生成接续说明，并在 Herdr 中启动新的父 Agent 接手这个任务。</Text>
        {failure && <div {...stylex.props(styles.failure)}><Text>{failure}</Text><Button size="small" onClick={() => void run('owners.launch', {})}>重试启动</Button></div>}
      </div>
    </Modal>
  </>;
}
