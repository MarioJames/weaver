import * as stylex from '@stylexjs/stylex';

/** Account quota window layout. */
export const engineStyles = stylex.create({
  quotaWindow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minInlineSize: 0,
  },
});
