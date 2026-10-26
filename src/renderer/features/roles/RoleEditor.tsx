import { useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Plus, Play, Trash2 } from 'lucide-react';
import { Alert, Button, Checkbox, Empty, Input, Modal, Text } from '@lobehub/ui';
import { Field } from '@base-ui/react/field';
import { Form, useForm } from '@lobehub/ui/form';
import { activeBlocks, channelAvailabilityOf } from '../../../shared/policy/availability';
import { roleChannels } from '../../../shared/policy/channels';
import { EFFORTS } from '../../../shared/policy/settings';
import type { Block, Owner, Worker } from '../../../shared/contracts/policy';
import { withWorkerChannels, withWorkerParallel, workerChannelsError, workerParallelText, roleDeleteImpact } from '../../policy/policy-edit';
import { engineBlockText } from '../../policy/worker-resume';
import { notifyError } from '../../api/notify';
import { NamedInputNumber, NamedSelect, NamedSwitch } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { FreeChannelTag } from '../../ui/FreeChannelTag';
import { ModelPicker } from '../engines/ModelPicker';
import { useFreeProbe } from '../probes/useFreeProbe';
import { blockOf } from '../probes/probe-view';
import { FreeProbePanel } from '../probes/FreeProbePanel';
import { OwnerScheduleFields } from './OwnerSchedule';
import { HelloCheck } from './HelloCheck';
import { channelOptions, NAMES, ownerUsersOf, roleChannelNames, availabilityText } from './roles-view';
import type { RoleEditorState } from './use-role-editor';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import type { RoleSection } from '../../policy/policy-edit';
import { rolesStyles } from './roles-style';

/** The right pane of a roles page: the selected record's form, or the empty state inviting the first one. */
export function RoleEditor({ section, policy, current, editor, freeProbe, onAdd }: { section: RoleSection; policy: PolicyDraft; current: string; editor: RoleEditorState; freeProbe: ReturnType<typeof useFreeProbe>; onAdd: () => void }) {
  const form = useForm();
  const fieldId = useId();
  const config = policy.config;
  if (!config) return null;
  const name = NAMES[section];
  const record = current ? config[section][current] : undefined;
  if (!record || !current) return <Empty title={`还没有${name}`} description={`新建一个${name}，选择渠道和模型后保存。`} action={<Button icon={Plus} onClick={onAdd}>新建{name}</Button>} />;
  const members = roleChannels(record);
  const diagnosticKey = `${section}:${current}`;
  const diagnostic = members.length === 1 ? members[0]! : members.includes(editor.diagnostics[diagnosticKey] ?? '') ? editor.diagnostics[diagnosticKey]! : '';
  const diagnosticEngine = config.channels[diagnostic]?.engine ?? '';
  const kind = config.engines[diagnosticEngine]?.kind;
  const poolError = 'channels' in record ? workerChannelsError(config, record) : '';
  const efforts = kind ? EFFORTS[kind] : undefined;
  function update(next: Owner | Worker) { policy.setConfig({ ...config!, [section]: { ...config![section], [current]: next } }); }
  const impactConfig = policy.snapshot?.config[section][current] ? policy.snapshot.config : config;
  const impact = roleDeleteImpact(impactConfig, section, current);
  const savedWorker = section === 'workers' ? policy.snapshot?.config.workers[current] : undefined;
  const pausedBy = savedWorker && policy.snapshot ? blockOf(policy.snapshot.blocks, savedWorker, Date.now(), current, policy.snapshot.config) : undefined;
  const referringOwners = section === 'workers' ? ownerUsersOf(config, current) : undefined;
  return <Form form={form} layout="vertical" {...stylex.props(styles.stack)}>
    {pausedBy && <WorkerBlockNotice block={pausedBy} busy={editor.resuming === current} disabled={policy.busy || (!!editor.resuming && editor.resuming !== current)} onResume={() => void editor.resume(current, pausedBy)} />}
    <div {...stylex.props(styles.spread)}>
      <Text strong>{name} 配置</Text>
      <Button danger size="small" icon={Trash2} disabled={policy.busy || editor.deleting} onClick={() => { editor.setDeleteError(''); editor.setAskDelete(true); }}>删除</Button>
    </div>
    {referringOwners && <Text type="secondary" {...stylex.props(styles.meta)}>被父 Agent 引用：{referringOwners.join('、') || '暂无'}</Text>}
    <div {...stylex.props(rolesStyles.pair)}>
      <Form.Field label="配置 ID" required desc="改名后按 Enter 或离开输入框，引用处一起更新。">
        <Input id={`${fieldId}-id`} aria-label="配置 ID" aria-invalid={!!editor.idError} value={editor.pendingId} placeholder={section === 'workers' ? '例如：research' : '例如：codex'} onChange={event => editor.setPendingId(event.target.value)} onBlur={editor.acceptId} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); editor.acceptId(); } }} />
      </Form.Field>
      <Field.Root invalid={!!poolError}>
        <Form.Field label="账号或渠道" required extra={<>{poolError && <Field.Error id={`${fieldId}-channel-error`} match render={<Text type="danger" role="alert" />}>{poolError}</Field.Error>}{section === 'workers' ? '每次派发从有可用额度的账号中随机选择；没有新鲜可用额度时不派发。多账号仅支持同一引擎 ID 的官方订阅池：Codex、Claude、Grok，或 OpenCode 的 opencode-go/模型。API、免费渠道及无额度接口的引擎只支持单账号。' : '选择父 Agent 使用的一个账号。'}</>}>
          <NamedSelect id={`${fieldId}-channel`} aria-label="账号或渠道" mode={section === 'workers' ? 'multiple' : undefined} value={'channels' in record ? record.channels : (record as Owner).channel || undefined} options={channelOptions(config)} onChange={value => {
            if ('channels' in record) {
              const channels = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
              const next = withWorkerChannels(config, record, channels);
              const error = workerChannelsError(config, next);
              if (error && channels.some(id => !record.channels.includes(id))) { notifyError(error, '无法添加账号'); return; }
              update(next);
            } else if (typeof value === 'string') {
              const channel = config.channels[value]!;
              const supported = EFFORTS[config.engines[channel.engine]?.kind ?? ''];
              update({ ...record, channel: value, model: value === record.channel ? record.model : '', effort: supported?.includes(record.effort) === false ? supported[0]! : record.effort, enabled: channel.enabled ? record.enabled : false });
            }
          }} />
        </Form.Field>
      </Field.Root>
    </div>
    {section === 'workers' && <div {...stylex.props(styles.tight)} aria-label="成员账号状态">{members.map(channel => {
      const saved = policy.snapshot?.config.workers[current];
      const state = saved?.channels.includes(channel) && policy.snapshot ? channelAvailabilityOf(policy.snapshot.config, activeBlocks({ version: 1, blocks: policy.snapshot.blocks }, Date.now()), { ...saved, channel }, current) : undefined;
      return <Text key={channel} type="secondary" {...stylex.props(styles.meta)}>{config.channels[channel]?.label ?? channel} · {state?.status === 'available' ? '未被策略限制；派发仍需新鲜可用额度' : availabilityText(state)}</Text>;
    })}</div>}
    {members.length > 1 && <Form.Field label="用于查看模型和连通测试的账号" extra="此选择仅用于当前诊断，不保存策略，也不指定派发账号。模型目录仅属于所选账号。"><NamedSelect id={`${fieldId}-diagnostic`} aria-label="用于查看模型和连通测试的账号" value={diagnostic || undefined} placeholder="选择一个成员账号" options={members.map(id => ({ value: id, label: config.channels[id]?.label ?? id }))} onChange={value => { if (typeof value === 'string' && members.includes(value)) editor.setDiagnostics(previous => ({ ...previous, [diagnosticKey]: value })); }} /></Form.Field>}
    <div {...stylex.props(rolesStyles.pair, rolesStyles.pairStart)}>
      <Form.Field label="模型" required><ModelPicker key={`${diagnosticKey}:${diagnostic}:${diagnosticEngine}`} kind={kind} channel={diagnostic || undefined} engine={diagnosticEngine} id={`${fieldId}-model`} value={record.model} onChange={model => update({ ...record, model })} /></Form.Field>
      <Form.Field label="推理强度" required><EffortPicker id={`${fieldId}-effort`} efforts={efforts} value={record.effort} onChange={effort => update({ ...record, effort })} /></Form.Field>
    </div>
    <HelloCheck id={diagnosticKey} record={{ channel: diagnostic, model: record.model, effort: record.effort }} engine={diagnosticEngine} channelLabel={config.channels[diagnostic]?.label} />
    {section === 'workers' ? <WorkerFields key={current} id={current} record={record as Worker} probe={freeProbe} update={update} /> : <OwnerFields key={current} savedRecord={policy.snapshot?.config.owners[current]} config={config} blocks={policy.blocks} record={record as Owner} update={update} />}
    {impact && <Modal open={editor.askDelete} title={impact.title} okText={editor.deleteError ? '重试删除' : '删除'} cancelText="取消" confirmLoading={editor.deleting} okButtonProps={{ danger: true, disabled: editor.deleting || policy.busy }} cancelButtonProps={{ disabled: editor.deleting }} closable={!editor.deleting} maskClosable={!editor.deleting} keyboard={!editor.deleting} onCancel={() => { if (!editor.deleting) editor.setAskDelete(false); }} onOk={() => void editor.confirmDelete()}>
      <Text>{policy.snapshot?.config[section][current] ? impact.detail : '这条角色尚未保存，确认后只从本地草稿移除，并清理引用。取消不改草稿。'}</Text>
      {editor.deleteError && <div role="alert"><Text type="danger">删除失败：{editor.deleteError}</Text></div>}
    </Modal>}
  </Form>;
}

/** The effort control with its hint below the input, mirroring the model field's hint placement so paired columns keep their inputs top aligned. */
function EffortPicker({ efforts, id, value, onChange }: { efforts?: string[]; id: string; value: string; onChange: (effort: string) => void }) {
  return <div {...stylex.props(styles.tight)}>
    {efforts?.length
      ? <NamedSelect id={id} aria-label="推理强度" value={value} options={efforts.map(option => ({ value: option, label: option }))} onChange={option => { if (typeof option === 'string') onChange(option); }} />
      : <Input id={id} aria-label="推理强度" value={value} placeholder="例如：max" onChange={event => onChange(event.target.value)} />}
    {!efforts?.length && <Text type="secondary" {...stylex.props(styles.meta)}>填写该模型接受的 variant。</Text>}
  </div>;
}

function WorkerFields({ id, record, probe, update }: { id: string; record: Worker; probe: ReturnType<typeof useFreeProbe>; update: (next: Worker) => void }) {
  const fieldId = useId();
  return <>
    <Form.Field label="免费渠道" desc="免费模型仅跳过不适用的套餐窗口；适用的额度上限、手动暂停和供应商限制仍生效。调度权重由父 Agent 分别设置。"><Checkbox disabled={record.channels.length > 1 && !record.free_channel} checked={record.free_channel === true} onChange={checked => update({ ...record, free_channel: checked === true })}>此子 Agent 使用免费渠道</Checkbox></Form.Field>
    <Form.Field label="用途说明"><Input id={`${fieldId}-description`} aria-label="用途说明" value={record.description ?? ''} placeholder="例如：负责前端界面与浏览器验收" onChange={event => update({ ...record, description: event.target.value })} /></Form.Field>
    {record.free_channel === true && record.channels.length === 1 && <FreeProbePanel worker={id} probe={probe} />}
    <WorkerParallelField record={record} update={update} />
  </>;
}

/** Off means no cap and removes the key; on stores the 1–100 limit on tasks this worker runs at once across every parent Agent. */
export function WorkerParallelField({ record, update }: { record: Worker; update: (next: Worker) => void }) {
  const on = record.max_parallel !== undefined;
  return <Form.Field label="并发上限" desc="同一时间最多运行几个任务，超出的任务排队等待；用于避免供应商限流。">
    <div {...stylex.props(styles.row, styles.nowrap)}>
      <NamedSwitch size="small" aria-label="限制同时运行的任务数" checked={on} onChange={checked => update(withWorkerParallel(record, checked, record.max_parallel))} />
      <Text>限制同时运行的任务数</Text>
      {on && <NamedInputNumber aria-label="并发上限" size="small" min={1} max={100} step={1} precision={0} value={record.max_parallel} {...stylex.props(rolesStyles.parallelInput)} onChange={value => update(withWorkerParallel(record, true, typeof value === 'number' ? value : undefined))} />}
    </div>
  </Form.Field>;
}

/** Why dispatch skips this worker right now, with the one button that lifts it. The ban is read from the saved policy, so the notice never shows an unsaved draft. */
export function WorkerBlockNotice({ block, now = Date.now(), busy, disabled, onResume }: { block: Block; now?: number; busy?: boolean; disabled?: boolean; onResume: () => void }) {
  const text = engineBlockText(block, now);
  const scope = block.channel ? `（作用于渠道 ${block.channel}）` : block.worker ? '' : block.model ? `（作用于引擎 ${block.engine} 的模型 ${block.model}）` : `（作用于整个引擎 ${block.engine}，恢复后该引擎的所有子 Agent 都会恢复）`;
  return <Alert type="warning" title={`已暂停派发 · ${text.category}`} description={`${text.reason}；${text.release}${scope}`}
    {...stylex.props(rolesStyles.blockNotice)} action={<Button size="small" icon={Play} aria-label="恢复派发" loading={busy} disabled={disabled} onClick={onResume}>恢复派发</Button>} />;
}

function OwnerFields({ config, blocks, record, savedRecord, update }: { config: NonNullable<PolicyDraft['config']>; blocks: PolicyDraft['blocks']; record: Owner; savedRecord?: Owner; update: (next: Owner) => void }) {
  return <>
    <Form.Field label="并行上限" required desc="这个父 Agent 同时运行的子 Agent 数量。"><NamedInputNumber id="owner-parallel" aria-label="并行上限" min={1} step={1} value={record.max_parallel} placeholder="例如：4" onChange={value => update({ ...record, max_parallel: value ?? 1 })} /></Form.Field>
    <OwnerScheduleFields config={config} blocks={blocks} record={record} savedRecord={savedRecord} update={update} />
  </>;
}
