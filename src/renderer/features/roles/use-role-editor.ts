import { useEffect, useRef, useState } from 'react';
import { notifyError } from '../../api/notify';
import { deleteRole, fieldErrorText, renameRole, roleIdError, syncRoleEditor, type RoleSection } from '../../policy/policy-edit';
import { removeBlock, resumeAction, resumeWorker } from '../../policy/worker-resume';
import type { RoleField } from './roles-view';
import type { Block } from '../../../shared/contracts/policy';
import type { PolicyDraft } from '../../policy/usePolicyDraft';

/**
 * Editor-side orchestration shared by the roles list pane and the editor form: the rename being typed
 * (pendingId), the delete confirmation, and the enable/resume mutations. The page owns the selection; this
 * hook follows it. `onSelect` moves the selection when a rename commits or a delete succeeds.
 */
export function useRoleEditor(section: RoleSection, policy: PolicyDraft, current: string, onSelect: (id: string) => void) {
  const [pendingId, setPendingId] = useState(current);
  const [freshId, setFreshId] = useState('');
  const [idError, setIdError] = useState('');
  const [askDelete, setAskDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [deleteError, setDeleteError] = useState('');
  const [toggling, setToggling] = useState('');
  const [resuming, setResuming] = useState('');
  const [diagnostics, setDiagnostics] = useState<Record<string, string>>({});
  /** Required-field hints stay hidden until the user touches the field (or touches all of them by clicking save). */
  const [touched, setTouched] = useState<Set<RoleField>>(new Set());
  useEffect(() => {
    // The reset follows the selection (syncRoleEditor's pendingId is the synced id), not every draft edit.
    // A freshly added role is not inserted into the draft until the user types its ID: the field starts empty.
    setPendingId(current && current === freshId ? '' : syncRoleEditor(Object.keys(policy.config?.[section] ?? {}), current).pendingId);
    setIdError('');
    setAskDelete(false);
    setTouched(new Set());
  }, [section, current, freshId]); // policy.config intentionally not a dep
  function touch(field: RoleField) {
    setTouched(previous => previous.has(field) ? previous : new Set(previous).add(field));
  }
  /** A save click reveals every required hint at once; the button stays disabled while the client checks fail. */
  function touchAll() {
    setTouched(new Set<RoleField>(['channel', 'model', 'effort', 'workers']));
  }
  /** Remember the throwaway key of a just-added role so its ID field stays empty until the user names it. */
  function startNew(id: string) { setFreshId(id); }
  function acceptId(): boolean {
    const config = policy.config;
    if (!config) return false;
    if (!pendingId.trim()) { setIdError('填写配置 ID。'); return false; }
    const error = pendingId !== current && Object.hasOwn(policy.snapshot?.config[section] ?? {}, pendingId)
      ? '这个 ID 仍属于已保存的角色。请先保存或放弃已有改名，再使用这个 ID。'
      : roleIdError(section, pendingId, config, current);
    setIdError(error);
    if (error) notifyError(error, '配置 ID 有误');
    if (error) return false;
    if (!current) return false;
    if (pendingId === current) return true;
    policy.setConfig(renameRole(config, section, current, pendingId));
    setFreshId('');
    onSelect(pendingId);
    return true;
  }
  /** Saved roles switch immediately on top of the saved policy; a role that was never saved only changes the draft. */
  async function toggle(id: string, enabled: boolean) {
    const config = policy.config;
    if (!config) return;
    if (!policy.snapshot?.config[section][id]) { policy.setConfig({ ...config, [section]: { ...config[section], [id]: { ...config[section][id]!, enabled } } }); return; }
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
      setPendingId('');
      setFreshId('');
      onSelect('');
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
  async function resume(id: string, target: Block, worker = true) {
    if (resuming) return;
    setResuming(id);
    try {
      if (worker && resumeAction(policy.snapshot?.blocks ?? [], id, target) === 'unblock') await resumeWorker(id, policy);
      else {
        try { await policy.commit(doc => ({ ...doc, blocks: removeBlock(doc.blocks, target) })); }
        catch (error) { notifyError(error, '恢复派发失败'); }
      }
    } finally { setResuming(''); }
  }
  return { pendingId, setPendingId, freshId, startNew, idError, setIdError, acceptId, askDelete, setAskDelete, deleting, deleteError, setDeleteError, confirmDelete, toggling, toggle, resuming, resume, diagnostics, setDiagnostics, touched, touch, touchAll };
}

export type RoleEditorState = ReturnType<typeof useRoleEditor>;
