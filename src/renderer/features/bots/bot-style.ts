import { createStaticStyles } from 'antd-style';

export const botStyles = createStaticStyles(({ css, cssVar }) => ({
  workspaces: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXS};
    inline-size: 100%;
    min-inline-size: 0;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXS};
    padding: 0;
    margin: 0;
    list-style: none;
  `,
  directory: css`
    display: flex;
    align-items: flex-start;
    gap: ${cssVar.marginXS};
    min-inline-size: 0;

    > :first-child {
      flex: 1 1 auto;
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }

    > button { flex: none; }
  `,
}));
