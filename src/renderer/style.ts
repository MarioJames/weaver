import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar, responsive }) => ({
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
  shell: css`
    block-size: 100%;
  `,
  mark: css`
    display: grid;
    flex-shrink: 0;
    place-items: center;
    inline-size: 24px;
    block-size: 24px;
    border-radius: ${cssVar.borderRadiusSM};
    background: ${cssVar.colorPrimary};
    color: ${cssVar.colorTextLightSolid};
    font-weight: 600;
  `,
  /** List on the left, the selected record on the right. Collapses to one column on narrow screens. */
  split: css`
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
    min-inline-size: 0;

    ${responsive.laptop} {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  /** The list stays in view while a long record scrolls the workspace. */
  listPane: css`
    position: sticky;
    inset-block-start: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-inline-size: 0;

    ${responsive.laptop} {
      position: static;
    }
  `,
  /** Every row takes the tallest card's height, so all engine cards line up. */
  cards: css`
    display: grid;
    grid-auto-rows: 1fr;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
    min-inline-size: 0;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    block-size: 100%;

    & > :last-child {
      flex: 1;
    }
  `,
  cardBody: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    block-size: 100%;
    min-inline-size: 0;
  `,
  /** Switches and the readiness note sit at the bottom edge of every card. */
  cardFoot: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-block-start: auto;
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  settings: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-inline-size: 720px;
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
  grow: css`
    flex: 1;
    min-inline-size: 180px;
  `,
  /** Two fields side by side; one column when the form is narrow. */
  pair: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    min-inline-size: 0;

    @media (max-width: 720px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  detail: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) 260px;
    gap: 16px;
    min-inline-size: 0;

    @media (max-width: 1100px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  /** Kanban: lanes side by side, scrolled sideways when they do not fit. */
  board: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-inline-size: 0;
  `,
  lanes: css`
    display: grid;
    grid-auto-columns: minmax(260px, 1fr);
    grid-auto-flow: column;
    gap: 12px;
    align-items: start;
    overflow-x: auto;
    padding-block-end: 4px;
  `,
  lane: css`
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillQuaternary};
  `,
  laneHead: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 6px;
  `,
  laneBody: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 8px 8px;
  `,
  taskCard: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;

    &:hover {
      border-color: ${cssVar.colorBorder};
      box-shadow: ${cssVar.boxShadowTertiary};
    }

    &[aria-current='true'] {
      border-color: ${cssVar.colorPrimaryBorder};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 1px;
    }
  `,
  /** A list entry: its enable switch, then a button that selects it. No outer frame. */
  roleItem: css`
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 10px;
    align-items: start;
    padding: 8px 10px;
    border-radius: ${cssVar.borderRadius};

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &[aria-current='true'] {
      background: ${cssVar.colorFillSecondary};
    }

    & > [role='switch'] {
      margin-block-start: 2px;
    }
  `,
  roleButton: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 2px;
      border-radius: ${cssVar.borderRadiusSM};
    }
  `,
  /** Setting label and description on the left, the control on the right. */
  setting: css`
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    min-inline-size: 0;
    padding-block: 12px;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }
  `,
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
  quotaWindow: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  `,
  numbers: css`
    font-variant-numeric: tabular-nums;
  `,
  wrap: css`
    overflow-wrap: anywhere;
    min-inline-size: 0;
  `,
  clip: css`
    overflow: auto;
    max-block-size: 280px;
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
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
  /** A model reply shown as a message card. */
  replyCard: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillQuaternary};

    &[data-ok='true'] {
      border-color: ${cssVar.colorSuccessBorder};
      background: ${cssVar.colorSuccessBg};
    }

    &[data-ok='false'] {
      border-color: ${cssVar.colorErrorBorder};
      background: ${cssVar.colorErrorBg};
    }
  `,
  replyText: css`
    margin: 0;
    font-size: 15px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,
  replyError: css`
    font-size: 13px;
    color: ${cssVar.colorErrorText};
  `,
  warn: css`
    color: ${cssVar.colorWarningText};
  `,
  tab: css`
    margin: 0;
    padding: 4px 8px;
    border: 0;
    border-radius: ${cssVar.borderRadiusSM};
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font: inherit;
    cursor: pointer;

    &[aria-selected='true'] {
      background: ${cssVar.colorFillSecondary};
      color: ${cssVar.colorText};
    }
  `,
}));
