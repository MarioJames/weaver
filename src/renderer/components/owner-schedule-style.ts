import { createStaticStyles } from 'antd-style';

export const scheduleStyles = createStaticStyles(({ css, cssVar }) => ({
  row: css`
    flex-wrap: wrap;
    gap: ${cssVar.marginXS};
  `,
  controls: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${cssVar.marginXS};
    max-inline-size: 100%;
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
    align-self: flex-end;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
}));
