import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { PageHeader } from '@lobehub/ui/dashboard';
import { Icon } from '@lobehub/ui';
import { Alert, Button, Skeleton, Spin, Text } from '@lobehub/ui/base-ui';
import type { QuotaSchedule } from '../../shared/quota';
import { QUOTA_INTERVAL_RANGE, chatgptReviewEnabled, quotaSettings, type Config } from '../../main/policy/routing';
import { NamedInputNumber, NamedSwitch } from '../components/NamedControls';
import { dateText } from '../quota-view';
import type { PolicyDraft } from '../usePolicyDraft';
import { styles } from '../style';

type SaveState = { status: 'saving' } | { status: 'saved' } | { status: 'error'; message: string };

/** Each setting saves on its own; the row shows its own outcome. */
function useSaver(policy: PolicyDraft) {
  const [states, setStates] = useState<Record<string, SaveState>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => { for (const timer of Object.values(timers.current)) clearTimeout(timer); }, []);
  async function save(key: string, patch: (config: Config) => Partial<Config>) {
    clearTimeout(timers.current[key]);
    setStates(current => ({ ...current, [key]: { status: 'saving' } }));
    try {
      await policy.commit(doc => ({ ...doc, config: { ...doc.config, ...patch(doc.config) } }));
      setStates(current => ({ ...current, [key]: { status: 'saved' } }));
      timers.current[key] = setTimeout(() => setStates(current => { const next = { ...current }; delete next[key]; return next; }), 2000);
    } catch (error) {
      setStates(current => ({ ...current, [key]: { status: 'error', message: error instanceof Error ? error.message : String(error) } }));
    }
  }
  return { states, save };
}

function Outcome({ state }: { state?: SaveState }) {
  if (!state) return null;
  if (state.status === 'saving') return <Spin size="small" aria-label="正在保存" />;
  if (state.status === 'saved') return <Text type="success" className={styles.meta} role="status"><Icon icon={Check} size="small" /> 已保存</Text>;
  return null;
}

function Setting({ label, desc, htmlFor, state, error, children }: { label: string; desc: ReactNode; htmlFor: string; state?: SaveState; error?: string; children: ReactNode }) {
  const message = error || (state?.status === 'error' ? `保存失败：${state.message}` : '');
  return <div className={styles.setting}>
    <div className={styles.tight}>
      <label htmlFor={htmlFor}><Text strong>{label}</Text></label>
      <Text type="secondary" className={styles.meta}>{desc}</Text>
      {message && <Text type="danger" className={styles.meta} role="alert">{message}</Text>}
    </div>
    <div className={styles.row} style={{ flexWrap: 'nowrap' }}><Outcome state={state} />{children}</div>
  </div>;
}

/** One group: its title and explanation on the left, its settings on the right. No card frame. */
function Group({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return <section aria-label={title} className={styles.settingsGroup}>
    <div className={styles.tight}>
      <Text strong>{title}</Text>
      {desc && <Text type="secondary" className={styles.meta}>{desc}</Text>}
    </div>
    <div className={styles.settingsRows}>{children}</div>
  </section>;
}

/** A number that is committed on blur or Enter, never on every keystroke. Out-of-range input stays local with a message. */
function MinutesInput({ id, label, value, min, max, step, disabled, onCommit, onError }: { id: string; label: string; value: number; min: number; max: number; step: number; disabled?: boolean; onCommit: (value: number) => void; onError: (message: string) => void }) {
  const [draft, setDraft] = useState<number | null>(value);
  useEffect(() => { setDraft(value); }, [value]);
  function commit() {
    if (draft === value) { onError(''); return; }
    if (draft === null || !Number.isInteger(draft) || draft < min || draft > max) { onError(`请输入 ${min} 到 ${max} 之间的整数。`); return; }
    onError('');
    onCommit(draft);
  }
  // No min/max on the control: it would silently clamp on blur and save a value the user did not type.
  return <NamedInputNumber id={id} aria-label={label} step={step} value={draft} placeholder={`例如：${value}`} disabled={disabled} style={{ inlineSize: 120 }}
    onChange={next => setDraft(typeof next === 'number' ? next : null)} onBlur={commit} onPressEnter={commit} />;
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
  const header = <PageHeader title="设置" description="每项修改立即生效。" />;
  if (!saved) return <>{header}{policy.loadError ? <Alert type="error" title="配置读取失败" description={policy.loadError} action={<Button size="small" onClick={() => void policy.load(true)}>重新读取</Button>} /> : <Skeleton.Text animated rows={6} />}</>;
  const quota = quotaSettings(saved);
  const inputError = (key: string) => (message: string) => setInputErrors(current => ({ ...current, [key]: message }));
  const scheduleText = !quota.auto_refresh ? '已关闭，只在引擎卡片上手动刷新。' : schedule?.nextRunAt ? `下次 ${dateText(schedule.nextRunAt)}${schedule.lastRunAt ? ` · 上次 ${dateText(schedule.lastRunAt)}` : ''}` : '按下方间隔自动查询订阅额度，不会调用模型。';
  return <>
    {header}
    <div className={styles.settings}>
      <Group title="额度" desc="只刷新已启用、并在引擎卡片上打开「主动刷新额度」的引擎。额度耗尽时自动暂停派发，恢复或到重置时间后自动解除。">
        <Setting label="定时刷新额度" htmlFor={`${id}-auto`} desc={scheduleText} state={saver.states.auto}>
          <NamedSwitch id={`${id}-auto`} aria-label="定时刷新额度" checked={quota.auto_refresh} disabled={saver.states.auto?.status === 'saving'} onChange={checked => void saver.save('auto', config => ({ quota: { ...quotaSettings(config), auto_refresh: checked } }))} />
        </Setting>
        <Setting label="刷新间隔（分钟）" htmlFor={`${id}-interval`} desc={`${QUOTA_INTERVAL_RANGE.min} 到 ${QUOTA_INTERVAL_RANGE.max} 分钟。`} state={saver.states.interval} error={inputErrors.interval}>
          <MinutesInput id={`${id}-interval`} label="刷新间隔（分钟）" value={quota.interval_minutes} min={QUOTA_INTERVAL_RANGE.min} max={QUOTA_INTERVAL_RANGE.max} step={5} disabled={!quota.auto_refresh} onError={inputError('interval')} onCommit={value => void saver.save('interval', config => ({ quota: { ...quotaSettings(config), interval_minutes: value } }))} />
        </Setting>
      </Group>
      <Group title="审查" desc="负责人验收工作代理结果时的额外审查。">
        <Setting label="ChatGPT Pro 自动审查" htmlFor={`${id}-review`} desc="关闭后负责人跳过 ChatGPT Pro 自动审查，本地审查和测试照常进行。" state={saver.states.review}>
          <NamedSwitch id={`${id}-review`} aria-label="ChatGPT Pro 自动审查" checked={chatgptReviewEnabled(saved)} disabled={saver.states.review?.status === 'saving'} onChange={checked => void saver.save('review', () => ({ chatgpt_review: checked }))} />
        </Setting>
      </Group>
      <Group title="负责人" desc="负责人观测和等待工作代理的方式。">
        <Setting label="查看间隔上限（分钟）" htmlFor={`${id}-wait`} desc="负责人两次查看工作代理状态之间的最长间隔；工作代理完成后负责人能及时发现。不会停止工作代理。" state={saver.states.wait} error={inputErrors.wait}>
          <MinutesInput id={`${id}-wait`} label="查看间隔上限（分钟）" value={saved.herdr.max_wait_minutes} min={1} max={1440} step={5} onError={inputError('wait')} onCommit={value => void saver.save('wait', () => ({ herdr: { max_wait_minutes: value } }))} />
        </Setting>
      </Group>
    </div>
  </>;
}
