import { createStaticStyles } from 'antd-style';

/** The app shell: brand lockup in the navigation. */
export const shellStyles = createStaticStyles(({ css }) => ({
  shell: css`
    block-size: 100%;
  `,
  brandLockup: css`
    display: block;
    flex-shrink: 0;
    inline-size: 128px;
    block-size: auto;
    object-fit: contain;

    [data-collapsed='true'] & {
      display: none;
    }
  `,
  mark: css`
    display: none;
    flex-shrink: 0;
    inline-size: 24px;
    block-size: 24px;
    object-fit: contain;

    [data-collapsed='true'] & {
      display: block;
    }
  `,
}));
