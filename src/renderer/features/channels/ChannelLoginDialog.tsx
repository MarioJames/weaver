import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button, InputPassword, Modal, Text } from '@lobehub/ui';
import type { ChannelLogin, ChannelLoginRef } from '../../../shared/contracts/channels';
import { notifyError } from '../../api/notify';
import { styles } from '../../ui/styles';
import { resourceStyles } from '../../ui/resource-style';
import { channelStyles } from './channels-style';

const active = (job: ChannelLogin) => ['starting', 'authorizing', 'verifying'].includes(job.status);
const statusText: Record<ChannelLogin['status'], string> = {
  starting: '正在启动原生登录', authorizing: '等待官方授权', verifying: '正在验证此账号的凭据',
  succeeded: '此账号已完成登录验证', failed: '登录未完成', cancelled: '登录已取消',
};
const storageKey = (channel: string) => `weaver.channel-login.${channel}`;
// Store only the exact job reference, never an authorization URL, code or native output.
function savedRef(channel: string): ChannelLoginRef | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(channel)) ?? 'null');
    if (value?.channel === channel && typeof value.id === 'string' && value.id) return { channel, id: value.id };
  } catch { /* Storage may be unavailable; same-channel start is idempotent on the server. */ }
  return undefined;
}
function remember(job: ChannelLogin) {
  try { sessionStorage.setItem(storageKey(job.channel), JSON.stringify({ channel: job.channel, id: job.id })); } catch { /* The server still owns this job. */ }
}

export function ChannelLoginDialog({ channel, label, onClose, onSucceeded }: { channel: string; label: string; onClose: () => void; onSucceeded: () => Promise<void> }) {
  const [job, setJob] = useState<ChannelLogin>();
  const [pending, setPending] = useState(false);
  const [authorizationCode, setAuthorizationCode] = useState('');
  const [pollRound, setPollRound] = useState(0);
  const mounted = useRef(false);
  const operation = useRef(false);
  const generation = useRef(0);
  const onSuccess = useRef(onSucceeded);
  onSuccess.current = onSucceeded;
  const completed = useRef('');

  function accept(next: ChannelLogin) {
    if (next.channel !== channel) throw new Error('登录响应与当前账号不匹配，请刷新状态。');
    remember(next);
    if (mounted.current) setJob(next);
  }
  async function run(action: 'start' | 'read' | 'cancel' | 'code', reference?: ChannelLoginRef) {
    if (operation.current) return;
    operation.current = true;
    const token = ++generation.current;
    setPending(true);
    try {
      const next = action === 'start' ? await window.weaver.startChannelLogin({ channel })
        : action === 'code' ? await window.weaver.submitChannelLoginCode({ ...reference!, code: authorizationCode })
        : action === 'cancel' ? await window.weaver.cancelChannelLogin(reference!) : await window.weaver.getChannelLogin(reference!);
      // Even if the dialog closed while starting, keep the exact ref for a later reopen.
      if (next.channel === channel) remember(next);
      if (mounted.current && token === generation.current) { accept(next); if (action === 'code') setAuthorizationCode(''); }
    } catch (error) {
      if (mounted.current && token === generation.current) notifyError(error, action === 'read' ? '无法刷新登录状态' : action === 'start' ? '无法启动登录' : '登录操作失败');
    } finally {
      operation.current = false;
      if (mounted.current && token === generation.current) setPending(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const token = ++generation.current;
    void Promise.resolve().then(() => {
      if (!mounted.current || token !== generation.current) return;
      const reference = savedRef(channel);
      void run(reference ? 'read' : 'start', reference);
    });
    return () => { mounted.current = false; generation.current++; };
  }, [channel]);

  const running = !!job && active(job);
  useEffect(() => {
    if (!job || !running || pending) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const reference = { channel, id: job.id };
    const token = generation.current;
    async function poll() {
      try {
        const next = await window.weaver.getChannelLogin(reference);
        if (!current || token !== generation.current) return;
        accept(next);
        if (active(next)) timer = setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (current && token === generation.current) notifyError(error, '无法刷新登录状态');
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { current = false; clearTimeout(timer); };
  }, [channel, job?.id, running, pending, pollRound]);

  useEffect(() => {
    if (job?.status !== 'succeeded' || completed.current === job.id) return;
    completed.current = job.id;
    void onSuccess.current().catch(error => { notifyError(error, '账号列表刷新失败'); });
  }, [job]);

  const reference = job ? { channel, id: job.id } : savedRef(channel);
  return <Modal open title={`登录 ${label}`} width={640} draggable={false} className={stylex.props(resourceStyles.modal).className}
    classNames={{ body: stylex.props(resourceStyles.modalBody).className, footer: stylex.props(resourceStyles.modalFooter).className }} onCancel={onClose}
    footer={<>
      {running && <Button danger disabled={pending} loading={pending} onClick={() => reference && void run('cancel', reference)}>取消此次登录</Button>}
      {reference && <Button disabled={pending} onClick={() => { setPollRound(value => value + 1); void run('read', reference); }}>刷新登录状态</Button>}
      {(!job || job.status === 'failed' || job.status === 'cancelled') && <Button type="primary" loading={pending} disabled={pending} onClick={() => void run('start')}>重试登录</Button>}
      {job?.status === 'succeeded' && <Button disabled={pending} onClick={() => void onSucceeded().catch(error => notifyError(error, '账号列表刷新失败'))}>刷新凭据状态</Button>}
      <Button onClick={onClose}>关闭</Button>
    </>}>
    <div {...stylex.props(styles.stack)} data-channels-scroll="">
      <Text role="status">{job ? statusText[job.status] : pending ? '正在读取或启动登录' : '尚未确认登录状态'}</Text>
      {job?.error && <div role="status" {...stylex.props(channelStyles.loginState)}>
        <Text strong type="danger">原生登录未完成</Text>
        <Text type="secondary">{job.error.code}：{job.error.message}</Text>
      </div>}
      <Text type="secondary">请在官方页面完成授权。关闭此窗口后，可从该账号的登录按钮找回状态；关闭不会取消登录。只有独立配置中的凭据通过验证后，账号才可用于执行。</Text>
      {running && job.verificationUrl && <a className={stylex.props(channelStyles.loginLink).className} href={job.verificationUrl} target="_blank" rel="noopener noreferrer">打开官方授权页面：{job.verificationUrl}</a>}
      {running && job.userCode && <Text>设备验证码：<code>{job.userCode}</code></Text>}
      {running && job.acceptsCode && <div {...stylex.props(styles.stack)}>
        <label htmlFor={`authorization-code-${channel}`}>官方返回授权码</label>
        <InputPassword id={`authorization-code-${channel}`} autoComplete="off" value={authorizationCode} disabled={pending} maxLength={4096} placeholder="粘贴官方页面返回的完整 code#state" onChange={event => setAuthorizationCode(event.target.value)} />
        <Button disabled={pending || !authorizationCode} loading={pending} onClick={() => reference && void run('code', reference)}>提交官方返回授权码</Button>
        <Text type="secondary">在官方页面完成授权后，粘贴页面返回的完整授权码。发送后仍需等待原生 CLI 验证凭据。</Text>
      </div>}
      {job?.identity?.label && <Text>已验证身份：{job.identity.label}</Text>}
    </div>
  </Modal>;
}
