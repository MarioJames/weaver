import { createStaticStyles } from 'antd-style';

export const quotaStyles = createStaticStyles(({ css, cssVar }) => ({
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-inline-size: 0;
  `,
  title: css`
    margin: 0;
    font-size: 14px;
  `,
  provider: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-inline-size: 0;
    padding: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    &:last-child { border-block-end: 0; }
  `,
  windows: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    gap: 8px 16px;
    min-inline-size: 0;
  `,
  window: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-inline-size: 0;
  `,
  note: css`
    font-size: 12px;
    overflow-wrap: anywhere;
    min-inline-size: 0;
  `,
  numbers: css`
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  `,
}));
