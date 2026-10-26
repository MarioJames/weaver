import * as stylex from '@stylexjs/stylex';

/** The app shell: brand lockup in the navigation. */
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
});
