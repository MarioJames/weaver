import { NamedSelect, NamedSwitch, NamedInputNumber } from '../components/NamedControls';
import { useEffect, useId, useState } from 'react';
import { Button, Input, Modal, Text } from '@lobehub/ui/base-ui';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
import { EFFORTS, type Owner, type Worker } from '../../main/policy/routing';
import { blankOwner, blankWorker, removeRole, renameRole, roleDeleteImpact, roleIdError, syncRoleEditor, tagChoices, type RoleSection } from '../policy-edit';
import { OwnerScheduleFields } from '../components/OwnerSchedule';
import type { PolicyDraft } from '../usePolicyDraft';
import { styles } from '../style';

export function RolesPage({ section, policy }: { section: RoleSection; policy: PolicyDraft }) {
  const config = policy.config;
  const ids = Object.keys(config?.[section] ?? {});
  const [selected, setSelected] = useState('');
  const [pendingId, setPendingId] = useState('');
  const [idError, setIdError] = useState('');
  const [askDelete, setAskDelete] = useState(false);
  const form = useForm();
  const fieldId = useId();
  const current = syncRoleEditor(ids, selected).selected;
  useEffect(() => {
    const next = syncRoleEditor(ids, selected);
    setSelected(next.selected);
    setPendingId(next.pendingId);
    setIdError('');
    setAskDelete(false);
  }, [section, current]);
  if (!config) return <div className={styles.page}><Text type="secondary">{policy.loading ? '正在读取策略…' : '策略还不可用。'}</Text></div>;
  const record = current ? config[section][current] : undefined;
  const kind = record ? config.engines[record.engine]?.kind : undefined;
  const efforts = kind ? EFFORTS[kind] : undefined;
  function update(next: Owner | Worker) { if (!current) return; policy.setConfig({ ...config!, [section]: { ...config![section], [current]: next } }); }
  function acceptId() {
    const error = roleIdError(section, pendingId, config!, current);
    setIdError(error);
    if (error || !current || pendingId === current) return;
    policy.setConfig(renameRole(config!, section, current, pendingId));
    setSelected(pendingId);
  }
  const impact = current ? roleDeleteImpact(config, section, current) : undefined;
  return <div className={styles.split}>
    <div className={styles.column}>
      <Button disabled={policy.busy} onClick={() => { const id = uniqueId(section, config); policy.setConfig({ ...config, [section]: { ...config[section], [id]: section === 'owners' ? blankOwner(config) : blankWorker(config) } }); setSelected(id); setPendingId(id); }}>新建{section === 'owners' ? '负责人' : '工作代理'}</Button>
      {!ids.length && <Text type="secondary">还没有{section === 'owners' ? '负责人' : '工作代理'}。启用引擎不会自动创建。</Text>}
      {ids.map(id => {
        const item = config[section][id];
        const availability = policy.snapshot?.[section][id]?.status;
        return <button key={id} type="button" className={styles.item} aria-current={id === current ? 'true' : undefined} onClick={() => { acceptId(); setSelected(id); setPendingId(id); setIdError(''); }}>
          <span className={styles.spread}><strong className={styles.wrap}>{id}</strong><Text type="secondary">{item.enabled ? '草稿启用' : '草稿停用'}</Text></span>
          <Text type="secondary" className={styles.wrap}>{item.engine} · {item.model || '模型为空'} · 已保存 {availability ?? '新记录'}</Text>
        </button>;
      })}
    </div>
    <div className={styles.column}>
      {!record || !current ? <Text type="secondary">选择一条角色配置。启用引擎不会写入这里。</Text> : <Form form={form} layout="vertical" className={styles.stack}>
        <Form.Field label="配置 ID" required desc="离开输入框或按 Enter 后同步引用。" extra={idError && <p id={`${fieldId}-id-error`} role="alert" className={styles.error}>{idError}</p>}>
          <Input id={`${fieldId}-id`} aria-label="配置 ID" aria-invalid={!!idError} aria-describedby={idError ? `${fieldId}-id-error` : undefined} value={pendingId} placeholder={section === 'workers' ? '例如：research_worker' : '例如：codex_owner'} onChange={event => setPendingId(event.target.value)} onBlur={acceptId} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); acceptId(); } }} />
        </Form.Field>
        <div className={styles.row}>
          <NamedSwitch aria-label="启用此角色" checked={record.enabled} disabled={!config.engines[record.engine]?.enabled} onChange={checked => update({ ...record, enabled: checked })} />
          <Text>{config.engines[record.engine]?.enabled ? '启用此角色。这不会立刻派发。' : `引擎 ${record.engine || '未选择'} 未启用。先在引擎页启用它，再启用角色。`}</Text>
        </div>
        <div className={styles.grid}>
          <Form.Field label="所属引擎" required><NamedSelect id={`${fieldId}-engine`} aria-label="所属引擎" value={record.engine || undefined} options={Object.keys(config.engines).map(id => ({ value: id, label: `${id}${config.engines[id]?.enabled ? '' : ' · 未启用'}` }))} onChange={value => { if (typeof value === 'string') update({ ...record, engine: value, enabled: config.engines[value]?.enabled ? record.enabled : false }); }} /></Form.Field>
          <Form.Field label="模型" required><Input id={`${fieldId}-model`} aria-label="模型" value={record.model} placeholder="例如：gpt-6.1-sol 或 provider/model" onChange={event => update({ ...record, model: event.target.value })} /></Form.Field>
          <Form.Field label="推理强度" required desc={efforts?.length ? `该引擎允许：${efforts.join('、')}` : '填写该模型接受的非空 variant。'}>{efforts?.length ? <NamedSelect id={`${fieldId}-effort`} aria-label="推理强度" value={record.effort} options={efforts.map(value => ({ value, label: value }))} onChange={value => { if (typeof value === 'string') update({ ...record, effort: value }); }} /> : <Input id={`${fieldId}-effort`} aria-label="推理强度" value={record.effort} placeholder="例如：max" onChange={event => update({ ...record, effort: event.target.value })} />}</Form.Field>
        </div>
        {section === 'workers' ? <WorkerFields record={record as Worker} update={next => update(next)} /> : <OwnerFields key={current} config={config} record={record as Owner} update={next => update(next)} />}
        <div className={styles.row}>
          <Button danger disabled={policy.busy} onClick={() => setAskDelete(true)}>删除此配置</Button>
          <Text type="secondary">删除前会说明影响。取消不改草稿，保存前仍会做完整校验。</Text>
        </div>
        {impact && <Modal open={askDelete} title={impact.title} okText="从草稿删除" cancelText="取消" okButtonProps={{ danger: true }} onCancel={() => setAskDelete(false)} onOk={() => { policy.setConfig(removeRole(config, section, current)); setSelected(''); setPendingId(''); setAskDelete(false); }}>
          <Text>{impact.detail}</Text>
        </Modal>}
      </Form>}
    </div>
  </div>;
}

function WorkerFields({ record, update }: { record: Worker; update: (next: Worker) => void }) {
  const fieldId = useId();
  return <>
    <Form.Field label="用途说明"><Input id={`${fieldId}-description`} aria-label="用途说明" value={record.description ?? ''} placeholder="例如：负责前端界面与浏览器验收" onChange={event => update({ ...record, description: event.target.value })} /></Form.Field>
    <Form.Field label="能力标签" desc="mechanical 与 routine 是类别标签，同一代理只能有其中一个。"><NamedSelect aria-label="能力标签" mode="tags" value={record.tags ?? []} options={tagChoices(record.tags).map(value => ({ value, label: value }))} placeholder="例如：frontend" tokenSeparators={[',']} onChange={value => update({ ...record, tags: Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] })} /></Form.Field>
  </>;
}

function OwnerFields({ config, record, update }: { config: NonNullable<PolicyDraft['config']>; record: Owner; update: (next: Owner) => void }) {
  return <>
    <Form.Field label="并行上限" required><NamedInputNumber id="owner-parallel" aria-label="并行上限" min={1} step={1} value={record.max_parallel} placeholder="例如：4" onChange={value => update({ ...record, max_parallel: value ?? 1 })} /></Form.Field>
    <OwnerScheduleFields config={config} record={record} update={update} />
  </>;
}

function uniqueId(section: RoleSection, config: NonNullable<PolicyDraft['config']>): string {
  const base = section === 'workers' ? 'new_worker' : 'new_owner';
  let id = base;
  let index = 2;
  while (Object.hasOwn(config[section], id) || roleIdError(section, id, config)) { id = section === 'workers' ? `new${index}_worker` : `new${index}_owner`; index += 1; }
  return id;
}
