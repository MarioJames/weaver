import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const settingGroupStyles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minInlineSize: 0,
  },
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
    color: cssVar.colorText,
    fontSize: 14,
    fontWeight: cssVar.fontWeightStrong,
    lineHeight: 1.4,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    minInlineSize: 0,
  },
});
