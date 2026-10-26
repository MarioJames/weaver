import { useEffect, useState } from 'react';

/** The one route shape shared by the shell and every page that links across pages. */
export type Route =
  | { page: 'tasks'; view: 'board'; taskId?: string }
  | { page: 'tasks'; view: 'sessions'; sessionKey?: string; taskId?: string }
  | { page: 'tasks'; view: 'all'; taskId?: string }
  | { page: 'schedules' | 'owners' | 'workers' | 'channels'; id?: string }
  | { page: 'bots' }
  | { page: 'settings' };

const RESOURCE_PAGES = ['schedules', 'owners', 'workers', 'channels'] as const;
type ResourcePage = typeof RESOURCE_PAGES[number];

const ROUTE_EVENT = 'weaver:route';

function isResourcePage(value: string | undefined): value is ResourcePage {
  return !!value && (RESOURCE_PAGES as readonly string[]).includes(value);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function segments(value: string): string[] {
  return value.replace(/^[#/]+/, '').split('/').filter(Boolean).map(decode);
}

function tasksRoute(rest: string[]): Route {
  const view = rest[0];
  if (view === 'all') {
    return rest[1] === 't' && rest[2]
      ? { page: 'tasks', view: 'all', taskId: rest[2] }
      : { page: 'tasks', view: 'all' };
  }
  if (view === 's') {
    if (!rest[1]) return { page: 'tasks', view: 'sessions' };
    return rest[2] === 't' && rest[3]
      ? { page: 'tasks', view: 'sessions', sessionKey: rest[1], taskId: rest[3] }
      : { page: 'tasks', view: 'sessions', sessionKey: rest[1] };
  }
  // `#/tasks/t/<id>` opens one task over the board; bare `#/tasks` is the board itself.
  if (view === 't' && rest[1]) return { page: 'tasks', view: 'board', taskId: rest[1] };
  return { page: 'tasks', view: 'board' };
}

/**
 * Hash routes, parsed in one place. The hash wins; without one the pathname is
 * read so older `/channels`-style links still land on the same page. Unknown
 * pages fall back to the board; unknown ids stay in the URL for the page's
 * 「未找到」 empty state instead of silently jumping away.
 */
export function parseRoute(hash: string, pathname?: string): Route {
  const source = hash && hash !== '#' ? hash : pathname ?? '';
  const [page, ...rest] = segments(source);
  if (page === 'tasks') return tasksRoute(rest);
  if (isResourcePage(page)) {
    return rest[0] ? { page, id: rest[0] } : { page };
  }
  if (page === 'bots') return { page: 'bots' };
  if (page === 'settings') return { page: 'settings' };
  return { page: 'tasks', view: 'board' };
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

/** The canonical href for a route; every cross-page link and the shell use it. */
export function routeHref(route: Route): string {
  if (route.page === 'tasks') {
    if (route.view === 'all') return route.taskId ? `#/tasks/all/t/${encode(route.taskId)}` : '#/tasks/all';
    if (route.view === 'sessions') {
      if (!route.sessionKey) return route.taskId ? `#/tasks/t/${encode(route.taskId)}` : '#/tasks/s';
      return route.taskId
        ? `#/tasks/s/${encode(route.sessionKey)}/t/${encode(route.taskId)}`
        : `#/tasks/s/${encode(route.sessionKey)}`;
    }
    return route.taskId ? `#/tasks/t/${encode(route.taskId)}` : '#/tasks';
  }
  if (route.page === 'bots' || route.page === 'settings') return `#/${route.page}`;
  return route.id ? `#/${route.page}/${encode(route.id)}` : `#/${route.page}`;
}

function currentLocation(): { hash: string; pathname: string } {
  if (typeof window === 'undefined') return { hash: '', pathname: '' };
  return { hash: window.location.hash, pathname: window.location.pathname };
}

/** Subscribe to hash navigation; unknown pages and legacy pathnames parse the same way every time. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => {
    const { hash, pathname } = currentLocation();
    return parseRoute(hash, pathname);
  });
  useEffect(() => {
    const sync = () => {
      const { hash, pathname } = currentLocation();
      setRoute(parseRoute(hash, pathname));
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    window.addEventListener(ROUTE_EVENT, sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener(ROUTE_EVENT, sync);
    };
  }, []);
  return route;
}

/** Navigate through the hash; `replace` edits the current history entry without adding one. */
export function navigate(route: Route, options?: { replace?: boolean }): void {
  if (typeof window === 'undefined') return;
  const href = routeHref(route);
  if (options?.replace) {
    window.history.replaceState(null, '', `/${window.location.search}${href}`);
    window.dispatchEvent(new Event(ROUTE_EVENT));
    return;
  }
  window.location.hash = href.slice(1);
}
