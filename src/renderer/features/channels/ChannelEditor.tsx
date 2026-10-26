import { useEffect, useId, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Upload } from 'lucide-react';
import { Button, Checkbox, Input, InputPassword, Text, TextArea, Upload as FileUpload } from '@lobehub/ui';
import { Form, useForm } from '@lobehub/ui/form';
import { CHANNEL_CONFIG_MAX_BYTES } from '../../../shared/contracts/channels';
import type { Channel } from '../../../shared/contracts/channels';
import { NamedSelect } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { channelContentError, channelDefaultProtocol, channelProtocols, directApiAllowed, subscriptionAllowed, type ChannelDraft } from './channels-view';
import { channelStyles } from './channels-style';

export interface ChannelEditorProps {
  draft: ChannelDraft;
  editing: boolean;
  engineOptions: { value: string; label: string }[];
  engineKind: (id: string) => string;
  hasConfig: boolean;
  hasKey: boolean;
  busy: boolean;
  onChange: (draft: ChannelDraft) => void;
}

/** The channel configuration fields as an in-pane draft; the pane footer owns SaveBar. */
export function ChannelEditor({ draft, editing, engineOptions, engineKind, hasConfig, hasKey, busy, onChange }: ChannelEditorProps) {
  const form = useForm();
  const id = useId();
  const uploadGeneration = useRef(0);
  useEffect(() => () => { uploadGeneration.current++; }, []);
  const channel = draft.channel;
  const kind = engineKind(channel.engine);
  const availableEngines = editing ? engineOptions : engineOptions.filter(option => channel.kind === 'subscription' ? subscriptionAllowed(engineKind(option.value)) : directApiAllowed(engineKind(option.value)));
  const protocols = channelProtocols(kind);
  const protocolValid = !channel.protocol || protocols.some(option => option.value === channel.protocol);
  const configError = draft.replaceConfig ? channelContentError(draft.nativeConfig) : '';
  const keyError = channel.kind === 'api' ? channelContentError(draft.apiKey) : '';
  const patch = (next: Partial<Channel>) => onChange({ ...draft, uploadError: '', channel: { ...channel, ...next } });
  return <Form form={form} layout="vertical" className={stylex.props(styles.stack).className} data-channels-scroll="">
    <Form.Field label="名称" required><Input id={`${id}-label`} value={channel.label} disabled={busy} onChange={event => patch({ label: event.target.value })} placeholder="例如：工作 ChatGPT、团队 API" /></Form.Field>
    <Form.Field label="类型" required extra={editing ? '已有账号的类型不能更换；需要另一种身份时新建账号。' : undefined}><NamedSelect id={`${id}-kind`} aria-label="账号或渠道类型" value={channel.kind} disabled={busy || editing} options={[{ value: 'subscription', label: '官方订阅账号' }, { value: 'api', label: 'API provider 渠道' }]} onChange={value => {
      const nextKind = value === 'subscription' ? 'subscription' : 'api';
      const allowed = engineOptions.filter(option => nextKind === 'subscription' ? subscriptionAllowed(engineKind(option.value)) : directApiAllowed(engineKind(option.value)));
      const engine = allowed.some(option => option.value === channel.engine) ? channel.engine : allowed[0]?.value ?? '';
      uploadGeneration.current++;
      onChange({ ...draft, channel: { label: channel.label, enabled: channel.enabled, kind: nextKind, engine, ...(engineKind(engine) === 'dsh' ? { provider: 'deepseek-official' } : {}) }, apiKey: '', nativeConfig: '', replaceConfig: false, uploadError: '' });
    }} /></Form.Field>
    <Form.Field label="执行引擎" required extra={editing ? '已有凭据归属于这个引擎；更换引擎请创建新渠道。' : undefined}><NamedSelect id={`${id}-engine`} aria-label="执行引擎" value={channel.engine} disabled={busy || editing} options={availableEngines} onChange={value => {
      const engine = String(value);
      if (engine === channel.engine) return;
      uploadGeneration.current++;
      onChange({ ...draft, channel: { ...channel, engine, kind: subscriptionAllowed(engineKind(engine)) ? channel.kind : 'api', provider: engineKind(engine) === 'dsh' ? 'deepseek-official' : undefined, baseUrl: undefined, protocol: undefined }, apiKey: '', nativeConfig: '', replaceConfig: false, uploadError: '' });
    }} /></Form.Field>
    {channel.kind === 'subscription' ? <Text type="secondary" className={stylex.props(styles.meta, styles.wrap).className}>官方账号使用独立配置。创建后会启动原生登录并等待凭据验证；已有账号的类型和引擎不能更换。</Text> : !directApiAllowed(kind) ? <Text type="secondary" className={stylex.props(styles.meta, styles.wrap).className}>Qoder API 使用导入的原生 BYOK 配置。新增 Qoder API 账号请先通过原生 /model 向导配置，再导入其配置目录；填写 key 或 settings JSON 不能创建 BYOK。</Text> : <>
      <Form.Field label="Provider" required><Input id={`${id}-provider`} value={channel.provider ?? ''} disabled={busy} onChange={event => patch({ provider: event.target.value })} placeholder="原生 provider ID，例如 openai" /></Form.Field>
      <Form.Field label="Base URL"><Input id={`${id}-url`} type="url" value={channel.baseUrl ?? ''} disabled={busy} onChange={event => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></Form.Field>
      <Form.Field label="API 协议" extra={!protocolValid ? '已有协议不受当前引擎支持，请重新选择。' : undefined}><NamedSelect id={`${id}-protocol`} aria-label="API 协议" value={protocolValid ? channel.protocol ?? channelDefaultProtocol(kind) : undefined} disabled={busy} options={protocols} onChange={protocol => patch({ protocol: protocol as Channel['protocol'] })} /></Form.Field>
      <Form.Field label="API 密钥" extra={hasKey ? '已配置；留空保留已有密钥，不会回显。' : '可提供密钥，或在高级原生配置中配置认证。'}><InputPassword aria-invalid={!!keyError} id={`${id}-key`} autoComplete="new-password" value={draft.apiKey} disabled={busy} onChange={event => onChange({ ...draft, uploadError: '', apiKey: event.target.value })} placeholder={hasKey ? '留空保留已有密钥' : '输入 API key'} /></Form.Field>
      {keyError && <Text type="danger" role="alert">{keyError}</Text>}
      <Text type="secondary" className={stylex.props(styles.meta, styles.wrap).className}>模型和推理强度在父、子 Agent 中选择。{kind === 'dsh' ? ' 当前仅支持 deepseek-official API provider，使用 Messages 协议。' : ''}</Text>
      <details>
        <summary>高级：原生配置覆写</summary>
        <div {...stylex.props(channelStyles.advanced)}>
          <Text type="secondary" className={stylex.props(styles.meta, styles.wrap).className}>{hasConfig ? '已有配置，秘密内容不会回显。' : '支持该 CLI 的原生配置格式。'}{kind === 'dsh' ? 'dsh 配置必须是 YAML patch 列表，例如 []；不接受配置对象。' : ''}填写或上传后替换同一份配置；不操作则保留。请勿上传整个账号目录。</Text>
          <Checkbox checked={draft.replaceConfig} disabled={busy} onChange={checked => onChange({ ...draft, uploadError: '', replaceConfig: checked === true })}>替换原生配置（空文本表示清除）</Checkbox>
          <TextArea aria-invalid={!!configError} aria-label="原生配置覆写" className={stylex.props(channelStyles.native).className} value={draft.nativeConfig} disabled={busy} rows={7} onChange={event => { uploadGeneration.current++; onChange({ ...draft, uploadError: '', nativeConfig: event.target.value, replaceConfig: true }); }} placeholder={kind === 'dsh' ? '[]（YAML patch 列表）' : '原生 JSON / TOML / YAML 配置'} />
          {configError && <Text type="danger" role="alert">{configError}</Text>}
          <div {...stylex.props(channelStyles.upload)}>
            <Text>上传原生配置</Text>
            <FileUpload id={`${id}-upload`} disabled={busy} accept=".json,.jsonc,.toml,.yaml,.yml,.txt" maxCount={1} onFiles={files => {
              const file = files[0];
              if (!file) return;
              if (file.size > CHANNEL_CONFIG_MAX_BYTES) { onChange({ ...draft, uploadError: `配置文件不能超过 ${CHANNEL_CONFIG_MAX_BYTES / 1024} KiB。` }); return; }
              const token = ++uploadGeneration.current;
              void file.text().then(text => {
                if (token !== uploadGeneration.current) return;
                onChange({ ...draft, nativeConfig: text, replaceConfig: true, uploadError: '' });
              }).catch(() => { if (token === uploadGeneration.current) onChange({ ...draft, uploadError: '无法读取文件，请重新选择。' }); });
            }}>
              <Button aria-label="选择原生配置文件" disabled={busy} icon={Upload}>选择配置文件</Button>
            </FileUpload>
            {draft.uploadError && <Text type="danger" role="alert">{draft.uploadError}</Text>}
          </div>
        </div>
      </details>
    </>}
  </Form>;
}
