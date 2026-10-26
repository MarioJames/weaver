import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const statusBadgeStyles = stylex.create({
  dotBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    maxInlineSize: '100%',
    minInlineSize: 0,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  },
  dot: {
    flexShrink: 0,
    inlineSize: 6,
    blockSize: 6,
    borderRadius: '50%',
    backgroundColor: cssVar.colorTextQuaternary,
    '[data-tone="processing"]': { backgroundColor: cssVar.colorPrimary },
    '[data-tone="warning"]': { backgroundColor: cssVar.colorWarning },
    '[data-tone="orange"]': { backgroundColor: cssVar.orange },
    '[data-tone="volcano"]': { backgroundColor: cssVar.volcano },
    '[data-tone="success"]': { backgroundColor: cssVar.colorSuccess },
    '[data-tone="error"]': { backgroundColor: cssVar.colorError },
  },
  label: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
});
