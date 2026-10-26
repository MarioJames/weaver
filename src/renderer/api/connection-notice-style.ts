import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const connectionStyles = stylex.create({
  content: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    color: cssVar.colorText,
  },
});
