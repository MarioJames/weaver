import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { TitleWithTips } from '@lobehub/ui/dashboard';
import { settingRowStyles } from './setting-row-style';

export interface SettingRowProps {
  label: ReactNode;
  tips?: ReactNode;
  hint?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}

/** Label and explanation on the left, the control on the right; stacked when the row is narrow. */
export function SettingRow({ label, tips, hint, status, children }: SettingRowProps) {
  return <div {...stylex.props(settingRowStyles.row)}>
    <div {...stylex.props(settingRowStyles.labels)}>
      <div {...stylex.props(settingRowStyles.labelLine)}>
        {tips ? <TitleWithTips title={label} tips={tips} /> : label}
        {status}
      </div>
      {hint !== undefined && <div {...stylex.props(settingRowStyles.hint)}>{hint}</div>}
    </div>
    <div {...stylex.props(settingRowStyles.control)}>{children}</div>
  </div>;
}
