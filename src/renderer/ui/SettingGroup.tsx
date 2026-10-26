import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { TitleWithTips } from '@lobehub/ui/dashboard';
import { settingGroupStyles } from './setting-group-style';

export interface SettingGroupProps {
  title: ReactNode;
  tips?: ReactNode;
  children: ReactNode;
}

/** A titled group of setting rows; the explanation lives in the tooltip, not the page. */
export function SettingGroup({ title, tips, children }: SettingGroupProps) {
  return <section {...stylex.props(settingGroupStyles.root)}>
    <header {...stylex.props(settingGroupStyles.title)}>
      {tips ? <TitleWithTips title={title} tips={tips} /> : title}
    </header>
    <div {...stylex.props(settingGroupStyles.body)}>{children}</div>
  </section>;
}
