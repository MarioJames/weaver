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
  body: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginSM};
    min-inline-size: 0;
    min-block-size: 0;
    padding: 0 ${cssVar.paddingXXS} 0 0;
    margin: 0;
    border: 0;
    > * { inline-size: 100%; min-inline-size: 0; }
  `,
  footer: css`
    position: relative;
    flex-shrink: 0;
    padding-block: ${cssVar.paddingSM} ${cssVar.paddingXXS};
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgElevated};
  `,
}));
