import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const styles = stylex.create({
  /** Wide: the action column sits beside the heading; narrow (drawer ≤ 480px): the buttons wrap to a row below the title instead of squeezing it. */
  header: {
    containerType: 'inline-size',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: cssVar.marginSM,
  },
  heading: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    minInlineSize: 0,
    flex: 1,
    '@container (max-width: 480px)': {
      flexBasis: '100%',
    },
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    alignItems: 'flex-end',
    gap: cssVar.marginXS,
    '@container (max-width: 480px)': {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'flex-start',
    },
  },
  markdown: {
    minInlineSize: 0,
    padding: cssVar.padding,
    lineHeight: 1.7,
    overflowWrap: 'anywhere',
  },
  markdownClamped: {
    maxBlockSize: `calc(var(--summary-lines) * 1.7em + 2 * ${cssVar.padding})`,
    overflow: 'hidden',
  },
  summaryLines: (lines: number) => ({
    '--summary-lines': lines,
  }),
  tabs: {
    minInlineSize: 0,
    inlineSize: '100%',
  },
  tabList: {
    overflowX: 'auto',
    maxInlineSize: '100%',
    flexWrap: 'nowrap',
    '[data-overflow="end"]': { maskImage: `linear-gradient(to right, ${cssVar.colorText} calc(100% - 24px), transparent)` },
    '[data-overflow="start"]': { maskImage: `linear-gradient(to right, transparent, ${cssVar.colorText} 24px)` },
    '[data-overflow="both"]': { maskImage: `linear-gradient(to right, transparent, ${cssVar.colorText} 24px, ${cssVar.colorText} calc(100% - 24px), transparent)` },
  },
  tab: {
    flexShrink: 0,
  },
  panel: {
    minInlineSize: 0,
    paddingBlockStart: cssVar.paddingLG,
  },
  overview: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginLG,
    minInlineSize: 0,
  },
  list: {
    margin: 0,
    paddingInlineStart: cssVar.paddingLG,
    overflowWrap: 'anywhere',
    lineHeight: 1.7,
  },
  textBlock: {
    overflow: 'hidden',
    minInlineSize: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorFillQuaternary,
  },
  textBlockFlat: {
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: 'transparent',
  },
  textHeader: {
    display: 'flex',
    gap: cssVar.marginSM,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBlock: cssVar.paddingSM,
    paddingInline: cssVar.padding,
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: cssVar.colorBorderSecondary,
  },
  textHeaderFlat: {
    paddingBlockStart: 0,
    paddingInline: 0,
    borderBlockEndWidth: 0,
  },
  textHeading: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXXS,
    minInlineSize: 0,
    overflowWrap: 'anywhere',
  },
  description: {
    fontSize: cssVar.fontSizeSM,
  },
  activity: {
    display: 'block',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    minInlineSize: 0,
  },
  clamped: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  clampLines: (lines: number) => ({
    WebkitLineClamp: lines,
  }),
  textFooter: {
    paddingBlock: cssVar.paddingXXS,
    paddingInline: cssVar.paddingSM,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: cssVar.colorBorderSecondary,
  },
  textFooterFlat: {
    paddingInline: 0,
  },
  textContent: {
    margin: 0,
    padding: cssVar.padding,
    color: cssVar.colorText,
    fontFamily: cssVar.fontFamilyCode,
    fontSize: cssVar.fontSizeSM,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    tabSize: 2,
  },
  markdownFlat: {
    paddingInline: 0,
  },
  modalFooter: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cssVar.marginXS,
    justifyContent: 'flex-end',
  },
  /** The header status tag keeps its spinner and label on one line. */
  statusTag: {
    margin: 0,
  },
});
