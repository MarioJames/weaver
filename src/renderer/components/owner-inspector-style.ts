import { createStaticStyles } from 'antd-style';

/** The 接续 tab: one status row, its launch line, and the dialog that starts a new owner. */
export const styles = createStaticStyles(({ css, cssVar }) => ({
  /** Owner and status on the left, the action on the right; wraps instead of squeezing on a narrow drawer. */
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    min-inline-size: 0;
  `,
  /** Brand mark, owner name and the status tag in one centered line. */
  lead: css`
    display: inline-flex;
    flex: 1 1 auto;
    gap: 8px;
    align-items: center;
    min-inline-size: 0;
  `,
  /** The owner name gives the tag its room and ellipsizes instead of overflowing. */
  owner: css`
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  `,
  /** Keeps the action against the line end when the row wraps. */
  action: css`
    flex: none;
    margin-inline-start: auto;
  `,
  /** One stacked column: status row, then the host line, then the launch result. */
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-inline-size: 0;
  `,
  /** The Herdr host line under the status row. */
  host: css`
    color: ${cssVar.colorTextSecondary};
    font-variant-numeric: tabular-nums;
  `,
  /** Dialog body: pick, one sentence, and the launch failure if there is one. */
  dialog: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-inline-size: 0;
  `,
  /** Profile option: brand mark and profile id in one row. */
  option: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;
    min-inline-size: 0;
  `,
  /** The pick fills the dialog width so a long profile id ellipsizes in the trigger. */
  pick: css`
    inline-size: 100%;
    min-inline-size: 0;
  `,
  /** A launch failure keeps its message and its retry button together. */
  failure: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid ${cssVar.colorErrorBorder};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorErrorText};
  `,
  /** Long host or command messages wrap inside the dialog. */
  wrap: css`
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,
}));
