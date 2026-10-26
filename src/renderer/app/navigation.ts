import { Bot, CalendarClock, KeyRound, ListTodo, MessageSquare, Settings2, UserRound } from 'lucide-react';
import type { ConsoleNavGroup } from '@lobehub/ui/dashboard';
import type { Availability } from '../../shared/contracts/policy';
import { routeHref } from './router';

export interface NavCounts {
  /** Tasks in the attention set; 0 hides the badge. */
  attention: number;
  /** Saved parent Agent profiles whose availability is blocked. */
  blockedOwners: number;
  /** Saved sub Agent profiles whose availability is blocked. */
  blockedWorkers: number;
}

const badge = (count: number) => (count > 0 ? { badge: count } : {});

/** Saved profiles whose availability is blocked; the badge never shows a zero. */
export function blockedProfileCount(profiles: Record<string, Availability> | undefined): number {
  return Object.values(profiles ?? {}).filter(profile => profile.status === 'blocked').length;
}

/** Grouped console navigation, all groups open by default. */
export function navigationGroups({ attention, blockedOwners, blockedWorkers }: NavCounts): ConsoleNavGroup[] {
  return [
    {
      key: 'work',
      label: '工作',
      items: [
        { href: routeHref({ page: 'tasks', view: 'board' }), label: '工作台', icon: ListTodo, ...badge(attention) },
        { href: routeHref({ page: 'schedules' }), label: '定时任务', icon: CalendarClock },
      ],
    },
    {
      key: 'orchestration',
      label: '编排',
      items: [
        { href: routeHref({ page: 'owners' }), label: '父 Agent', icon: UserRound, ...badge(blockedOwners) },
        { href: routeHref({ page: 'workers' }), label: '子 Agent', icon: Bot, ...badge(blockedWorkers) },
        { href: routeHref({ page: 'channels' }), label: '账号与渠道', icon: KeyRound },
      ],
    },
    {
      key: 'access',
      label: '接入',
      items: [{ href: routeHref({ page: 'bots' }), label: 'Bot', icon: MessageSquare }],
    },
    {
      key: 'system',
      label: '系统',
      items: [{ href: routeHref({ page: 'settings' }), label: '设置', icon: Settings2 }],
    },
  ];
}
