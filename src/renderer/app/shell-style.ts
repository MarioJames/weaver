import * as stylex from '@stylexjs/stylex';

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
