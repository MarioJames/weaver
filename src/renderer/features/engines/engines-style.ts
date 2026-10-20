import { createStaticStyles } from 'antd-style';

/** The engines page: card grid, card body and foot, enable switch, quota window and stall history. */
export const engineStyles = createStaticStyles(({ css, cssVar }) => ({
  cards: css`display: grid; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); align-items: start; gap: 16px; min-inline-size: 0;`,
  enable: css`display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-inline-size: 0; max-inline-size: 190px; > :last-child { flex-shrink: 0; }`,
  version: css`white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-inline-size: 0;`,
  switchReason: css`color: ${cssVar.colorTextSecondary}; font-size: ${cssVar.fontSizeSM}; min-inline-size: 0; overflow: hidden; text-align: end; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;`,
  cardBody: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    block-size: 100%;
    min-inline-size: 0;
  `,
  /** Switches and the readiness note sit at the bottom edge of every card. */
  cardFoot: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-block-start: auto;
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  quotaWindow: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  `,
  /** Stall penalty history: a collapsed list under the penalty line, kept smaller than the card body. */
  stallHistory: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
    margin-block-start: 2px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    & > summary {
      cursor: pointer;
    }
  `,
}));
