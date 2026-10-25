import { blockOf } from '../probes/probe-view';
import { useFreeProbe } from '../probes/useFreeProbe';
import { useEffect, useRef, useState } from 'react';
import { GripVertical, Play, Plus } from 'lucide-react';
import { SortableList } from '@lobehub/ui';
import { Surface } from '@lobehub/ui/dashboard';
import { Button, Skeleton, Tag, Text } from '@lobehub/ui/base-ui';
import type { Worker } from '../../../shared/contracts/policy';
import { roleChannels } from '../../../shared/policy/channels';
import { blankOwner, blankWorker, reorderRoles, syncRoleEditor, workerChannelsSaveBlockReason, workerParallelText, type RoleSection } from '../../policy/policy-edit';
import { NamedSwitch } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { FreeChannelTag } from '../../ui/FreeChannelTag';
import { tagColor } from '../../format/tag-colors';
import { DESCRIPTIONS, NAMES, roleChannelNames, roleNote, uniqueId } from './roles-view';
import { PolicyHeader } from '../../policy/PolicyHeader';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { useRoleEditor } from './use-role-editor';
import { RoleEditor } from './RoleEditor';
import { rolesStyles } from './roles-style';

export function RolesPage({ section, policy }: { section: RoleSection; policy: PolicyDraft }) {
  const editorPane = useRef<HTMLDivElement>(null);
  const scrollToEditor = () => { if (window.matchMedia('(max-width: 768px)').matches) requestAnimationFrame(() => editorPane.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); };
  const config = policy.config;
  const ids = Object.keys(config?.[section] ?? {});
  const [selected, setSelected] = useState('');
  const current = syncRoleEditor(ids, selected).selected;
  const editor = useRoleEditor(section, policy, current, setSelected);
  const freeProbe = useFreeProbe(policy.snapshot?.revision);
  const name = NAMES[section];
  const header = <PolicyHeader title={name} description={DESCRIPTIONS[section]} policy={policy} saveBlockReason={config ? workerChannelsSaveBlockReason(config) : undefined} extra={config && <Button icon={Plus} disabled={policy.busy} onClick={add}>新建{name}</Button>} />;
  useEffect(() => {
    const next = syncRoleEditor(ids, selected);
    setSelected(next.selected);
  }, [section, current]);
  if (!config) return <>{header}{policy.loading && <Skeleton.Text animated rows={6} />}</>;
  function add() {
    if (!config) return;
    const id = uniqueId(section, config, policy.snapshot?.config);
    policy.setConfig({ ...config, [section]: { ...config[section], [id]: section === 'owners' ? blankOwner(config) : blankWorker(config) } });
    setSelected(id); scrollToEditor();
  }
  const canSort = ids.length > 1 && !policy.busy && !editor.toggling && !editor.resuming;
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
            const channelOn = roleChannels(item).some(channel => config.channels[channel]?.enabled === true);
            const saved = policy.snapshot?.config[section][id];
            const cap = section === 'workers' ? workerParallelText(item as Worker) : undefined;
            const hit = policy.snapshot && saved ? blockOf(policy.snapshot.blocks, saved, Date.now(), section === 'workers' ? id : undefined, policy.snapshot.config) : undefined;
            const note = roleNote(policy.snapshot?.[section][id], false, hit);
            return <SortableList.Item id={id} align="flex-start" className={rolesStyles.sortItem}>
              {ids.length > 1 && (canSort
                ? <SortableList.DragHandle className={rolesStyles.roleGrip} aria-label={`拖动排序 ${id}`} size={{ blockSize: 44, borderRadius: 8, size: 16 }} style={{ touchAction: 'none' }} />
                : <span className={rolesStyles.roleGripOff} aria-hidden="true"><GripVertical size={16} /></span>)}
              <div className={rolesStyles.roleItem} aria-current={id === current ? 'true' : undefined}>
                <NamedSwitch size="small" aria-label={`启用 ${id}`} checked={item.enabled} loading={editor.toggling === id} disabled={!channelOn || !!editor.toggling} title={channelOn ? undefined : '账号或渠道未启用，请在账号与渠道页检查'} onChange={checked => void editor.toggle(id, checked)} />
                <button type="button" className={rolesStyles.roleButton} onClick={() => { editor.acceptId(); setSelected(id); editor.setPendingId(id); editor.setIdError(''); scrollToEditor(); }}>
                  <span className={rolesStyles.roleTitle}>
                    <strong className={styles.wrap}>{id}</strong>
                    {section === 'workers' && 'free_channel' in item && item.free_channel === true && <FreeChannelTag />}
                  </span>
                  <span className={rolesStyles.roleNote}>
                    <span className={`${styles.wrap} ${styles.meta}`}>{roleChannelNames(config, item)} · {item.model || '未填模型'}</span>
                    {cap && <Tag size="small" color={tagColor('neutral')}>{cap}</Tag>}
                  </span>
                  {note && (note.tag
                    ? <span className={rolesStyles.roleNote}><Tag size="small" color={note.tag.color}>{note.tag.label}</Tag><span className={`${styles.wrap} ${styles.meta} ${styles.warn}`}>{note.text}</span></span>
                    : <span className={`${styles.wrap} ${styles.meta} ${note.warning ? styles.warn : ''}`}>{note.text}</span>)}
                </button>
                {section === 'workers' && hit && <Button size="small" type="text" icon={Play} className={rolesStyles.roleResume} aria-label={`恢复派发 ${id}`} loading={editor.resuming === id} disabled={policy.busy || (!!editor.resuming && editor.resuming !== id)} onClick={() => void editor.resume(id, hit)}>恢复派发</Button>}
              </div>
            </SortableList.Item>;
          }}
          renderOverlay={({ id }) => {
            const item = config[section][id];
            return <div className={rolesStyles.roleOverlay}>
              <strong className={styles.wrap}>{id}</strong>
              <span className={`${styles.wrap} ${styles.meta}`}>{item ? `${roleChannelNames(config, item)} · ${item.model || '未填模型'}` : ''}</span>
            </div>;
          }}
        />}
      </nav>
      <div ref={editorPane} tabIndex={-1}><Surface padded>
        <RoleEditor section={section} policy={policy} current={current} editor={editor} freeProbe={freeProbe} onAdd={add} />
      </Surface></div>
    </div>
  </>;
}
