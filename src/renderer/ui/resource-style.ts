import { createStaticStyles } from 'antd-style';

/** Shared chrome for resource pages (账号与渠道, 父/子 Agent): page frame, toolbar, bordered list, row actions and modal shells. Anything one feature owns stays in that feature's style file. */
export const resourceStyles = createStaticStyles(({ css, cssVar }) => ({
  /** Page column under the header: one gap rhythm for every block the page stacks. */
  page: css`
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 20px;
    min-inline-size: 0;
  `,
  /** Filter and secondary actions between the header and the list. */
  toolbar: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-block-end: 16px;
  `,
  /** One bordered container holding the resource rows. */
  list: css`
    flex: none;
    display: flex;
    flex-direction: column;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    overflow: hidden;
  `,
  /** Actions on one row: the enable switch and the row's text buttons. */
  rowActions: css`
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  `,
  /** Tall modal shell: never grows past the viewport, its body scrolls. */
  modal: css`
    max-block-size: calc(100dvh - 32px);
    min-block-size: 0;
  `,
  modalBody: css`
    min-block-size: 0;
    overflow: auto;
    overscroll-behavior: contain;
  `,
  modalFooter: css`
    flex-wrap: wrap;
  `,
  /** The save-state text in a policy page header keeps one width so the actions beside it never shift. */
  headerStatus: css`
    flex-shrink: 0;
    inline-size: 126px;
  `,
}));
