import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import { media } from '@lobehub/ui/stylex/media.stylex';

/** The schedules management page: toolbar, compact responsive rows, run history and form layout. */
export const schedulesStyles = stylex.create({
  /* Page body under PageHeader: filters above, cards below, one vertical stack like the tasks board. */
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginSM,
    minInlineSize: 0,
    maxInlineSize: '100%',
  },
  /* Desktop: search + type + refresh stay on one line; narrow screens wrap compactly without horizontal overflow. */
  toolbar: {
    display: 'flex',
    flexWrap: {
      default: 'nowrap',
      [media.mobile]: 'wrap',
    },
    gap: 8,
    alignItems: 'center',
    minInlineSize: 0,
    maxInlineSize: '100%',
  },
  search: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: {
      default: 200,
      [media.mobile]: '100%',
    },
    minInlineSize: 0,
    maxInlineSize: {
      default: 420,
      [media.mobile]: 'none',
    },
  },
  kindFilter: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    inlineSize: 132,
    minInlineSize: 0,
  },
  refresh: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  /* Responsive card grid: multiple columns in a 1280 content area, one column at 390 with no horizontal scroll. */
  list: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))',
    alignItems: 'start',
    gap: 12,
    minInlineSize: 0,
    maxInlineSize: '100%',
  },
  /* One schedule card: identity + status zones above, actions in their own footer zone below. */
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minInlineSize: 0,
    maxInlineSize: '100%',
    padding: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorBgContainer,
  },
  rowHead: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    minInlineSize: 0,
    maxInlineSize: '100%',
  },
  name: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    fontWeight: cssVar.fontWeightStrong,
    overflowWrap: 'anywhere',
    minInlineSize: 0,
  },
  /* Status + kind tags sit in their own scannable row so long names never squeeze them. */
  tags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    alignItems: 'center',
    minInlineSize: 0,
    maxInlineSize: '100%',
  },
  /** Actions live in the card footer, separated from identity/status and wrapping without squeezing. */
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 2,
    alignItems: 'center',
    minInlineSize: 0,
    maxInlineSize: '100%',
    marginBlockStart: 'auto',
    paddingBlockStart: 8,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: cssVar.colorBorderSecondary,
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    rowGap: 4,
    columnGap: 14,
    fontSize: cssVar.fontSizeSM,
    color: cssVar.colorTextSecondary,
    fontVariantNumeric: 'tabular-nums',
    minInlineSize: 0,
    maxInlineSize: '100%',
  },
  metaItem: {
    display: 'inline-flex',
    gap: 4,
    alignItems: 'baseline',
    minInlineSize: 0,
    maxInlineSize: '100%',
  },
  metaLabel: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  metaValue: {
    overflowWrap: 'anywhere',
    minInlineSize: 0,
  },
  staleNote: {
    margin: 0,
  },
  /** The history drawer keeps runs scannable: one bordered block per run, output below. */
  runs: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minInlineSize: 0,
  },
  run: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    paddingBlock: 10,
    paddingInline: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadius,
    minInlineSize: 0,
  },
  runHead: {
    display: 'flex',
    flexWrap: 'wrap',
    rowGap: 4,
    columnGap: 12,
    alignItems: 'center',
    minInlineSize: 0,
  },
  /** The form stacks its two-column pairs and drops to one column while narrow. */
  formBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minInlineSize: 0,
    paddingBlockEnd: 8,
  },
  pair: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(2, minmax(0, 1fr))',
      [media.mobile]: 'minmax(0, 1fr)',
    },
    columnGap: 12,
    minInlineSize: 0,
  },
  intervalInput: {
    inlineSize: 200,
  },
  footer: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
    paddingBlockStart: 12,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: cssVar.colorBorderSecondary,
  },
});
