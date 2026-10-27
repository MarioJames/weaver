import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { shellStyles } from './shell-style';

export const PageHeaderTarget = createContext<HTMLElement | null>(null);

/** Keep page-owned actions in the shell's top bar while retaining their state and handlers. */
export function PageHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  const target = useContext(PageHeaderTarget);
  const header = <div {...stylex.props(shellStyles.pageHeader)}>
    <h1 {...stylex.props(shellStyles.pageTitle)}>{title}</h1>
    {action && <div {...stylex.props(shellStyles.pageActions)}>{action}</div>}
  </div>;
  return target ? createPortal(header, target) : header;
}
