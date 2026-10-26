import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** Bot 页：顶部状态块 + 设置分组，样式只写 StyleX 长写属性与 cssVar token。 */
const NARROW = '@media (max-width: 767.98px)';

export const botStyles = stylex.create({  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    minInlineSize: 0,
    maxInlineSize: 960,
  },
  status: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minInlineSize: 0,
    paddingBlock: 12,
    paddingInline: 16,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorBgContainer,
  },
  statusRow: {
    display: 'flex',
    flexWrap: 'wrap',
    rowGap: 8,
    columnGap: 16,
    alignItems: 'center',
    minInlineSize: 0,
  },
  statusItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
  },
  statusActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    marginInlineStart: 'auto',
  },
  groups: {
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
    minInlineSize: 0,
  },
  footer: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minInlineSize: 0,
  },
  control: {
    inlineSize: '100%',
  },
  wideControl: {
    inlineSize: '100%',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    /* Switches keep an intrinsic size: end-align them with the inputs' right
       edge, like the settings page row control (justify flex-end) does;
       stacked narrow rows start controls at the left on both pages. */
    alignItems: { default: 'flex-end', [NARROW]: 'flex-start' },
    gap: 4,
    inlineSize: '100%',
    maxInlineSize: 360,
    minInlineSize: 0,
  },
  error: {
    margin: 0,
    alignSelf: 'flex-start',
    fontSize: cssVar.fontSizeSM,
    color: cssVar.colorErrorText,
    overflowWrap: 'anywhere',
  },
  hint: {
    margin: 0,
    alignSelf: 'flex-start',
    fontSize: cssVar.fontSizeSM,
    color: cssVar.colorTextSecondary,
  },
  loading: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    paddingBlock: 12,
    paddingInline: 0,
  },
  workspaces: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    inlineSize: '100%',
    maxInlineSize: 360,
    minInlineSize: 0,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 0,
    margin: 0,
    listStyle: 'none',
  },
  directory: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
  },
  directoryPath: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    minInlineSize: 0,
    overflowWrap: 'anywhere',
  },
  fieldset: {
    borderWidth: 0,
    padding: 0,
    margin: 0,
    minInlineSize: 0,
    inlineSize: '100%',
  },
  conflictAction: {
    marginInlineStart: 8,
  },
});
