import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lobehub/ui';
import { saveBarStyles } from './save-bar-style';

export interface SaveBarProps {
  dirty: boolean;
  saving?: boolean;
  message?: ReactNode;
  onSave(): void;
  onDiscard(): void;
  saveDisabled?: boolean;
}

/** The one draft footer: only present while there is something to save. */
export function SaveBar({ dirty, saving, message, onSave, onDiscard, saveDisabled }: SaveBarProps) {
  if (!dirty) return null;
  return <div role="region" aria-label="未保存的修改" {...stylex.props(saveBarStyles.bar)}>
    <div {...stylex.props(saveBarStyles.message)}>{message ?? '有未保存的修改'}</div>
    <div {...stylex.props(saveBarStyles.actions)}>
      <Button size="small" disabled={saving} onClick={onDiscard}>放弃修改</Button>
      <Button size="small" type="primary" loading={saving} disabled={saveDisabled || saving} onClick={onSave}>保存</Button>
    </div>
  </div>;
}
