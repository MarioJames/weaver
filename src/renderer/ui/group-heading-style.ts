import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const groupHeadingStyles = stylex.create({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    fontWeight: cssVar.fontWeightStrong,
  },
  label: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  count: {
    flexShrink: 0,
    color: cssVar.colorTextTertiary,
    fontVariantNumeric: 'tabular-nums',
  },
});
