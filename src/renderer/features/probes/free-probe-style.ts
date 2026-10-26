import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const probeStyles = stylex.create({
  /** The next divided section starts a full step below the last history row. */
  panel: {
    paddingBlockEnd: cssVar.paddingSM,
  },
  /** Descriptions whose long values (reasons, errors) ellipsize instead of widening the form. */
  descriptions: {
    minInlineSize: 0,
  },
  descriptionsLabel: {
    whiteSpace: 'nowrap',
  },
  descriptionsContent: {
    minInlineSize: 0,
  },
  /** A tag and the sentence that explains it, on one line while they fit. */
  state: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cssVar.marginXXS} ${cssVar.marginXS}`,
    alignItems: 'center',
    minInlineSize: 0,
  },
  /** A tag, a duration and a time, with the error summary under them. */
  last: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXXS,
    minInlineSize: 0,
  },
  history: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    minInlineSize: 0,
  },
  /** Outcome tag, then time and duration; failures carry their note on a second line. */
  entry: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    columnGap: cssVar.marginXS,
    rowGap: 2,
    alignItems: 'center',
    paddingBlock: 6,
    minInlineSize: 0,
    borderBlockStartColor: { default: null, ':not(:first-child)': cssVar.colorBorderSecondary },
    borderBlockStartStyle: { default: null, ':not(:first-child)': 'solid' },
    borderBlockStartWidth: { default: null, ':not(:first-child)': 1 },
  },
  entryMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: cssVar.marginSM,
    minInlineSize: 0,
    fontSize: cssVar.fontSizeSM,
    color: cssVar.colorTextSecondary,
  },
  entryNote: {
    gridColumn: '2',
    minInlineSize: 0,
    fontSize: cssVar.fontSizeSM,
    color: cssVar.colorTextSecondary,
    overflowWrap: 'anywhere',
  },
});
