import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Modal, Skeleton, Text } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import type { OpenCodeConsoleAccounts, OpenCodeConsoleLogin, OpenCodeConsoleOrg } from '../../../shared/contracts/opencode-accounts';
import { NamedSelect } from '../../ui/NamedControls';

const css = createStaticStyles(({ css, cssVar }) => ({
  body: css`display: flex; flex-direction: column; gap: 16px; min-inline-size: 0; overflow-wrap: anywhere;`,
  section: css`display: flex; flex-direction: column; gap: 8px; min-inline-size: 0;`,
  actions: css`display: flex; align-items: center; gap: 8px; flex-wrap: wrap;`,
  select: css`inline-size: 100%; min-inline-size: 0;`,
  note: css`color: ${cssVar.colorTextSecondary}; font-size: ${cssVar.fontSizeSM}; line-height: 1.6;`,
  code: css`padding: 8px 12px; background: ${cssVar.colorFillQuaternary}; border-radius: ${cssVar.borderRadiusSM}; font-size: ${cssVar.fontSizeLG}; user-select: text; overflow-wrap: anywhere;`,
  link: css`color: ${cssVar.colorLink}; overflow-wrap: anywhere;`,
}));
const orgKey = (org: OpenCodeConsoleOrg) => JSON.stringify([org.accountID, org.orgID]);
const pending = (job?: OpenCodeConsoleLogin) => job?.status === 'starting' || job?.status === 'authorizing';

/** Account discovery can refresh credentials, so all reads are scoped to the open panel. */
export function OpenCodeAccounts({ onChanged }: { onChanged: () => Promise<unknown> | void }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<OpenCodeConsoleAccounts>();
  const [selection, setSelection] = useState('');
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(false);
  const [job, setJob] = useState<OpenCodeConsoleLogin>();
  const [restoring, setRestoring] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [actionError, setActionError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<'login' | 'switch' | 'cancel'>();
  const mounted = useRef(true);
  const opened = useRef(false);
  const generation = useRef(0);
  const action = useRef(false);
  const listRequest = useRef(0);
  const completed = useRef(new Set<string>());
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const selectId = useId();
  const active = snapshot?.orgs.find(org => org.active);
  const chosen = snapshot?.orgs.find(org => orgKey(org) === selection);
  const running = pending(job);
  const blocked = !!busy || restoring || running;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; opened.current = false; generation.current++; }; }, []);
  const accept = useCallback((next: OpenCodeConsoleAccounts) => {
    setSnapshot(next);
    setSelection(current => next.orgs.some(org => orgKey(org) === current) ? current : '');
    setListError(false);
  }, []);
  const load = useCallback(async () => {
    if (!opened.current) return;
    const version = generation.current;
    const request = ++listRequest.current;
    setLoading(true);
    try {
      const next = await window.weaver.listOpenCodeAccounts();
      if (mounted.current && opened.current && version === generation.current && request === listRequest.current) accept(next);
    } catch {
      if (mounted.current && opened.current && version === generation.current && request === listRequest.current) setListError(true);
    } finally {
      if (mounted.current && version === generation.current && request === listRequest.current) setLoading(false);
    }
  }, [accept]);
  const changed = useCallback(async () => {
    try { await callback.current(); }
    catch { if (mounted.current) setActionError('登录状态已更新，但额度同步失败，请重试刷新额度。'); }
  }, []);
  const receiveJob = useCallback((next: OpenCodeConsoleLogin) => {
    setJob(next); setLoginError('');
    if (next.status === 'succeeded' && !completed.current.has(next.id)) {
      completed.current.add(next.id);
      setFeedback('登录已完成。');
      void load(); void changed();
    }
  }, [changed, load]);
  const restore = useCallback(async () => {
    if (!opened.current) return;
    const version = generation.current;
    setRestoring(true); setLoginError('');
    try {
      const next = await window.weaver.getOpenCodeLogin({ id: 'current' });
      if (mounted.current && opened.current && version === generation.current) { if (next) receiveJob(next); else setJob(undefined); }
    } catch {
      if (mounted.current && opened.current && version === generation.current) setLoginError('登录状态读取失败，请重试查询；后台授权可能仍在进行。');
    } finally { if (mounted.current && version === generation.current) setRestoring(false); }
  }, [receiveJob]);
  useEffect(() => {
    opened.current = open; generation.current++;
    if (open) { void load(); void restore(); }
    return () => { opened.current = false; generation.current++; };
  }, [open, load, restore]);
  useEffect(() => {
    if (!open || !job || !pending(job) || loginError || busy) return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const next = await window.weaver.getOpenCodeLogin({ id: job.id });
        if (stopped) return;
        if (next) receiveJob(next);
        else setLoginError('登录状态已不可用，请重试查询或重新登录。');
      } catch { if (!stopped) setLoginError('登录进度读取失败，请重试查询；后台授权仍可能继续。'); }
    }, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [open, job, loginError, receiveJob, busy]);

  async function start() {
    if (action.current || blocked || loading || loginError) return;
    action.current = true; setBusy('login'); setActionError(''); setFeedback('');
    try { const next = await window.weaver.startOpenCodeLogin(); if (mounted.current) receiveJob(next); }
    catch { if (mounted.current) setLoginError('登录请求未确认，请重试查询登录状态后再继续。'); }
    finally { action.current = false; if (mounted.current) setBusy(undefined); }
  }
  async function cancel() {
    if (action.current || !job || !running) return;
    action.current = true; setBusy('cancel'); setActionError('');
    try { const next = await window.weaver.cancelOpenCodeLogin({ id: job.id }); if (mounted.current) receiveJob(next); }
    catch { if (mounted.current) setActionError('取消未确认，请重试查询登录状态，或再次取消。'); }
    finally { action.current = false; if (mounted.current) setBusy(undefined); }
  }
  async function switchAccount() {
    if (action.current || blocked || loading || listError || !chosen || chosen.active) return;
    action.current = true; setBusy('switch'); setActionError(''); setFeedback('');
    try {
      const next = await window.weaver.switchOpenCodeAccount({ accountID: chosen.accountID, orgID: chosen.orgID, expectedActive: active ? { accountID: active.accountID, orgID: active.orgID } : null });
      if (mounted.current) { listRequest.current++; setLoading(false); accept(next); setFeedback('当前 Console 账号/组织已切换。'); void changed(); }
    } catch {
      if (mounted.current) { setActionError('切换未完成，请刷新账号列表确认当前账号后重试。'); setListError(true); }
    } finally { action.current = false; if (mounted.current) setBusy(undefined); }
  }
  async function copyCode() {
    if (!job?.userCode) return;
    try { await navigator.clipboard.writeText(job.userCode); if (mounted.current) setFeedback('授权码已复制。'); }
    catch { if (mounted.current) setActionError('无法自动复制，请选中授权码手动复制。'); }
  }
  const verificationUrl = (() => {
    try { const url = new URL(job?.verificationUrl ?? ''); return url.origin === 'https://opencode.ai' && !url.username && !url.password && !url.hash ? url.href : undefined; } catch { return undefined; }
  })();
  return <>
    <Button size="small" onClick={() => setOpen(true)}>账号登录与切换</Button>
    <Modal open={open} title="OpenCode 账号登录与切换" width="min(560px, calc(100vw - 24px))" destroyOnHidden={false} onCancel={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>关闭</Button>}>
      <div className={css.body}>
        <Text className={css.note}>账号共用原有对话与配置，只切换登录。仅之后新启动的进程生效；运行中任务继续使用原账号，长驻服务需重新启动。</Text>
        <section className={css.section} aria-label="当前 Console 账号">
          {loading && !snapshot && <Skeleton.Text rows={2} />}
          {snapshot && <>
            {active ? <Descriptions column={1} colon={false} items={[{ label: '当前账号', children: active.accountEmail }, { label: '当前组织', children: active.orgName }]} />
              : <Text type="secondary">尚未选择 Console 账号/组织，可登录新账号。</Text>}
            {snapshot.detail && <Alert type="warning" title={snapshot.detail} />}
          </>}
          {listError && <div role="alert" className={css.section}><Text type="danger">账号列表读取失败{snapshot ? '，下面保留上次读取的内容' : ''}。请重试后再切换。</Text></div>}
          <div className={css.actions}><Button size="small" loading={loading} disabled={!!busy} onClick={() => void load()}>{listError ? '重试读取账号' : '刷新账号列表'}</Button></div>
          {snapshot && !snapshot.orgs.length && <Text type="secondary">没有已登录账号，点击「登录新账号」开始授权。</Text>}
          {!!snapshot?.orgs.length && <>
            <label htmlFor={selectId}>切换到已登录账号 / 组织</label>
            <NamedSelect id={selectId} aria-label="切换到已登录账号 / 组织" className={css.select} value={selection || undefined} placeholder="选择账号及组织，再点击切换" disabled={blocked || loading || listError} options={snapshot.orgs.map(org => ({ value: orgKey(org), label: `${org.accountEmail} · ${org.orgName}${org.active ? '（当前）' : ''}` }))} onChange={value => { if (typeof value === 'string') setSelection(value); }} />
            {chosen && <Text className={css.note}>已选择：{chosen.accountEmail} · {chosen.orgName}</Text>}
            <div className={css.actions}><Button type="primary" loading={busy === 'switch'} disabled={blocked || loading || listError || !chosen || chosen.active} onClick={() => void switchAccount()}>切换账号 / 组织</Button></div>
          </>}
        </section>
        <section className={css.section} aria-label="登录新账号">
          <div className={css.actions}><Button loading={busy === 'login'} disabled={blocked || loading || !!loginError} onClick={() => void start()}>{job?.status === 'failed' || job?.status === 'cancelled' ? '重新登录' : '登录新账号'}</Button>{restoring && <Text type="secondary" role="status">正在读取登录状态…</Text>}</div>
          {running && <>
            <Text role="status">{job?.status === 'starting' ? '正在准备授权…' : '等待浏览器授权。'}关闭面板后授权会继续，重新打开可恢复进度。</Text>
            {verificationUrl && <a className={css.link} href={verificationUrl} target="_blank" rel="noopener noreferrer">打开 OpenCode 授权页面 ↗</a>}
            {job?.userCode && <><Text type="secondary">在授权页面输入以下授权码</Text><code className={css.code}>{job.userCode}</code><div className={css.actions}><Button size="small" onClick={() => void copyCode()}>复制授权码</Button></div></>}
            <div className={css.actions}><Button loading={busy === 'cancel'} disabled={!!busy} onClick={() => void cancel()}>取消本次登录</Button></div>
          </>}
          {job?.status === 'failed' && <Text role="alert" type="danger">{job.detail || '登录失败或授权已超时，请重新登录。'}</Text>}
          {job?.status === 'cancelled' && <Text role="status" type="secondary">本次登录已取消，可重新登录。</Text>}
          {loginError && <div className={css.section}><Text role="alert" type="danger">{loginError}</Text><div className={css.actions}><Button size="small" loading={restoring} disabled={!!busy} onClick={() => void restore()}>重试查询登录状态</Button></div></div>}
        </section>
        {actionError && <Text role="alert" type="danger">{actionError}</Text>}
        {feedback && <Text role="status">{feedback}</Text>}
      </div>
    </Modal>
  </>;
}
