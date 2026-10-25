import { useEffect, useState } from 'react';
import { Bot, CalendarClock, KeyRound, ListTodo, MessageSquare, Settings2, UserRound } from 'lucide-react';
import { ConsoleBrand, ConsoleNav, ConsoleShell } from '@lobehub/ui/dashboard';
import { ToastHost } from '@lobehub/ui/base-ui';
import weaverIcon from '../assets/weaver-icon.png';
import weaverLockup from '../assets/weaver-lockup.svg';
import { useWorkbench } from '../features/tasks/useWorkbench';
import { ownerKindLookup, freeChannelLookup } from '../features/tasks/task-view';
import { ChannelsPage } from '../features/channels/ChannelsPage';
import { RolesPage } from '../features/roles/RolesPage';
import { BotsPage } from '../features/bots/BotsPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { TasksPage } from '../features/tasks/TasksPage';
import { SchedulesPage } from '../features/schedules/SchedulesPage';
import { shellStyles } from './shell-style';
import { usePolicyDraft } from '../policy/usePolicyDraft';
import { displayTimeZone } from '../policy/policy-edit';
import { TimeZoneProvider } from '../format/timezone';

const PAGES = ['tasks', 'schedules', 'channels', 'owners', 'workers', 'bots', 'settings'] as const;
type Page = typeof PAGES[number];

const NAVIGATION = [
  { href: '/#/tasks', label: '任务', icon: ListTodo },
  { href: '/#/schedules', label: '定时任务', icon: CalendarClock },
  { href: '/#/channels', label: '账号与渠道', icon: KeyRound },
  { href: '/#/owners', label: '父 Agent', icon: UserRound },
  { href: '/#/workers', label: '子 Agent', icon: Bot },
  { href: '/#/bots', label: 'Bot', icon: MessageSquare },
  { href: '/#/settings', label: '设置', icon: Settings2 },
];

export function pageFromHash(): Page {
  const value = (window.location.hash || window.location.pathname).replace(/^[#/]*/, '');
  return (PAGES as readonly string[]).includes(value) ? value as Page : 'tasks';
}

/** The hash keeps the current page across reloads without a router. */
function usePage(): [Page, (next: Page) => void] {
  const [page, setPage] = useState(pageFromHash);
  useEffect(() => {
    const sync = () => {
      const next = pageFromHash();
      if (window.location.pathname !== '/' || window.location.hash !== `#/${next}`) window.history.replaceState(null, '', `/${window.location.search}#/${next}`);
      setPage(next);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return [page, next => { window.location.hash = `/${next}`; }];
}

export function App() {
  useEffect(() => {
    // Focus each newly opened panel once; keyboard navigation within it remains unrestricted.
    const focused = new WeakSet<HTMLElement>();
    const focusPanel = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      const panel = event.target.closest<HTMLElement>('[role="dialog"]');
      if (!panel || focused.has(panel)) return;
      focused.add(panel);
      const content = panel.querySelector<HTMLElement>('[data-channels-scroll]');
      const target = content?.parentElement ?? panel;
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', focusPanel);
    return () => document.removeEventListener('focusin', focusPanel);
  }, []);
  const work = useWorkbench();
  const policy = usePolicyDraft();
  const [page, open] = usePage();
  // Schedules link to agent run detail: the request survives until the task shows up in the list.
  const [requestedTaskId, setRequestedTaskId] = useState<string>();
  const ownerKind = ownerKindLookup(policy.config);
  const workerFreeChannel = freeChannelLookup(policy.config);
  // The saved policy decides the time zone for the whole page; a draft elsewhere never moves it.
  return <TimeZoneProvider zone={displayTimeZone(policy.snapshot?.config)}><ConsoleShell
    className={shellStyles.shell}
    storageKey="weaver-nav"
    brand={<ConsoleBrand label="Weaver 任务" logo={<>
      <img className={shellStyles.brandLockup} src={weaverLockup} width={128} height={27} alt="" aria-hidden="true" draggable={false} />
      <img className={shellStyles.mark} src={weaverIcon} width={24} height={24} alt="" aria-hidden="true" draggable={false} />
    </>} href="/#/tasks" />}
    navigation={<ConsoleNav label="主导航" items={NAVIGATION} pathname={`/#/${page}`} onNavigate={href => open(href.replace(/^\/#\//, '') as Page)} />}
    openNavigationLabel="打开导航" closeNavigationLabel="关闭导航" collapseLabel="收起导航" expandLabel="展开导航" skipToContentLabel="跳到内容"
  >
    <ToastHost position="bottom-right" />
    {page === 'tasks' ? <TasksPage work={work} ownerKind={ownerKind} freeChannel={workerFreeChannel}
        requestedTaskId={requestedTaskId} onRequestedTaskArrived={() => setRequestedTaskId(undefined)} />
      : page === 'schedules' ? <SchedulesPage
          onOpenTask={taskId => { setRequestedTaskId(taskId); open('tasks'); }}
          onPolicyChanged={() => { void policy.load(); }} />
        : page === 'channels' ? <ChannelsPage policy={policy} />
          : page === 'owners' ? <RolesPage key="owners" section="owners" policy={policy} />
            : page === 'workers' ? <RolesPage key="workers" section="workers" policy={policy} />
              : page === 'bots' ? <BotsPage policy={policy} />
                : <SettingsPage policy={policy} />}
  </ConsoleShell></TimeZoneProvider>;
}
