import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const scheduleStyles = stylex.create({
  /** Rows of a short editable list: one fixed height, hairline separators, no outer frame. */
  list: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 72px max-content 24px',
    columnGap: cssVar.marginXS,
    minInlineSize: 0,
  },
  /** The heading shares the rows' tracks so its weight label lines up with the input column. */
  columns: {
    display: 'grid',
    gridColumn: '1 / -1',
    gridTemplateColumns: 'subgrid',
  },
  row: {
    display: 'grid',
    gridColumn: '1 / -1',
    gridTemplateColumns: 'subgrid',
    alignItems: 'center',
    gap: cssVar.marginXS,
    minBlockSize: 40,
    paddingBlock: 4,
    '[data-locked]': {
      color: cssVar.colorTextTertiary,
    },
  },
  /** Hairline between rows, without a selector that reaches beyond this row. */
  rowDivider: {
    borderBlockStartWidth: 1,
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: cssVar.colorBorderSecondary,
  },
  /** The pause reason beside its tag: one line, the rest in the tooltip. */
  reason: {
    flex: '1 1 0',
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
  },
  name: {
    gridColumn: 1,
    minInlineSize: 0,
    '@media (max-width: 600px)': {
      gridColumn: '1 / -1',
    },
  },
  /** The weight input keeps its fixed column width. */
  weightInput: {
    gridColumn: 2,
    inlineSize: 72,
  },
  controls: {
    display: 'contents',
  },
  presets: {
    display: 'inline-flex',
    flexWrap: 'nowrap',
    gridColumn: 3,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorder,
    borderRadius: cssVar.borderRadius,
    overflow: 'hidden',
  },
  presetsLocked: {
    borderColor: cssVar.colorBorderSecondary,
  },
  presetButton: {
    borderWidth: 0,
    borderRadius: 0,
    font: 'inherit',
  },
  presetDivider: {
    borderInlineStartWidth: 1,
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: cssVar.colorBorder,
  },
  presetDividerLocked: {
    borderInlineStartColor: cssVar.colorBorderSecondary,
  },
  presetActive: {
    backgroundColor: {
      default: cssVar.colorFillSecondary,
      ':hover': cssVar.colorFillSecondary,
    },
    color: cssVar.colorText,
  },
  rowAction: {
    gridColumn: 4,
  },
  heading: {
    gridColumn: 2,
    fontSize: cssVar.fontSizeSM,
    color: cssVar.colorTextSecondary,
  },
});
