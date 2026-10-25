import { dateText } from '../quota/quota-view';
import { blockOf, blockText, pauseOfBlock } from '../probes/probe-view';
import { useFreeProbe } from '../probes/useFreeProbe';
import { FreeProbePanel } from '../probes/FreeProbePanel';
import { TimeText } from '../../ui/TimeText';
import { notifyError, useNotifyError } from '../../api/notify';
import { NamedSelect, NamedSwitch, NamedInputNumber } from '../../ui/NamedControls';
import { useEffect, useId, useRef, useState } from 'react';
import { GripVertical, Play, Plus, Trash2, Zap } from 'lucide-react';
import { Empty, SortableList } from '@lobehub/ui';
import { Surface } from '@lobehub/ui/dashboard';
import { Alert, Button, Checkbox, Input, Modal, Skeleton, Tag, Text } from '@lobehub/ui/base-ui';
import type { HelloResult } from '../../../shared/engines';
import { startHello, useHelloRun } from '../engines/hello-runs';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
import { EFFORTS } from '../../../shared/policy/settings';
import { type Availability, type Block, type Owner, type Worker } from '../../../shared/contracts/policy';
import { blankOwner, blankWorker, deleteRole, fieldErrorText, renameRole, reorderRoles, roleDeleteImpact, roleIdError, syncRoleEditor, withWorkerParallel, workerParallelText, type RoleSection } from '../../policy/policy-edit';
import { OwnerScheduleFields } from './OwnerSchedule';
import { ModelPicker } from '../engines/ModelPicker';
import { engineBlockText, removeBlock, resumeAction, resumeWorker } from '../../policy/worker-resume';
import { FreeChannelTag } from '../../ui/FreeChannelTag';
import { statusTagColor, tagColor } from '../../format/tag-colors';
import { PolicyHeader } from '../../policy/PolicyHeader';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { styles } from '../../ui/styles';
import { rolesStyles } from './roles-style';

const NAMES: Record<RoleSection, string> = { owners: '父 Agent', workers: '子 Agent' };
const DESCRIPTIONS: Record<RoleSection, string> = {
  owners: '父 Agent 接收任务并派发给子 Agent。可以为同一引擎配置不同账号的父 Agent。',
  workers: '子 Agent 执行父 Agent 派发的任务包。',
};

/** What the saved policy lets dispatch do with this role right now. */
export function availabilityText(availability: Availability | undefined): string {
  if (!availability) return '尚未保存';
  if (availability.status === 'available') return '可派发';
  if (availability.status === 'disabled') return '已停用';
  if (availability.status === 'channel_disabled') return '渠道未启用';
  return `已限制：${availability.reason ?? '未说明原因'}${availability.release_at ? `，${dateText(availability.release_at)} 恢复` : ''}`;
}

/** The one line a list item needs beyond its switch: only states the switch does not already show. A pause written by the penalty ladders or the free probe also names its kind as a tag. Tag colors come from the shared semantic scheme. */
export function roleNote(availability: Availability | undefined, unsaved: boolean, block?: Block): { text: string; warning?: boolean; tag?: { label: string; color?: string } } | undefined {
  if (unsaved) return { text: availability ? '有未保存的修改' : '尚未保存', warning: true };
  if (availability?.status === 'channel_disabled') return { text: '渠道未启用' };
  if (availability?.status === 'blocked') {
    const pause = pauseOfBlock(block);
    if (pause && block) return { text: blockText(block), warning: true, tag: { label: pause.label, color: statusTagColor(pause.tone) } };
    return { text: availabilityText(availability), warning: true };
  }
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
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [deleteError, setDeleteError] = useState('');
  const [toggling, setToggling] = useState('');
  const [resuming, setResuming] = useState('');
  const form = useForm();
  const fieldId = useId();
  const freeProbe = useFreeProbe(policy.snapshot?.revision);
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
  const kind = record ? config.engines[config.channels[record.channel]?.engine ?? '']?.kind : undefined;
  const efforts = kind ? EFFORTS[kind] : undefined;
  function add() {
    if (!config) return;
    const id = uniqueId(section, config, policy.snapshot?.config);
    policy.setConfig({ ...config, [section]: { ...config[section], [id]: section === 'owners' ? blankOwner(config) : blankWorker(config) } });
    setSelected(id); setPendingId(id); scrollToEditor();
  }
  function update(next: Owner | Worker) { if (!current) return; policy.setConfig({ ...config!, [section]: { ...config![section], [current]: next } }); }
  function acceptId() {
    const error = pendingId !== current && Object.hasOwn(policy.snapshot?.config[section] ?? {}, pendingId)
      ? '这个 ID 仍属于已保存的角色。请先保存或放弃已有改名，再使用这个 ID。'
      : roleIdError(section, pendingId, config!, current);
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
  async function confirmDelete() {
    if (deletingRef.current || policy.busy || !current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteRole(policy, section, current);
      setAskDelete(false);
      setSelected('');
      setPendingId('');
    } catch (error) {
      setDeleteError(fieldErrorText(error));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }
  /**
   * 「恢复派发」 for one worker: the shown ban decides the call (see resumeAction). The worker's own ban is lifted by the server
   * together with the whole-engine ban that depended on it; a ban that reaches it through its engine or model is removed from the saved policy.
   */
  async function resume(id: string, target: Block) {
    if (resuming) return;
    setResuming(id);
    try {
      if (resumeAction(policy.snapshot?.blocks ?? [], id, target) === 'unblock') await resumeWorker(id, policy);
      else {
        try { await policy.commit(doc => ({ ...doc, blocks: removeBlock(doc.blocks, target) })); }
        catch (error) { notifyError(error, '恢复派发失败'); }
      }
    } finally { setResuming(''); }
  }
  const impactConfig = policy.snapshot?.config[section][current] ? policy.snapshot.config : config;
  const impact = current ? roleDeleteImpact(impactConfig, section, current) : undefined;
  const savedWorker = section === 'workers' && current ? policy.snapshot?.config.workers[current] : undefined;
  const pausedBy = savedWorker && current && policy.snapshot ? blockOf(policy.snapshot.blocks, savedWorker, Date.now(), current, policy.snapshot.config) : undefined;
  const canSort = ids.length > 1 && !policy.busy && !toggling && !resuming;
  return <>
    {header}
    <div className={rolesStyles.split}>
      <nav aria-label={`${name} 列表`} className={rolesStyles.listPane}>
        {!ids.length && <Text type="secondary" className={styles.meta}>还没有{name}。</Text>}
        {ids.length > 1 && <Text type="secondary" className={styles.meta}>拖动左侧手柄调整顺序，保存后生效。</Text>}
        {!!ids.length && <SortableList
          className={rolesStyles.sortList}
          items={ids.map(id => ({ id }))}
          onChange={items => { if (canSort) policy.setConfig(current => current ? reorderRoles(current, section, items.map(item => item.id)) : current); }}
          renderItem={({ id }) => {
            const item = config[section][id]!;
            const channelOn = config.channels[item.channel]?.enabled === true;
            const saved = policy.snapshot?.config[section][id];
            const cap = section === 'workers' ? workerParallelText(item as Worker) : undefined;
            const hit = policy.snapshot && saved ? blockOf(policy.snapshot.blocks, saved, Date.now(), section === 'workers' ? id : undefined, policy.snapshot.config) : undefined;
            const note = roleNote(policy.snapshot?.[section][id], false, hit);
            return <SortableList.Item id={id} align="flex-start" className={rolesStyles.sortItem}>
              {ids.length > 1 && (canSort
                ? <SortableList.DragHandle className={rolesStyles.roleGrip} aria-label={`拖动排序 ${id}`} size={{ blockSize: 44, borderRadius: 8, size: 16 }} style={{ touchAction: 'none' }} />
                : <span className={rolesStyles.roleGripOff} aria-hidden="true"><GripVertical size={16} /></span>)}
              <div className={rolesStyles.roleItem} aria-current={id === current ? 'true' : undefined}>
                <NamedSwitch size="small" aria-label={`启用 ${id}`} checked={item.enabled} loading={toggling === id} disabled={!channelOn || !!toggling} title={channelOn ? undefined : '账号或渠道未启用，请在账号与渠道页检查'} onChange={checked => void toggle(id, checked)} />
                <button type="button" className={rolesStyles.roleButton} style={{ font: 'inherit' }} onClick={() => { acceptId(); setSelected(id); setPendingId(id); setIdError(''); scrollToEditor(); }}>
                  <span className={rolesStyles.roleTitle}>
                    <strong className={styles.wrap}>{id}</strong>
                    {section === 'workers' && 'free_channel' in item && item.free_channel === true && <FreeChannelTag />}
                  </span>
                  <span className={rolesStyles.roleNote}>
                    <span className={`${styles.wrap} ${styles.meta}`}>{config.channels[item.channel]?.label ?? item.channel} · {item.model || '未填模型'}</span>
                    {cap && <Tag size="small" color={tagColor('neutral')}>{cap}</Tag>}
                  </span>
                  {note && (note.tag
                    ? <span className={rolesStyles.roleNote}><Tag size="small" color={note.tag.color}>{note.tag.label}</Tag><span className={`${styles.wrap} ${styles.meta} ${rolesStyles.warn}`}>{note.text}</span></span>
                    : <span className={`${styles.wrap} ${styles.meta} ${note.warning ? rolesStyles.warn : ''}`}>{note.text}</span>)}
                </button>
                {section === 'workers' && hit && <Button size="small" type="text" icon={Play} className={rolesStyles.roleResume} aria-label={`恢复派发 ${id}`} loading={resuming === id} disabled={policy.busy || (!!resuming && resuming !== id)} onClick={() => void resume(id, hit)}>恢复派发</Button>}
              </div>
            </SortableList.Item>;
          }}
          renderOverlay={({ id }) => {
            const item = config[section][id];
            return <div className={rolesStyles.roleOverlay}>
              <strong className={styles.wrap}>{id}</strong>
              <span className={`${styles.wrap} ${styles.meta}`}>{item ? `${config.channels[item.channel]?.label ?? item.channel} · ${item.model || '未填模型'}` : ''}</span>
            </div>;
          }}
        />}
      </nav>
      <div ref={editor} tabIndex={-1}><Surface padded>
        {!record || !current ? <Empty title={`还没有${name}`} description={`新建一个${name}，选择渠道和模型后保存。`} action={<Button icon={Plus} onClick={add}>新建{name}</Button>} /> : <Form form={form} layout="vertical" className={styles.stack}>
          {pausedBy && current && <WorkerBlockNotice block={pausedBy} busy={resuming === current} disabled={policy.busy || (!!resuming && resuming !== current)} onResume={() => void resume(current, pausedBy)} />}
          <div className={styles.spread}>
            <Text strong>{name} 配置</Text>
            <Button danger size="small" icon={Trash2} disabled={policy.busy || deleting} onClick={() => { setDeleteError(''); setAskDelete(true); }}>删除</Button>
          </div>
          <div className={rolesStyles.pair}>
          <Form.Field label="配置 ID" required desc="改名后按 Enter 或离开输入框，引用处一起更新。">
            <Input id={`${fieldId}-id`} aria-label="配置 ID" aria-invalid={!!idError} value={pendingId} placeholder={section === 'workers' ? '例如：research' : '例如：codex'} onChange={event => setPendingId(event.target.value)} onBlur={acceptId} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); acceptId(); } }} />
          </Form.Field>
            <Form.Field label="账号或渠道" required extra={config.channels[record.channel] ? `执行引擎：${config.channels[record.channel]!.engine}` : '渠道不存在，请重新选择；可在账号与渠道页添加。'}><NamedSelect id={`${fieldId}-channel`} aria-label="账号或渠道" value={record.channel || undefined} options={Object.entries(config.channels).map(([id, channel]) => ({ value: id, label: `${channel.label} · ${channel.engine}${channel.enabled ? '' : '（渠道停用）'}` }))} onChange={value => { if (typeof value !== 'string') return; const channel = config.channels[value]!; const supported = EFFORTS[config.engines[channel.engine]?.kind ?? '']; update({ ...record, channel: value, model: value === record.channel ? record.model : '', effort: supported?.includes(record.effort) === false ? supported[0]! : record.effort, enabled: channel.enabled ? record.enabled : false }); }} /></Form.Field>
          </div>
          <div className={rolesStyles.pair} style={{ alignItems: 'start' }}>
            <Form.Field label="模型" required><ModelPicker kind={kind} channel={record.channel} engine={config.channels[record.channel]?.engine ?? ''} id={`${fieldId}-model`} value={record.model} onChange={model => update({ ...record, model })} /></Form.Field>
            <Form.Field label="推理强度" required><EffortPicker id={`${fieldId}-effort`} efforts={efforts} value={record.effort} onChange={effort => update({ ...record, effort })} /></Form.Field>
          </div>
          {section === 'owners' && <HelloCheck id={`owners:${current}`} record={record} engine={config.channels[record.channel]?.engine ?? ''} />}
          {section === 'workers' ? <WorkerFields key={current} id={current} record={record as Worker} engine={config.channels[record.channel]?.engine ?? ''} probe={freeProbe} update={next => update(next)} /> : <OwnerFields key={current} savedRecord={policy.snapshot?.config.owners[current]} config={config} blocks={policy.blocks} record={record as Owner} update={next => update(next)} />}
          {impact && <Modal open={askDelete} title={impact.title} okText={deleteError ? '重试删除' : '删除'} cancelText="取消" confirmLoading={deleting} okButtonProps={{ danger: true, disabled: deleting || policy.busy }} cancelButtonProps={{ disabled: deleting }} closable={!deleting} maskClosable={!deleting} keyboard={!deleting} onCancel={() => { if (!deletingRef.current) setAskDelete(false); }} onOk={() => void confirmDelete()}>
            <Text>{policy.snapshot?.config[section][current] ? impact.detail : '这条角色尚未保存，确认后只从本地草稿移除，并清理引用。取消不改草稿。'}</Text>
            {deleteError && <div role="alert"><Text type="danger">删除失败：{deleteError}</Text></div>}
          </Modal>}
        </Form>}
      </Surface></div>
    </div>
  </>;
}

/** The effort control with its hint below the input, mirroring the model field's hint placement so paired columns keep their inputs top aligned. */
function EffortPicker({ efforts, id, value, onChange }: { efforts?: string[]; id: string; value: string; onChange: (effort: string) => void }) {
  return <div className={styles.tight}>
    {efforts?.length
      ? <NamedSelect id={id} aria-label="推理强度" value={value} options={efforts.map(option => ({ value: option, label: option }))} onChange={option => { if (typeof option === 'string') onChange(option); }} />
      : <Input id={id} aria-label="推理强度" value={value} placeholder="例如：max" onChange={event => onChange(event.target.value)} />}
    {!efforts?.length && <Text type="secondary" className={styles.meta}>填写该模型接受的 variant。</Text>}
  </div>;
}

function WorkerFields({ id, record, engine, probe, update }: { id: string; record: Worker; engine: string; probe: ReturnType<typeof useFreeProbe>; update: (next: Worker) => void }) {
  const fieldId = useId();
  return <>
    <Form.Field label="免费渠道" desc="仅跳过原生账户额度暂停；手动暂停、供应商限流仍生效。调度权重由父 Agent 分别设置。"><Checkbox checked={record.free_channel === true} onChange={checked => update({ ...record, free_channel: checked === true })}>此子 Agent 使用免费渠道</Checkbox></Form.Field>
    <Form.Field label="用途说明"><Input id={`${fieldId}-description`} aria-label="用途说明" value={record.description ?? ''} placeholder="例如：负责前端界面与浏览器验收" onChange={event => update({ ...record, description: event.target.value })} /></Form.Field>
    {record.free_channel === true && <FreeProbePanel worker={id} probe={probe} />}
    <WorkerParallelField record={record} update={update} />
    <HelloCheck id={id} record={record} engine={engine} />
  </>;
}

/** Off means no cap and removes the key; on stores the 1–100 limit on tasks this worker runs at once across every parent Agent. */
export function WorkerParallelField({ record, update }: { record: Worker; update: (next: Worker) => void }) {
  const on = record.max_parallel !== undefined;
  return <Form.Field label="并发上限" desc="同一时间最多运行几个任务，超出的任务排队等待；用于避免供应商限流。">
    <div className={styles.row} style={{ flexWrap: 'nowrap' }}>
      <NamedSwitch size="small" aria-label="限制同时运行的任务数" checked={on} onChange={checked => update(withWorkerParallel(record, checked, record.max_parallel))} />
      <Text>限制同时运行的任务数</Text>
      {on && <NamedInputNumber aria-label="并发上限" size="small" min={1} max={100} step={1} precision={0} value={record.max_parallel} style={{ inlineSize: 88 }} onChange={value => update(withWorkerParallel(record, true, typeof value === 'number' ? value : undefined))} />}
    </div>
  </Form.Field>;
}

/** Why dispatch skips this worker right now, with the one button that lifts it. The ban is read from the saved policy, so the notice never shows an unsaved draft. */
export function WorkerBlockNotice({ block, now = Date.now(), busy, disabled, onResume }: { block: Block; now?: number; busy?: boolean; disabled?: boolean; onResume: () => void }) {
  const text = engineBlockText(block, now);
  const scope = block.channel ? `（作用于渠道 ${block.channel}）` : block.worker ? '' : block.model ? `（作用于引擎 ${block.engine} 的模型 ${block.model}）` : `（作用于整个引擎 ${block.engine}，恢复后该引擎的所有子 Agent 都会恢复）`;
  return <Alert type="warning" title={`已暂停派发 · ${text.category}`} description={`${text.reason}；${text.release}${scope}`}
    style={{ marginBlockEnd: 12 }} action={<Button size="small" icon={Play} aria-label="恢复派发" loading={busy} disabled={disabled} onClick={onResume}>恢复派发</Button>} />;
}

/** Sends one real "say hi" through the route as currently filled in, saved or not. The run outlives this form. */
export function HelloCheck({ id, record, engine }: { id: string; record: Pick<Worker, 'channel' | 'model' | 'effort'>; engine: string }) {
  const run = useHelloRun(id);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run?.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.running]);
  const ready = Boolean(record.channel && engine && record.model.trim() && record.effort.trim());
  const elapsed = run?.running ? Math.max(0, Math.floor((now - run.startedAt) / 1000)) : 0;
  return <div className={`${styles.stack} ${styles.divided}`}>
    <div className={styles.spread} style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
      <div className={styles.tight}>
        <Text strong>可用性</Text>
        <Text type="secondary" className={styles.meta}>用当前填写的渠道、模型和推理强度发送一条简短问候，检查能否正常回复。不调用工具，不保存会话，会消耗少量额度。</Text>
      </div>
      <Button icon={Zap} loading={run?.running} disabled={!ready} onClick={() => void startHello(id, { channel: record.channel, engine, model: record.model.trim(), effort: record.effort.trim() }, `${record.channel} · ${record.model.trim()} · ${record.effort.trim()}`)}>连通测试</Button>
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
  return <article role="status" aria-label="连通测试结果" className={rolesStyles.replyCard} data-ok={result.ok ? 'true' : 'false'}>
    <header className={styles.spread} style={{ flexWrap: 'nowrap' }}>
      <span className={styles.row} style={{ flexWrap: 'nowrap', minInlineSize: 0 }}>
        <Tag size="small" color={result.ok ? tagColor('success') : tagColor('error')}>{result.ok ? '可用' : '不可用'}</Tag>
        <Text strong className={styles.wrap}>{result.route}</Text>
      </span>
      <Text type="secondary" className={`${styles.meta} ${styles.numbers}`} style={{ whiteSpace: 'nowrap' }}>{seconds && `${seconds} · `}<TimeText value={result.checkedAt} /></Text>
    </header>
    <p className={rolesStyles.replyText}>{result.reply}</p>
    {result.model && <Text type="secondary" className={styles.meta}>实际应答模型：{result.model}</Text>}
  </article>;
}

function OwnerFields({ config, blocks, record, savedRecord, update }: { config: NonNullable<PolicyDraft['config']>; blocks: PolicyDraft['blocks']; record: Owner; savedRecord?: Owner; update: (next: Owner) => void }) {
  return <>
    <Form.Field label="并行上限" required desc="这个父 Agent 同时运行的子 Agent 数量。"><NamedInputNumber id="owner-parallel" aria-label="并行上限" min={1} step={1} value={record.max_parallel} placeholder="例如：4" onChange={value => update({ ...record, max_parallel: value ?? 1 })} /></Form.Field>
    <OwnerScheduleFields config={config} blocks={blocks} record={record} savedRecord={savedRecord} update={update} />
  </>;
}

function uniqueId(section: RoleSection, config: NonNullable<PolicyDraft['config']>, saved?: NonNullable<PolicyDraft['config']>): string {
  let id = 'new';
  let index = 2;
  while (Object.hasOwn(config[section], id) || Object.hasOwn(saved?.[section] ?? {}, id) || roleIdError(section, id, config)) { id = `new${index}`; index += 1; }
  return id;
}
