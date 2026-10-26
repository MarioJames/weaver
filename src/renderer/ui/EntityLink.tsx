import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { Route } from '../app/router';
import { routeHref } from '../app/router';
import { entityLinkStyles } from './entity-link-style';

export interface EntityLinkProps {
  route: Route;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}

/** A real hash link to another record, so it can be copied or opened in a new tab. */
export function EntityLink({ route, icon, children, title }: EntityLinkProps) {
  return <a href={routeHref(route)} title={title} {...stylex.props(entityLinkStyles.root)}>
    {icon}
    <span {...stylex.props(entityLinkStyles.text)}>{children}</span>
  </a>;
}
