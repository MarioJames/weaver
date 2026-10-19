import { createStaticStyles } from 'antd-style';

/** Facts block and the brand label it is built from: one compact key/value area. */
export const factsStyles = createStaticStyles(({ css, cssVar }) => ({
  /** Two columns: the key keeps its own width, every value shares what is left of the line. */
  grid: css`
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 8px;
    align-items: center;
    margin: 0;
    min-inline-size: 0;
  `,
  /** A board card's facts: the same block at the size of the rest of its meta text. */
  gridCompact: css`
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 2px 6px;
    align-items: center;
    margin: 0;
    min-inline-size: 0;
    font-size: 12px;
  `,
  /** The full block: Descriptions with room-keeping values (long paths and models ellipsize). */
  descriptions: css`
    min-inline-size: 0;
    dt { white-space: nowrap; }
    dd { min-inline-size: 0; overflow: hidden; }
    dd > time { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    dd > span { max-inline-size: 100%; }
  `,
  /** A key: definition-list semantics without the user-agent indent or emphasis. */
  key: css`
    margin: 0;
    color: ${cssVar.colorTextSecondary};
    font-weight: normal;
    white-space: nowrap;
  `,
  /** A value: icon, text and the copy button in one centered row. */
  value: css`
    display: flex;
    gap: 4px;
    align-items: center;
    margin: 0;
    min-inline-size: 0;
    color: ${cssVar.colorText};
  `,
  /** Keep the brand mark with a single-line, ellipsized name. */
  label: css`
    display: inline-block;
    max-inline-size: 100%;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    & > svg {
      flex: none;
      margin-inline-end: 4px;
      vertical-align: -0.15em;
    }
  `,
  /** The path gives the copy button its room and ellipsizes instead of overflowing. */
  path: css`
    flex: 1 1 auto;
    min-inline-size: 0;
  `,
}));
