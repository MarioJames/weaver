import { createStaticStyles } from 'antd-style';

export const channelStyles = createStaticStyles(({ css, cssVar, responsive }) => ({
  list: css`display: flex; flex-direction: column; border: 1px solid ${cssVar.colorBorderSecondary}; border-radius: ${cssVar.borderRadiusLG}; background: ${cssVar.colorBgContainer}; overflow: hidden;`,
  row: css`display: grid; grid-template-columns: minmax(200px, 1.2fr) minmax(200px, 1fr) minmax(200px, 1fr) auto; align-items: start; gap: 16px; padding: 20px; & + & { border-block-start: 1px solid ${cssVar.colorBorderSecondary}; } ${responsive.md} { grid-template-columns: minmax(180px,1fr) minmax(180px,1fr); } ${responsive.sm} { grid-template-columns: 1fr; padding: 16px; }`,
  actions: css`display: flex; gap: 8px; align-items: center; flex-wrap: wrap;`,
  toolbar: css`display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-block-end: 16px;`,
  error: css`color: ${cssVar.colorErrorText}; overflow-wrap: anywhere;`,
  native: css`font-family: ${cssVar.fontFamilyCode};`,
}));
