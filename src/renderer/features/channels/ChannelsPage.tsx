import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Plus, RefreshCw, Upload } from 'lucide-react';
import { Empty } from '@lobehub/ui';
import { PageHeader } from '@lobehub/ui/dashboard';
import { Alert, Button, Checkbox, Input, InputPassword, Modal, Skeleton, Tag, Text, TextArea, Upload as FileUpload } from '@lobehub/ui/base-ui';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
import { CHANNEL_CONFIG_MAX_BYTES } from '../../../shared/contracts/channels';
import type { Channel, ChannelsSnapshot } from '../../../shared/contracts/channels';
import { QUOTA_KINDS } from '../../../shared/policy/settings';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { NamedSelect, NamedSwitch } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { tagColor } from '../../format/tag-colors';
import { QuotaSummary } from '../engines/QuotaSummary';
import { channelContentError, channelImportInput, channelQuota, channelSaveInput, channelUsers, directApiAllowed, mergeChannelPolicy, subscriptionAllowed } from './channels-view';
import { channelStyles } from './channels-style';

export function ChannelsPage({ policy }: { policy: PolicyDraft }) {
  const [snapshot, setSnapshot] = useState<ChannelsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  const locked = useRef(false);
  const readGeneration = useRef(0);
  const [filter, setFilter] = useState('all');
  const [engineFilter, setEngineFilter] = useState('all');
  const [editor, setEditor] = useState<{ id?: string; channel: Channel }>();
  const [deleting, setDeleting] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [importEngine, setImportEngine] = useState('all');
  const [sourceDir, setSourceDir] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [notice, setNotice] = useState('');
  const config = snapshot?.policy.config ?? policy.snapshot?.config;
  const accept = useCallback((next: ChannelsSnapshot) => {
    setSnapshot(next);
    const before = policy.snapshot?.config;
    policy.rebase(next.policy, doc => ({ ...doc, config: before ? mergeChannelPolicy(doc.config, before, next.policy.config) : { ...doc.config, channels: next.policy.config.channels }, blocks: next.policy.blocks }));
  }, [policy.rebase, policy.snapshot]);
  const load = useCallback(async (silent = false) => {
    if (locked.current) return;
    const generation = ++readGeneration.current;
    if (!silent) { setLoading(true); setFailure(''); }
    try { const next = await window.weaver.getChannels(); if (generation === readGeneration.current) accept(next); }
    catch (error) { if (!silent && generation === readGeneration.current) setFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === readGeneration.current) setLoading(false); }
  }, [accept]);
  // The page owns channel reads; policy revision changes should not erase an open editor.
  const initialLoad = useRef(false);
  useEffect(() => { if (!initialLoad.current) { initialLoad.current = true; void load(); } }, [load]);
  useEffect(() => {
    if (editor || importing || deleting) return;
    const timer = setInterval(() => void load(true), 30_000);
    return () => clearInterval(timer);
  }, [load, editor, importing, deleting]);
  async function mutate(id: string, fn: () => Promise<ChannelsSnapshot>, success: string, done?: () => void) {
    if (locked.current || policy.busy) return;
    locked.current = true; readGeneration.current++; setLoading(false); setBusy(id); setFailure(''); setNotice('');
    try { accept(await fn()); setNotice(success); done?.(); }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { locked.current = false; setBusy(''); }
  }
  const revision = snapshot?.policy.revision ?? policy.snapshot?.revision;
  const engineOptions = Object.entries(config?.engines ?? {}).map(([id, engine]) => ({ value: id, label: `${id} · ${engine.kind}${engine.enabled ? '' : '（工具未启用）'}` }));
  const apiEngineOptions = engineOptions.filter(option => directApiAllowed(config?.engines[option.value]?.kind ?? ''));
  const rows = Object.entries(config?.channels ?? {}).filter(([, channel]) => (filter === 'all' || channel.kind === filter) && (engineFilter === 'all' || channel.engine === engineFilter));
  const newChannel = () => {
    const engine = apiEngineOptions.find(option => config?.engines[option.value]?.enabled)?.value ?? apiEngineOptions[0]?.value ?? '';
    readGeneration.current++; setLoading(false); setFailure(''); setEditor({ channel: { label: '', engine, kind: 'api', enabled: true } });
  };
  return <>
    <PageHeader title="账号与渠道" description="选择官方订阅账号或 API 渠道，再分配给父、子 Agent。每个渠道使用独立配置。" action={<Button type="primary" icon={Plus} disabled={!apiEngineOptions.length || !!busy || policy.busy} onClick={newChannel}>添加 API 渠道</Button>} />
    <div className={channelStyles.toolbar}>
      <NamedSelect aria-label="渠道类型筛选" value={filter} options={[{ value: 'all', label: '全部类型' }, { value: 'subscription', label: '官方订阅' }, { value: 'api', label: 'API' }]} onChange={value => setFilter(String(value))} />
      <NamedSelect aria-label="渠道引擎筛选" value={engineFilter} options={[{ value: 'all', label: '全部引擎' }, ...engineOptions]} onChange={value => setEngineFilter(String(value))} />
      <Button icon={Upload} disabled={!!busy || policy.busy} onClick={() => { readGeneration.current++; setLoading(false); setFailure(''); setReplaceExisting(false); setImporting(true); }}>导入已有账号或渠道</Button>
      <Button icon={RefreshCw} loading={loading} disabled={!!busy} onClick={() => void load()}>重新读取</Button>
    </div>
    {failure && !editor && !importing && !deleting && <Alert type="error" title="操作未完成" description={`${failure}。表单内容已保留；若配置已变化，请重新读取后重试。`} action={<Button size="small" disabled={!!busy} onClick={() => void load()}>重新读取</Button>} />}
    {notice && <Text role="status" type="secondary">{notice}</Text>}
    {loading && !snapshot ? <Skeleton.Text animated rows={5} /> : !rows.length ? <Empty title={Object.keys(config?.channels ?? {}).length ? '没有匹配的渠道' : '添加第一个账号或渠道'} description="官方订阅账号通过「导入已有账号或渠道」添加；API 渠道可直接填写连接配置。Qoder API 请先在原生 /model 配置 BYOK 后导入。" action={<Button icon={Plus} disabled={!apiEngineOptions.length} onClick={newChannel}>添加 API 渠道</Button>} /> : <div className={channelStyles.list}>
      {rows.map(([id, channel]) => {
        const state = snapshot?.configurations[id];
        const users = config ? channelUsers(config, id) : [];
        const engine = config?.engines[channel.engine];
        const record = channelQuota(id, channel, state);
        const canQueryQuota = channel.kind === 'subscription' && (QUOTA_KINDS as readonly string[]).includes(engine?.kind ?? '');
        return <article key={id} aria-label={channel.label} className={channelStyles.row}>
          <div className={styles.tight}>
            <Text strong className={styles.wrap}>{channel.label}</Text>
            <span className={styles.row}><Tag size="small" color={tagColor('neutral')}>{channel.kind === 'subscription' ? '官方订阅' : 'API'}</Tag><Text type="secondary">{channel.engine}</Text></span>
            {!engine?.enabled && <Text type="warning" className={styles.meta}>引擎未启用，请到引擎页启用工具。</Text>}
            <Text type="secondary" className={`${styles.meta} ${styles.wrap}`}>{users.length ? users.join('、') : '尚未分配给 Agent'}</Text>
          </div>
          <div className={styles.tight}>
            <Text>{channel.kind === 'subscription' ? state?.hasCredentials ? '原生登录凭据已配置' : '尚未导入原生登录' : state?.hasApiKey ? 'API 密钥已配置' : state?.hasCredentials ? '原生认证已配置' : state?.hasConfig ? '原生配置已提供' : '尚未配置连接'}</Text>
            {channel.kind === 'api' && <Text type="secondary" className={`${styles.meta} ${styles.wrap}`}>{[channel.provider, channel.baseUrl, channel.protocol].filter(Boolean).join(' · ') || '编辑渠道以配置 provider 与 endpoint'}</Text>}
            <Text type="secondary" className={styles.meta}>{state?.hasConfig ? '已有原生配置覆写 · 不回显秘密内容' : '使用引擎原生配置'}</Text>
            {state?.detail && <Text type="warning" className={`${styles.meta} ${styles.wrap}`}>{state.detail}</Text>}
            {channel.kind === 'subscription' && !state?.hasCredentials && <Text type="secondary" className={styles.meta}>请从已登录的原生 CLI 目录导入账号，再在父、子 Agent 中选择对应渠道。</Text>}
          </div>
          <div className={styles.tight}>
            {record ? <QuotaSummary engine={record.engine} record={record} now={Date.now()} busy={busy === `quota:${id}` ? record.engine : null} policyBusy={!!busy || policy.busy} onRefresh={() => void mutate(`quota:${id}`, () => window.weaver.refreshChannelQuota({ channel: id }), '已刷新所选账号额度。')} recovery={record.status === 'unauthenticated' ? '请重新导入该账号的原生登录，再刷新额度。' : undefined} refreshLabel={`刷新 ${channel.label} 额度`} />
              : <><Text type="secondary">{channel.kind === 'api' ? 'API 渠道不显示官方订阅额度' : !canQueryQuota ? '该引擎没有官方只读额度接口' : '尚无该账号的额度观测'}</Text>{canQueryQuota && <Button size="small" disabled={!!busy || policy.busy} loading={busy === `quota:${id}`} onClick={() => void mutate(`quota:${id}`, () => window.weaver.refreshChannelQuota({ channel: id }), '已刷新所选账号额度。')}>刷新账号额度</Button>}</>}
            {canQueryQuota && <span className={channelStyles.actions}><NamedSwitch size="small" aria-label={`${channel.label} 自动刷新额度`} checked={channel.quota_refresh !== false} disabled={!!busy || policy.busy} onChange={checked => revision !== undefined && void mutate(id, () => window.weaver.saveChannel({ revision, id, channel: { ...channel, quota_refresh: checked } }), '已更新额度刷新设置。')} /><Text type="secondary" className={styles.meta}>自动刷新</Text></span>}
          </div>
          <div className={channelStyles.actions}>
            <NamedSwitch size="small" aria-label={`启用 ${channel.label}`} checked={channel.enabled} loading={busy === id} disabled={!!busy || policy.busy} onChange={enabled => revision !== undefined && void mutate(id, () => window.weaver.saveChannel({ revision, id, channel: { ...channel, enabled } }), enabled ? '渠道已启用；实际执行仍需可用凭据与引擎。' : '渠道已停用。')} />
            <Button size="small" disabled={!!busy} onClick={() => { readGeneration.current++; setLoading(false); setFailure(''); setEditor({ id, channel: { ...channel } }); }}>编辑</Button>
            <Button size="small" danger disabled={!!busy} onClick={() => { readGeneration.current++; setLoading(false); setFailure(''); setDeleting(id); }}>删除</Button>
          </div>
        </article>;
      })}
    </div>}
    {editor && revision !== undefined && config && <ChannelEditor key={editor.id ?? 'new'} value={editor.channel} editing={!!editor.id} engineOptions={editor.id ? engineOptions : apiEngineOptions} engineKind={id => config.engines[id]?.kind ?? ''} hasConfig={!!(editor.id && snapshot?.configurations[editor.id]?.hasConfig)} hasKey={!!(editor.id && snapshot?.configurations[editor.id]?.hasApiKey)} busy={!!busy} failure={failure} onReload={() => void load()} onCancel={() => { if (!busy) setEditor(undefined); }} onSave={(channel, apiKey, nativeConfig, replaceConfig) => void mutate('save', () => window.weaver.saveChannel(channelSaveInput(revision, editor.id, channel, apiKey, nativeConfig, replaceConfig)), '配置已保存；请在 Agent 配置中做连通测试。', () => setEditor(undefined))} />}
    <Modal open={importing} title="导入原生账号与 API 配置" okText="导入" cancelText="取消" confirmLoading={busy === 'import'} okButtonProps={{ disabled: !!busy || revision === undefined || (!!sourceDir.trim() && importEngine === 'all') }} maskClosable={!busy} keyboard={!busy} onCancel={() => { if (!busy) setImporting(false); }} onOk={() => revision !== undefined && void mutate('import', () => window.weaver.importChannels(channelImportInput(revision, importEngine, sourceDir, replaceExisting)), '导入已完成；这不代表连通测试已通过。', () => setImporting(false))}>
      <ImportForm engine={importEngine} engines={engineOptions} sourceDir={sourceDir} replaceExisting={replaceExisting} onReplace={setReplaceExisting} onEngine={setImportEngine} onSource={setSourceDir} busy={!!busy} failure={failure} onReload={() => void load()} />
    </Modal>
    <Modal open={!!deleting} title="删除渠道" okText="删除" cancelText="取消" okButtonProps={{ danger: true, disabled: !!busy || !deleting || !!(config && channelUsers(config, deleting).length) }} confirmLoading={busy === 'delete'} onCancel={() => { if (!busy) setDeleting(undefined); }} onOk={() => revision !== undefined && deleting && void mutate('delete', () => window.weaver.deleteChannel({ revision, id: deleting }), '渠道已删除。', () => setDeleting(undefined))}>
      <Text>{deleting && config && channelUsers(config, deleting).length ? `以下角色仍引用该渠道，请先在角色配置中更换：${channelUsers(config, deleting).join('、')}` : '删除这条渠道及其托管配置，不修改来源 CLI 目录。此操作不能撤销。'}</Text>
      {failure && <Text role="alert" className={channelStyles.error}>{failure}</Text>}
    </Modal>
  </>;
}

function ChannelEditor({ value, editing, engineOptions, engineKind, hasConfig, hasKey, busy, failure, onReload, onCancel, onSave }: { value: Channel; editing: boolean; engineOptions: { value: string; label: string }[]; engineKind: (id: string) => string; hasConfig: boolean; hasKey: boolean; busy: boolean; failure: string; onReload: () => void; onCancel: () => void; onSave: (channel: Channel, key: string, config: string, replace: boolean) => void }) {
  const form = useForm();
  const id = useId();
  const [channel, setChannel] = useState(value);
  const [apiKey, setApiKey] = useState('');
  const [nativeConfig, setNativeConfig] = useState('');
  const [replaceConfig, setReplaceConfig] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const kind = engineKind(channel.engine);
  const defaultProtocol = kind === 'claude' || kind === 'dsh' ? 'anthropic' : 'openai-responses';
  const protocols = kind === 'claude' || kind === 'dsh' ? [{ value: 'anthropic', label: 'Anthropic Messages' }] : kind === 'codex' ? [{ value: 'openai-responses', label: 'OpenAI Responses' }] : [{ value: 'openai-responses', label: 'OpenAI Responses' }, { value: 'openai', label: 'OpenAI Chat Completions' }, { value: 'anthropic', label: 'Anthropic Messages' }];
  const protocolValid = !channel.protocol || protocols.some(option => option.value === channel.protocol);
  const configError = replaceConfig ? channelContentError(nativeConfig) : '';
  const keyError = channel.kind === 'api' ? channelContentError(apiKey) : '';
  const canSave = !configError && !keyError && protocolValid && !!channel.label.trim() && !!channel.engine && (channel.kind !== 'api' || kind === 'qodercli' || !!channel.provider?.trim()) && !uploadError;
  return <Modal open title={value.label ? `编辑 ${value.label}` : '添加 API 渠道'} width={640} okText="保存配置" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: !canSave || busy }} maskClosable={!busy} keyboard={!busy} onCancel={onCancel} onOk={() => onSave({ ...channel, label: channel.label.trim(), ...(channel.kind === 'api' ? { protocol: channel.protocol ?? defaultProtocol } : {}) }, channel.kind === 'api' ? apiKey : '', nativeConfig, replaceConfig)}>
    <Form form={form} layout="vertical" className={styles.stack}>
      <Form.Field label="名称" required><Input id={`${id}-label`} value={channel.label} disabled={busy} onChange={event => setChannel({ ...channel, label: event.target.value })} placeholder="例如：工作 ChatGPT、团队 API" /></Form.Field>
      <Form.Field label="执行引擎" required extra={editing ? '已有凭据归属于这个引擎；更换引擎请创建新渠道。' : undefined}><NamedSelect id={`${id}-engine`} aria-label="执行引擎" value={channel.engine} disabled={busy || editing} options={engineOptions} onChange={engine => { const next = String(engine); if (next === channel.engine) return; setApiKey(''); setNativeConfig(''); setReplaceConfig(false); setChannel({ ...channel, engine: next, kind: subscriptionAllowed(engineKind(next)) ? channel.kind : 'api', provider: engineKind(next) === 'dsh' ? 'deepseek-official' : undefined, baseUrl: undefined, protocol: undefined }); }} /></Form.Field>
      <Form.Field label="类型" required><NamedSelect id={`${id}-kind`} aria-label="渠道类型" value={channel.kind} disabled options={[...(subscriptionAllowed(kind) ? [{ value: 'subscription', label: '官方订阅账号' }] : []), { value: 'api', label: 'API provider 渠道' }]} onChange={value => setChannel({ ...channel, kind: value === 'subscription' ? 'subscription' : 'api', ...(value === 'subscription' ? { provider: undefined, baseUrl: undefined, protocol: undefined } : {}) })} /></Form.Field>
      {channel.kind === 'subscription' ? <Text type="secondary">这是已导入的官方账号，可在这里修改名称和原生配置。其他账号请从已登录的原生 CLI 目录导入，认证不会回显或覆盖来源。</Text> : kind === 'qodercli' ? <Text type="secondary">Qoder API 使用导入的原生 BYOK 配置。其他 API 账号请先通过原生 /model 向导配置，再导入其配置目录；填写 key 或 settings JSON 不能创建 BYOK。</Text> : <>
        <Form.Field label="Provider" required><Input id={`${id}-provider`} value={channel.provider ?? ''} disabled={busy} onChange={event => setChannel({ ...channel, provider: event.target.value })} placeholder="原生 provider ID，例如 openai" /></Form.Field>
        <Form.Field label="Base URL"><Input id={`${id}-url`} type="url" value={channel.baseUrl ?? ''} disabled={busy} onChange={event => setChannel({ ...channel, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></Form.Field>
        <Form.Field label="API 协议" extra={!protocolValid ? '已有协议不受当前引擎支持，请重新选择。' : undefined}><NamedSelect id={`${id}-protocol`} aria-label="API 协议" value={protocolValid ? channel.protocol ?? defaultProtocol : undefined} disabled={busy} options={protocols} onChange={protocol => setChannel({ ...channel, protocol: protocol as Channel['protocol'] })} /></Form.Field>
        <Form.Field label="API 密钥" extra={keyError || (hasKey ? '已配置；留空保留已有密钥，不会回显。' : '可提供密钥，或在高级原生配置中配置认证。')}><InputPassword aria-invalid={!!keyError} id={`${id}-key`} autoComplete="new-password" value={apiKey} disabled={busy} onChange={event => setApiKey(event.target.value)} placeholder={hasKey ? '留空保留已有密钥' : '输入 API key'} /></Form.Field>
        <Text type="secondary" className={styles.meta}>模型和推理强度在父、子 Agent 中选择。{kind === 'dsh' ? ' 当前仅支持 deepseek-official API provider，使用 Messages 协议。' : kind === 'qodercli' ? ' Qoder API 需先在原生 /model 向导配置 BYOK 后导入；settings JSON 不能定义 BYOK。' : ''}</Text>
      </>}
      <details><summary>高级：原生配置覆写</summary><div className={styles.stack}>
        <Text type="secondary" className={styles.meta}>{hasConfig ? '已有配置，秘密内容不会回显。' : '支持该 CLI 的原生配置格式。'}填写或上传后替换同一份配置；不操作则保留。请勿上传整个账号目录。</Text>
        <Checkbox checked={replaceConfig} disabled={busy} onChange={checked => setReplaceConfig(checked === true)}>替换原生配置（空文本表示清除）</Checkbox>
        <TextArea aria-invalid={!!configError} aria-label="原生配置覆写" className={channelStyles.native} value={nativeConfig} disabled={busy} rows={7} onChange={event => { setNativeConfig(event.target.value); setReplaceConfig(true); setUploadError(''); }} placeholder="原生 JSON / TOML / YAML 配置" />
        {configError && <Text type="danger" role="alert">{configError}</Text>}
        <div><Text>上传原生配置</Text><FileUpload id={`${id}-upload`} disabled={busy} accept=".json,.jsonc,.toml,.yaml,.yml,.txt" maxCount={1} onFiles={files => { const file = files[0]; if (!file) return; if (file.size > CHANNEL_CONFIG_MAX_BYTES) { setUploadError(`配置文件不能超过 ${CHANNEL_CONFIG_MAX_BYTES / 1024} KiB。`); return; } void file.text().then(text => { setNativeConfig(text); setReplaceConfig(true); setUploadError(''); }).catch(() => setUploadError('无法读取文件，请重新选择。')); }}><Button aria-label="选择原生配置文件" disabled={busy} icon={Upload}>选择配置文件</Button></FileUpload>{uploadError && <Text type="danger" role="alert">{uploadError}</Text>}</div>
      </div></details>
      {failure && <Alert type="error" title="保存失败，输入已保留" description={failure} action={<Button size="small" onClick={onReload}>重新读取状态</Button>} />}
    </Form>
  </Modal>;
}

function ImportForm({ engine, engines, sourceDir, replaceExisting, onReplace, onEngine, onSource, busy, failure, onReload }: { engine: string; engines: { value: string; label: string }[]; sourceDir: string; replaceExisting: boolean; onReplace: (value: boolean) => void; onEngine: (value: string) => void; onSource: (value: string) => void; busy: boolean; failure: string; onReload: () => void }) {
  const form = useForm(); const id = useId();
  return <Form form={form} layout="vertical" className={styles.stack}>
    <Form.Field label="导入引擎"><NamedSelect id={`${id}-engine`} aria-label="执行引擎" value={engine} disabled={busy} options={[{ value: 'all', label: '所有已有引擎配置' }, ...engines]} onChange={value => onEngine(String(value))} /></Form.Field>
    <Form.Field label="来源配置目录" extra="Weaver 所在机器的原生 CLI 配置根；指定目录时请先选择对应引擎。留空使用默认位置。只复制必要配置与认证，不修改来源。"><Input id={`${id}-source`} value={sourceDir} disabled={busy} onChange={event => onSource(event.target.value)} placeholder="可选，例如 /home/user/.codex" /></Form.Field>
    <Checkbox checked={replaceExisting} disabled={busy} onChange={checked => onReplace(checked === true)}>更新已导入的配置与认证</Checkbox>
    <Text type="secondary">默认保留已有托管凭据，同一来源不会创建重复渠道。勾选后替换新启动使用的配置与认证；已有进程继续使用旧凭据根，名称、启停及角色选择保留。平台 keychain 或不支持的认证格式需在托管根重新登录。</Text>
    {failure && <Alert type="error" title="导入未完成，输入已保留" description={failure} action={<Button size="small" onClick={onReload}>重新读取状态</Button>} />}
  </Form>;
}
