import { createStaticStyles } from 'antd-style';

export const scheduleStyles = createStaticStyles(({ css, cssVar }) => ({
  /** Rows of a short editable list: one fixed height, hairline separators, no outer frame. */
  listRows: css`
    display: flex;
    flex-direction: column;
    min-inline-size: 0;

    &:empty {
      display: none;
    }
  `,
  listRow: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    min-block-size: 40px;
    padding-block: 4px;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }
  `,
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
  /** The pause reason beside its tag: one line, the rest in the tooltip. */
  reason: css`
    flex: 1 1 0;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${cssVar.colorTextSecondary};
    font-size: ${cssVar.fontSizeSM};
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
    &[data-locked] { border-color: ${cssVar.colorBorderSecondary}; }
    &[data-locked] button + button { border-inline-start-color: ${cssVar.colorBorderSecondary}; }
  `,
  heading: css`
    grid-column: 2;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
}));
