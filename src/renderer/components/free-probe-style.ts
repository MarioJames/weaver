import { createStaticStyles } from 'antd-style';

export const probeStyles = createStaticStyles(({ css, cssVar }) => ({
  /** The next divided section starts a full step below the last history row. */
  panel: css`
    padding-block-end: ${cssVar.paddingSM};
  `,
  /** Descriptions whose long values (reasons, errors) ellipsize instead of widening the form. */
  descriptions: css`
    min-inline-size: 0;
    dt { white-space: nowrap; }
    dd { min-inline-size: 0; }
  `,
  /** A tag and the sentence that explains it, on one line while they fit. */
  state: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${cssVar.marginXXS} ${cssVar.marginXS};
    align-items: center;
    min-inline-size: 0;
  `,
  /** A tag, a duration and a time, with the error summary under them. */
  last: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXXS};
    min-inline-size: 0;
  `,
  history: css`
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    min-inline-size: 0;
  `,
  /** Outcome tag, then time and duration; failures carry their note on a second line. */
  entry: css`
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 2px ${cssVar.marginXS};
    align-items: center;
    padding-block: 6px;
    min-inline-size: 0;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }
  `,
  entryMeta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 0 ${cssVar.marginSM};
    min-inline-size: 0;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
  entryNote: css`
    grid-column: 2;
    min-inline-size: 0;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
    overflow-wrap: anywhere;
  `,
}));
