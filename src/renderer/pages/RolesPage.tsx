import { formatDate } from '../log-view';
import { notifyError, useNotifyError } from '../notify';
import { NamedSelect, NamedSwitch, NamedInputNumber } from '../components/NamedControls';
import { useEffect, useId, useRef, useState } from 'react';
import { Plus, Trash2, Zap } from 'lucide-react';
import { Empty } from '@lobehub/ui';
import { Surface } from '@lobehub/ui/dashboard';
import { Button, Input, Modal, Skeleton, Tag, Text } from '@lobehub/ui/base-ui';
import type { HelloResult } from '../../shared/engines';
import { startHello, useHelloRun } from '../hello-runs';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
import { EFFORTS, type Availability, type Owner, type Worker } from '../../main/policy/routing';
import { blankOwner, blankWorker, removeRole, renameRole, roleDeleteImpact, roleIdError, syncRoleEditor, type RoleSection } from '../policy-edit';
import { OwnerScheduleFields } from '../components/OwnerSchedule';
import { PolicyHeader } from '../components/PolicyHeader';
import type { PolicyDraft } from '../usePolicyDraft';
import { styles } from '../style';

const NAMES: Record<RoleSection, string> = { owners: '父 Agent', workers: '子 Agent' };
const DESCRIPTIONS: Record<RoleSection, string> = {
  owners: '父 Agent接收任务并派发给子 Agent。每个引擎最多启用一个父 Agent。',
  workers: '子 Agent执行父 Agent派发的任务包。',
};

/** What the saved policy lets dispatch do with this role right now. */
export function availabilityText(availability: Availability | undefined): string {
  if (!availability) return '尚未保存';
  if (availability.status === 'available') return '可派发';
  if (availability.status === 'disabled') return '已停用';
  if (availability.status === 'engine_disabled') return `引擎未启用`;
  return `已限制：${availability.reason ?? '未说明原因'}${availability.release_at ? `，${formatDate(availability.release_at)} 恢复` : ''}`;
}

/** The one line a list item needs beyond its switch: only states the switch does not already show. */
export function roleNote(availability: Availability | undefined, unsaved: boolean): { text: string; warning?: boolean } | undefined {
  if (unsaved) return { text: availability ? '有未保存的修改' : '尚未保存', warning: true };
  if (availability?.status === 'engine_disabled') return { text: '引擎未启用' };
  if (availability?.status === 'blocked') return { text: availabilityText(availability), warning: true };
  return undefined;
}

export function RolesPage({ section, policy }: { section: RoleSection; policy: PolicyDraft }) {
  const editor = useRef<HTMLDivElement>(null);
  const scrollToEditor = () => { if (window.matchMedia('(max-width: 768px)').matches) requestAnimationFrame(() => editor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); };
  const config = policy.config;
  const ids = Object.keys(config?.[section] ?? {});
  const [selected, setSelected] = useState('');
  const [pendingId, setPendingId] = useState('');
  const [idError, setIdError] = useState('');
  const [askDelete, setAskDelete] = useState(false);
  const [toggling, setToggling] = useState('');
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
  const name = NAMES[section];
  const header = <PolicyHeader title={name} description={DESCRIPTIONS[section]} policy={policy} extra={config && <Button icon={Plus} disabled={policy.busy} onClick={add}>新建{name}</Button>} />;
  if (!config) return <>{header}{policy.loading && <Skeleton.Text animated rows={6} />}</>;
  const record = current ? config[section][current] : undefined;
  const kind = record ? config.engines[record.engine]?.kind : undefined;
  const efforts = kind ? EFFORTS[kind] : undefined;
  function add() {
    if (!config) return;
    const id = uniqueId(section, config);
    policy.setConfig({ ...config, [section]: { ...config[section], [id]: section === 'owners' ? blankOwner(config) : blankWorker(config) } });
    setSelected(id); setPendingId(id); scrollToEditor();
  }
  function update(next: Owner | Worker) { if (!current) return; policy.setConfig({ ...config!, [section]: { ...config![section], [current]: next } }); }
  function acceptId() {
    const error = roleIdError(section, pendingId, config!, current);
    setIdError(error);
    if (error) notifyError(error, '配置 ID 有误');
    if (error || !current || pendingId === current) return;
    policy.setConfig(renameRole(config!, section, current, pendingId));
    setSelected(pendingId);
  }
  /** Saved roles switch immediately on top of the saved policy; a role that was never saved only changes the draft. */
  async function toggle(id: string, enabled: boolean) {
    if (!policy.snapshot?.config[section][id]) { policy.setConfig({ ...config!, [section]: { ...config![section], [id]: { ...config![section][id]!, enabled } } }); return; }
    setToggling(id);
    try { await policy.commit(doc => ({ ...doc, config: { ...doc.config, [section]: { ...doc.config[section], [id]: { ...doc.config[section][id]!, enabled } } } })); }
    catch (error) { notifyError(error, '保存失败'); }
    finally { setToggling(''); }
  }
  const impact = current ? roleDeleteImpact(config, section, current) : undefined;
  return <>
    {header}
    <div className={styles.split}>
      <nav aria-label={`${name}列表`} className={styles.listPane}>
        {!ids.length && <Text type="secondary" className={styles.meta}>还没有{name}。</Text>}
        {ids.map(id => {
          const item = config[section][id]!;
          const engineOn = config.engines[item.engine]?.enabled === true;
          const note = roleNote(policy.snapshot?.[section][id], false);
          return <div key={id} className={styles.roleItem} aria-current={id === current ? 'true' : undefined}>
            <NamedSwitch size="small" aria-label={`启用 ${id}`} checked={item.enabled} loading={toggling === id} disabled={!engineOn || !!toggling} title={engineOn ? undefined : `引擎 ${item.engine || '未选择'} 未启用，先在引擎页打开它`} onChange={checked => void toggle(id, checked)} />
            <button type="button" className={styles.roleButton} style={{ font: 'inherit' }} onClick={() => { acceptId(); setSelected(id); setPendingId(id); setIdError(''); scrollToEditor(); }}>
              <strong className={styles.wrap}>{id}</strong>
              <span className={`${styles.wrap} ${styles.meta}`}>{item.engine} · {item.model || '未填模型'}</span>
              {note && <span className={`${styles.wrap} ${styles.meta} ${note.warning ? styles.warn : ''}`}>{note.text}</span>}
            </button>
          </div>;
        })}
      </nav>
      <div ref={editor} tabIndex={-1}><Surface padded>
        {!record || !current ? <Empty title={`还没有${name}`} description={`新建一个${name}，选择引擎和模型后保存。`} action={<Button icon={Plus} onClick={add}>新建{name}</Button>} /> : <Form form={form} layout="vertical" className={styles.stack}>
          <div className={styles.spread}>
            <Text strong>{name}配置</Text>
            <Button danger size="small" icon={Trash2} disabled={policy.busy} onClick={() => setAskDelete(true)}>删除</Button>
          </div>
          <div className={styles.pair}>
          <Form.Field label="配置 ID" required desc="改名后按 Enter 或离开输入框，引用处一起更新。">
            <Input id={`${fieldId}-id`} aria-label="配置 ID" aria-invalid={!!idError} value={pendingId} placeholder={section === 'workers' ? '例如：research_worker' : '例如：codex_owner'} onChange={event => setPendingId(event.target.value)} onBlur={acceptId} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); acceptId(); } }} />
          </Form.Field>
            <Form.Field label="所属引擎" required><NamedSelect id={`${fieldId}-engine`} aria-label="所属引擎" value={record.engine || undefined} options={Object.keys(config.engines).map(id => ({ value: id, label: `${id}${config.engines[id]?.enabled ? '' : '（未启用）'}` }))} onChange={value => { if (typeof value === 'string') update({ ...record, engine: value, enabled: config.engines[value]?.enabled ? record.enabled : false }); }} /></Form.Field>
          </div>
          <div className={styles.pair}>
            <Form.Field label="模型" required><Input id={`${fieldId}-model`} aria-label="模型" value={record.model} placeholder="例如：gpt-6.1-sol 或 provider/model" onChange={event => update({ ...record, model: event.target.value })} /></Form.Field>
            <Form.Field label="推理强度" required desc={efforts?.length ? undefined : '填写该模型接受的 variant。'}>{efforts?.length ? <NamedSelect id={`${fieldId}-effort`} aria-label="推理强度" value={record.effort} options={efforts.map(value => ({ value, label: value }))} onChange={value => { if (typeof value === 'string') update({ ...record, effort: value }); }} /> : <Input id={`${fieldId}-effort`} aria-label="推理强度" value={record.effort} placeholder="例如：max" onChange={event => update({ ...record, effort: event.target.value })} />}</Form.Field>
          </div>
          {section === 'workers' ? <WorkerFields key={current} id={current} record={record as Worker} update={next => update(next)} /> : <OwnerFields key={current} config={config} blocks={policy.blocks} record={record as Owner} update={next => update(next)} />}
          {impact && <Modal open={askDelete} title={impact.title} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onCancel={() => setAskDelete(false)} onOk={() => { policy.setConfig(removeRole(config, section, current)); setSelected(''); setPendingId(''); setAskDelete(false); }}>
            <Text>{impact.detail}</Text>
          </Modal>}
        </Form>}
      </Surface></div>
    </div>
  </>;
}

function WorkerFields({ id, record, update }: { id: string; record: Worker; update: (next: Worker) => void }) {
  const fieldId = useId();
  return <>
    <Form.Field label="用途说明"><Input id={`${fieldId}-description`} aria-label="用途说明" value={record.description ?? ''} placeholder="例如：负责前端界面与浏览器验收" onChange={event => update({ ...record, description: event.target.value })} /></Form.Field>
    <HelloCheck id={id} record={record} />
  </>;
}

/** Sends one real "say hi" through the route as currently filled in, saved or not. The run outlives this form. */
function HelloCheck({ id, record }: { id: string; record: Worker }) {
  const run = useHelloRun(id);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run?.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.running]);
  const ready = Boolean(record.engine && record.model.trim() && record.effort.trim());
  const elapsed = run?.running ? Math.max(0, Math.floor((now - run.startedAt) / 1000)) : 0;
  return <div className={`${styles.stack} ${styles.divided}`}>
    <div className={styles.spread} style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
      <div className={styles.tight}>
        <Text strong>可用性</Text>
        <Text type="secondary" className={styles.meta}>用当前填写的引擎、模型和推理强度发送一条简短问候，检查能否正常回复。不调用工具，不保存会话，会消耗少量额度。</Text>
      </div>
      <Button icon={Zap} loading={run?.running} disabled={!ready} onClick={() => void startHello(id, { engine: record.engine, model: record.model.trim(), effort: record.effort.trim() }, `${record.engine} · ${record.model.trim()} · ${record.effort.trim()}`)}>连通测试</Button>
    </div>
    {run?.running && <Text type="secondary" className={styles.meta} role="status">正在等待 {run.route.split(' · ')[0]} 回复… {elapsed} 秒</Text>}
    {run?.result && !run.running && <ReplyCard result={{ ...run.result, route: run.route }} />}
  </div>;
}

/** The model's answer as a message card: who answered, what it said, how long it took. */
function ReplyCard({ result }: { result: HelloResult & { route: string } }) {
  useNotifyError(!result.ok ? result.error : '', '探测失败');
  if (!result.ok) return null;
  const seconds = result.durationMs ? `${(result.durationMs / 1000).toFixed(1)} 秒` : '';
  return <article role="status" aria-label="连通测试结果" className={styles.replyCard} data-ok={result.ok ? 'true' : 'false'}>
    <header className={styles.spread} style={{ flexWrap: 'nowrap' }}>
      <span className={styles.row} style={{ flexWrap: 'nowrap', minInlineSize: 0 }}>
        <Tag size="small" color={result.ok ? 'success' : 'error'}>{result.ok ? '可用' : '不可用'}</Tag>
        <Text strong className={styles.wrap}>{result.route}</Text>
      </span>
      <Text type="secondary" className={`${styles.meta} ${styles.numbers}`} style={{ whiteSpace: 'nowrap' }}>{[seconds, formatDate(result.checkedAt)].filter(Boolean).join(' · ')}</Text>
    </header>
    <p className={styles.replyText}>{result.reply}</p>
    {result.model && <Text type="secondary" className={styles.meta}>实际应答模型：{result.model}</Text>}
  </article>;
}

function OwnerFields({ config, blocks, record, update }: { config: NonNullable<PolicyDraft['config']>; blocks: PolicyDraft['blocks']; record: Owner; update: (next: Owner) => void }) {
  return <>
    <Form.Field label="并行上限" required desc="这个父 Agent同时运行的子 Agent数量。"><NamedInputNumber id="owner-parallel" aria-label="并行上限" min={1} step={1} value={record.max_parallel} placeholder="例如：4" onChange={value => update({ ...record, max_parallel: value ?? 1 })} /></Form.Field>
    <OwnerScheduleFields config={config} blocks={blocks} record={record} update={update} />
  </>;
}

function uniqueId(section: RoleSection, config: NonNullable<PolicyDraft['config']>): string {
  const base = section === 'workers' ? 'new_worker' : 'new_owner';
  let id = base;
  let index = 2;
  while (Object.hasOwn(config[section], id) || roleIdError(section, id, config)) { id = section === 'workers' ? `new${index}_worker` : `new${index}_owner`; index += 1; }
  return id;
}
