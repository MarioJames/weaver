import { createStaticStyles } from 'antd-style';

/** Account quota window layout. */
export const engineStyles = createStaticStyles(({ css }) => ({
  quotaWindow: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  `,
}));
