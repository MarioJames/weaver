import { createStaticStyles } from 'antd-style';

export const composerStyles = createStaticStyles(({ css, cssVar }) => ({
  form: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginSM};
    inline-size: 100%;
    min-inline-size: 0;
    max-block-size: calc(100dvh - 160px);
    button, input, textarea { font: inherit; }
    input, textarea { inline-size: 100%; }
  `,
  body: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginSM};
    min-inline-size: 0;
    min-block-size: 0;
    overflow-y: auto;
    padding: 0 ${cssVar.paddingXXS} 0 0;
    margin: 0;
    border: 0;
    flex: 1 1 auto;
    > * { inline-size: 100%; min-inline-size: 0; }
  `,
  footer: css`
    position: sticky;
    inset-block-end: 0;
    flex-shrink: 0;
    padding-block-start: ${cssVar.paddingXS};
    background: ${cssVar.colorBgElevated};
  `,
}));
