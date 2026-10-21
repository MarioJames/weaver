import { createStaticStyles } from 'antd-style';

/** The schedules management page: toolbar, compact responsive rows, run history and form layout. */
export const schedulesStyles = createStaticStyles(({ css, cssVar, responsive }) => ({
  /* Page body under PageHeader: filters above, cards below, one vertical stack like the tasks board. */
  page: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginSM};
    min-inline-size: 0;
    max-inline-size: 100%;
  `,
  /* Desktop: search + type + refresh stay on one line; narrow screens wrap compactly without horizontal overflow. */
  toolbar: css`
    display: flex;
    flex-wrap: nowrap;
    gap: 8px;
    align-items: center;
    min-inline-size: 0;
    max-inline-size: 100%;

    ${responsive.mobile} {
      flex-wrap: wrap;
    }
  `,
  search: css`
    flex: 1 1 200px;
    min-inline-size: 0;
    max-inline-size: 420px;

    ${responsive.mobile} {
      flex-basis: 100%;
      max-inline-size: none;
    }
  `,
  kindFilter: css`
    flex: none;
    inline-size: 132px;
    min-inline-size: 0;
  `,
  refresh: css`
    flex: none;
  `,
  /* Responsive card grid: multiple columns in a 1280 content area, one column at 390 with no horizontal scroll. */
  list: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
    align-items: start;
    gap: 12px;
    min-inline-size: 0;
    max-inline-size: 100%;
  `,
  /* One schedule card: identity + status zones above, actions in their own footer zone below. */
  row: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-inline-size: 0;
    max-inline-size: 100%;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
  rowHead: css`
    display: flex;
    gap: 8px;
    align-items: center;
    min-inline-size: 0;
    max-inline-size: 100%;
  `,
  name: css`
    flex: 1 1 auto;
    font-weight: 600;
    overflow-wrap: anywhere;
    min-inline-size: 0;
  `,
  /* Status + kind tags sit in their own scannable row so long names never squeeze them. */
  tags: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    min-inline-size: 0;
    max-inline-size: 100%;
  `,
  /** Actions live in the card footer, separated from identity/status and wrapping without squeezing. */
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    align-items: center;
    min-inline-size: 0;
    max-inline-size: 100%;
    margin-block-start: auto;
    padding-block-start: 8px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  meta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
    font-variant-numeric: tabular-nums;
    min-inline-size: 0;
    max-inline-size: 100%;
  `,
  metaItem: css`
    display: inline-flex;
    gap: 4px;
    align-items: baseline;
    min-inline-size: 0;
    max-inline-size: 100%;

    & > span:first-child {
      flex: none;
    }

    & > span:last-child {
      overflow-wrap: anywhere;
      min-inline-size: 0;
    }
  `,
  staleNote: css`
    margin: 0;
  `,
  /** The history drawer keeps runs scannable: one bordered block per run, output below. */
  runs: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-inline-size: 0;
  `,
  run: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    min-inline-size: 0;
  `,
  runHead: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    align-items: center;
    min-inline-size: 0;
  `,
  /** The form stacks its two-column pairs and drops to one column while narrow. */
  formBody: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-inline-size: 0;
    padding-block-end: 8px;
  `,
  pair: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 12px;
    min-inline-size: 0;

    ${responsive.mobile} {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));
