import { useNotifyError } from '../../api/notify';
import { TimeText } from '../../ui/TimeText';
import { SettingGroup } from '../../ui/SettingGroup';
import { SettingRow } from '../../ui/SettingRow';
import { TimeZoneSelect } from './TimeZoneSelect';
import { useEffect, useId, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { TitleWithTips } from '@lobehub/ui/dashboard';
import { PageHeader } from '../../app/PageHeader';
import { Button, Spin, Skeleton, Text } from '@lobehub/ui';
import { Check } from 'lucide-react';
import { Icon } from '@lobehub/ui';
import type { QuotaSchedule } from '../../../shared/contracts/quota';
import { FREE_CHANNEL_INTERVAL_RANGE, MAX_COMMAND_MINUTES_RANGE, QUOTA_INTERVAL_RANGE, chatgptReviewEnabled, freeChannelProbeSettings, maxCommandMinutes, quotaSettings } from '../../../shared/policy/settings';
import { useFreeProbe } from '../probes/useFreeProbe';
import { NamedSwitch } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { displayTimeZone, displayWithTimeZone } from '../../policy/policy-edit';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { settingsStyles } from './settings-style';
import { MinutesInput, useSaver, type SaveState } from './SettingRows';
import { EngineCleanup } from '../engines/EngineCleanup';

export type { SaveState };

function Outcome({ state }: { state?: SaveState }) {
  if (!state) return null;
  if (state.status === 'saving') return <Spin size="small" aria-label="正在保存" />;
  if (state.status === 'saved') return <Text type="success" fontSize={12} role="status" className={stylex.props(settingsStyles.outcome).className}><Icon icon={Check} size="small" /> 已保存</Text>;
  return null;
}

/** The shared SettingRow carries no native label; name the control with a screen-reader label. */
function Control({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <><label htmlFor={id} {...stylex.props(styles.srOnly)}>{label}</label>{children}</>;
}

/** Schedule timestamps come from the running process; reading them never contacts a provider. */
function useSchedule(revision: number | undefined) {
  const [schedule, setSchedule] = useState<QuotaSchedule>();
  useEffect(() => {
    let current = true;
    const load = () => { void window.weaver?.getQuota().then(result => { if (current) setSchedule(result.schedule); }).catch(() => {}); };
    load();
    const timer = setInterval(load, 30_000);
    return () => { current = false; clearInterval(timer); };
  }, [revision]);
  return schedule;
}

export function SettingsPage({ policy }: { policy: PolicyDraft }) {
  const id = useId();
  const saver = useSaver(policy);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const saved = policy.snapshot?.config;
  const schedule = useSchedule(policy.snapshot?.revision);
  const freeProbe = useFreeProbe(policy.snapshot?.revision);
  const header = <PageHeader title={<TitleWithTips title="设置" tips="每项修改立即生效；数据维护需预览并确认。" />} />;
  useNotifyError(policy.loadError, '配置读取失败');
  if (!saved) {
    if (policy.loadError) return <>{header}
      <div role="status" {...stylex.props(settingsStyles.failure)}>
        <span>读取失败</span>
        <Button size="small" onClick={() => void policy.load(true)}>重试</Button>
      </div>
    </>;
    return <>{header}{!policy.loadError && <Skeleton.Text animated rows={6} />}</>;
  }
  const quota = quotaSettings(saved);
  const probe = freeChannelProbeSettings(saved);
  const inputError = (key: string) => (message: string) => setInputErrors(current => ({ ...current, [key]: message }));
  const quotaHint = !quota.auto_refresh
    ? '已关闭，只在账号与渠道页手动刷新。'
    : schedule?.nextRunAt
      ? <>下次 <TimeText value={schedule.nextRunAt} />{schedule.lastRunAt && <> · 上次 <TimeText value={schedule.lastRunAt} /></>}</>
      : '按下方间隔自动查询订阅额度，不会调用模型。';
  const probeHint = !probe.enabled
    ? '已关闭，只能在子 Agent 页手动探测。'
    : freeProbe.status?.schedule?.nextRunAt
      ? <>下次 <TimeText value={freeProbe.status.schedule.nextRunAt} />{freeProbe.status.schedule.lastRunAt && <> · 上次 <TimeText value={freeProbe.status.schedule.lastRunAt} /></>}</>
      : '按下方间隔向免费渠道子 Agent 发送简短问候，会消耗少量额度。';
  return <div {...stylex.props(settingsStyles.page)}>
    {header}
    {policy.loadError && <div role="status" {...stylex.props(settingsStyles.failure)}>
      <span>读取失败</span>
      <Button size="small" onClick={() => void policy.load(true)}>重试</Button>
    </div>}
    <div {...stylex.props(settingsStyles.groups)}>
      <SettingGroup title="显示" tips="网页里所有时间的显示方式。">
        <SettingRow label="项目时区" tips="任务看板、详情、时间线和各页面的时间都按此时区显示，「今天」从该时区当天 00:00 起算。未设置时跟随浏览器。" status={<Outcome state={saver.states.timezone} />}>
          <Control id={`${id}-timezone`} label="项目时区"><TimeZoneSelect id={`${id}-timezone`} value={displayTimeZone(saved)} disabled={saver.states.timezone?.status === 'saving'} onChange={next => void saver.save('timezone', config => ({ display: displayWithTimeZone(config, next) }))} /></Control>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="额度" tips="只刷新已启用、并在账号与渠道页打开「自动刷新」的官方订阅渠道。额度耗尽时自动暂停派发，恢复或到重置时间后自动解除。">
        <SettingRow label="定时刷新额度" hint={quotaHint} status={<Outcome state={saver.states.auto} />}>
          <Control id={`${id}-auto`} label="定时刷新额度"><NamedSwitch id={`${id}-auto`} aria-label="定时刷新额度" checked={quota.auto_refresh} disabled={saver.states.auto?.status === 'saving'} onChange={checked => void saver.save('auto', config => ({ quota: { ...quotaSettings(config), auto_refresh: checked } }))} /></Control>
        </SettingRow>
        <SettingRow label="刷新间隔（分钟）" tips={`${QUOTA_INTERVAL_RANGE.min} 到 ${QUOTA_INTERVAL_RANGE.max} 分钟。`} hint={inputErrors.interval ? <span role="alert">{inputErrors.interval}</span> : undefined} status={<Outcome state={saver.states.interval} />}>
          <Control id={`${id}-interval`} label="刷新间隔（分钟）"><MinutesInput id={`${id}-interval`} label="刷新间隔（分钟）" value={quota.interval_minutes} min={QUOTA_INTERVAL_RANGE.min} max={QUOTA_INTERVAL_RANGE.max} step={5} disabled={!quota.auto_refresh} onError={inputError('interval')} onCommit={value => void saver.save('interval', config => ({ quota: { ...quotaSettings(config), interval_minutes: value } }))} /></Control>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="免费渠道探测" tips="按固定间隔向已启用、并标记为免费渠道的子 Agent 发送简短问候，保持免费额度并发现故障。失败按惩罚阶梯暂停，额度用完则暂停到恢复。">
        <SettingRow label="定时探测" hint={probeHint} status={<Outcome state={saver.states.probe} />}>
          <Control id={`${id}-probe`} label="定时探测"><NamedSwitch id={`${id}-probe`} aria-label="定时探测" checked={probe.enabled} disabled={saver.states.probe?.status === 'saving'} onChange={checked => void saver.save('probe', config => ({ free_channel_probe: { ...freeChannelProbeSettings(config), enabled: checked } }))} /></Control>
        </SettingRow>
        <SettingRow label="探测间隔（分钟）" tips={`${FREE_CHANNEL_INTERVAL_RANGE.min} 到 ${FREE_CHANNEL_INTERVAL_RANGE.max} 分钟。每轮依次探测，不并发。`} hint={inputErrors.probeInterval ? <span role="alert">{inputErrors.probeInterval}</span> : undefined} status={<Outcome state={saver.states.probeInterval} />}>
          <Control id={`${id}-probe-interval`} label="探测间隔（分钟）"><MinutesInput id={`${id}-probe-interval`} label="探测间隔（分钟）" value={probe.interval_minutes} min={FREE_CHANNEL_INTERVAL_RANGE.min} max={FREE_CHANNEL_INTERVAL_RANGE.max} step={5} disabled={!probe.enabled} onError={inputError('probeInterval')} onCommit={value => void saver.save('probeInterval', config => ({ free_channel_probe: { ...freeChannelProbeSettings(config), interval_minutes: value } }))} /></Control>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="审查" tips="父 Agent 验收子 Agent 结果时的额外审查。">
        <SettingRow label="ChatGPT Pro 自动审查" tips="关闭后父 Agent 跳过 ChatGPT Pro 自动审查，本地审查和测试照常进行。" status={<Outcome state={saver.states.review} />}>
          <Control id={`${id}-review`} label="ChatGPT Pro 自动审查"><NamedSwitch id={`${id}-review`} aria-label="ChatGPT Pro 自动审查" checked={chatgptReviewEnabled(saved)} disabled={saver.states.review?.status === 'saving'} onChange={checked => void saver.save('review', () => ({ chatgpt_review: checked }))} /></Control>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="父 Agent" tips="父 Agent 观测和等待子 Agent 的方式。">
        <SettingRow label="查看间隔上限（分钟）" tips="父 Agent 两次查看子 Agent 状态之间的最长间隔，也是 tasks wait 不带 --for 时的等待时长；子 Agent 完成后父 Agent 能及时发现。不会停止子 Agent。" hint={inputErrors.wait ? <span role="alert">{inputErrors.wait}</span> : undefined} status={<Outcome state={saver.states.wait} />}>
          <Control id={`${id}-wait`} label="查看间隔上限（分钟）"><MinutesInput id={`${id}-wait`} label="查看间隔上限（分钟）" value={saved.herdr.max_wait_minutes} min={1} max={1440} step={5} onError={inputError('wait')} onCommit={value => void saver.save('wait', () => ({ herdr: { ...saved.herdr, max_wait_minutes: value } }))} /></Control>
        </SettingRow>
        <SettingRow label="单条命令最长运行时间（分钟）" tips="单条命令持续运行超过这个时长后，任务健康会提示父 Agent 疑似挂死，tasks wait 也会提前返回；不会自动停止命令。范围 1 到 1440 分钟。" hint={inputErrors.command ? <span role="alert">{inputErrors.command}</span> : '范围 1 到 1440 分钟；超时只提示疑似挂死，不会自动停止命令。'} status={<Outcome state={saver.states.command} />}>
          <Control id={`${id}-command`} label="单条命令最长运行时间（分钟）"><MinutesInput id={`${id}-command`} label="单条命令最长运行时间（分钟）" value={maxCommandMinutes(saved)} min={MAX_COMMAND_MINUTES_RANGE.min} max={MAX_COMMAND_MINUTES_RANGE.max} step={5} onError={inputError('command')} onCommit={value => void saver.save('command', () => ({ herdr: { ...saved.herdr, max_command_minutes: value } }))} /></Control>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="数据维护">
        <SettingRow label="OpenCode 数据库" tips="清理服务端原生 OpenCode 的过期会话，可选择裁剪事件历史和整理空间。不包含 Weaver 数据库或独立账号数据；执行前先预览并确认。">
          <EngineCleanup />
        </SettingRow>
      </SettingGroup>
    </div>
  </div>;
}
