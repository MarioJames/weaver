import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** Parent / sub agent pages: master-detail split, list entries and the model reply card. */
export const rolesStyles = stylex.create({
  /** List on the left, the selected record on the right. Collapses to one column on narrow screens. */
  split: {
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr)',
    gap: 16,
    alignItems: 'start',
    minInlineSize: 0,
    '@media (max-width: 991.98px)': {
      gridTemplateColumns: 'minmax(0, 1fr)',
    },
  },
  /** The list stays in view while a long record scrolls the workspace. */
  listPane: {
    position: 'sticky',
    insetBlockStart: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minInlineSize: 0,
    '@media (max-width: 991.98px)': {
      position: 'static',
    },
  },
  /** The sortable list keeps the pane's own spacing instead of the browser's list margin. */
  sortList: {
    marginBlock: 0,
  },
  /** A sortable list row: the drag handle, then the record. */
  sortItem: {
    minInlineSize: 0,
  },
  /** The independent drag handle. Touch drags move the row instead of scrolling the page. */
  roleGrip: {
    flex: 'none',
    marginBlockStart: 2,
    color: cssVar.colorTextTertiary,
    touchAction: 'none',
  },
  /** The same grip while another action holds the page: it keeps the row width but cannot start a drag. */
  roleGripOff: {
    display: 'inline-flex',
    flex: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    inlineSize: 44,
    blockSize: 44,
    marginBlockStart: 2,
    color: cssVar.colorTextQuaternary,
  },
  /** The drag preview shows the record's identity only, never copies its switches or buttons. */
  roleOverlay: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    boxSizing: 'border-box',
    inlineSize: '100%',
    paddingBlock: 8,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadius,
    backgroundColor: cssVar.colorBgElevated,
    boxShadow: cssVar.boxShadowSecondary,
  },
  /** Two fields side by side; one column when the form is narrow. */
  pair: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 12,
    minInlineSize: 0,
    '@media (max-width: 720px)': {
      gridTemplateColumns: 'minmax(0, 1fr)',
    },
  },
  /** The model/effort pair top-aligns when one side grows a hint line. */
  pairStart: {
    alignItems: 'start',
  },
  /** The parallel-cap input keeps its compact inline size beside its switch. */
  parallelInput: {
    inlineSize: 88,
  },
  /** The paused-dispatch notice sits off the fields below it. */
  blockNotice: {
    marginBlockEnd: 12,
  },
  /** A list entry: its enable switch, then a button that selects it. No outer frame. */
  roleItem: {
    display: 'grid',
    flex: 1,
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    gap: '4px 10px',
    alignItems: 'start',
    paddingBlock: 8,
    paddingInline: 10,
    borderRadius: cssVar.borderRadius,
    backgroundColor: {
      default: 'transparent',
      ':hover': cssVar.colorFillTertiary,
    },
    '[aria-current="true"]': {
      backgroundColor: cssVar.colorFillSecondary,
    },
  },
  /** The enable switch sits on the first text line, not above it. */
  roleSwitch: {
    marginBlockStart: 2,
  },
  roleButton: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minInlineSize: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    ':focus-visible': {
      outlineWidth: 2,
      outlineStyle: 'solid',
      outlineColor: cssVar.colorPrimaryBorder,
      outlineOffset: 2,
      borderRadius: cssVar.borderRadiusSM,
    },
  },
  /** The list entry's title row: the id, then the free-channel badge; the badge wraps to its own line before anything overflows. */
  roleTitle: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '2px 6px',
    alignItems: 'center',
    minInlineSize: 0,
  },
  /** The list entry's text button for resuming a paused worker: its own row under the note, never beside the switch or the tags. */
  roleResume: {
    gridColumn: 2,
    justifySelf: 'start',
    marginInlineStart: -8,
  },
  /** A list entry's pause: its kind as a tag, then the reason; the reason moves under the tag when the pane is narrow. */
  roleNote: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '2px 6px',
    alignItems: 'center',
    minInlineSize: 0,
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
  /** The reply header's route and timestamp stay on one line. */
  replyTime: {
    whiteSpace: 'nowrap',
  },
});
