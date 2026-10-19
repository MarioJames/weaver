import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  header: css`
    display: flex;
    flex-wrap: nowrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: ${cssVar.marginSM};
  `,
  heading: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXS};
    min-inline-size: 0;
    flex: 1;
  `,
  actions: css`
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    align-items: flex-end;
    gap: ${cssVar.marginXS};
    button { font: inherit; }
  `,
  markdown: css`
    min-inline-size: 0;
    padding: ${cssVar.padding};
    line-height: 1.7;
    overflow-wrap: anywhere;
    &&& h1, &&& h2, &&& h3 {
      font-size: ${cssVar.fontSize};
      font-weight: 600;
      line-height: 1.7;
    }
  `,
  markdownClamped: css`
    max-block-size: calc(var(--summary-lines) * 1.7em + 2 * ${cssVar.padding});
    overflow: hidden;
  `,
  tabs: css`
    min-inline-size: 0;
    inline-size: 100%;
  `,
  tabList: css`
    overflow-x: auto;
    max-inline-size: 100%;
    flex-wrap: nowrap;
    button { flex-shrink: 0; font: inherit; }
    &[data-overflow='end'] { mask-image: linear-gradient(to right, ${cssVar.colorText} calc(100% - 24px), transparent); }
    &[data-overflow='start'] { mask-image: linear-gradient(to right, transparent, ${cssVar.colorText} 24px); }
    &[data-overflow='both'] { mask-image: linear-gradient(to right, transparent, ${cssVar.colorText} 24px, ${cssVar.colorText} calc(100% - 24px), transparent); }
  `,
  panel: css`
    min-inline-size: 0;
    padding-block-start: ${cssVar.paddingLG};
  `,
  overview: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginLG};
    min-inline-size: 0;
  `,
  list: css`
    margin: 0;
    padding-inline-start: ${cssVar.paddingLG};
    overflow-wrap: anywhere;
    line-height: 1.7;
  `,
  textBlock: css`
    overflow: hidden;
    min-inline-size: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillQuaternary};
  `,
  textHeader: css`
    display: flex;
    gap: ${cssVar.marginSM};
    align-items: center;
    justify-content: space-between;
    padding: ${cssVar.paddingSM} ${cssVar.padding};
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  textHeading: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXXS};
    min-inline-size: 0;
    overflow-wrap: anywhere;
  `,
  description: css`
    font-size: ${cssVar.fontSizeSM};
  `,
  activity: css`
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    min-inline-size: 0;
  `,
  clamped: css`
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
  `,
  textFooter: css`
    padding: ${cssVar.paddingXXS} ${cssVar.paddingSM};
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  textContent: css`
    margin: 0;
    padding: ${cssVar.padding};
    color: ${cssVar.colorText};
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 2;
  `,
  modalFooter: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${cssVar.marginXS};
    justify-content: flex-end;
  `,
  /** The header status tag keeps its spinner and label on one line. */
  statusTag: css`
    margin: 0;
  `,
}));
