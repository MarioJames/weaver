import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const composerStyles = stylex.create({
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginSM,
    inlineSize: '100%',
    minInlineSize: 0,
    maxBlockSize: 'calc(100dvh - 160px)',
    overflow: 'hidden',
  },
  fieldControl: {
    inlineSize: '100%',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    lineHeight: 'inherit',
  },
  scroll: {
    flex: '1 1 auto',
    minBlockSize: 0,
    overflowY: 'auto',
    paddingBlockEnd: cssVar.paddingSM,
  },
  /** Form.Field already pads itself between fields; the fieldset adds nothing on top. */
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    minInlineSize: 0,
    minBlockSize: 0,
    paddingBlock: 0,
    paddingInline: `${cssVar.paddingXXS} 0`,
    margin: 0,
    borderWidth: 0,
  },
  /** The chosen path plus, when allowed, a clear entry beside it: the directory button takes the remaining width. */
  directoryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: cssVar.marginXXS,
    minInlineSize: 0,
  },
  /** The chosen path reads like the inputs around it: from the start edge, one line, the rest ellipsized. */
  directoryButton: {
    flex: '1 1 auto',
    minInlineSize: 0,
    justifyContent: 'flex-start',
    textAlign: 'start',
  },
  directoryLabel: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The clear entry is an icon-only square: as tall as the directory button and exactly as wide. */
  directoryClear: {
    flex: 'none',
    aspectRatio: '1',
    paddingInline: 0,
    paddingBlock: 0,
  },
  directoryBrowser: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginMD,
    minInlineSize: 0,
    maxBlockSize: 'calc(100dvh - 220px)',
    overflowY: 'auto',
  },
  directorySection: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    minInlineSize: 0,
  },
  /** Earlier workspaces: the name first, the full path after it and ellipsized. */
  recentList: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXXS,
  },
  recentItem: {
    justifyContent: 'flex-start',
    minBlockSize: 32,
    flexShrink: 0,
  },
  recentName: {
    flex: 'none',
    minInlineSize: 0,
    maxInlineSize: '45%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: cssVar.colorText,
  },
  recentPath: {
    flex: '1 1 auto',
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: cssVar.colorTextTertiary,
    fontSize: cssVar.fontSizeSM,
    textAlign: 'start',
  },
  directoryEnter: {
    marginInlineStart: 'auto',
    color: cssVar.colorTextQuaternary,
  },
  directoryPath: {
    overflowWrap: 'anywhere',
  },
  directoryActions: {
    display: 'flex',
    gap: cssVar.marginSM,
  },
  directoryList: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXXS,
  },
  directoryEntry: {
    justifyContent: 'flex-start',
    minBlockSize: 32,
    flexShrink: 0,
  },
  footer: {
    position: 'relative',
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: cssVar.marginXS,
    flexShrink: 0,
    paddingBlock: `${cssVar.paddingSM} ${cssVar.paddingXXS}`,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: cssVar.colorBorderSecondary,
    backgroundColor: cssVar.colorBgElevated,
  },
});
