import { useEffect, useId, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Upload } from 'lucide-react';
import { Alert, Button, Checkbox, Input, InputPassword, Modal, Text, TextArea, Upload as FileUpload } from '@lobehub/ui';
import { Form, useForm } from '@lobehub/ui/form';
import { CHANNEL_CONFIG_MAX_BYTES } from '../../../shared/contracts/channels';
import type { Channel } from '../../../shared/contracts/channels';
import { NamedSelect } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { resourceStyles } from '../../ui/resource-style';
import { channelContentError, directApiAllowed, subscriptionAllowed } from './channels-view';
import { channelStyles } from './channels-style';

export function ChannelEditor({ open, value, editing, engineOptions, engineKind, hasConfig, hasKey, busy, failure, onReload, onCancel, onDiscard, onSave }: { open: boolean; value: Channel; editing: boolean; engineOptions: { value: string; label: string }[]; engineKind: (id: string) => string; hasConfig: boolean; hasKey: boolean; busy: boolean; failure: string; onReload: () => void; onCancel: () => void; onDiscard: () => void; onSave: (channel: Channel, key: string, config: string, replace: boolean) => void }) {
  const form = useForm();
  const id = useId();
  const [channel, setChannel] = useState(value);
  const [apiKey, setApiKey] = useState('');
  const [nativeConfig, setNativeConfig] = useState('');
  const [replaceConfig, setReplaceConfig] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const uploadGeneration = useRef(0);
  useEffect(() => () => { uploadGeneration.current++; }, []);
  const kind = engineKind(channel.engine);
  const availableEngines = editing ? engineOptions : engineOptions.filter(option => channel.kind === 'subscription' ? subscriptionAllowed(engineKind(option.value)) : directApiAllowed(engineKind(option.value)));
  const defaultProtocol = kind === 'claude' || kind === 'dsh' ? 'anthropic' : 'openai-responses';
  const protocols = kind === 'claude' || kind === 'dsh' ? [{ value: 'anthropic', label: 'Anthropic Messages' }] : kind === 'codex' ? [{ value: 'openai-responses', label: 'OpenAI Responses' }] : [{ value: 'openai-responses', label: 'OpenAI Responses' }, { value: 'openai', label: 'OpenAI Chat Completions' }, { value: 'anthropic', label: 'Anthropic Messages' }];
  const protocolValid = !channel.protocol || protocols.some(option => option.value === channel.protocol);
  const configError = replaceConfig ? channelContentError(nativeConfig) : '';
  const keyError = channel.kind === 'api' ? channelContentError(apiKey) : '';
  const canSave = (editing || availableEngines.some(option => option.value === channel.engine)) && !configError && !keyError && protocolValid && !!channel.label.trim() && !!channel.engine && (channel.kind !== 'api' || !directApiAllowed(kind) || !!channel.provider?.trim()) && !uploadError;
  return <Modal className={stylex.props(resourceStyles.modal).className} classNames={{ body: stylex.props(resourceStyles.modalBody).className, footer: stylex.props(resourceStyles.modalFooter).className }} draggable={false} open={open} title={editing ? `编辑 ${value.label}` : '添加账号'} width={640} okText={channel.kind === 'subscription' && !editing ? '创建并登录' : '保存配置'} cancelText="暂存并关闭" confirmLoading={busy} okButtonProps={{ disabled: !canSave || busy }} maskClosable={!busy} keyboard={!busy} cancelButtonProps={{ disabled: busy }} onCancel={onCancel} onOk={() => onSave({ ...channel, label: channel.label.trim(), ...(channel.kind === 'api' && directApiAllowed(kind) ? { protocol: channel.protocol ?? defaultProtocol } : {}) }, channel.kind === 'api' ? apiKey : '', nativeConfig, replaceConfig)}>
    <Form form={form} layout="vertical" className={stylex.props(styles.stack).className} data-channels-scroll="">
      <Form.Field label="名称" required><Input id={`${id}-label`} value={channel.label} disabled={busy} onChange={event => setChannel({ ...channel, label: event.target.value })} placeholder="例如：工作 ChatGPT、团队 API" /></Form.Field>
      <Form.Field label="类型" required><NamedSelect id={`${id}-kind`} aria-label="渠道类型" value={channel.kind} disabled={busy || editing} options={[{ value: 'subscription', label: '官方订阅账号' }, { value: 'api', label: 'API provider 渠道' }]} onChange={value => {
        const nextKind = value === 'subscription' ? 'subscription' : 'api';
        const allowed = engineOptions.filter(option => nextKind === 'subscription' ? subscriptionAllowed(engineKind(option.value)) : directApiAllowed(engineKind(option.value)));
        const engine = allowed.some(option => option.value === channel.engine) ? channel.engine : allowed[0]?.value ?? '';
        uploadGeneration.current++; setApiKey(''); setNativeConfig(''); setReplaceConfig(false); setUploadError('');
        setChannel({ label: channel.label, enabled: channel.enabled, kind: nextKind, engine, ...(engineKind(engine) === 'dsh' ? { provider: 'deepseek-official' } : {}) });
      }} /></Form.Field>
      <Form.Field label="执行引擎" required extra={editing ? '已有凭据归属于这个引擎；更换引擎请创建新渠道。' : undefined}><NamedSelect id={`${id}-engine`} aria-label="执行引擎" value={channel.engine} disabled={busy || editing} options={availableEngines} onChange={engine => { const next = String(engine); if (next === channel.engine) return; uploadGeneration.current++; setApiKey(''); setNativeConfig(''); setReplaceConfig(false); setChannel({ ...channel, engine: next, kind: subscriptionAllowed(engineKind(next)) ? channel.kind : 'api', provider: engineKind(next) === 'dsh' ? 'deepseek-official' : undefined, baseUrl: undefined, protocol: undefined }); }} /></Form.Field>
      {channel.kind === 'subscription' ? <Text type="secondary">官方账号使用独立配置。创建后会在此处启动原生登录并等待凭据验证；已有账号的引擎和类型不能更换。</Text> : !directApiAllowed(kind) ? <Text type="secondary">Qoder API 使用导入的原生 BYOK 配置。新增 Qoder API 账号请先通过原生 /model 向导配置，再导入其配置目录；填写 key 或 settings JSON 不能创建 BYOK。</Text> : <>
        <Form.Field label="Provider" required><Input id={`${id}-provider`} value={channel.provider ?? ''} disabled={busy} onChange={event => setChannel({ ...channel, provider: event.target.value })} placeholder="原生 provider ID，例如 openai" /></Form.Field>
        <Form.Field label="Base URL"><Input id={`${id}-url`} type="url" value={channel.baseUrl ?? ''} disabled={busy} onChange={event => setChannel({ ...channel, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></Form.Field>
        <Form.Field label="API 协议" extra={!protocolValid ? '已有协议不受当前引擎支持，请重新选择。' : undefined}><NamedSelect id={`${id}-protocol`} aria-label="API 协议" value={protocolValid ? channel.protocol ?? defaultProtocol : undefined} disabled={busy} options={protocols} onChange={protocol => setChannel({ ...channel, protocol: protocol as Channel['protocol'] })} /></Form.Field>
        <Form.Field label="API 密钥" extra={keyError || (hasKey ? '已配置；留空保留已有密钥，不会回显。' : '可提供密钥，或在高级原生配置中配置认证。')}><InputPassword aria-invalid={!!keyError} id={`${id}-key`} autoComplete="new-password" value={apiKey} disabled={busy} onChange={event => setApiKey(event.target.value)} placeholder={hasKey ? '留空保留已有密钥' : '输入 API key'} /></Form.Field>
        <Text type="secondary" className={stylex.props(styles.meta).className}>模型和推理强度在父、子 Agent 中选择。{kind === 'dsh' ? ' 当前仅支持 deepseek-official API provider，使用 Messages 协议。' : !directApiAllowed(kind) ? ' Qoder API 需先在原生 /model 向导配置 BYOK 后导入；settings JSON 不能定义 BYOK。' : ''}</Text>
      </>}
      {channel.kind === 'api' && directApiAllowed(kind) && <details><summary>高级：原生配置覆写</summary><div {...stylex.props(styles.stack)}>
        <Text type="secondary" className={stylex.props(styles.meta).className}>{hasConfig ? '已有配置，秘密内容不会回显。' : '支持该 CLI 的原生配置格式。'}{kind === 'dsh' ? 'dsh 配置必须是 YAML patch 列表，例如 []；不接受配置对象。' : ''}填写或上传后替换同一份配置；不操作则保留。请勿上传整个账号目录。</Text>
        <Checkbox checked={replaceConfig} disabled={busy} onChange={checked => setReplaceConfig(checked === true)}>替换原生配置（空文本表示清除）</Checkbox>
        <TextArea aria-invalid={!!configError} aria-label="原生配置覆写" className={stylex.props(channelStyles.native).className} value={nativeConfig} disabled={busy} rows={7} onChange={event => { uploadGeneration.current++; setNativeConfig(event.target.value); setReplaceConfig(true); setUploadError(''); }} placeholder={kind === 'dsh' ? '[]（YAML patch 列表）' : '原生 JSON / TOML / YAML 配置'} />
        {configError && <Text type="danger" role="alert">{configError}</Text>}
        <div><Text>上传原生配置</Text><FileUpload id={`${id}-upload`} disabled={busy} accept=".json,.jsonc,.toml,.yaml,.yml,.txt" maxCount={1} onFiles={files => { const file = files[0]; if (!file) return; if (file.size > CHANNEL_CONFIG_MAX_BYTES) { setUploadError(`配置文件不能超过 ${CHANNEL_CONFIG_MAX_BYTES / 1024} KiB。`); return; } const token = ++uploadGeneration.current; void file.text().then(text => { if (token !== uploadGeneration.current) return; setNativeConfig(text); setReplaceConfig(true); setUploadError(''); }).catch(() => { if (token === uploadGeneration.current) setUploadError('无法读取文件，请重新选择。'); }); }}><Button aria-label="选择原生配置文件" disabled={busy} icon={Upload}>选择配置文件</Button></FileUpload>{uploadError && <Text type="danger" role="alert">{uploadError}</Text>}</div>
      </div></details>}
      <div><Button danger size="small" disabled={busy} onClick={onDiscard}>放弃此草稿</Button></div>
      {failure && <Alert type="error" title="保存失败，输入已保留" description={failure} action={<Button size="small" onClick={onReload}>重新读取状态</Button>} />}
    </Form>
  </Modal>;
}
