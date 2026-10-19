import { useEffect, useRef, useState } from 'react';
import { Bot, Cpu, GitBranch, ListTodo, Moon, PanelLeftClose, PanelLeftOpen, Sun, UserRound } from 'lucide-react';
import { ConsoleNav } from '@lobehub/ui/dashboard';
import { Alert, Button, Text } from '@lobehub/ui/base-ui';
import { command } from './commands';
import { NewTaskDialog } from './components/NewTaskDialog';
import { TaskBoard } from './components/TaskBoard';
import { TaskDetail } from './components/TaskDetail';
import { useWorkbench } from './hooks/useWorkbench';
import { EnginesPage } from './pages/EnginesPage';
import { RolesPage } from './pages/RolesPage';
import { RoutingPage } from './pages/RoutingPage';
import { styles } from './style';
import { usePolicyDraft } from './usePolicyDraft';

type Page = 'tasks' | 'engines' | 'owners' | 'workers' | 'routing';

function initialRail(): boolean {
  const stored = window.localStorage.getItem('weaver-nav');
  if (stored === 'rail') return true;
  if (stored === 'expanded') return false;
  return window.matchMedia('(max-width: 960px)').matches;
}

export function App({ mode, onMode }: { mode: 'light' | 'dark'; onMode: (mode: 'light' | 'dark') => void }) {
  const work = useWorkbench();
  const policy = usePolicyDraft();
  const [page, setPage] = useState<Page>('tasks');
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(initialRail);
  const [selected, setSelected] = useState<string>();
  const newTaskRef = useRef<HTMLButtonElement | HTMLAnchorElement>(null);
  const task = work.tasks.find(item => item.id === selected);
  const saveBar = page !== 'tasks';
  const syncLine = work.caps ? `${work.caps.maxParallel} 个并行槽位` : work.loading ? '正在连接' : '未连接';
  const syncState = work.busy ? '处理中' : work.syncState === 'live' ? '已同步' : work.syncState === 'stale' ? '同步中断' : work.syncState === 'disconnected' ? '未连接' : '同步中';
  useEffect(() => { window.localStorage.setItem('weaver-nav', collapsed ? 'rail' : 'expanded'); }, [collapsed]);
  function openPage(next: Page) {
    setPage(next);
    if (next === 'tasks') policy.setMessage('');
  }
  return <div className={styles.root}>
    <a className={styles.skip} href="#content">跳到内容</a>
    <aside className={styles.nav} data-collapsed={collapsed ? 'true' : 'false'}>
      <button type="button" className={styles.brand} aria-label="Weaver" onClick={() => openPage('tasks')}>
        <span className={styles.mark} aria-hidden="true">W</span>
        {!collapsed && <span>Weaver</span>}
      </button>
      <div className={styles.navBody}>
        <ConsoleNav collapsed={collapsed} label="主导航" pathname={`/${page}`} onNavigate={href => openPage(href.slice(1) as Page)} items={[
          { href: '/tasks', label: '任务', icon: ListTodo },
          { href: '/engines', label: '引擎', icon: Cpu },
          { href: '/owners', label: '负责人', icon: UserRound },
          { href: '/workers', label: '工作代理', icon: Bot },
          { href: '/routing', label: '路由与配额', icon: GitBranch },
        ]} />
      </div>
      <div className={styles.navTools}>
        <Button type="text" aria-label={collapsed ? '展开导航' : '收起导航'} icon={collapsed ? PanelLeftOpen : PanelLeftClose} onClick={() => setCollapsed(value => !value)} />
        <Button type="text" aria-label={mode === 'dark' ? '切换到浅色' : '切换到深色'} icon={mode === 'dark' ? Sun : Moon} onClick={() => onMode(mode === 'dark' ? 'light' : 'dark')} />
      </div>
      <div className={styles.sync} role="status">{collapsed ? syncState : `${syncLine} · ${syncState}`}</div>
    </aside>
    <main id="content" className={styles.main}>
      {work.error && <Alert type="error" title={work.error} closable action={<Button size="small" disabled={work.busy || work.loading} onClick={() => void work.refresh()}>重试连接</Button>} onClose={work.dismissError} />}
      {saveBar && <div className={styles.row}>
        <Button type="primary" loading={policy.busy} disabled={!policy.config || !policy.dirty} onClick={() => void policy.save()}>保存配置</Button>
        <Button disabled={policy.busy || policy.loading} onClick={() => void policy.load(true)}>放弃草稿并重新加载</Button>
        <Text type="secondary">{policy.dirty ? '有未保存修改' : `已保存版本 ${policy.snapshot?.revision ?? 0}`}{policy.conflict ? ' · 保存冲突，草稿仍保留' : ''}</Text>
      </div>}
      {policy.loadError && page !== 'tasks' && <Alert type="error" title={policy.loadError} action={<Button size="small" onClick={() => void policy.load(true)}>重试读取策略</Button>} />}
      {policy.saveError && page !== 'tasks' && <Alert type="error" title={policy.saveError} description={policy.issues.length ? policy.issues.map(issue => `${issue.path}: ${issue.message}`).join('\n') : undefined} />}
      {policy.message && page !== 'tasks' && <Text role="status" type="secondary">{policy.message}</Text>}
      {page === 'tasks' ? <div className={styles.split}>
        <div className={styles.column}>
          <div className={styles.row}><Button ref={newTaskRef} type="primary" disabled={work.busy || !work.caps || work.loading} onClick={() => setCreating(true)}>新建任务</Button></div>
          <TaskBoard tasks={work.tasks} selected={selected} loading={work.loading} onSelect={setSelected} />
        </div>
        <div className={styles.column}><TaskDetail key={selected ?? 'empty'} task={task} busy={work.busy || !work.caps} action={work.action} onStart={id => void work.action(() => window.weaver.startTask(id))} onCancel={id => void work.action(() => window.weaver.cancelTask(id))} onRetry={id => void work.action(async () => { const next = await command<{ id: string }>('tasks.retry', { taskId: id }, true); setSelected(next.id); })} /></div>
      </div> : page === 'engines' ? <EnginesPage policy={policy} /> : page === 'owners' ? <RolesPage key="owners" section="owners" policy={policy} /> : page === 'workers' ? <RolesPage key="workers" section="workers" policy={policy} /> : <RoutingPage policy={policy} />}
    </main>
    <NewTaskDialog open={creating} busy={work.busy} close={() => setCreating(false)} onClosed={() => newTaskRef.current?.focus()} create={input => work.action(async () => { const created = await command<{ id: string }>('tasks.create', { ...input }, true); setSelected(created.id); })} importTask={() => void work.action(async () => { const imported = await window.weaver.importTask(); if (imported) { setSelected(imported.id); setCreating(false); } })} />
  </div>;
}
