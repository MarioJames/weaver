import { createStaticStyles } from 'antd-style';

export const connectionStyles = createStaticStyles(({ css, cssVar }) => ({
  content: css`
    display: flex;
    align-items: center;
    gap: 12px;
    color: ${cssVar.colorText};
  `,
  details: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-inline-size: 0;
  `,
}));
