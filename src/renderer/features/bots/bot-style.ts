import { createStaticStyles } from 'antd-style';

export const botStyles = createStaticStyles(({ css, cssVar }) => ({
  surface: css`
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
  tabList: css`
    /* 渠道导航已在卡片之外：左右与卡片内容对齐，下方留出与卡片的间距。 */
    padding: 10px 20px 12px;

    button { font-family: inherit; }
  `,
  tabPanel: css`
    && { padding-block-start: 0; }
  `,
  channel: css`
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  `,
  channelHeader: css`
    display: flex;
    flex-direction: column;
    padding: 12px 20px;
    border-block-end: 1px solid ${cssVar.colorBorder};
    background: ${cssVar.colorFillQuaternary};
    overflow-wrap: anywhere;
  `,
  rows: css`
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  `,
  row: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 400px);
    align-items: stretch;
    min-inline-size: 0;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorder};
    }

    @container (max-width: 860px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  fieldCell: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXXS};
    justify-content: flex-start;
    min-inline-size: 0;
    padding: 12px 20px;
    overflow-wrap: anywhere;
  `,
  controlCell: css`
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    min-inline-size: 0;
    padding: 12px 20px;
    border-inline-start: 1px solid ${cssVar.colorBorder};

    @container (max-width: 860px) {
      border-block-start: 1px solid ${cssVar.colorBorder};
      border-inline-start: 0;
    }
  `,
  controlStack: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXXS};
    min-inline-size: 0;
  `,
  controlRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${cssVar.marginXS};
    align-items: center;
    min-inline-size: 0;
  `,
  error: css`
    margin: 0;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorErrorText};
    overflow-wrap: anywhere;
  `,
  loading: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${cssVar.marginXS};
    align-items: center;
    padding: 12px 20px;
  `,
  wrap: css`
    min-inline-size: 0;
    overflow-wrap: anywhere;
  `,
  workspaces: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXS};
    inline-size: 100%;
    min-inline-size: 0;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXS};
    padding: 0;
    margin: 0;
    list-style: none;
  `,
  directory: css`
    display: flex;
    align-items: flex-start;
    gap: ${cssVar.marginXS};
    min-inline-size: 0;

    > :first-child {
      flex: 1 1 auto;
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }

    > button { flex: none; }
  `,
}));
