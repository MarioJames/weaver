import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Segmented, Skeleton, Tag, Text, Tooltip } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import type { OpenCodeAccountQuotas, OpenCodeAccountRef } from '../../../shared/contracts/opencode-account-quotas';
import { quotaNextUpdateMs } from '../quota/quota-view';
import { QuotaSummary } from './QuotaSummary';
import { tagColor } from '../../format/tag-colors';

const css = createStaticStyles(({ css, cssVar }) => ({
  root: css`display: flex; flex-direction: column; gap: 8px; min-inline-size: 0; overflow-wrap: anywhere;`,
  scroll: css`overflow-x: auto; min-inline-size: 0; max-inline-size: 100%; padding-block: 4px;`,
  segments: css`inline-size: max-content; max-inline-size: none;`,
  label: css`display: block; max-inline-size: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`,
  actions: css`display: flex; align-items: center; gap: 8px; flex-wrap: wrap;`,
  note: css`color: ${cssVar.colorTextSecondary}; font-size: ${cssVar.fontSizeSM}; line-height: 1.6;`,
}));
const keyOf = (pair: OpenCodeAccountRef) => JSON.stringify([pair.accountID, pair.orgID]);

/** Viewing a pair never changes native authentication. The backend owns automatic rotation. */
export function OpenCodeAccountQuota({ autoRefresh, version, policyBusy, currentCredentialQuota }: { autoRefresh: boolean; version: number; policyBusy: boolean; currentCredentialQuota: ReactNode }) {
  const [pool, setPool] = useState<OpenCodeAccountQuotas>();
  const [selection, setSelection] = useState('');
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState(false);
  const [busy, setBusy] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const generation = useRef(0);
  const readGeneration = useRef(0);
  const refreshing = useRef(new Set<string>());
  const initialRefresh = useRef(false);
  const automatic = useRef(autoRefresh);
  automatic.current = autoRefresh;
  const accept = useCallback((next: OpenCodeAccountQuotas) => {
    setPool(next); setNow(Date.now()); setReadError(false);
    setSelection(current => next.accounts.some(item => keyOf(item.account) === current) ? current
      : next.active && next.accounts.some(item => keyOf(item.account) === keyOf(next.active!)) ? keyOf(next.active)
      : next.accounts[0] ? keyOf(next.accounts[0].account) : '');
  }, []);
  const refresh = useCallback(async (pair?: OpenCodeAccountRef) => {
    const key = pair ? keyOf(pair) : '*';
    if (refreshing.current.has(key) || refreshing.current.has('*') || (!pair && refreshing.current.size)) return;
    refreshing.current.add(key); setBusy([...refreshing.current]);
    setErrors(current => ({ ...current, [key]: '' }));
    const request = ++generation.current;
    try {
      const next = await window.weaver.refreshOpenCodeAccountQuotas(pair ?? {});
      if (mounted.current && request === generation.current) accept(next);
    } catch {
      if (mounted.current) setErrors(current => ({ ...current, [key]: '额度刷新失败，保留上次观测，请稍后重试。' }));
    } finally {
      refreshing.current.delete(key);
      if (mounted.current) setBusy([...refreshing.current]);
    }
  }, [accept]);
  const load = useCallback(async () => {
    // Cache polls must not supersede a user refresh still querying a provider.
    if (refreshing.current.size) return;
    const request = ++generation.current;
    const read = ++readGeneration.current;
    setReading(true);
    try {
      const next = await window.weaver.getOpenCodeAccountQuotas();
      if (!mounted.current || request !== generation.current) return;
      accept(next);
      if (automatic.current && !next.accounts.length && !initialRefresh.current) {
        initialRefresh.current = true;
        void refresh();
      }
    } catch { if (mounted.current && request === generation.current) setReadError(true); }
    finally { if (mounted.current && read === readGeneration.current) setReading(false); }
  }, [accept, refresh]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; readGeneration.current++; };
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load, version, autoRefresh]);

  const selected = pool?.accounts.find(item => keyOf(item.account) === selection);
  const selectedKey = selected ? keyOf(selected.account) : '';
  const active = pool?.accounts.find(item => pool.active && keyOf(item.account) === keyOf(pool.active));
  const viewingActive = !!selected && !!pool?.active && selectedKey === keyOf(pool.active);
  const pairBusy = busy.includes('*') || busy.includes(selectedKey);
  const cooldown = selected?.cooldownUntil ? Date.parse(selected.cooldownUntil) : NaN;
  const cooldownMs = Number.isFinite(cooldown) ? Math.max(0, cooldown - now) : 0;
  // A candidate cooldown is independent of the native quota retry deadline.
  const record = selected && cooldownMs > 0 && (!selected.quota.retryAt || Date.parse(selected.quota.retryAt) < cooldown)
    ? { ...selected.quota, retryAt: selected.cooldownUntil } : selected?.quota;
  useEffect(() => {
    const delay = quotaNextUpdateMs(record ? [record] : [], now);
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [record, now]);
  function choose(value: string) {
    setSelection(value);
    const item = pool?.accounts.find(account => keyOf(account.account) === value);
    if (item && !item.quota.checkedAt && !item.quota.observedAt && !policyBusy && !pool?.switching) void refresh(item.account);
  }
  const recovery = selected?.quota.status === 'unauthenticated' ? '此账号登录状态不可用，请在「账号登录与切换」中重新登录后刷新。'
    : selected?.quota.status === 'unsupported' ? '此账号尚无可读取的 Go 套餐额度，请核对该账号的订阅与登录状态。' : undefined;
  return <section className={css.root} aria-label="OpenCode 多账号额度">
    <Text className={css.note}>当前用于调度：{active ? `${active.account.accountEmail} · ${active.account.orgName}` : pool ? '尚未确认' : '读取中'}</Text>
    {pool?.switching && <Alert type="info" title="正在自动切换调度账号，请稍候。" />}
    {pool?.detail && <Alert type="warning" title={pool.detail} />}
    {!pool && reading && <Skeleton.Text rows={2} />}
    {(!pool || pool.accounts.length === 0) && <section className={css.root} aria-label="当前凭证额度">
      <Text className={css.note}>当前凭证额度（含 API Key）单独显示；登录 Console 后可按账号和组织查看额度。</Text>
      {currentCredentialQuota}
    </section>}
    {readError && <Text role="alert" type="danger">账号额度读取失败{pool ? '，已保留上次内容' : ''}，请重试读取。</Text>}
    {pool && pool.accounts.length > 0 && <>
      <div role="group" aria-label="查看账号额度" className={css.scroll}>
        <Segmented className={css.segments} size="small" value={selection} options={pool.accounts.map(item => {
          const name = `${item.account.accountEmail} · ${item.account.orgName}`;
          return { value: keyOf(item.account), title: name, label: <Tooltip title={name}><span className={css.label}>{name}</span></Tooltip> };
        })} onChange={choose} />
      </div>
      {selected && <>
        <div className={css.actions}><Tag size="small" color={tagColor(viewingActive ? 'success' : 'neutral')}>{viewingActive ? '当前用于调度' : '仅查看额度'}</Tag></div>
        <Text className={css.note}>正在查看：{selected.account.accountEmail} · {selected.account.orgName}{!viewingActive && '。仅查看，不影响正在调度的账号。'}</Text>
        {!selected.goReady && <Alert type="warning" title="尚未确认此账号的 Go 凭证会随 Console 登录切换。" />}
        <QuotaSummary engine="opencode" record={record} now={now} busy={pairBusy ? 'opencode' : null} policyBusy={policyBusy || !!pool.switching} onRefresh={() => void refresh(selected.account)} recovery={recovery} refreshLabel={`刷新 ${selected.account.accountEmail} · ${selected.account.orgName} 额度`} />
        {cooldownMs > 0 && <Text className={css.note}>此账号冷却中，约 {Math.ceil(cooldownMs / 1000)} 秒后可重试。</Text>}
        {errors[selectedKey] && <Text role="alert" type="danger">{errors[selectedKey]}</Text>}
      </>}
    </>}
    {pool && !pool.accounts.length && <Text type="secondary">尚无 Console 账号额度记录。点击「读取全部账号额度」，或在「账号登录与切换」中登录账号。</Text>}
    {(!pool || !pool.accounts.length || readError) && <div className={css.actions}>
      <Button size="small" loading={reading} disabled={busy.length > 0} onClick={() => void load()}>{readError ? '重试读取' : '读取缓存'}</Button>
      <Button size="small" loading={busy.includes('*')} disabled={busy.length > 0 || policyBusy || !!pool?.switching} onClick={() => void refresh()}>读取全部账号额度</Button>
    </div>}
    {errors['*'] && <Text role="alert" type="danger">{errors['*']}</Text>}
    <Text className={css.note}>当前账号耗尽时，调度会在确认其他账号仍有额度后自动切换；运行中任务结束后切换，不重跑已失败任务。</Text>
  </section>;
}
