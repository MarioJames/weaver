import { createStaticStyles } from 'antd-style';

export const composerStyles = createStaticStyles(({ css, cssVar }) => ({
  form: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginSM};
    inline-size: 100%;
    min-inline-size: 0;
    max-block-size: calc(100dvh - 160px);
    overflow: hidden;
    button, input, textarea { font: inherit; }
    input, textarea { inline-size: 100%; }
  `,
  scroll: css`
    flex: 1 1 auto;
    min-block-size: 0;
    overflow-y: auto;
    padding-block-end: ${cssVar.paddingSM};
  `,
  /** Form.Field already pads itself between fields; the fieldset adds nothing on top. */
  body: css`
    display: flex;
    flex-direction: column;
    gap: 0;
    min-inline-size: 0;
    min-block-size: 0;
    padding: 0 ${cssVar.paddingXXS} 0 0;
    margin: 0;
    border: 0;
    > * { inline-size: 100%; min-inline-size: 0; }
  `,
  /** The chosen path reads like the inputs around it: from the start edge, one line, the rest ellipsized. */
  directoryButton: css`
    justify-content: flex-start;
    text-align: start;

    > span {
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  directoryBrowser: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginMD};
    min-inline-size: 0;
    max-block-size: calc(100dvh - 220px);
    overflow-y: auto;
  `,
  directorySection: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXS};
    min-inline-size: 0;
  `,
  /** Earlier workspaces: the name first, the full path after it and ellipsized. */
  recentList: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXXS};
  `,
  recentItem: css`
    justify-content: flex-start;
    min-block-size: 32px;
    flex-shrink: 0;

    > span:not(:first-child) { min-inline-size: 0; }
  `,
  recentName: css`
    flex: none;
    max-inline-size: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${cssVar.colorText};
  `,
  recentPath: css`
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${cssVar.colorTextTertiary};
    font-size: ${cssVar.fontSizeSM};
    text-align: start;
  `,
  directoryEnter: css`
    margin-inline-start: auto;
    color: ${cssVar.colorTextQuaternary};
  `,
  directoryPath: css`
    overflow-wrap: anywhere;
  `,
  directoryActions: css`
    display: flex;
    gap: ${cssVar.marginSM};
  `,
  directoryList: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXXS};
    button { justify-content: flex-start; min-block-size: 32px; flex-shrink: 0; }
  `,
  footer: css`
    position: relative;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: ${cssVar.marginXS};
    flex-shrink: 0;
    padding-block: ${cssVar.paddingSM} ${cssVar.paddingXXS};
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgElevated};
  `,
}));
