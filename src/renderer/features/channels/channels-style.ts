import { createStaticStyles } from 'antd-style';

/** What only the channels page owns: its row grid, the native-config font and the login link. Page frame, toolbar, list container, row actions and modal shells come from ui/resource-style. */
export const channelStyles = createStaticStyles(({ css, cssVar, responsive }) => ({
  row: css`
    display: grid;
    grid-template-columns: minmax(200px, 1.2fr) minmax(200px, 1fr) minmax(200px, 1fr) auto;
    align-items: start;
    gap: 16px;
    padding: 20px;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }

    ${responsive.md} {
      grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr);
    }

    ${responsive.sm} {
      grid-template-columns: 1fr;
      padding: 16px;
    }
  `,
  loginLink: css`
    color: ${cssVar.colorLink};
    overflow-wrap: anywhere;
  `,
  native: css`
    font-family: ${cssVar.fontFamilyCode};
  `,
}));
