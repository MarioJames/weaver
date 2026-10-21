import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, X } from 'lucide-react';
import { Button, Modal, Text } from '@lobehub/ui/base-ui';
import { Icon } from '@lobehub/ui';
import { command } from '../../api/commands';
import { notifyError } from '../../api/notify';
import { composerStyles } from './task-composer-style';

interface DirectoryListing { path: string; parent: string | null; directories: { name: string; path: string }[] }

const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path;

/** Clearing only empties the field: the picker modal never opens from it and the next save sends workspace null. */
export function clearWorkspace(onChange: (path: string) => void): void { onChange(''); }

/** After clearing, keyboard focus moves back to the directory button instead of dropping to body. */
export function focusDirectoryPicker(button: HTMLElement | null): void { button?.focus(); }

/**
 * Choose the project directory on the service host (a web file input cannot supply an absolute server path):
 * the directories earlier tasks already work in come first, then a browser for any other folder.
 * With `allowClear` a filled directory gains a clear entry beside it: drafts may leave the directory open.
 */
export function WorkspacePicker({ value, disabled, allowClear = false, recent = [], id, label = '选择目标项目目录', placeholder = '选择项目文件夹', confirmLabel = '选择此目录', onChange }: { value: string; disabled: boolean; allowClear?: boolean; recent?: string[]; id?: string; label?: string; placeholder?: string; confirmLabel?: string; onChange: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<string>();
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState('');
  const directoryButtonRef = useRef<HTMLButtonElement>(null);
  // A lock/close invalidates recent-directory checks already in flight, even if the picker reopens later.
  const selection = useRef({ disabled, open, epoch: 0 });
  if (selection.current.disabled !== disabled || selection.current.open !== open) {
    selection.current = { disabled, open, epoch: selection.current.epoch + 1 };
  }
  useEffect(() => () => { selection.current.epoch += 1; }, []);
  useEffect(() => { setChecking(''); }, [disabled, open]);
  const closePicker = () => { selection.current.open = false; selection.current.epoch += 1; setOpen(false); };
  const retry = () => { if (!selection.current.disabled && selection.current.open) setAttempt(value => value + 1); };
  useEffect(() => {
    if (!open || disabled) return;
    let current = true;
    setLoading(true); setError(''); setListing(undefined);
    void command<DirectoryListing>('workspaces.list', path ? { path } : {}).then(result => {
      if (current) setListing(result);
    }).catch(cause => { if (current) setError(String(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, disabled, path, attempt]);
  /** An earlier workspace may have been moved or deleted since: confirm it still opens before it becomes the target. */
  async function pickRecent(target: string) {
    if (selection.current.disabled || !selection.current.open) return;
    const mine = ++selection.current.epoch;
    const current = () => selection.current.epoch === mine && selection.current.open && !selection.current.disabled;
    setChecking(target);
    try {
      await command<DirectoryListing>('workspaces.list', { path: target });
      if (!current()) return;
      onChange(target);
      closePicker();
    } catch (cause) { if (current()) notifyError(cause, '这个工作目录已不可用'); }
    finally { if (current()) setChecking(''); }
  }
  return <>
    <div className={composerStyles.directoryRow}>
      <Button id={id} ref={directoryButtonRef} block className={composerStyles.directoryButton} title={value || undefined} disabled={disabled} aria-label={label} icon={value ? FolderOpen : Folder} onClick={() => { if (!selection.current.disabled) { setListing(undefined); setError(''); setLoading(true); setPath(value || undefined); setOpen(true); } }}>{value || placeholder}</Button>
      {allowClear && !!value && <Button htmlType="button" className={composerStyles.directoryClear} disabled={disabled} title="清除目标项目目录" aria-label="清除目标项目目录" icon={X} onClick={() => { if (!selection.current.disabled) { clearWorkspace(onChange); focusDirectoryPicker(directoryButtonRef.current); } }} />}
    </div>
    <Modal open={open} title={label} width={560} onCancel={closePicker} footer={<Button type="primary" disabled={loading || !!checking || !!error || !listing || disabled} onClick={() => { if (listing && !selection.current.disabled && selection.current.open) { onChange(listing.path); closePicker(); } }}>{confirmLabel}</Button>}>
      <div className={composerStyles.directoryBrowser}>
        {recent.length > 0 && <section aria-label="已有工作区" className={composerStyles.directorySection}>
          <Text strong>已有工作区</Text>
          <div className={composerStyles.recentList}>
            {recent.map(item => <Button key={item} block type="text" loading={checking === item} disabled={disabled || !!checking} title={item} aria-label={`使用工作区 ${item}`} className={composerStyles.recentItem} onClick={() => void pickRecent(item)}>
              <Icon icon={Folder} size="small" />
              <span className={composerStyles.recentName}>{baseName(item)}</span>
              <span className={composerStyles.recentPath}>{item}</span>
            </Button>)}
          </div>
        </section>}
        <section aria-label="浏览目录" className={composerStyles.directorySection}>
          <Text strong>浏览其他目录</Text>
          <Text className={composerStyles.directoryPath}>{listing?.path || path || '项目目录'}</Text>
          <div className={composerStyles.directoryActions}>
            <Button disabled={disabled || !!checking || loading || (!listing?.parent && !error)} onClick={() => setPath(listing?.parent ?? undefined)}>上一级</Button>
            <Button disabled={disabled || !!checking || loading} onClick={() => { setPath(undefined); setAttempt(value => value + 1); }}>起始目录</Button>
          </div>
          {error && <div role="alert"><Text type="danger">目录读取失败，可重试或返回起始目录。</Text><Button disabled={disabled || loading} onClick={retry}>重试</Button></div>}
          {loading && <Text role="status" type="secondary">正在读取目录…</Text>}
          {listing && <div className={composerStyles.directoryList}>
            {listing.directories.length ? listing.directories.map(directory => <Button key={directory.path} block type="text" disabled={disabled || !!checking} onClick={() => setPath(directory.path)}>
              <Icon icon={Folder} size="small" />
              <span className={composerStyles.recentName}>{directory.name}</span>
              <Icon icon={ChevronRight} size="small" className={composerStyles.directoryEnter} />
            </Button>) : <Text type="secondary">此目录没有可浏览的子目录，可直接选择当前目录。</Text>}
          </div>}
        </section>
      </div>
    </Modal>
  </>;
}
