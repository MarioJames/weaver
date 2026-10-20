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
  warn: css`
    color: ${cssVar.colorWarningText};
  `,
}));
