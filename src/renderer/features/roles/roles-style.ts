import { createStaticStyles } from 'antd-style';

/** Parent / sub agent pages: master-detail split, list entries and the model reply card. */
export const rolesStyles = createStaticStyles(({ css, cssVar, responsive }) => ({
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
  /** The sortable list keeps the pane's own spacing instead of the browser's list margin. */
  sortList: css`
    margin-block: 0;
  `,
  /** A sortable list row: the drag handle, then the record. */
  sortItem: css`
    min-inline-size: 0;
  `,
  /** The independent drag handle. Touch drags move the row instead of scrolling the page. The DragHandle also carries touch-action inline: static-render tests can only see inline styles, never classes. */
  roleGrip: css`
    flex: none;
    margin-block-start: 2px;
    color: ${cssVar.colorTextTertiary};
    touch-action: none;
  `,
  /** The same grip while another action holds the page: it keeps the row width but cannot start a drag. */
  roleGripOff: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    inline-size: 44px;
    block-size: 44px;
    margin-block-start: 2px;
    color: ${cssVar.colorTextQuaternary};
  `,
  /** The drag preview shows the record's identity only, never copies its switches or buttons. */
  roleOverlay: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    box-sizing: border-box;
    inline-size: 100%;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
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
  /** The model/effort pair top-aligns when one side grows a hint line. */
  pairStart: css`
    align-items: start;
  `,
  /** The parallel-cap input keeps its compact inline size beside its switch. */
  parallelInput: css`
    inline-size: 88px;
  `,
  /** The paused-dispatch notice sits off the fields below it. */
  blockNotice: css`
    margin-block-end: 12px;
  `,
  /** A list entry: its enable switch, then a button that selects it. No outer frame. */
  roleItem: css`
    display: grid;
    flex: 1;
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
  /** The list entry's title row: the id, then the free-channel badge; the badge wraps to its own line before anything overflows. */
  roleTitle: css`
    display: flex;
    flex-wrap: wrap;
    gap: 2px 6px;
    align-items: center;
    min-inline-size: 0;
  `,
  /** The list entry's text button for resuming a paused worker: its own row under the note, never beside the switch or the tags. */
  roleResume: css`
    grid-column: 2;
    justify-self: start;
    margin-inline-start: -8px;
  `,
  /** A list entry's pause: its kind as a tag, then the reason; the reason moves under the tag when the pane is narrow. */
  roleNote: css`
    display: flex;
    flex-wrap: wrap;
    gap: 2px 6px;
    align-items: center;
    min-inline-size: 0;
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
  /** The reply header's route and timestamp stay on one line. */
  replyTime: css`
    white-space: nowrap;
  `,
}));
