import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/**
 * One bordered panel with three columns per band: group context, field explanation, control.
 * The fills are the ordered `colorFill` ladder (one step lighter than the raw ladder: Tertiary on the group, Quaternary on the field, none on the control),
 * so the hierarchy reads the same in light and dark without any theme branch.
 * Borders take `colorBorder`, not the softer step: every separator here lands on a shaded fill.
 */
export const settingsStyles = stylex.create({
  surface: {
    containerType: 'inline-size',
    display: 'flex',
    flexDirection: 'column',
    /* The hidden overflow below drops this item's automatic min-size, so without the no-shrink
       rule the panel shrinks to the viewport and clips its last group instead of scrolling. */
    flexShrink: 0,
    overflow: 'hidden',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorder,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorBgContainer,
  },
  /** Group context on the left, its rows on the right; the two bands share the group height. */
  group: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(180px, 24%) minmax(0, 1fr)',
      '@container (max-width: 860px)': 'minmax(0, 1fr)',
    },
    alignItems: 'stretch',
    borderBlockStartWidth: {
      default: null,
      ':not(:first-child)': 1,
    },
    borderBlockStartStyle: {
      default: null,
      ':not(:first-child)': 'solid',
    },
    borderBlockStartColor: {
      default: null,
      ':not(:first-child)': cssVar.colorBorder,
    },
  },
  /** The column separator becomes the band separator once the group stacks. */
  groupCell: {
    justifyContent: 'flex-start',
    paddingBlock: 12,
    paddingInline: 20,
    backgroundColor: cssVar.colorBgContainer,
    borderInlineEndWidth: {
      default: 1,
      '@container (max-width: 860px)': 0,
    },
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: cssVar.colorBorder,
    borderBlockEndWidth: {
      default: null,
      '@container (max-width: 860px)': 1,
    },
    borderBlockEndStyle: {
      default: null,
      '@container (max-width: 860px)': 'solid',
    },
    borderBlockEndColor: {
      default: null,
      '@container (max-width: 860px)': cssVar.colorBorder,
    },
  },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    minInlineSize: 0,
  },
  /** Field text and control share one row; the control track is fixed so the separators line up across rows. */
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) minmax(240px, 400px)',
      '@container (max-width: 860px)': 'minmax(0, 1fr)',
    },
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    borderBlockStartWidth: {
      default: null,
      ':not(:first-child)': 1,
    },
    borderBlockStartStyle: {
      default: null,
      ':not(:first-child)': 'solid',
    },
    borderBlockStartColor: {
      default: null,
      ':not(:first-child)': cssVar.colorBorder,
    },
  },
  /** The control with its inline message underneath. */
  controlStack: {
    display: 'flex',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    flexDirection: 'column',
    gap: 4,
    minInlineSize: 0,
  },
  controlRow: {
    display: 'flex',
    flexWrap: 'nowrap',
    gap: 8,
    alignItems: 'center',
    minInlineSize: 0,
  },
  fieldCell: {
    paddingBlock: 12,
    paddingInline: 20,
    backgroundColor: cssVar.colorFillQuaternary,
    justifyContent: 'flex-start',
  },
  /** The control keeps its size at the column end; stacked, it starts the band instead. */
  controlCell: {
    display: 'flex',
    flexWrap: 'nowrap',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingBlock: 12,
    paddingInline: 20,
    borderInlineStartWidth: {
      default: 1,
      '@container (max-width: 860px)': 0,
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: cssVar.colorBorder,
    borderBlockStartWidth: {
      default: null,
      '@container (max-width: 860px)': 1,
    },
    borderBlockStartStyle: {
      default: null,
      '@container (max-width: 860px)': 'solid',
    },
    borderBlockStartColor: {
      default: null,
      '@container (max-width: 860px)': cssVar.colorBorder,
    },
  },
  outcome: {
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  minutesInput: {
    inlineSize: 120,
  },
  timezoneSelect: {
    inlineSize: '100%',
  },
});
