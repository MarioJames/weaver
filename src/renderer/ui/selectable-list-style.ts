import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const selectableListStyles = stylex.create({
  list: {
    display: 'flex',
    flexDirection: 'column',
    // basis auto, not 0: inside an indefinite-height ancestor (a block pane
    // body) a 0 basis collapses the list to its minimum and crushes every
    // option to minBlockSize, clipping two-line rows under the selection.
    flex: '1 1 auto',
    minBlockSize: 0,
    minInlineSize: 0,
    outline: 'none',
  },
  virtualList: {
    blockSize: '100%',
    minBlockSize: 0,
    overflowX: 'hidden',
    scrollbarGutter: 'stable',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    minInlineSize: 0,
  },
  heading: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    minInlineSize: 0,
    paddingBlock: 8,
    paddingInline: 12,
  },
  headingToggle: {
    display: 'flex',
    alignItems: 'center',
    flex: '1 1 0',
    gap: 4,
    minInlineSize: 0,
    paddingBlock: 8,
    paddingInline: 12,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    ':hover': { backgroundColor: cssVar.colorFillTertiary },
    ':focus-visible': { outlineWidth: 2, outlineStyle: 'solid', outlineColor: cssVar.colorPrimaryBorder, outlineOffset: -2 },
  },
  headingText: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    minBlockSize: 40,
    minInlineSize: 0,
    // No horizontal padding here: the body owns the 12px text inset, so the
    // selected background reaches both list edges on every page.
    paddingBlock: 6,
    paddingInline: 0,
    color: cssVar.colorText,
    cursor: 'pointer',
    backgroundColor: 'transparent',
    ':hover:not([aria-selected="true"])': { backgroundColor: cssVar.colorFillTertiary },
    '[aria-selected="true"]': { backgroundColor: cssVar.colorFillSecondary },
    ':focus-visible': { outlineWidth: 2, outlineStyle: 'solid', outlineColor: cssVar.colorPrimaryBorder, outlineOffset: -2 },
  },
  optionBody: {
    minInlineSize: 0,
    flex: '1 1 0',
    paddingInline: 12,
  },
  empty: {
    padding: 16,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
  },
});
