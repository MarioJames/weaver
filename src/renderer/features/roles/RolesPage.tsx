import { useEffect, useRef, useState, type DragEvent } from 'react';
import * as stylex from '@stylexjs/stylex';
import { GripVertical, Play, Plus, Search } from 'lucide-react';
import { Button, Empty, Input, Skeleton, Tag, Text, Tooltip } from '@lobehub/ui';
import { TitleWithTips } from '@lobehub/ui/dashboard';
import { PageHeader } from '../../app/PageHeader';
import type { Task } from '../../../shared/contracts/tasks';
import type { Worker } from '../../../shared/contracts/policy';
import { roleChannels } from '../../../shared/policy/channels';
import { blankOwner, blankWorker, reorderRoles, roleIdError, workerChannelsSaveBlockReason, workerParallelText, type RoleSection } from '../../policy/policy-edit';
import { NamedSwitch } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { FreeChannelTag } from '../../ui/FreeChannelTag';
import { tagColor } from '../../format/tag-colors';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { navigate, useRoute } from '../../app/router';
import { useNotifyError } from '../../api/notify';
import { MasterDetail } from '../../ui/MasterDetail';
import { CompactMetrics, type CompactMetricItem } from '../../ui/CompactMetrics';
import { Pane } from '../../ui/Pane';
import { SelectableList } from '../../ui/SelectableList';
import { SaveBar } from '../../ui/SaveBar';
import { useDraftGuard } from '../../ui/useDraftGuard';
import { EngineIcon } from '../../ui/EngineIcon';
import { blockOf } from '../probes/probe-view';
import { useFreeProbe } from '../probes/useFreeProbe';
import {
  DESCRIPTIONS, NAMES, dirtyRoleCount, fallbackRoleId, filterRoleIds, incompleteRoleIds, moveRoleOrder, roleChannelNames, roleMetrics, roleNote, roleStatusView, uniqueId,
} from './roles-view';
import { useRoleEditor } from './use-role-editor';
import { RoleEditor } from './RoleEditor';
import { rolesStyles } from './roles-style';

const NARROW_QUERY = '(max-width: 1023.98px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return narrow;
}

/** The parent / sub agent pages: a searchable, sortable role list and the selected role's editor. */
export function RolesPage({ section, policy, tasks = [] }: { section: RoleSection; policy: PolicyDraft; tasks?: Task[] }) {
  const name = NAMES[section];
  const route = useRoute();
  const routedId = route.page === section ? route.id : undefined;
  const narrow = useNarrow();
  const [showList, setShowList] = useState(() => !routedId);
  const [search, setSearch] = useState('');
  const [dragId, setDragId] = useState('');
  const [overId, setOverId] = useState('');
  /** Set when the user discards the draft: a discarded rename can strand the URL on an id that no longer exists. */
  const discardFallback = useRef(false);
  const config = policy.config;
  const ids = Object.keys(config?.[section] ?? {});
  const current = routedId ? (ids.includes(routedId) ? routedId : '') : ids[0] ?? '';
  const missing = !!routedId && !!config && !ids.includes(routedId);
  const editor = useRoleEditor(section, policy, current, id => {
    navigate(id ? { page: section, id } : { page: section }, { replace: true });
  });
  const freeProbe = useFreeProbe(policy.snapshot?.revision);
  const guard = useDraftGuard(policy.dirty);
  useNotifyError(policy.loadError, '配置读取失败');
  useNotifyError(policy.saveError && !policy.issues.length ? policy.saveError : '', '保存失败');
  useNotifyError(policy.conflict ? '配置已在别处更新，草稿仍保留。重新读取会放弃本页草稿。' : '', '配置冲突');

  useEffect(() => {
    if (route.page !== section || routedId || !config || !ids.length) return;
    // Same landing as opening with the id in the URL: narrow screens show the editor, not the list.
    setShowList(false);
    navigate({ page: section, id: ids[0]! }, { replace: true });
  }, [route.page, routedId, section, config, ids[0]]); // ids is derived from config

  // After a discard the draft matches the saved policy again. If the discard removed the routed id
  // (a rename that never saved), fall back to the first role; a manually entered unknown id keeps its 未找到 empty state.
  useEffect(() => {
    if (!discardFallback.current || route.page !== section || policy.loading || !config) return;
    discardFallback.current = false;
    const fallback = fallbackRoleId(config, section, routedId);
    if (fallback !== undefined) navigate(fallback ? { page: section, id: fallback } : { page: section }, { replace: true });
  }, [route.page, routedId, section, config, policy.loading]); // config is derived from the reloaded draft

  async function discardDraft() {
    discardFallback.current = true;
    await policy.load(true);
  }

  const canSort = ids.length > 1 && !policy.busy && !editor.toggling && !editor.resuming;
  const searching = search.trim() !== '';
  const filtered = config ? filterRoleIds(config, section, search) : [];
  const mobileView = narrow && showList ? 'list' : 'main';
  const metrics = roleMetrics(config, policy.snapshot, section);
  const dirty = dirtyRoleCount(config, policy.snapshot);
  const saveBlockReason = config ? workerChannelsSaveBlockReason(config) : '';
  const incomplete = incompleteRoleIds(config, section);
  const idInvalid = !!config && !!editor.pendingId && editor.pendingId !== current && !!roleIdError(section, editor.pendingId, config, current);
  const draftIncomplete = !current || incomplete.length > 0 || !editor.pendingId || idInvalid;
  const items: CompactMetricItem[] = [
    { label: '启用', value: `${metrics.enabled}/${metrics.total}`, hint: '当前草稿' },
    { label: '可派发', value: metrics.dispatchable, hint: '已保存的策略' },
    { label: section === 'owners' ? '覆盖子 Agent' : '被父 Agent 引用', value: metrics.referenced, hint: section === 'owners' ? '已启用的父 Agent 引用到的子 Agent' : '引用该子 Agent 的父 Agent 范围' },
    { label: '已暂停', value: metrics.paused, hint: '已保存的策略', valueTone: metrics.paused > 0 ? 'warning' : undefined },
  ];

  function add() {
    if (!config) return;
    const id = uniqueId(section, config, policy.snapshot?.config);
    policy.setConfig({ ...config, [section]: { ...config[section], [id]: section === 'owners' ? blankOwner(config) : blankWorker(config) } });
    editor.startNew(id);
    setSearch('');
    setShowList(false);
    navigate({ page: section, id });
  }

  function select(id: string) {
    setShowList(false);
    if (id !== routedId) navigate({ page: section, id });
  }

  function drop(target: string) {
    if (!dragId || dragId === target || !canSort || searching) return;
    const next = moveRoleOrder(ids, dragId, target);
    policy.setConfig(currentConfig => currentConfig ? reorderRoles(currentConfig, section, next) : currentConfig);
    setDragId('');
    setOverId('');
  }

  const header = <PageHeader
    title={<TitleWithTips title={name} tips={DESCRIPTIONS[section]} />}
    action={<Button type="primary" icon={Plus} disabled={!config || policy.busy} onClick={add}>新建{name}</Button>}
  />;

  const list = <Pane
    label={`${name} 列表`}
    toolbar={<div {...stylex.props(rolesStyles.toolbar)}>
      <Input
        allowClear
        aria-label={`搜索${name}`}
        placeholder={`按 ID、渠道或模型搜索${name}`}
        prefix={<Search size={14} />}
        value={search}
        onChange={event => setSearch(event.target.value)}
        {...stylex.props(rolesStyles.search)}
      />
    </div>}
  >
    <nav aria-label={`${name} 列表`} {...stylex.props(rolesStyles.listBody)}>
      {policy.loading && !config ? <div {...stylex.props(rolesStyles.listEmpty)}><Skeleton.Text animated rows={6} /></div>
        : !config ? <div {...stylex.props(rolesStyles.listEmpty)}>
          <Text type="secondary">配置尚未读取。</Text>
          <Button size="small" onClick={() => void policy.load(true)}>重新读取</Button>
        </div>
          : !ids.length ? <div {...stylex.props(rolesStyles.listEmpty)}>
            <Text type="secondary">还没有{name}。</Text>
            <Button size="small" icon={Plus} onClick={add}>新建{name}</Button>
          </div>
            : !filtered.length ? <div {...stylex.props(rolesStyles.listEmpty)}>
              <Text type="secondary">没有匹配的{name}。</Text>
              <Button size="small" onClick={() => setSearch('')}>清除搜索</Button>
            </div>
              : <SelectableList<string>
                label={`${name} 列表`}
                sections={[{ key: 'roles', items: filtered }]}
                getKey={id => id}
                selectedKey={missing ? undefined : current}
                onSelect={select}
                renderItem={id => {
                  const item = config[section][id];
                  if (!item) return null;
                  const saved = policy.snapshot?.config[section][id];
                  const availability = policy.snapshot?.[section][id];
                  const hit = policy.snapshot && saved ? blockOf(policy.snapshot.blocks, saved, Date.now(), section === 'workers' ? id : undefined, policy.snapshot.config) : undefined;
                  const status = roleStatusView(item, availability, hit);
                  const note = roleNote(availability, !!saved && JSON.stringify(saved) !== JSON.stringify(item), hit);
                  const channelOn = roleChannels(item).some(channel => config.channels[channel]?.enabled === true);
                  const kind = config.engines[config.channels[roleChannels(item)[0] ?? '']?.engine ?? '']?.kind;
                  const channelsText = `${roleChannelNames(config, item)} · ${item.model || '未填模型'}`;
                  const displayId = id === current ? (editor.pendingId || '未命名') : id;
                  const cap = section === 'workers' ? workerParallelText(item as Worker) : undefined;
                  const grip = ids.length > 1 && !policy.busy && !editor.toggling && !editor.resuming
                    ? searching
                      ? <Tooltip title="清除搜索后可拖动排序"><span {...stylex.props(rolesStyles.roleGripOff)} aria-hidden="true"><GripVertical size={14} /></span></Tooltip>
                      : <Tooltip title="拖动排序，保存后生效"><button
                        type="button"
                        draggable={canSort}
                        aria-label={`拖动排序 ${id}`}
                        onClick={event => event.stopPropagation()}
                        onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', id);
                          setDragId(id);
                        }}
                        onDragEnd={() => { setDragId(''); setOverId(''); }}
                        {...stylex.props(rolesStyles.roleGrip)}
                      ><GripVertical size={14} /></button></Tooltip>
                    : ids.length > 1
                      ? <span {...stylex.props(rolesStyles.roleGripOff)} aria-hidden="true"><GripVertical size={14} /></span>
                      : null;
                  return <div
                    data-dragging={dragId === id || undefined}
                    data-over={overId === id && dragId !== id || undefined}
                    onDragOver={event => { if (dragId && canSort && !searching) { event.preventDefault(); setOverId(id); } }}
                    onDragLeave={() => setOverId(currentOver => currentOver === id ? '' : currentOver)}
                    onDrop={event => { event.preventDefault(); drop(id); }}
                    {...stylex.props(rolesStyles.row, dragId === id && rolesStyles.rowDragging, overId === id && dragId !== id && rolesStyles.rowDropTarget)}
                  >
                    <span {...stylex.props(rolesStyles.switchWrap)} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                      <NamedSwitch
                        size="small"
                        aria-label={`启用 ${id}`}
                        checked={item.enabled}
                        loading={editor.toggling === id}
                        disabled={!channelOn || !!editor.toggling}
                        title={channelOn ? undefined : '账号或渠道未启用，请在账号与渠道页检查'}
                        onChange={checked => void editor.toggle(id, checked)}
                      />
                    </span>
                    <div {...stylex.props(rolesStyles.rowCopy)}>
                      <div {...stylex.props(rolesStyles.rowHead)}>
                        {grip}
                        <EngineIcon kind={kind} />
                        <strong {...stylex.props(rolesStyles.rowId)} title={displayId}>{displayId}</strong>
                        {section === 'workers' && 'free_channel' in item && item.free_channel === true && <FreeChannelTag />}
                        <span title={status.hint ?? note?.text} {...stylex.props(rolesStyles.status)}>
                          <span data-tone={status.tone} aria-hidden="true" {...stylex.props(rolesStyles.statusDot)} />
                          {status.label}
                        </span>
                      </div>
                      <div {...stylex.props(rolesStyles.rowMeta)}>
                        <span {...stylex.props(rolesStyles.rowMetaText)} title={channelsText}>{channelsText}</span>
                        {cap && <Tag size="small" color={tagColor('neutral')} {...stylex.props(rolesStyles.capTag)}>{cap}</Tag>}
                      </div>
                      {section === 'workers' && hit && <Button
                        size="small"
                        type="text"
                        icon={Play}
                        aria-label={`恢复派发 ${id}`}
                        loading={editor.resuming === id}
                        disabled={policy.busy || (!!editor.resuming && editor.resuming !== id)}
                        onClick={event => { event.stopPropagation(); void editor.resume(id, hit); }}
                        {...stylex.props(rolesStyles.roleResume)}
                      >恢复派发</Button>}
                    </div>
                  </div>;
                }}
              />}
    </nav>
  </Pane>;

  const main = missing
    ? <Pane label={`${name} 详情`} title="未找到">
      <div {...stylex.props(rolesStyles.emptyPane)}>
        <Empty
          title={`未找到这个${name}`}
          description="它可能已被删除，或链接中的 ID 有误。"
          action={<Button onClick={() => { setShowList(true); navigate({ page: section }, { replace: true }); }}>返回列表</Button>}
        />
      </div>
    </Pane>
    : current && config
      ? <RoleEditor
        section={section}
        policy={policy}
        current={current}
        editor={editor}
        freeProbe={freeProbe}
        tasks={tasks}
        narrow={narrow}
        onBack={() => setShowList(true)}
        onAdd={add}
      />
      : <Pane label={`${name} 详情`} title={name}>
        <div {...stylex.props(rolesStyles.emptyPane)}>
          {policy.loading ? <Skeleton.Text animated rows={6} />
            : <Empty
              title={`还没有${name}`}
              description={`新建一个${name}，选择账号和模型后保存。`}
              action={<Button icon={Plus} disabled={!config} onClick={add}>新建{name}</Button>}
            />}
        </div>
      </Pane>;

  return <section aria-label={`${name} 内容`} {...stylex.props(rolesStyles.page)}>
    {header}
    <CompactMetrics label={`${name}指标`} items={items} loading={!config || !policy.snapshot} />
    <div {...stylex.props(rolesStyles.body)}>
      <MasterDetail
        listLabel={`${name} 列表`}
        mainLabel={`${name} 详情`}
        listWidth={320}
        list={list}
        main={main}
        mobileView={mobileView}
      />
    </div>
    <div title={saveBlockReason || undefined}>
      <SaveBar
        dirty={policy.dirty}
        saving={policy.busy}
        message={dirty ? `${dirty} 个 Agent 有未保存的修改` : '有未保存的修改'}
        saveDisabled={!config || !!saveBlockReason || draftIncomplete}
          onSave={() => { editor.touchAll(); void policy.save(); }}
        onDiscard={() => void discardDraft()}
      />
    </div>
    {guard.dialog}
  </section>;
}
