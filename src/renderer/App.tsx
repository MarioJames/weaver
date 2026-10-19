import { useEffect, useState } from 'react';
import { Bot, Cpu, ListTodo, Settings2, UserRound } from 'lucide-react';
import { ConsoleBrand, ConsoleNav, ConsoleShell } from '@lobehub/ui/dashboard';
import { ToastHost } from '@lobehub/ui/base-ui';
import weaverIcon from './assets/weaver-icon.png';
import weaverLockup from './assets/weaver-lockup.svg';
import { useWorkbench } from './hooks/useWorkbench';
import { ownerKindLookup } from './task-view';
import { EnginesPage } from './pages/EnginesPage';
import { RolesPage } from './pages/RolesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';
import { styles } from './style';
import { usePolicyDraft } from './usePolicyDraft';

const PAGES = ['tasks', 'engines', 'owners', 'workers', 'settings'] as const;
type Page = typeof PAGES[number];

const NAVIGATION = [
  { href: 'tasks', label: '任务', icon: ListTodo },
  { href: 'engines', label: '引擎', icon: Cpu },
  { href: 'owners', label: '负责人', icon: UserRound },
  { href: 'workers', label: '工作代理', icon: Bot },
  { href: 'settings', label: '设置', icon: Settings2 },
];

function pageFromHash(): Page {
  const value = window.location.hash.replace(/^#\/?/, '');
  return (PAGES as readonly string[]).includes(value) ? value as Page : 'tasks';
}

/** The hash keeps the current page across reloads without a router. */
function usePage(): [Page, (next: Page) => void] {
  const [page, setPage] = useState(pageFromHash);
  useEffect(() => {
    const sync = () => {
      const next = pageFromHash();
      if (window.location.hash !== `#/${next}`) window.history.replaceState(null, '', `#/${next}`);
      setPage(next);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return [page, next => { window.location.hash = `/${next}`; }];
}

export function App() {
  const work = useWorkbench();
  const policy = usePolicyDraft();
  const [page, open] = usePage();
  const ownerKind = ownerKindLookup(policy.config);
  return <ConsoleShell
    className={styles.shell}
    storageKey="weaver-nav"
    brand={<ConsoleBrand label="Weaver 任务" logo={<>
      <img className={styles.brandLockup} src={weaverLockup} width={128} height={27} alt="" aria-hidden="true" draggable={false} />
      <img className={styles.mark} src={weaverIcon} width={24} height={24} alt="" aria-hidden="true" draggable={false} />
    </>} href="#/tasks" />}
    navigation={<ConsoleNav label="主导航" items={NAVIGATION} pathname={page} onNavigate={href => open(href as Page)} />}
    openNavigationLabel="打开导航" closeNavigationLabel="关闭导航" collapseLabel="收起导航" expandLabel="展开导航" skipToContentLabel="跳到内容"
  >
    <ToastHost position="bottom-right" />
    {page === 'tasks' ? <TasksPage work={work} ownerKind={ownerKind} />
      : page === 'engines' ? <EnginesPage policy={policy} />
        : page === 'owners' ? <RolesPage key="owners" section="owners" policy={policy} />
          : page === 'workers' ? <RolesPage key="workers" section="workers" policy={policy} />
            : <SettingsPage policy={policy} />}
  </ConsoleShell>;
}
