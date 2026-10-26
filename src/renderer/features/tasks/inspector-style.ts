import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** TaskInspector: header, banners, four tabs. The header owns the only close button. */
export const inspectorStyles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginLG,
    minInlineSize: 0,
    padding: cssVar.padding,
  },
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
    overflowWrap: 'anywhere',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: cssVar.marginXS,
    flexShrink: 0,
  },
  close: {
    flexShrink: 0,
  },
  banners: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    minInlineSize: 0,
  },
  bannerBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    minInlineSize: 0,
  },
  bannerRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cssVar.marginXS,
    alignItems: 'center',
  },
  bannerCode: {
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
  tabs: {
    minInlineSize: 0,
    inlineSize: '100%',
  },
  tabList: {
    overflowX: 'auto',
    maxInlineSize: '100%',
    flexWrap: 'nowrap',
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
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    minInlineSize: 0,
  },
  list: {
    margin: 0,
    paddingInlineStart: cssVar.paddingLG,
    overflowWrap: 'anywhere',
    lineHeight: 1.7,
  },
  activity: {
    display: 'block',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    minInlineSize: 0,
  },
  path: {
    minInlineSize: 0,
    overflow: 'hidden',
  },
  value: {
    display: 'inline-flex',
    gap: cssVar.marginXS,
    alignItems: 'center',
    minInlineSize: 0,
    maxInlineSize: '100%',
  },
  error: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    alignItems: 'flex-start',
    minInlineSize: 0,
  },
});
