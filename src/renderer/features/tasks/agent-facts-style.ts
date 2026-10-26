import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** The facts block: one compact key/value area. */
export const factsStyles = stylex.create({
  /** Two columns: the key keeps its own width, every value shares what is left of the line. */
  grid: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    gap: '4px 8px',
    alignItems: 'center',
    margin: 0,
    minInlineSize: 0,
  },
  /** A board card's facts: the same block at the size of the rest of its meta text. */
  gridCompact: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    gap: '2px 6px',
    alignItems: 'center',
    margin: 0,
    minInlineSize: 0,
    fontSize: 12,
  },
  /** The full block: Descriptions with room-keeping values (long paths and models ellipsize). */
  descriptions: {
    minInlineSize: 0,
  },
  label: {
    whiteSpace: 'nowrap',
  },
  content: {
    minInlineSize: 0,
    overflow: 'hidden',
  },
  /** A key: definition-list semantics without the user-agent indent or emphasis. */
  key: {
    margin: 0,
    color: cssVar.colorTextSecondary,
    fontWeight: 'normal',
    whiteSpace: 'nowrap',
  },
  /** A value: icon, text and the copy button in one centered row. */
  value: {
    display: 'flex',
    gap: 4,
    alignItems: 'center',
    margin: 0,
    minInlineSize: 0,
    color: cssVar.colorText,
  },
  /** The path gives the copy button its room and ellipsizes instead of overflowing. */
  path: {
    flex: '1 1 auto',
    minInlineSize: 0,
  },
  time: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
