import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** Parent / sub agent pages: page frame, list rows, editor sections and the model reply card. */
export const rolesStyles = stylex.create({
  /** Header, metrics and master-detail fill the shell; only the panes scroll. */
  page: {
    display: 'flex',
    flex: '1 1 0',
    flexDirection: 'column',
    gap: 12,
    blockSize: '100%',
    minBlockSize: 0,
    minInlineSize: 0,
    overflow: 'hidden',
  },
  body: {
    display: 'flex',
    flex: '1 1 0',
    flexDirection: 'column',
    minBlockSize: 0,
    minInlineSize: 0,
    overflow: 'hidden',
  },
  /** The list pane keeps its own scrolling body under a search toolbar. */
  listBody: {
    display: 'flex',
    flex: '1 1 0',
    flexDirection: 'column',
    minBlockSize: 0,
    minInlineSize: 0,
    // The first option starts below the toolbar border instead of touching it.
    paddingBlockStart: 8,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
  },
  search: {
    flex: '1 1 0',
    minInlineSize: 0,
  },
  listEmpty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: 24,
    minInlineSize: 0,
    textAlign: 'center',
  },
  /** One list row: switch, identity line, then accounts and model. */
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    inlineSize: '100%',
    minInlineSize: 0,
    // Same two-line rhythm as the workbench session rows: the option's own
    // 6px padding plus this inset keeps the selection wrapped around the row.
    paddingBlock: 2,
    paddingInline: 0,
  },
  switchWrap: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    paddingBlockStart: 2,
  },
  rowCopy: {
    display: 'flex',
    flex: '1 1 0',
    flexDirection: 'column',
    gap: 4,
    minInlineSize: 0,
  },
  rowHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
  },
  rowId: {
    flex: '1 1 auto',
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: cssVar.fontWeightStrong,
  },
  rowMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
    overflow: 'hidden',
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    lineHeight: 1.4,
  },
  rowMetaText: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  capTag: {
    flexShrink: 0,
  },
  /** A status dot with its label; the full reason stays on the row title. */
  status: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: 4,
    maxInlineSize: '100%',
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  },
  statusDot: {
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
  roleResume: {
    alignSelf: 'flex-start',
    marginInlineStart: -8,
  },
  /** The independent drag handle; touch drags reorder instead of scrolling the pane. */
  roleGrip: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    inlineSize: 20,
    blockSize: 20,
    padding: 0,
    borderWidth: 0,
    borderRadius: cssVar.borderRadiusSM,
    backgroundColor: 'transparent',
    color: cssVar.colorTextTertiary,
    cursor: 'grab',
    touchAction: 'none',
    ':hover': { color: cssVar.colorText, backgroundColor: cssVar.colorFillTertiary },
    ':focus-visible': {
      outlineWidth: 2,
      outlineStyle: 'solid',
      outlineColor: cssVar.colorPrimaryBorder,
      outlineOffset: 1,
    },
  },
  /** The same grip while searching or saving: it keeps the row width but cannot start a drag. */
  roleGripOff: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    inlineSize: 20,
    blockSize: 20,
    color: cssVar.colorTextQuaternary,
    cursor: 'not-allowed',
  },
  /** The dragged row stays in place, faded, until the drop reorders the draft. */
  rowDragging: {
    opacity: 0.4,
  },
  rowDropTarget: {
    backgroundColor: cssVar.colorFillTertiary,
  },
  /** Pane head: back (narrow), engine mark, id and status. */
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
    maxInlineSize: '100%',
  },
  headerName: {
    flex: '0 1 auto',
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerMeta: {
    flexShrink: 0,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
  },
  mobileBack: {
    flexShrink: 0,
  },
  /** Editor sections keep the settings-page rhythm: a 12px gap, not a separate card floor. */
  mainBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minInlineSize: 0,
    padding: 16,
  },
  sectionFields: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minInlineSize: 0,
  },
  /** Two fields side by side; one column when the pane is narrow. */
  pair: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 12,
    minInlineSize: 0,
    '@media (max-width: 720px)': {
      gridTemplateColumns: 'minmax(0, 1fr)',
    },
  },
  pairStart: {
    alignItems: 'start',
  },
  parallelInput: {
    inlineSize: 88,
  },
  inlineControl: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
  },
  fieldHint: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
  },
  /** A pause is page content, fixed at the top of the availability section. */
  blockNotice: {
    minInlineSize: 0,
  },
  relationGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minInlineSize: 0,
  },
  relationLabel: {
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    lineHeight: 1.5,
  },
  linkList: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    minInlineSize: 0,
  },
  taskList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    margin: 0,
    padding: 0,
    minInlineSize: 0,
    listStyle: 'none',
  },
  taskRow: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
  },
  taskTime: {
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  emptyPane: {
    display: 'flex',
    flex: '1 1 0',
    alignItems: 'center',
    justifyContent: 'center',
    minBlockSize: 0,
    padding: 24,
  },
  /** A model reply shown as a message card. */
  replyCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    paddingBlock: 12,
    paddingInline: 14,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorFillQuaternary,
    '[data-ok="true"]': {
      borderColor: cssVar.colorSuccessBorder,
      backgroundColor: cssVar.colorSuccessBg,
    },
    '[data-ok="false"]': {
      borderColor: cssVar.colorErrorBorder,
      backgroundColor: cssVar.colorErrorBg,
    },
  },
  replyText: {
    margin: 0,
    fontSize: 15,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  replyTime: {
    whiteSpace: 'nowrap',
  },
});
