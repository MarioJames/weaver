import { useId, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowLeft, Play, Plus, Trash2 } from 'lucide-react';
import { Alert, Button, Checkbox, Input, Modal, Text } from '@lobehub/ui';
import { Section, TitleWithTips } from '@lobehub/ui/dashboard';
import { Field } from '@base-ui/react/field';
import { Form, useForm } from '@lobehub/ui/form';
import { activeBlocks, channelAvailabilityOf } from '../../../shared/policy/availability';
import { roleChannels } from '../../../shared/policy/channels';
import { EFFORTS } from '../../../shared/policy/settings';
import type { Block, Owner, Worker } from '../../../shared/contracts/policy';
import type { Task } from '../../../shared/contracts/tasks';
import { withWorkerChannels, withWorkerParallel, workerChannelsError, roleDeleteImpact, type RoleSection } from '../../policy/policy-edit';
import { engineBlockText } from '../../policy/worker-resume';
import { notifyError } from '../../api/notify';
import { NamedInputNumber, NamedSelect, NamedSwitch } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { ModelPicker } from '../engines/ModelPicker';
import { useFreeProbe } from '../probes/useFreeProbe';
import { blockOf } from '../probes/probe-view';
import { FreeProbePanel } from '../probes/FreeProbePanel';
import { Pane } from '../../ui/Pane';
import { OwnerScheduleFields } from './OwnerSchedule';
import { HelloCheck } from './HelloCheck';
import { channelOptions, NAMES, ownerUsersOf, recentWorkerTasks, roleChannelNames, roleFieldIssues, roleStatusView, visibleFieldError, availabilityText, type RoleField } from './roles-view';
import type { RoleEditorState } from './use-role-editor';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { rolesStyles } from './roles-style';
import { EngineIcon } from '../../ui/EngineIcon';
import { EntityLink } from '../../ui/EntityLink';
import { StatusBadge } from '../../ui/StatusBadge';
import { TimeText } from '../../ui/TimeText';
import { displayStatus } from '../../format/status-colors';

const BASIC_TIPS: Record<RoleSection, string> = {
  owners: '配置 ID 是任务报告和引用里的名字。选择父 Agent 使用的一个账号；模型和推理强度决定它执行会话的方式。',
  workers: '配置 ID 是任务报告和引用里的名字。派发时从有可用额度的账号中随机选择；多账号仅支持同一执行引擎 ID 的官方订阅池，API、免费渠道与无额度接口的引擎只支持单账号。',
};

const SCHEDULE_TIPS: Record<RoleSection, string> = {
  owners: '并行上限决定这个父 Agent 同时运行多少个子 Agent。派发按权重分摊：空闲时先给权重高的，并发时按权重比例分配；权重为 0–10 的整数，0 表示不派给它。',
  workers: '并发上限限制同一时间最多运行几个任务，超出的任务排队等待。免费模型仅跳过不适用的套餐窗口；适用的额度上限、手动暂停和供应商限制仍生效。调度权重由父 Agent 分别设置。',
};

const AVAILABILITY_TIPS = '暂停状态来自已保存的策略。连通测试会用当前填写的渠道、模型和推理强度发送一条简短问候，不保存配置，会消耗少量额度；连通成功不代表额度可用。';

const RELATION_TIPS: Record<RoleSection, string> = {
  owners: '这里列出这个父 Agent 在调度时引用的子 Agent。链接可以打开对应子 Agent 的详情。',
  workers: '列出引用这个子 Agent 的父 Agent，以及最近 5 个由它执行的任务。链接分别打开父 Agent 详情和任务详情。',
};

/** The main pane of a roles page: the selected record's segmented editor, its pause state and relations. */
export function RoleEditor({ section, policy, current, editor, freeProbe, tasks, narrow, onBack, onAdd }: {
  section: RoleSection;
  policy: PolicyDraft;
  current: string;
  editor: RoleEditorState;
  freeProbe: ReturnType<typeof useFreeProbe>;
  tasks: readonly Task[];
  narrow: boolean;
  onBack: () => void;
  onAdd: () => void;
}) {
  const form = useForm();
  const fieldId = useId();
  const config = policy.config;
  if (!config) return null;
  const name = NAMES[section];
  const record = current ? config[section][current] : undefined;
  const untitled = editor.freshId === current && !editor.pendingId;
  if (!record || !current) return <div {...stylex.props(rolesStyles.emptyPane)}>
    <Text type="secondary">选择左侧的{name}，或新建一个。</Text>
    <Button icon={Plus} onClick={onAdd}>新建{name}</Button>
  </div>;
  const members = roleChannels(record).filter(Boolean);
  const diagnosticKey = `${section}:${current}`;
  const diagnostic = members.length === 1 ? members[0]! : members.includes(editor.diagnostics[diagnosticKey] ?? '') ? editor.diagnostics[diagnosticKey]! : '';
  const diagnosticEngine = config.channels[diagnostic]?.engine ?? '';
  const kind = config.engines[diagnosticEngine]?.kind;
  const efforts = kind ? EFFORTS[kind] : undefined;
  const savedRecord = policy.snapshot?.config[section][current];
  const availability = policy.snapshot?.[section][current];
  const pausedBy = savedRecord && policy.snapshot ? blockOf(policy.snapshot.blocks, savedRecord, Date.now(), section === 'workers' ? current : undefined, policy.snapshot.config) : undefined;
  const status = roleStatusView(record, availability, pausedBy);
  const impactConfig = savedRecord ? policy.snapshot!.config : config;
  const impact = roleDeleteImpact(impactConfig, section, current);
  const referringOwners = section === 'workers' ? ownerUsersOf(config, current) : undefined;
  const recentTasks = section === 'workers' ? recentWorkerTasks(tasks, current) : [];
  const base = `$.${section}.${current}`;
  const issue = (...parts: string[]) => (policy.issues ?? [])
    .filter(item => item.path.startsWith(base) && parts.some(part => item.path.slice(base.length).startsWith(part)))
    .map(item => item.message)
    .join('；');
  // Fresh-form client checks stay hidden until the user touches the field (or
  // clicks save); a server rejection only exists after a save attempt, so it
  // always shows. The save button stays disabled while checks fail.
  const clientIssues = roleFieldIssues(section, record);
  const clientMessage = (field: RoleField) => field === 'channel' && section === 'workers'
    ? workerChannelsError(config, record as Worker)
    : clientIssues.find(item => item.field === field)?.message ?? '';
  const channelTouched = (field: RoleField) => editor.touched.has(field);
  const channelIssue = visibleFieldError(clientMessage('channel'), issue('.channel', '.channels', '.engine'), channelTouched('channel'));
  const modelIssue = visibleFieldError(clientMessage('model'), issue('.model'), channelTouched('model'));
  const effortIssue = visibleFieldError(clientMessage('effort'), issue('.effort'), channelTouched('effort'));
  const workersIssue = section === 'owners'
    ? visibleFieldError(clientMessage('workers'), issue('.workers', '.worker_weights'), channelTouched('workers'))
    : '';
  function update(next: Owner | Worker) { policy.setConfig({ ...config!, [section]: { ...config![section], [current]: next } }); }

  const header = <div {...stylex.props(rolesStyles.headerRow)}>
    {narrow && <Button size="small" type="text" icon={ArrowLeft} aria-label={`返回${name} 列表`} onClick={onBack} {...stylex.props(rolesStyles.mobileBack)} />}
    <EngineIcon kind={kind} size={16} />
    <span {...stylex.props(rolesStyles.headerName)} title={untitled ? undefined : current}>{untitled ? `新建${name}` : current}</span>
    <span title={status.hint} {...stylex.props(rolesStyles.status)}>
      <span data-tone={status.tone} aria-hidden="true" {...stylex.props(rolesStyles.statusDot)} />
      {status.label}
    </span>
  </div>;

  return <Pane
    label={`${name} 详情`}
    title={header}
    actions={<Button danger size="small" icon={Trash2} disabled={policy.busy || editor.deleting} onClick={() => { editor.setDeleteError(''); editor.setAskDelete(true); }}>删除</Button>}
  >
    <Form form={form} layout="vertical">
      <div {...stylex.props(rolesStyles.mainBody)}>
        <Section title={<TitleWithTips title="基本" tips={BASIC_TIPS[section]} />}>
          <div {...stylex.props(rolesStyles.sectionFields)}>
            <Form.Field label="配置 ID" required desc="改名后按 Enter 或离开输入框，引用处一起更新。">
              <Input id={`${fieldId}-id`} aria-label="配置 ID" aria-invalid={!!editor.idError} value={editor.pendingId} placeholder={section === 'workers' ? '例如：research' : '例如：codex'} onChange={event => editor.setPendingId(event.target.value)} onBlur={editor.acceptId} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); editor.acceptId(); } }} />
            </Form.Field>
            <Field.Root invalid={!!channelIssue}>
            <Form.Field label="账号或渠道" required desc={section === 'workers' ? '派发时从有可用额度的账号中随机选择。' : '选择父 Agent 使用的一个账号。'}>
              {/* A blur (not just a change) counts as touching: tabbing through the empty field reveals its hint. */}
              <div onBlur={() => editor.touch('channel')}>
              <NamedSelect id={`${fieldId}-channel`} aria-label="账号或渠道" mode={section === 'workers' ? 'multiple' : undefined} placeholder="选择账号或渠道" value={'channels' in record ? (record.channels.length ? record.channels : undefined) : (record as Owner).channel || undefined} options={channelOptions(config)} onChange={value => {
                editor.touch('channel');
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
              }} /></div>
                {channelIssue && <Field.Error id={`${fieldId}-channel-error`} match render={<Text type="danger" role="alert" />}>{channelIssue}</Field.Error>}
              </Form.Field>
            </Field.Root>
            {section === 'workers' && <div {...stylex.props(styles.tight)} aria-label="成员账号状态">{members.map(channel => {
              const saved = policy.snapshot?.config.workers[current];
              const state = saved?.channels.includes(channel) && policy.snapshot ? channelAvailabilityOf(policy.snapshot.config, activeBlocks({ version: 1, blocks: policy.snapshot.blocks }, Date.now()), { ...saved, channel }, current) : undefined;
              const text = `${config.channels[channel]?.label ?? channel} · ${state?.status === 'available' ? '未被策略限制；派发仍需新鲜可用额度' : availabilityText(state)}`;
              return <Text key={channel} type="secondary" title={text} {...stylex.props(rolesStyles.fieldHint)}>{text}</Text>;
            })}</div>}
            {members.length > 1 && <Form.Field label="用于查看模型和连通测试的账号" desc="仅用于当前诊断，不保存策略。">
              <NamedSelect id={`${fieldId}-diagnostic`} aria-label="用于查看模型和连通测试的账号" value={diagnostic || undefined} placeholder="选择一个成员账号" options={members.map(id => ({ value: id, label: config.channels[id]?.label ?? id }))} onChange={value => { if (typeof value === 'string' && members.includes(value)) editor.setDiagnostics(previous => ({ ...previous, [diagnosticKey]: value })); }} />
            </Form.Field>}
            <div {...stylex.props(rolesStyles.pair, rolesStyles.pairStart)}>
              <div onBlur={() => editor.touch('model')} {...stylex.props(styles.tight)}>
                <Form.Field label="模型" required>
                  <ModelPicker key={`${diagnosticKey}:${diagnostic}:${diagnosticEngine}`} kind={kind} channel={diagnostic || undefined} engine={diagnosticEngine} id={`${fieldId}-model`} value={record.model} onChange={model => { editor.touch('model'); update({ ...record, model }); }} />
                </Form.Field>
                {modelIssue && <Text type="danger" role="alert" {...stylex.props(rolesStyles.fieldHint)}>{modelIssue}</Text>}
              </div>
              <div onBlur={() => editor.touch('effort')} {...stylex.props(styles.tight)}>
                <Form.Field label="推理强度" required>
                  <EffortPicker id={`${fieldId}-effort`} efforts={efforts} value={record.effort} onChange={effort => { editor.touch('effort'); update({ ...record, effort }); }} />
                </Form.Field>
                {effortIssue && <Text type="danger" role="alert" {...stylex.props(rolesStyles.fieldHint)}>{effortIssue}</Text>}
              </div>
            </div>
          </div>
        </Section>

        <Section title={<TitleWithTips title="调度" tips={SCHEDULE_TIPS[section]} />}>
          <div {...stylex.props(rolesStyles.sectionFields)}>
            {section === 'workers'
              ? <>
                <WorkerParallelField record={record as Worker} update={update} />
                <Form.Field label="免费渠道" desc="标记后按免费渠道参与定时探测和额度恢复。">
                  <Checkbox disabled={(record as Worker).channels.length > 1 && !(record as Worker).free_channel} checked={(record as Worker).free_channel === true} onChange={checked => update({ ...record, free_channel: checked === true })}>此子 Agent 使用免费渠道</Checkbox>
                </Form.Field>
                <Form.Field label="用途说明">
                  <Input id={`${fieldId}-description`} aria-label="用途说明" value={(record as Worker).description ?? ''} placeholder="例如：负责前端界面与浏览器验收" onChange={event => update({ ...record, description: event.target.value })} />
                </Form.Field>
              </>
              : <>
                <Form.Field label="并行上限" required desc="这个父 Agent 同时运行的子 Agent 数量。">
                  <NamedInputNumber id="owner-parallel" aria-label="并行上限" min={1} step={1} value={record.max_parallel} placeholder="例如：4" onChange={value => update({ ...record, max_parallel: value ?? 1 })} />
                </Form.Field>
                <OwnerScheduleFields config={config} blocks={policy.blocks} record={record as Owner} savedRecord={savedRecord as Owner | undefined} update={update} emptyError={workersIssue || undefined} onInteract={() => editor.touch('workers')} />
              </>}
          </div>
        </Section>

        <Section title={<TitleWithTips title="可用性" tips={AVAILABILITY_TIPS} />}>
          <div {...stylex.props(rolesStyles.sectionFields)}>
            {pausedBy
              ? <WorkerBlockNotice
                block={pausedBy}
                busy={editor.resuming === current}
                disabled={policy.busy || (!!editor.resuming && editor.resuming !== current)}
                onResume={() => void editor.resume(current, pausedBy, section === 'workers')}
              />
              : <Text type="secondary" {...stylex.props(rolesStyles.fieldHint)}>未被策略暂停，保存后的配置可以参与派发。</Text>}
            <HelloCheck id={diagnosticKey} record={{ channel: diagnostic, model: record.model, effort: record.effort }} engine={diagnosticEngine} channelLabel={config.channels[diagnostic]?.label} />
            {section === 'workers' && (record as Worker).free_channel === true && (record as Worker).channels.length === 1 && <FreeProbePanel worker={current} probe={freeProbe} />}
          </div>
        </Section>

        <Section title={<TitleWithTips title="关系" tips={RELATION_TIPS[section]} />}>
          <div {...stylex.props(rolesStyles.sectionFields)}>
            {section === 'owners'
              ? <div {...stylex.props(rolesStyles.relationGroup)}>
                <span {...stylex.props(rolesStyles.relationLabel)}>引用的子 Agent</span>
                <div {...stylex.props(rolesStyles.linkList)}>
                  {(record as Owner).workers.length
                    ? (record as Owner).workers.map(worker => <EntityLink key={worker} route={{ page: 'workers', id: worker }} icon={<EngineIcon kind={config.engines[config.channels[config.workers[worker]?.channels[0] ?? '']?.engine ?? '']?.kind} />}>{worker}</EntityLink>)
                    : <Text type="secondary">还没有引用子 Agent。</Text>}
                </div>
              </div>
              : <>
                <div {...stylex.props(rolesStyles.relationGroup)}>
                  <span {...stylex.props(rolesStyles.relationLabel)}>被父 Agent 引用</span>
                  <div {...stylex.props(rolesStyles.linkList)}>
                    {referringOwners?.length
                      ? referringOwners.map(owner => <EntityLink key={owner} route={{ page: 'owners', id: owner }} icon={<EngineIcon kind={config.engines[config.channels[(config.owners[owner]?.channel) ?? '']?.engine ?? '']?.kind} />}>{owner}</EntityLink>)
                      : <Text type="secondary">还没有父 Agent 引用它。</Text>}
                  </div>
                </div>
                <div {...stylex.props(rolesStyles.relationGroup)}>
                  <span {...stylex.props(rolesStyles.relationLabel)}>最近执行的任务</span>
                  {recentTasks.length
                    ? <ul aria-label="最近执行的任务" {...stylex.props(rolesStyles.taskList)}>
                      {recentTasks.map(task => <li key={task.id} {...stylex.props(rolesStyles.taskRow)}>
                        <StatusBadge status={displayStatus(task)} />
                        <EntityLink route={{ page: 'tasks', view: 'all', taskId: task.id }} title={task.title}>{task.title || task.id}</EntityLink>
                        <TimeText value={task.updatedAt} {...stylex.props(rolesStyles.taskTime)} />
                      </li>)}
                    </ul>
                    : <Text type="secondary">还没有由它执行的任务。</Text>}
                </div>
              </>}
          </div>
        </Section>
      </div>
    </Form>
    {impact && <Modal open={editor.askDelete} title={impact.title} okText={editor.deleteError ? '重试删除' : '删除'} cancelText="取消" confirmLoading={editor.deleting} okButtonProps={{ danger: true, disabled: editor.deleting || policy.busy }} cancelButtonProps={{ disabled: editor.deleting }} closable={!editor.deleting} maskClosable={!editor.deleting} keyboard={!editor.deleting} onCancel={() => { if (!editor.deleting) editor.setAskDelete(false); }} onOk={() => void editor.confirmDelete()}>
      <Text>{savedRecord ? impact.detail : '这条角色尚未保存，确认后只从本地草稿移除，并清理引用。取消不改草稿。'}</Text>
      {editor.deleteError && <div role="alert"><Text type="danger">删除失败：{editor.deleteError}</Text></div>}
    </Modal>}
  </Pane>;
}


/** The effort control with its hint below the input, mirroring the model field's hint placement so paired columns keep their inputs top aligned. */
function EffortPicker({ efforts, id, value, onChange }: { efforts?: string[]; id: string; value: string; onChange: (effort: string) => void }) {
  return <div {...stylex.props(styles.tight)}>
    {efforts?.length
      ? <NamedSelect id={id} aria-label="推理强度" placeholder="选择推理强度" value={value || undefined} options={efforts.map(option => ({ value: option, label: option }))} onChange={option => { if (typeof option === 'string') onChange(option); }} />
      : <Input id={id} aria-label="推理强度" value={value} placeholder="例如：max" onChange={event => onChange(event.target.value)} />}
    {!efforts?.length && <Text type="secondary" {...stylex.props(styles.meta)}>填写该模型接受的 variant。</Text>}
  </div>;
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
    action={<Button size="small" icon={Play} aria-label="恢复派发" loading={busy} disabled={disabled} onClick={onResume}>恢复派发</Button>} />;
}
