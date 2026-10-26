import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** The 接续 tab: one status row, its launch line, and the dialog that starts a new owner. */
export const styles = stylex.create({
  /** Owner and status on the left, the action on the right; wraps instead of squeezing on a narrow drawer. */
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    minInlineSize: 0,
  },
  /** Brand mark, owner name and the status tag in one centered line. */
  lead: {
    display: 'inline-flex',
    flex: '1 1 auto',
    gap: 8,
    alignItems: 'center',
    minInlineSize: 0,
  },
  /** The owner name gives the tag its room and ellipsizes instead of overflowing. */
  owner: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600,
  },
  /** Keeps the action against the line end when the row wraps. */
  action: {
    flex: 'none',
    marginInlineStart: 'auto',
  },
  /** One stacked column: status row, then the host line, then the launch result. */
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minInlineSize: 0,
  },
  /** The Herdr host line under the status row. */
  host: {
    color: cssVar.colorTextSecondary,
    fontVariantNumeric: 'tabular-nums',
  },
  /** Dialog body: pick, one sentence, and the launch failure if there is one. */
  dialog: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minInlineSize: 0,
  },
  /** Profile option: brand mark and profile id in one row. */
  option: {
    display: 'inline-flex',
    gap: 6,
    alignItems: 'center',
    minInlineSize: 0,
  },
  /** The pick fills the dialog width so a long profile id ellipsizes in the trigger. */
  pick: {
    inlineSize: '100%',
    minInlineSize: 0,
  },
  /** A launch failure keeps its message and its retry button together. */
  failure: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    paddingBlock: 8,
    paddingInline: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorErrorBorder,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorErrorBg,
    color: cssVar.colorErrorText,
  },
  /** Long host or command messages wrap inside the dialog. */
  wrap: {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
});
