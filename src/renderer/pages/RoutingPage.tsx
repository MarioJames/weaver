import { NamedSelect, NamedSwitch, NamedInputNumber } from '../components/NamedControls';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Button, Input, Text, TextArea } from '@lobehub/ui/base-ui';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
import type { Block, Owner } from '../../main/policy/routing';
import { acceptPolicyJson, blankBlock } from '../policy-edit';
import type { PolicyDraft } from '../usePolicyDraft';
import { CapabilitiesPanel } from '../components/CapabilitiesPanel';
import { OwnerScheduleFields } from '../components/OwnerSchedule';
import { styles } from '../style';
import { routePreviewReducer } from '../route-preview';

export function RoutingPage({ policy }: { policy: PolicyDraft }) {
  const config = policy.config;
  const [owner, setOwner] = useState('');
  const [cls, setClass] = useState('judgment');
  const [tag, setTag] = useState('');
  const [count, setCount] = useState<number | null>(0);
  const [preview, updatePreview] = useReducer(routePreviewReducer, { key: '', request: 0 });
  const request = useRef(0);
  const [rawConfig, setRawConfig] = useState('');
  const [rawBlocks, setRawBlocks] = useState('');
  const [rawError, setRawError] = useState('');
  const form = useForm();
  const owners = Object.keys(config?.owners ?? {});
  const selectedOwner = owners.includes(owner) ? owner : owners[0] ?? '';
  const previewKey = useMemo(() => JSON.stringify([selectedOwner, cls, tag, count, config, policy.blocks, policy.snapshot?.revision, policy.snapshot?.activeBlocks]), [selectedOwner, cls, tag, count, config, policy.blocks, policy.snapshot?.revision, policy.snapshot?.activeBlocks]);
  useEffect(() => { updatePreview({ type: 'invalidate', key: previewKey }); }, [previewKey]);
  const result = preview.key === previewKey ? preview.result : undefined;
  const previewError = preview.key === previewKey ? preview.error : undefined;
  if (!config || !policy.snapshot) return <div className={styles.page}><Text type="secondary">{policy.loading ? '正在读取策略…' : policy.loadError || '策略还不可用。'}</Text></div>;
  const draftOwner = selectedOwner ? config.owners[selectedOwner] : undefined;
  const savedOwner = Object.hasOwn(policy.snapshot.config.owners, selectedOwner);
  async function applyJson() {
    try {
      const parsedConfig = JSON.parse(rawConfig || JSON.stringify(config)) as unknown;
      const parsedBlocks = JSON.parse(rawBlocks || JSON.stringify(policy.blocks)) as unknown;
      if (!window.weaver) { setRawError('控制面不可用。草稿未改。'); return; }
      const accepted = await acceptPolicyJson(parsedConfig, parsedBlocks, value => window.weaver.validatePolicy(value));
      if (!accepted.ok) { setRawError(accepted.error); return; }
      policy.setConfig(accepted.config);
      policy.setBlocks(accepted.blocks);
      setRawError('');
      setRawConfig('');
      setRawBlocks('');
    } catch (error) { setRawError(error instanceof Error ? error.message : String(error)); }
  }
  function updateOwner(next: Owner) {
    if (!config || !selectedOwner) return;
    policy.setConfig({ ...config, owners: { ...config.owners, [selectedOwner]: next } });
  }
  async function previewRoute() {
    const id = ++request.current;
    const key = previewKey;
    updatePreview({ type: 'request', key, request: id });
    try {
      const result = await policy.preview({ owner: selectedOwner, class: cls, ...(cls === 'judgment' && tag ? { tag } : {}), runningCount: count ?? 0 });
      updatePreview({ type: 'settled', key, request: id, result });
    } catch (error) {
      updatePreview({ type: 'settled', key, request: id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return <div className={styles.page}>
    <Text type="secondary">预览只看已保存版本，不含未保存草稿，也不会启动代理。权重和固定引擎写入草稿，用上方保存后才参与预览。假设运行数只用于容量判断。</Text>
    <Form form={form} layout="vertical" className={styles.grid}>
      <Form.Field label="负责人"><NamedSelect id="routing-owner" aria-label="预览负责人" value={selectedOwner || undefined} options={owners.map(id => ({ value: id, label: id }))} onChange={value => { if (typeof value === 'string') setOwner(value); }} /></Form.Field>
      <Form.Field label="类别"><NamedSelect id="routing-class" aria-label="类别" value={cls} options={[{ value: 'mechanical', label: '机械' }, { value: 'routine', label: '常规' }, { value: 'judgment', label: '判断' }]} onChange={value => { if (typeof value === 'string') setClass(value); }} /></Form.Field>
      <Form.Field label="领域标签" desc="只在判断类时参与选择。"><Input id="routing-tag" aria-label="领域标签" value={tag} disabled={cls !== 'judgment'} placeholder="例如：frontend" onChange={event => setTag(event.target.value)} /></Form.Field>
      <Form.Field label="假设正在运行的工作代理数"><NamedInputNumber id="routing-count" aria-label="假设正在运行的工作代理数" min={0} step={1} value={count} onChange={setCount} /></Form.Field>
      <Form.Field label="等待上限（分钟）"><NamedInputNumber id="routing-wait" aria-label="等待上限（分钟）" min={1} step={1} value={config.herdr.max_wait_minutes} onChange={value => policy.setConfig({ ...config, herdr: { max_wait_minutes: value ?? config.herdr.max_wait_minutes } })} /></Form.Field>
      {draftOwner && <OwnerScheduleFields key={selectedOwner} config={config} record={draftOwner} update={updateOwner} />}
    </Form>
    {!savedOwner && <Text role="status">这个负责人尚未保存，预览不可用。</Text>}
    <Button disabled={!savedOwner || policy.busy} onClick={() => void previewRoute()}>预览已保存路由</Button>
    {previewError && <Text role="alert" type="danger">{previewError.includes('no available worker') ? `没有可派发的工作代理。${previewError}` : previewError.includes('unavailable') || previewError.includes('blocked') ? `当前不能派发。${previewError}` : previewError}</Text>}
    <Text type="secondary">已保存版本 {policy.snapshot.revision} · 生效限制 {policy.snapshot.activeBlocks.length} 项</Text>
    {result && <div className={styles.stack} aria-label="路由预览">
      <Text>已保存路由选中 {result.worker} · 引擎 {result.engine} · 同类优先权重 {result.weight ?? 100}{result.only_engine ? ` · 固定引擎 ${result.only_engine}` : ' · 未固定引擎'}</Text>
      {result.skipped?.length ? <Text className={styles.wrap}>跳过：{result.skipped.map(item => `${item.worker}（${item.reason}）`).join('；')}</Text> : null}
      {!result.capacityAvailable && <Text role="status">容量已满。新的派发会等待，已接受的任务不会被静默改派。</Text>}
      <pre className={styles.clip}>{JSON.stringify(result, null, 2)}</pre>
    </div>}
    <div className={styles.row}><NamedSwitch aria-label="自动审查偏好" checked={config.chatgpt_review !== false} onChange={checked => policy.setConfig({ ...config, chatgpt_review: checked })} /><Text>自动审查偏好。关闭后本应用不会外接审查。</Text></div>
    <Text style={{ fontWeight: 600 }}>配额限制</Text>
    <Text type="secondary">每项需要引擎、原因和开始时间。恢复时间留空表示手动解除。过期项不参与路由。移除后再保存才会生效。</Text>
    {policy.blocks.map((block, index) => {
      if (!block || typeof block.engine !== 'string' || typeof block.reason !== 'string' || typeof block.since !== 'string') return <Text key={index} role="alert" type="danger">第 {index + 1} 条配额格式无效，未显示字段。</Text>;
      return <BlockRow key={index} block={block} engines={Object.keys(config.engines)} onChange={next => policy.setBlocks(policy.blocks.map((item, itemIndex) => itemIndex === index ? next : item))} onRemove={() => policy.setBlocks(policy.blocks.filter((_, itemIndex) => itemIndex !== index))} />;
    })}
    <Button onClick={() => policy.setBlocks([...policy.blocks, blankBlock(Object.keys(config.engines)[0] ?? 'claude')])}>添加限制</Button>
    <details>
      <summary>控制面状态与高级 JSON</summary>
      <CapabilitiesPanel />
      <div className={styles.grid}>
        <TextArea aria-label="策略 JSON" rows={12} value={rawConfig || JSON.stringify(config, null, 2)} spellCheck={false} onChange={event => setRawConfig(event.target.value)} />
        <TextArea aria-label="配额 JSON" rows={12} value={rawBlocks || JSON.stringify(policy.blocks, null, 2)} spellCheck={false} onChange={event => setRawBlocks(event.target.value)} />
      </div>
      <Button onClick={() => void applyJson()}>应用到草稿</Button>
      {rawError && <Text role="alert" type="danger">{rawError}</Text>}
    </details>
  </div>;
}

function BlockRow({ block, engines, onChange, onRemove }: { block: Block; engines: string[]; onChange: (block: Block) => void; onRemove: () => void }) {
  return <div className={styles.grid}>
    <NamedSelect aria-label="限制引擎" value={block.engine} options={engines.map(id => ({ value: id, label: id }))} onChange={value => { if (typeof value === 'string') onChange({ ...block, engine: value }); }} />
    <Input aria-label="限制模型" value={block.model ?? ''} placeholder="留空表示整台引擎" onChange={event => onChange({ ...block, ...(event.target.value ? { model: event.target.value } : { model: undefined }) })} />
    <Input aria-label="限制原因" value={block.reason} placeholder="例如：额度用尽" onChange={event => onChange({ ...block, reason: event.target.value })} />
    <Input aria-label="开始时间" value={block.since} placeholder="2026-10-18T12:00:00+08:00" onChange={event => onChange({ ...block, since: event.target.value })} />
    <Input aria-label="恢复时间" value={block.release_at ?? ''} placeholder="留空表示手动解除" onChange={event => onChange({ ...block, ...(event.target.value ? { release_at: event.target.value } : { release_at: undefined }) })} />
    <Button danger onClick={onRemove}>移除</Button>
  </div>;
}
