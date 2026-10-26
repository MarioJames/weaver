import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const botStyles = stylex.create({
  surface: {
    containerType: 'inline-size',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    overflow: 'hidden',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorder,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorBgContainer,
  },
  tabList: {
    /* 渠道导航已在卡片之外：底线之外留出真正的空白，避免卡片贴着导航底线。 */
    marginBlockEnd: cssVar.marginSM,
    paddingBlockStart: 10,
    paddingInline: 20,
  },
  tabPanel: {
    paddingBlockStart: 0,
  },
  channel: {
    display: 'flex',
    flexDirection: 'column',
    minInlineSize: 0,
  },
  channelHeader: {
    display: 'flex',
    flexDirection: 'column',
    paddingBlock: 12,
    paddingInline: 20,
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: cssVar.colorBorder,
    backgroundColor: cssVar.colorFillQuaternary,
    overflowWrap: 'anywhere',
  },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    minInlineSize: 0,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) minmax(280px, 400px)',
      '@container (max-width: 860px)': 'minmax(0, 1fr)',
    },
    alignItems: 'stretch',
    minInlineSize: 0,
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
  fieldCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXXS,
    justifyContent: 'flex-start',
    minInlineSize: 0,
    paddingBlock: 12,
    paddingInline: 20,
    overflowWrap: 'anywhere',
  },
  controlCell: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-start',
    minInlineSize: 0,
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
  controlStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXXS,
    minInlineSize: 0,
  },
  controlRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cssVar.marginXS,
    alignItems: 'center',
    minInlineSize: 0,
  },
  error: {
    margin: 0,
    fontSize: cssVar.fontSizeSM,
    color: cssVar.colorErrorText,
    overflowWrap: 'anywhere',
  },
  loading: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cssVar.marginXS,
    alignItems: 'center',
    paddingBlock: 12,
    paddingInline: 20,
  },
  wrap: {
    minInlineSize: 0,
    overflowWrap: 'anywhere',
  },
  workspaces: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    inlineSize: '100%',
    minInlineSize: 0,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    padding: 0,
    margin: 0,
    listStyle: 'none',
  },
  directory: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cssVar.marginXS,
    minInlineSize: 0,
  },
  directoryPath: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    minInlineSize: 0,
    overflowWrap: 'anywhere',
  },
  directoryAction: {
    flexShrink: 0,
  },
  fullControl: {
    inlineSize: '100%',
    maxInlineSize: 320,
  },
  wideControl: {
    inlineSize: '100%',
    maxInlineSize: 360,
  },
  fieldset: {
    borderWidth: 0,
    padding: 0,
    margin: 0,
    minInlineSize: 0,
    inlineSize: '100%',
    maxInlineSize: 360,
  },
});
