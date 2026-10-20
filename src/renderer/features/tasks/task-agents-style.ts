import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  section: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginSM};
    min-inline-size: 0;
    overflow-wrap: anywhere;
  `,
  /** An inline-block label in a table cell sits on the text baseline and makes its row taller than the others. */
  value: css`
    display: flex;
    min-inline-size: 0;
  `,
  children: css`
    list-style: none;
    margin: 0;
    padding: 0;
  `,
  child: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: ${cssVar.marginXS};
    padding-block: ${cssVar.paddingSM};
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  link: css`
    min-inline-size: 0;
    max-inline-size: 100%;
    height: auto;
    white-space: normal;
    text-align: start;
    overflow-wrap: anywhere;
  `,
  meta: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${cssVar.marginXS};
  `,
}));
