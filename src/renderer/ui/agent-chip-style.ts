import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const agentChipStyles = stylex.create({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxInlineSize: '100%',
    minInlineSize: 0,
    color: cssVar.colorText,
  },
  name: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
