import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { paneStyles } from './pane-style';

export interface PaneProps {
  label: string;
  title?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

/** A pane with a fixed head, an optional toolbar, one scrolling body and a footer pinned to the bottom. */
export function Pane({ label, title, actions, toolbar, footer, children }: PaneProps) {
  return <section aria-label={label} {...stylex.props(paneStyles.root)}>
    {(title !== undefined || actions !== undefined) && <header {...stylex.props(paneStyles.header)}>
      <div {...stylex.props(paneStyles.heading)}>{title}</div>
      {actions !== undefined && <div {...stylex.props(paneStyles.actions)}>{actions}</div>}
    </header>}
    {toolbar !== undefined && <div {...stylex.props(paneStyles.toolbar)}>{toolbar}</div>}
    <div {...stylex.props(paneStyles.body)}>{children}</div>
    {footer !== undefined && <footer {...stylex.props(paneStyles.footer)}>{footer}</footer>}
  </section>;
}
