import { useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { Button, Modal, Text } from '@lobehub/ui/base-ui';
import { Icon } from '@lobehub/ui';
import { command } from '../../api/commands';
import { notifyError, useNotifyError } from '../../api/notify';
import { composerStyles } from './task-composer-style';

interface DirectoryListing { path: string; parent: string | null; directories: { name: string; path: string }[] }

const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path;

/**
 * Choose the project directory on the service host (a web file input cannot supply an absolute server path):
 * the directories earlier tasks already work in come first, then a browser for any other folder.
 */
export function WorkspacePicker({ value, disabled, recent = [], onChange }: { value: string; disabled: boolean; recent?: string[]; onChange: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<string>();
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState('');
  useNotifyError(error, '目录读取失败', { label: '重试', run: () => setAttempt(value => value + 1) });
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true); setError(''); setListing(undefined);
    void command<DirectoryListing>('workspaces.list', path ? { path } : {}).then(result => {
      if (current) setListing(result);
    }).catch(cause => { if (current) setError(String(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, path, attempt]);
  /** An earlier workspace may have been moved or deleted since: confirm it still opens before it becomes the target. */
  async function pickRecent(target: string) {
    setChecking(target);
    try {
      await command<DirectoryListing>('workspaces.list', { path: target });
      onChange(target);
      setOpen(false);
    } catch (cause) { notifyError(cause, '这个工作目录已不可用'); }
    finally { setChecking(''); }
  }
  return <>
    <Button block className={composerStyles.directoryButton} title={value || undefined} disabled={disabled} aria-label="选择目标项目目录" icon={value ? FolderOpen : Folder} onClick={() => { setPath(value || undefined); setOpen(true); }}>{value || '选择项目文件夹'}</Button>
    <Modal open={open} title="选择目标项目目录" width={560} onCancel={() => setOpen(false)} footer={<Button type="primary" disabled={loading || !!error || !listing || disabled} onClick={() => { if (listing) { onChange(listing.path); setOpen(false); } }}>选择此目录</Button>}>
      <div className={composerStyles.directoryBrowser}>
        {recent.length > 0 && <section aria-label="已有工作区" className={composerStyles.directorySection}>
          <Text strong>已有工作区</Text>
          <div className={composerStyles.recentList}>
            {recent.map(item => <Button key={item} block type="text" loading={checking === item} disabled={!!checking} title={item} aria-label={`使用工作区 ${item}`} className={composerStyles.recentItem} onClick={() => void pickRecent(item)}>
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
            <Button disabled={loading || (!listing?.parent && !error)} onClick={() => setPath(listing?.parent ?? undefined)}>上一级</Button>
            <Button disabled={loading} onClick={() => { setPath(undefined); setAttempt(value => value + 1); }}>起始目录</Button>
          </div>
          {loading && <Text role="status" type="secondary">正在读取目录…</Text>}
          {listing && <div className={composerStyles.directoryList}>
            {listing.directories.length ? listing.directories.map(directory => <Button key={directory.path} block type="text" onClick={() => setPath(directory.path)}>
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
