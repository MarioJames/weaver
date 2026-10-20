import { createStaticStyles } from 'antd-style';

/** Layout and text helpers shared across pages; anything one feature owns lives in that feature's style file. */
export const styles = createStaticStyles(({ css, cssVar }) => ({
  srOnly: css`
    position: absolute;
    overflow: hidden;
    clip-path: inset(50%);
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    white-space: nowrap;
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-inline-size: 0;
  `,
  tight: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-inline-size: 0;
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    min-inline-size: 0;
  `,
  spread: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    min-inline-size: 0;
  `,
  numbers: css`
    font-variant-numeric: tabular-nums;
  `,
  wrap: css`
    overflow-wrap: anywhere;
    min-inline-size: 0;
  `,
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  error: css`
    margin: 0;
    font-size: 12px;
    color: ${cssVar.colorErrorText};
  `,
  /** A form section set off from the fields above it. */
  divided: css`
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  /** Keep the brand mark with a single-line, ellipsized name. */
  agentLabel: css`
    display: inline-block;
    max-inline-size: 100%;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    & > svg {
      flex: none;
      margin-inline-end: 4px;
      vertical-align: -0.15em;
    }
  `,
}));
