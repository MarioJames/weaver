import * as stylex from '@stylexjs/stylex';

const COMPACT_HEADER = '@media (max-width: 600px)';

/** The app shell: brand lockup, a definite-height content frame and the page column inside it. */
export const shellStyles = stylex.create({
  shell: {
    blockSize: '100%',
  },
  brandLockup: {
    display: 'block',
    flexShrink: 0,
    inlineSize: 128,
    blockSize: 'auto',
    objectFit: 'contain',
  },
  mark: {
    display: 'block',
    flexShrink: 0,
    inlineSize: 24,
    blockSize: 24,
    objectFit: 'contain',
  },
  headerTarget: {
    flex: '1 1 0',
    minInlineSize: 0,
  },
  pageHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    minInlineSize: 0,
    flexWrap: { default: 'nowrap', [COMPACT_HEADER]: 'wrap' },
    rowGap: { default: 16, [COMPACT_HEADER]: 8 },
  },
  pageTitle: {
    flex: 'none',
    margin: 0,
    fontSize: 16,
    fontWeight: 600,
    lineHeight: 1.4,
  },
  pageActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 'none',
    marginInlineStart: 'auto',
    maxInlineSize: '100%',
    overflowX: 'auto',
    inlineSize: { default: 'auto', [COMPACT_HEADER]: '100%' },
  },
  /**
   * The shell's main box is the page scroller. This frame owns the height a
   * MasterDetail fills; its panes then scroll instead of the page.
   */
  content: {
    display: 'flex',
    flexDirection: 'column',
    flex: 'none',
    gap: 24,
    blockSize: '100%',
    minBlockSize: 0,
    minInlineSize: 0,
  },
});
