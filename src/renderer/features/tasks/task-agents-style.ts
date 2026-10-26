import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const styles = stylex.create({
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginSM,
    minInlineSize: 0,
    overflowWrap: 'anywhere',
  },
  /** An inline-block label in a table cell sits on the text baseline and makes its row taller than the others. */
  value: {
    display: 'flex',
    minInlineSize: 0,
  },
  children: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },
  child: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cssVar.marginXS,
    paddingBlock: cssVar.paddingSM,
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: cssVar.colorBorderSecondary,
  },
  link: {
    minInlineSize: 0,
    maxInlineSize: '100%',
    height: 'auto',
    whiteSpace: 'normal',
    textAlign: 'start',
    overflowWrap: 'anywhere',
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cssVar.marginXS,
  },
});
