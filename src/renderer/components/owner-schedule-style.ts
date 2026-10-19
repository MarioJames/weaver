import { createStaticStyles } from 'antd-style';

export const scheduleStyles = createStaticStyles(({ css, cssVar }) => ({
  list: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) 72px max-content 24px;
    column-gap: ${cssVar.marginXS};
  `,
  columns: css`
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
  `,
  row: css`
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: center;
    gap: ${cssVar.marginXS};
  `,
  name: css`
    @media (max-width: 600px) { grid-column: 1 / -1; }
  `,
  controls: css`
    display: contents;
    > :first-child { grid-column: 2; }
  `,
  presets: css`
    display: inline-flex;
    flex-wrap: nowrap;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius};
    overflow: hidden;
    button { border-radius: 0; font: inherit; }
    button[aria-pressed="true"] { background: ${cssVar.colorFillSecondary}; color: ${cssVar.colorText}; }
    button + button { border-inline-start: 1px solid ${cssVar.colorBorder}; }
  `,
  heading: css`
    grid-column: 2;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
}));
