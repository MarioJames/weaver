import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** Styles for the task timeline (EventsPanel). Layout-only styles still come from ../style. */
export const styles = stylex.create({
  /** The vertical timeline: the connector line and node spacing come from Steps. */
  timeline: {
    minInlineSize: 0,
  },
  /** Steps indicator reduced to a bare dot: no ring, color from the node kind. */
  indicator: {
    inlineSize: 10,
    blockSize: 10,
    marginBlockStart: 6,
    marginInline: 6,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  /** Steps title cell: wraps, no nowrap, no per-state color. */
  nodeTitle: {
    overflowWrap: 'anywhere',
    whiteSpace: 'normal',
    color: cssVar.colorText,
    fontWeight: 'normal',
  },
  /** Dot of one event kind. */
  dot: {
    display: 'block',
    inlineSize: 10,
    blockSize: 10,
    borderRadius: '50%',
    backgroundColor: cssVar.colorTextQuaternary,
  },
  dotLifecycle: {
    backgroundColor: cssVar.colorPrimary,
  },
  dotSuccess: {
    backgroundColor: cssVar.colorSuccess,
  },
  dotError: {
    backgroundColor: cssVar.colorError,
  },
  dotWarning: {
    backgroundColor: cssVar.colorWarning,
  },
  dotInfo: {
    backgroundColor: cssVar.colorInfo,
  },
  /** Node head: tags and message on the left, relative time pinned right. */
  head: {
    display: 'flex',
    gap: cssVar.marginXS,
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    minInlineSize: 0,
  },
  headMain: {
    display: 'flex',
    flex: '1 1 auto',
    flexWrap: 'wrap',
    gap: `${cssVar.marginXXS} ${cssVar.marginXS}`,
    alignItems: 'center',
    minInlineSize: 0,
  },
  /** Time of a node: right aligned, never wraps. */
  time: {
    flex: 'none',
    marginInlineStart: 'auto',
    color: cssVar.colorTextTertiary,
    fontSize: cssVar.fontSizeSM,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  /** Neutralizes Tag's side margin inside flex rows. */
  tag: {
    flex: 'none',
    margin: 0,
  },
  /** Result / failure card shared shape. */
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    minInlineSize: 0,
    marginBlockStart: cssVar.marginXS,
    paddingBlock: cssVar.paddingSM,
    paddingInline: cssVar.padding,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: cssVar.borderRadiusLG,
  },
  cardSuccess: {
    borderColor: cssVar.colorSuccessBorder,
    backgroundColor: cssVar.colorSuccessBg,
  },
  cardError: {
    borderColor: cssVar.colorErrorBorder,
    backgroundColor: cssVar.colorErrorBg,
  },
  cardHead: {
    display: 'flex',
    gap: cssVar.marginXS,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardText: {
    margin: 0,
    color: cssVar.colorText,
    fontFamily: 'inherit',
    fontSize: cssVar.fontSize,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  cardClamped: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 6,
    overflow: 'hidden',
  },
  cardCode: {
    margin: 0,
    paddingBlock: cssVar.paddingXS,
    paddingInline: cssVar.paddingSM,
    maxBlockSize: 160,
    overflow: 'auto',
    borderRadius: cssVar.borderRadius,
    backgroundColor: cssVar.colorFillQuaternary,
    color: cssVar.colorTextSecondary,
    fontFamily: cssVar.fontFamilyCode,
    fontSize: cssVar.fontSizeSM,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
});
