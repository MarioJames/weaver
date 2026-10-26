import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const entityLinkStyles = stylex.create({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxInlineSize: '100%',
    minInlineSize: 0,
    color: cssVar.colorLink,
    textDecorationLine: 'none',
    ':hover': {
      color: cssVar.colorLinkHover,
      textDecorationLine: 'underline',
    },
    ':focus-visible': {
      outlineWidth: 2,
      outlineStyle: 'solid',
      outlineColor: cssVar.colorPrimaryBorder,
      outlineOffset: 1,
    },
  },
  text: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
