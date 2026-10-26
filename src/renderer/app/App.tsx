import { useEffect } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ToastHost } from '@lobehub/ui';
import { ConsoleBrand, ConsoleNav, ConsoleShell, useConsoleShell } from '@lobehub/ui/dashboard';
import weaverIcon from '../assets/weaver-icon.png';
import weaverLockup from '../assets/weaver-lockup.svg';
import { useWorkbench } from '../features/tasks/useWorkbench';
import { attentionCount } from '../features/tasks/task-attention';
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
import { routeHref, useRoute } from './router';
import { blockedProfileCount, navigationGroups } from './navigation';

/** The rail keeps only the mark; the full lockup needs the expanded navigation width. */
function BrandLogo() {
  const { collapsed } = useConsoleShell();
  return collapsed
    ? <img {...stylex.props(shellStyles.mark)} src={weaverIcon} width={24} height={24} alt="" aria-hidden="true" draggable={false} />
    : <img {...stylex.props(shellStyles.brandLockup)} src={weaverLockup} width={128} height={27} alt="" aria-hidden="true" draggable={false} />;
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
  const route = useRoute();
  const ownerKind = ownerKindLookup(policy.config);
  const workerFreeChannel = freeChannelLookup(policy.config);
  const navigation = navigationGroups({
    attention: attentionCount(work.tasks, Date.now()),
    blockedOwners: blockedProfileCount(policy.snapshot?.owners),
    blockedWorkers: blockedProfileCount(policy.snapshot?.workers),
  });
  // The saved policy decides the time zone for the whole page; a draft elsewhere never moves it.
  return <TimeZoneProvider zone={displayTimeZone(policy.snapshot?.config)}><ConsoleShell
    {...stylex.props(shellStyles.shell)}
    storageKey="weaver-nav"
    brand={<ConsoleBrand label="Weaver" logo={<BrandLogo />} href={routeHref({ page: 'tasks', view: 'sessions' })} />}
    navigation={<ConsoleNav label="主导航" groups={navigation} defaultExpanded="all" pathname={routeHref(route)} />}
    openNavigationLabel="打开导航" closeNavigationLabel="关闭导航" collapseLabel="收起导航" expandLabel="展开导航" skipToContentLabel="跳到内容"
  >
    <ToastHost position="bottom-right" />
    <div {...stylex.props(shellStyles.content)}>
      {route.page === 'tasks' ? <TasksPage work={work} ownerKind={ownerKind} freeChannel={workerFreeChannel} />
        : route.page === 'schedules' ? <SchedulesPage onPolicyChanged={() => { void policy.load(); }} />
          : route.page === 'channels' ? <ChannelsPage policy={policy} />
            : route.page === 'owners' ? <RolesPage key="owners" section="owners" policy={policy} tasks={work.tasks} />
              : route.page === 'workers' ? <RolesPage key="workers" section="workers" policy={policy} tasks={work.tasks} />
                : route.page === 'bots' ? <BotsPage policy={policy} />
                  : <SettingsPage policy={policy} />}
    </div>
  </ConsoleShell></TimeZoneProvider>;
}
