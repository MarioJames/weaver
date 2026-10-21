import { notifyError } from '../../api/notify';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Icon } from '@lobehub/ui';
import { Spin, Text } from '@lobehub/ui/base-ui';
import type { Config } from '../../../shared/contracts/policy';
import { fieldErrorText, isFieldError, minutesError, type DisplaySettings, type SettingsPatch } from '../../policy/policy-edit';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { NamedInputNumber } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { settingsStyles } from './settings-style';

export type SaveState = { status: 'saving' } | { status: 'saved' } | { status: 'error'; message: string };

/** Each setting saves on its own; the row shows its own outcome. */
export function useSaver(policy: PolicyDraft) {
  const [states, setStates] = useState<Record<string, SaveState>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => { for (const timer of Object.values(timers.current)) clearTimeout(timer); }, []);
  async function save(key: string, patch: (config: Config) => SettingsPatch) {
    clearTimeout(timers.current[key]);
    setStates(current => ({ ...current, [key]: { status: 'saving' } }));
    try {
      await policy.commit(doc => {
        const config: Config & { display?: DisplaySettings } = { ...doc.config, ...patch(doc.config) };
        if (config.display === undefined) delete config.display;
        return { ...doc, config };
      });
      setStates(current => ({ ...current, [key]: { status: 'saved' } }));
      timers.current[key] = setTimeout(() => setStates(current => { const next = { ...current }; delete next[key]; return next; }), 2000);
    } catch (error) {
      if (!isFieldError(error)) notifyError(error, '保存失败');
      setStates(current => ({ ...current, [key]: { status: 'error', message: fieldErrorText(error) } }));
    }
  }
  return { states, save };
}

function Outcome({ state }: { state?: SaveState }) {
  if (!state) return null;
  if (state.status === 'saving') return <Spin size="small" aria-label="正在保存" />;
  if (state.status === 'saved') return <Text type="success" fontSize={12} role="status" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}><Icon icon={Check} size="small" /> 已保存</Text>;
  return null;
}

/** A bad value or a refused save is said right under the control it belongs to; a floating notice is for the request failing, not for the input being wrong. */
export function Setting({ label, desc, htmlFor, state, error, children }: { label: string; desc: ReactNode; htmlFor: string; state?: SaveState; error?: string; children: ReactNode }) {
  const message = error || (state?.status === 'error' ? state.message : '');
  return <div className={settingsStyles.row}>
    <div className={`${settingsStyles.fieldCell} ${styles.tight}`}>
      <label htmlFor={htmlFor}><Text strong>{label}</Text></label>
      <Text fontSize={12}>{desc}</Text>
    </div>
    <div className={settingsStyles.controlCell}>
      <div className={settingsStyles.controlStack}>
        <div className={settingsStyles.controlRow}><Outcome state={state} />{children}</div>
        {message && <p id={`${htmlFor}-error`} role="alert" className={styles.error}>{message}</p>}
      </div>
    </div>
  </div>;
}

/** One group: its title and explanation in the left column, its settings in the field and control columns. */
export function Group({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return <section aria-label={title} className={settingsStyles.group}>
    <div className={`${settingsStyles.groupCell} ${styles.tight}`}>
      <Text strong>{title}</Text>
      {desc && <Text fontSize={12}>{desc}</Text>}
    </div>
    <div className={settingsStyles.rows}>{children}</div>
  </section>;
}

/**
 * A number that is committed on blur or Enter, never on every keystroke. Out-of-range input stays local with a message.
 * `onDraftChange` 是受控同步口：传入时，每次敲击都把框里此刻的数（含 null）如实回写给调用方，
 * 调用方的表单状态成为唯一事实——可见非法数字能进保存计划、能被放弃/重载复位，也不会被旧值顶替。
 * 不传时行为不变：错误只在 blur/Enter 上收束，合法数字照旧只在不变更旧值时提交。
 */
export function MinutesInput({ id, label, value, min, max, step, disabled, onCommit, onError, onDraftChange }: { id: string; label: string; value: number | null; min: number; max: number; step: number; disabled?: boolean; onCommit: (value: number) => void; onError: (message: string) => void; onDraftChange?: (value: number | null) => void }) {
  const [draft, setDraft] = useState<number | null>(value);
  useEffect(() => { setDraft(value); }, [value]);
  function commit() {
    const error = minutesError(draft, min, max);
    onError(error);
    // 处于受控同步的调用方已持有草稿，这里只在框中的数与已知值不同且合法时补一次提交。
    if (!error && draft !== null && draft !== value) onCommit(draft);
  }
  // No min/max on the control: it would silently clamp on blur and save a value the user did not type.
  // Minutes are plain integers: no thousands separator ("1,440" reads like a decimal in some locales).
  return <NamedInputNumber id={id} aria-label={label} step={step} format={{ useGrouping: false }} value={draft} placeholder={`例如：${value ?? min}`} disabled={disabled} style={{ inlineSize: 120 }}
    onChange={next => { const visible = typeof next === 'number' ? next : null; setDraft(visible); if (onDraftChange) onDraftChange(visible); if (!minutesError(visible, min, max)) onError(''); }} onBlur={commit} onPressEnter={commit} />;
}
