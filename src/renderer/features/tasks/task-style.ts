import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** Task board, facet filters, lanes, cards and the archive drawer. */
export const taskStyles = stylex.create({
  grow: {
    flex: 1,
    minInlineSize: 180,
  },
  /** Kanban: the facet block above one lane grid. */
  board: {
    display: 'flex',
    flex: '1 1 auto',
    flexDirection: 'column',
    gap: cssVar.marginSM,
    minInlineSize: 0,
  },
  /** Shopping-site facets: one fixed-label row per dimension, summary row always present. */
  facets: {
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    minInlineSize: 0,
    padding: cssVar.paddingSM,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorFillQuaternary,
  },
  facetRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cssVar.marginSM,
    minInlineSize: 0,
  },
  facetLabel: {
    flex: 'none',
    inlineSize: 64,
    minBlockSize: cssVar.controlHeightSM,
    display: 'flex',
    alignItems: 'center',
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
  },
  facetValues: {
    position: 'relative',
    display: 'flex',
    flex: '1 1 0',
    gap: cssVar.marginXS,
    alignItems: 'flex-start',
    minInlineSize: 0,
  },
  /** Hidden items retain measurable widths without occupying the chip line. */
  facetChips: {
    position: 'relative',
    display: 'flex',
    flex: '1 1 0',
    gap: `${cssVar.marginXXS} ${cssVar.marginXS}`,
    alignItems: 'flex-start',
    minInlineSize: 0,
    overflow: 'hidden',
    '[data-expanded="true"]': { flexWrap: 'wrap' },
  },
  facetItem: {
    display: 'inline-flex',
    flex: 'none',
    maxInlineSize: '100%',
    '[data-hidden="true"]': { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' },
  },
  /** Reserve the toggle slot even when unused, keeping measurements stable. */
  facetMore: {
    '[data-visible="false"]': { visibility: 'hidden', pointerEvents: 'none' },
  },
  facetEmpty: {
    display: 'flex',
    alignItems: 'center',
    minBlockSize: cssVar.controlHeightSM,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
  },
  facetChip: {
    display: 'inline-flex',
    flex: 'none',
    gap: 4,
    alignItems: 'center',
    maxInlineSize: '100%',
    blockSize: cssVar.controlHeightSM,
    paddingInline: cssVar.paddingXS,
    borderWidth: 0,
    borderRadius: cssVar.borderRadiusSM,
    backgroundColor: 'transparent',
    color: cssVar.colorTextSecondary,
    fontFamily: 'inherit',
    fontSize: cssVar.fontSizeSM,
    fontWeight: 'inherit',
    lineHeight: 'inherit',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: '0.15s',
    ':hover': { backgroundColor: cssVar.colorFillSecondary, color: cssVar.colorText },
    '[aria-pressed="true"]': { backgroundColor: cssVar.colorPrimaryBg, color: cssVar.colorPrimary },
    ':focus-visible': { outline: `2px solid ${cssVar.colorPrimaryBorder}`, outlineOffset: 1 },
  },
  facetChipLabel: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  facetChipCount: {
    color: cssVar.colorTextTertiary,
    fontVariantNumeric: 'tabular-nums',
  },
  facetDot: {
    flex: 'none',
    inlineSize: 6,
    blockSize: 6,
    borderRadius: '50%',
    backgroundColor: cssVar.colorTextQuaternary,
    '[data-tone="processing"]': { backgroundColor: cssVar.colorPrimary },
    '[data-tone="warning"]': { backgroundColor: cssVar.colorWarning },
    '[data-tone="orange"]': { backgroundColor: cssVar.orange },
    '[data-tone="volcano"]': { backgroundColor: cssVar.volcano },
    '[data-tone="success"]': { backgroundColor: cssVar.colorSuccess },
    '[data-tone="error"]': { backgroundColor: cssVar.colorError },
  },
  /** Always rendered at a fixed height, so choosing values never moves the board. */
  facetSelected: {
    display: 'flex',
    gap: cssVar.marginXS,
    alignItems: 'center',
    minInlineSize: 0,
    blockSize: cssVar.controlHeight,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
  },
  facetSelectedDetails: {
    display: 'flex',
    flex: '1 1 0',
    gap: cssVar.marginXS,
    alignItems: 'center',
    minInlineSize: 0,
    whiteSpace: 'nowrap',
    '[data-active="false"]': { visibility: 'hidden' },
  },
  facetSelectedList: {
    display: 'flex',
    flex: '1 1 0',
    gap: cssVar.marginXS,
    alignItems: 'center',
    minInlineSize: 0,
    overflowX: 'auto',
    scrollbarWidth: 'none',
  },
  facetSummary: {
    flex: '1 1 0',
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** Archive drawer: filters above the table. A narrow drawer wraps them onto a second row instead of squeezing four into one; wide drawers keep the single row. */
  archiveFilters: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cssVar.marginXS,
    alignItems: 'center',
    minInlineSize: 0,
  },
  archiveFilterField: {
    flex: '1 1 0',
    minInlineSize: 150,
  },
  archiveFilterTrigger: {
    justifyContent: 'flex-start',
    textAlign: 'start',
    blockSize: 32,
    minBlockSize: 32,
    maxBlockSize: 32,
    whiteSpace: 'nowrap',
    '--weaver-filter-clear': { default: 'none', ':hover': 'inline-flex' },
    '--weaver-filter-arrow': { default: 'inline-flex' },
    ':hover:has([data-role="lobe-select-clear"])': { '--weaver-filter-arrow': 'none' },
  },
  archiveFilterPrefixWrapper: {
    flex: '1 1 auto',
    minInlineSize: 0,
    overflow: 'hidden',
  },
  /** The label before the value stays whole (it is short) and the value yields with an ellipsis instead of running into the arrow. */
  archiveFilterPrefix: {
    display: 'block',
    flex: 'none',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  /** The selected values render in the prefix summary; the library's own tag row stays out of the way. */
  archiveFilterValue: {
    display: 'none',
  },
  archiveFilterSuffix: {
    flex: 'none',
    minInlineSize: 0,
  },
  /** Hidden while the trigger rests: reserving its width would squeeze the value into an ellipsis even when room is left. */
  archiveFilterClear: {
    display: 'var(--weaver-filter-clear, none)',
  },
  /** The arrow closes the trigger; on hover the clear action steps in for it instead of sharing the space. */
  archiveFilterArrow: {
    display: 'var(--weaver-filter-arrow, inline-flex)',
    flex: 'none',
  },
  archiveFilterLabel: {
    display: 'block',
    flex: '1 1 auto',
    minInlineSize: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    textAlign: 'start',
  },
  /** The +N badge after the whole first value: it stays readable while the value itself truncates. */
  archiveFilterMore: {
    flex: 'none',
    marginInlineStart: 2,
    color: cssVar.colorTextTertiary,
    fontVariantNumeric: 'tabular-nums',
  },
  boardScrollHint: {
    display: 'none',
    fontSize: cssVar.fontSizeSM,
    '@media (max-width: 1179px)': { display: 'block' },
  },
  /** Four lanes fit desktop widths; smaller viewports scroll with an explicit hint. */
  columns: {
    display: 'grid',
    flex: '1 1 auto',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: cssVar.marginSM,
    alignItems: 'stretch',
    minBlockSize: 320,
    inlineSize: '100%',
    minInlineSize: 0,
    overflowX: 'auto',
    scrollbarWidth: 'auto',
    '@media (max-width: 1179px)': { gridTemplateColumns: 'repeat(4, minmax(240px, 1fr))' },
  },
  column: {
    '--column-bg': cssVar.colorFillTertiary,
    '--column-text': cssVar.colorTextSecondary,
    display: 'flex',
    flexDirection: 'column',
    gap: cssVar.marginXS,
    minInlineSize: 0,
    padding: cssVar.paddingSM,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: 'var(--column-bg)',
    '[data-status-column="running"]': {
      '--column-bg': `color-mix(in srgb, ${cssVar.colorInfo} 8%, transparent)`,
      '--column-text': cssVar.colorPrimary,
    },
    '[data-status-column="review"]': {
      '--column-bg': `color-mix(in srgb, ${cssVar.colorWarning} 10%, transparent)`,
      '--column-text': cssVar.colorWarning,
    },
    '[data-status-column="closed"]': {
      '--column-bg': cssVar.colorFillQuaternary,
      '--column-text': cssVar.colorTextTertiary,
    },
    '[data-collapsed="true"]': { gap: 0 },
  },
  columnHead: {
    display: 'flex',
    gap: cssVar.marginXS,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBlock: cssVar.paddingXXS,
    color: 'var(--column-text)',
  },
  columnCount: {
    color: 'var(--column-text)',
    fontSize: cssVar.fontSizeSM,
  },
  /** The 已结束 count is also its fold: label, number and chevron in one clickable row. */
  fold: {
    display: 'inline-flex',
    gap: 6,
    alignItems: 'center',
    minInlineSize: 0,
    padding: '2px 6px 2px 2px',
    borderWidth: 0,
    borderRadius: cssVar.borderRadiusSM,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    lineHeight: 'inherit',
    cursor: 'pointer',
    ':focus-visible': { outline: `2px solid ${cssVar.colorPrimaryBorder}`, outlineOffset: 1 },
  },
  /** A virtualized column body: rows carry their own spacing (items are measured, so no margins), the trailing gap is handed back. */
  lane: {
    minInlineSize: 0,
    marginBlockEnd: `calc(-1 * ${cssVar.marginXS})`,
    overflowAnchor: 'none',
  },
  laneRow: {
    minInlineSize: 0,
    paddingBlockEnd: cssVar.marginXS,
    '[data-row="heading"]': { paddingBlock: '4px 12px' },
    '[data-row="zoneHeading"]': { paddingBlock: '8px 12px' },
  },
  workspaceHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
    marginBlock: 4,
    marginInline: 0,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    fontWeight: 'normal',
  },
  workspaceIcon: {
    flex: 'none',
  },
  workspaceName: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** Sub agent and title share a single text flow, capped at two lines. */
  cardTitle: {
    display: '-webkit-box',
    minInlineSize: 0,
    paddingInlineEnd: 24,
    overflow: 'hidden',
    overflowWrap: 'anywhere',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
  },
  /** A long sub agent tag yields with an ellipsis and leaves the title room on the same line. */
  cardTag: {
    marginInlineEnd: 4,
    minInlineSize: 0,
    maxInlineSize: '60%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The tag's flex item: the only part that shrinks, so the icon keeps its size and the name gets the ellipsis. */
  cardTagText: {
    display: 'block',
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardTitleText: {
    overflowWrap: 'anywhere',
  },
  cardStatus: {
    display: 'flex',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: 4,
    minInlineSize: 0,
    minBlockSize: 24,
  },
  cardStatusTag: {
    display: 'inline-flex',
    flex: 'none',
  },
  cardActivity: {
    flex: '1 1 0',
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: cssVar.fontSizeSM,
  },
  /** 待验收 wait line: secondary text, warning color once the wait is overdue. */
  cardWait: {
    minInlineSize: 0,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    lineHeight: '20px',
    fontVariantNumeric: 'tabular-nums',
    '[data-overdue="true"]': { color: cssVar.colorWarningText },
  },
  cardChildren: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: cssVar.fontSizeSM,
  },
  cardTime: {
    flex: 'none',
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  /**
   * The card's one footer sentence: who dispatched and when, then the latest word, a dot between. In a narrow card it is running text that wraps
   * between its three parts (each part stays whole); from 300px up it is one line.
   */
  cardMeta: {
    display: 'block',
    minInlineSize: 0,
    minBlockSize: 20,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    lineHeight: '20px',
    '@container (min-width: 300px)': {
      display: 'flex',
      flexWrap: 'nowrap',
      alignItems: 'baseline',
      gap: 4,
    },
  },
  cardWho: {
    minInlineSize: 0,
    '@container (min-width: 300px)': {
      display: 'flex',
      flexWrap: 'nowrap',
      gap: 4,
      alignItems: 'baseline',
      whiteSpace: 'nowrap',
    },
  },
  /** The time fragments and their verbs never give up room; only the parent name shrinks. */
  cardTail: {
    flex: 'none',
    whiteSpace: 'nowrap',
  },
  /** The dot closes the first part, so a wrapped second part starts clean on its own line instead of with a stray dot. */
  cardSep: {
    whiteSpace: 'nowrap',
  },
  /**
   * The one footer part that gives way: a single ellipsized line, whole name on hover, icon untouched.
   * Under 300px it is an inline-block in running text, so its cap reserves the leading 「由」 and its space:
   * a long name can never start a new line alone and leave the prefix orphaned on the line above.
   */
  cardParent: {
    display: 'inline-block',
    flex: '1 1 auto',
    minInlineSize: 0,
    maxInlineSize: 'calc(100% - 2em)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    verticalAlign: 'bottom',
    '@container (min-width: 300px)': {
      maxInlineSize: '100%',
    },
  },
  taskCard: {
    containerType: 'inline-size',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    inlineSize: '100%',
    minInlineSize: 0,
    padding: '10px 12px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadius,
    backgroundColor: cssVar.colorBgContainer,
    color: cssVar.colorText,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: '0.15s',
    ':hover': {
      borderColor: cssVar.colorBorder,
      boxShadow: cssVar.boxShadowTertiary,
    },
    '[aria-current="true"]': {
      borderColor: cssVar.colorPrimaryBorder,
    },
    ':focus-visible': { outline: `2px solid ${cssVar.colorPrimaryBorder}`, outlineOffset: 1 },
  },
  /** Owner and worker side by side in one archive row cell. */
  agentPair: {
    display: 'inline-flex',
    gap: 6,
    alignItems: 'center',
    minInlineSize: 0,
    maxInlineSize: '100%',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  },
  /** Archive drawer: filters above the table. */
  archiveBody: {
    display: 'flex',
    flex: '1 1 auto',
    flexDirection: 'column',
    minBlockSize: 0,
    gap: 12,
    minInlineSize: 0,
  },
  /** The archive table takes the room the drawer leaves under the filters; its virtual body scrolls inside. */
  archiveTable: {
    flex: '1 1 auto',
    minBlockSize: 280,
    minInlineSize: 0,
    overflow: 'hidden',
  },
  /** A narrow drawer wraps the pager onto a second right-aligned line rather than letting it overflow the table. */
  archivePager: {
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    minInlineSize: 0,
    marginBlock: -8,
  },
  /** Virtual rows keep one fixed height: long values end in an ellipsis and carry the full text as a tooltip. */
  archiveCell: {
    display: 'block',
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  archiveDirectory: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    overflowWrap: 'normal',
    wordBreak: 'normal',
  },
  /** An archived row opens the full record: whole-row click, so it reads and looks clickable. */
  archiveRow: {
    cursor: 'pointer',
    '[aria-current="true"]': {
      backgroundColor: cssVar.colorFillQuaternary,
    },
    ':focus-visible': { outline: `2px solid ${cssVar.colorPrimaryBorder}`, outlineOffset: -2 },
  },
  /** 置顶区 header inside a lane: Pin icon + 「置顶 · N」, a step quieter than a workspace heading. */
  pinnedHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minInlineSize: 0,
    marginBlock: 4,
    marginInline: 0,
    color: cssVar.colorText,
    fontSize: cssVar.fontSizeSM,
    fontWeight: 500,
  },
  pinnedIcon: {
    flex: 'none',
    color: cssVar.colorPrimary,
  },
  /** Closes the 置顶 zone so a workspace listed in it and again below reads as two sections, not a repeated group. */
  pinnedEnd: {
    marginBlock: '0 12px',
    marginInline: 0,
    borderWidth: 0,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: 'dashed',
    borderBlockStartColor: cssVar.colorBorder,
  },
  /** Card and its pin action share a shell; the action is a sibling of the card button, never nested inside it. */
  cardShell: {
    position: 'relative',
    minInlineSize: 0,
    '--weaver-pin-opacity': { default: '0', ':hover': '1', ':focus-within': '1' },
    '--weaver-pin-pointer-events': { default: 'none', ':hover': 'auto', ':focus-within': 'auto' },
  },
  pinGlyph: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinGlyphPin: {
    display: 'var(--weaver-pin-state-pin, inline-flex)',
  },
  pinGlyphUnpin: {
    display: 'var(--weaver-pin-state-unpin, none)',
  },
  /** The pin action sits in the card's top-right corner, revealed on hover or keyboard focus and permanent once pinned (and always shown where there is no hover). */
  pinButton: {
    position: 'absolute',
    insetBlockStart: 8,
    insetInlineEnd: 8,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    inlineSize: 24,
    blockSize: 24,
    padding: 0,
    borderWidth: 0,
    borderRadius: cssVar.borderRadiusSM,
    backgroundColor: cssVar.colorBgContainer,
    color: cssVar.colorTextSecondary,
    cursor: 'pointer',
    opacity: 'var(--weaver-pin-opacity, 0)',
    pointerEvents: 'var(--weaver-pin-pointer-events, none)',
    transitionProperty: 'opacity, color, background-color',
    transitionDuration: '0.15s',
    ':hover': { backgroundColor: cssVar.colorFillSecondary, color: cssVar.colorText },
    '[data-pinned="true"]': {
      '--weaver-pin-state-pin': { default: 'inline-flex', ':hover': 'none', ':focus-visible': 'none' },
      '--weaver-pin-state-unpin': { default: 'none', ':hover': 'inline-flex', ':focus-visible': 'inline-flex' },
      opacity: 1,
      pointerEvents: 'auto',
      color: cssVar.colorPrimary,
    },
    ':focus-visible': { outline: `2px solid ${cssVar.colorPrimaryBorder}`, outlineOffset: 1 },
    '@media (hover: none)': {
      '[data-pinned="false"]': {
        opacity: 0.7,
        pointerEvents: 'auto',
      },
    },
  },
});
