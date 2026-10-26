import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const styles = stylex.create({
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
});
