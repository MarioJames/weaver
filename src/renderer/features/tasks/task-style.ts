import { createStaticStyles } from 'antd-style';

/** Task board, facet filters, lanes, cards and the archive drawer. */
export const taskStyles = createStaticStyles(({ css, cssVar }) => ({
  grow: css`
    flex: 1;
    min-inline-size: 180px;
  `,
  /** Kanban: the facet block above one lane grid. */
  board: css`
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: ${cssVar.marginSM};
    min-inline-size: 0;
  `,
  /** Shopping-site facets: one fixed-label row per dimension, summary row always present. */
  facets: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXS};
    min-inline-size: 0;
    padding: ${cssVar.paddingSM};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillQuaternary};
  `,
  facetRow: css`
    display: flex;
    align-items: flex-start;
    gap: ${cssVar.marginSM};
    min-inline-size: 0;
  `,
  facetLabel: css`
    flex: none;
    inline-size: 64px;
    min-block-size: ${cssVar.controlHeightSM};
    display: flex;
    align-items: center;
    color: ${cssVar.colorTextSecondary};
    font-size: ${cssVar.fontSizeSM};
  `,
  facetValues: css`
    position: relative;
    display: flex;
    flex: 1 1 0;
    gap: ${cssVar.marginXS};
    align-items: flex-start;
    min-inline-size: 0;
  `,
  /** Hidden items retain measurable widths without occupying the chip line. */
  facetChips: css`
    position: relative;
    display: flex;
    flex: 1 1 0;
    gap: ${cssVar.marginXXS} ${cssVar.marginXS};
    align-items: flex-start;
    min-inline-size: 0;
    overflow: hidden;

    &[data-expanded='true'] { flex-wrap: wrap; }
  `,
  facetItem: css`
    display: inline-flex;
    flex: none;
    max-inline-size: 100%;

    &[data-hidden='true'] { position: absolute; visibility: hidden; pointer-events: none; }
  `,
  /** Reserve the toggle slot even when unused, keeping measurements stable. */
  facetMore: css`
    &[data-visible='false'] { visibility: hidden; pointer-events: none; }
  `,
  facetEmpty: css`
    display: flex;
    align-items: center;
    min-block-size: ${cssVar.controlHeightSM};
    color: ${cssVar.colorTextSecondary};
    font-size: ${cssVar.fontSizeSM};
  `,
  facetChip: css`
    display: inline-flex;
    flex: none;
    gap: 4px;
    align-items: center;
    max-inline-size: 100%;
    block-size: ${cssVar.controlHeightSM};
    padding-inline: ${cssVar.paddingXS};
    border: 0;
    border-radius: ${cssVar.borderRadiusSM};
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font: inherit;
    font-size: ${cssVar.fontSizeSM};
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;

    &:hover { background: ${cssVar.colorFillSecondary}; color: ${cssVar.colorText}; }
    &[aria-pressed='true'] { background: ${cssVar.colorPrimaryBg}; color: ${cssVar.colorPrimary}; }
    &:focus-visible { outline: 2px solid ${cssVar.colorPrimaryBorder}; outline-offset: 1px; }
  `,
  facetChipLabel: css`
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  facetChipCount: css`
    color: ${cssVar.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,
  facetDot: css`
    flex: none;
    inline-size: 6px;
    block-size: 6px;
    border-radius: 50%;
    background: ${cssVar.colorTextQuaternary};

    &[data-tone='processing'] { background: ${cssVar.colorPrimary}; }
    &[data-tone='warning'] { background: ${cssVar.colorWarning}; }
    &[data-tone='orange'] { background: ${cssVar.orange}; }
    &[data-tone='volcano'] { background: ${cssVar.volcano}; }
    &[data-tone='success'] { background: ${cssVar.colorSuccess}; }
    &[data-tone='error'] { background: ${cssVar.colorError}; }
  `,
  /** Always rendered at a fixed height, so choosing values never moves the board. */
  facetSelected: css`
    display: flex;
    gap: ${cssVar.marginXS};
    align-items: center;
    min-inline-size: 0;
    block-size: ${cssVar.controlHeight};
    color: ${cssVar.colorTextSecondary};
    font-size: ${cssVar.fontSizeSM};
  `,
  facetSelectedDetails: css`
    display: flex;
    flex: 1 1 0;
    gap: ${cssVar.marginXS};
    align-items: center;
    min-inline-size: 0;
    white-space: nowrap;

    &[data-active='false'] { visibility: hidden; }
  `,
  facetSelectedList: css`
    display: flex;
    flex: 1 1 0;
    gap: ${cssVar.marginXS};
    align-items: center;
    min-inline-size: 0;
    overflow-x: auto;
    scrollbar-width: none;
  `,
  facetSummary: css`
    flex: 1 1 0;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  /** Archive drawer: filters above the table. A narrow drawer wraps them onto a second row instead of squeezing four into one; wide drawers keep the single row. */
  archiveFilters: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${cssVar.marginXS};
    align-items: center;
    min-inline-size: 0;

    > * { flex: 1 1 0; min-inline-size: 150px; }
  `,
  archiveFilterTrigger: css`
    justify-content: flex-start;
    text-align: start;
    block-size: 32px;
    min-block-size: 32px;
    max-block-size: 32px;
    white-space: nowrap;
    > * { min-inline-size: 0; }
    /* The arrow closes the trigger: it never yields space to the prefix or value. */
    > :last-child { flex: none; }
    /* The clear × only exists while a value is chosen; it steps in for the arrow on hover instead of
       reserving width beside it, so the value keeps every pixel between the prefix and the arrow. */
    &:hover [data-role='lobe-select-clear'] { display: inline-flex; }
    &:hover:has([data-role='lobe-select-clear']) > :last-child > :last-child { display: none; }
  `,
  /** Hidden while the trigger rests: reserving its width would squeeze the value into an ellipsis even when room is left. */
  archiveFilterClear: css`
    display: none;
  `,
  /** The label before the value stays whole (it is short) and the value yields with an ellipsis instead of running into the arrow. */
  archiveFilterPrefix: css`
    display: block;
    flex: none;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  `,
  archiveFilterValue: css`
    && {
      display: block;
      flex: 1 1 auto;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      text-align: start;
    }
    > * { flex-wrap: nowrap; overflow: hidden; }
    [data-role='lobe-select-tag'] { min-inline-size: 0; flex-shrink: 0; }
    /* Folded-away values render as empty tags; they stay out of sight until the fold hides them. */
    [data-role='lobe-select-tag']:empty { display: none; }
  `,
  /** The +N badge after the whole first value: it stays readable while the value itself truncates. */
  archiveFilterMore: css`
    flex: none;
    margin-inline-start: 2px;
    color: ${cssVar.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,
  archiveFilterLabel: css`
    display: block;
    min-inline-size: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  `,
  boardScrollHint: css`
    display: none;
    font-size: ${cssVar.fontSizeSM};

    @media (max-width: 1179px) { display: block; }
  `,
  /** Four lanes fit desktop widths; smaller viewports scroll with an explicit hint. */
  columns: css`
    display: grid;
    flex: 1 1 auto;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: ${cssVar.marginSM};
    align-items: stretch;
    min-block-size: 320px;
    inline-size: 100%;
    min-inline-size: 0;
    overflow-x: auto;
    scrollbar-width: auto;

    @media (max-width: 1179px) { grid-template-columns: repeat(4, minmax(240px, 1fr)); }
  `,
  column: css`
    --column-bg: ${cssVar.colorFillTertiary};
    --column-text: ${cssVar.colorTextSecondary};
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXS};
    min-inline-size: 0;
    padding: ${cssVar.paddingSM};
    border-radius: ${cssVar.borderRadiusLG};
    background: var(--column-bg);

    &[data-status-column='running'] {
      --column-bg: color-mix(in srgb, ${cssVar.colorInfo} 8%, transparent);
      --column-text: ${cssVar.colorPrimary};
    }
    &[data-status-column='review'] {
      --column-bg: color-mix(in srgb, ${cssVar.colorWarning} 10%, transparent);
      --column-text: ${cssVar.colorWarning};
    }
    &[data-status-column='closed'] {
      --column-bg: ${cssVar.colorFillQuaternary};
      --column-text: ${cssVar.colorTextTertiary};
    }
    &[data-collapsed='true'] { gap: 0; }
  `,
  columnHead: css`
    display: flex;
    gap: ${cssVar.marginXS};
    align-items: center;
    justify-content: space-between;
    padding-block: ${cssVar.paddingXXS};
    color: var(--column-text);
  `,
  columnCount: css`
    color: var(--column-text);
    font-size: ${cssVar.fontSizeSM};
  `,
  /** The 已结束 count is also its fold: label, number and chevron in one clickable row. */
  fold: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;
    min-inline-size: 0;
    padding: 2px 6px 2px 2px;
    border: 0;
    border-radius: ${cssVar.borderRadiusSM};
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 1px;
    }
  `,
  /** A virtualized column body: rows carry their own spacing (items are measured, so no margins), the trailing gap is handed back. */
  lane: css`
    min-inline-size: 0;
    margin-block-end: calc(-1 * ${cssVar.marginXS});
    overflow-anchor: none;
  `,
  laneRow: css`
    min-inline-size: 0;
    padding-block-end: ${cssVar.marginXS};

    &[data-row='heading'] { padding-block: 4px 12px; }
    &[data-row='zoneHeading'] { padding-block: 8px 12px; }
  `,
  workspaceHeading: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-inline-size: 0;
    margin: 4px 0;
    color: ${cssVar.colorTextSecondary};
    font-size: ${cssVar.fontSizeSM};
    font-weight: normal;
    > svg { flex: none; }
  `,
  workspaceName: css`
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  /** Sub agent and title share a single text flow, capped at two lines. */
  cardTitle: css`
    display: -webkit-box;
    min-inline-size: 0;
    /* The pin action sits in the card's top-right corner (24px button + 8px inset, 20px past the content edge); only this first row shares that corner, so only it keeps clear — status and footer lines keep the full width. */
    padding-inline-end: 24px;
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  `,
  /** A long sub agent tag yields with an ellipsis and leaves the title room on the same line. */
  cardTag: css`
    margin-inline-end: 4px;
    min-inline-size: 0;
    max-inline-size: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    > svg { flex: none; }
  `,
  /** The tag's flex item: the only part that shrinks, so the icon keeps its size and the name gets the ellipsis. */
  cardTagText: css`
    display: block;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  cardTitleText: css`
    overflow-wrap: anywhere;
  `,
  cardStatus: css`
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 4px;
    min-inline-size: 0;
    min-block-size: 24px;
    > :first-child { flex: none; }
  `,
  cardActivity: css`
    flex: 1 1 0;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: ${cssVar.fontSizeSM};
  `,
  /** 待验收 wait line: secondary text, warning color once the wait is overdue. */
  cardWait: css`
    min-inline-size: 0;
    color: ${cssVar.colorTextSecondary};
    font-size: ${cssVar.fontSizeSM};
    line-height: 20px;
    font-variant-numeric: tabular-nums;
    &[data-overdue='true'] { color: ${cssVar.colorWarningText}; }
  `,
  cardChildren: css`
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: ${cssVar.fontSizeSM};
  `,
  cardTime: css`
    flex: none;
    color: ${cssVar.colorTextSecondary};
    font-size: ${cssVar.fontSizeSM};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `,
  /**
   * The card's one footer sentence: who dispatched and when, then the latest word, a dot between. In a narrow card it is running text that wraps
   * between its three parts (each part stays whole); from 300px up it is one line.
   */
  cardMeta: css`
    display: block;
    min-inline-size: 0;
    min-block-size: 20px;
    color: ${cssVar.colorTextSecondary};
    font-size: ${cssVar.fontSizeSM};
    line-height: 20px;

    @container (min-width: 300px) {
      display: flex;
      flex-wrap: nowrap;
      align-items: baseline;
      gap: 4px;
    }
  `,
  cardWho: css`
    min-inline-size: 0;

    @container (min-width: 300px) {
      display: flex;
      flex-wrap: nowrap;
      gap: 4px;
      align-items: baseline;
      white-space: nowrap;
    }
  `,
  /** The time fragments and their verbs never give up room; only the parent name shrinks. */
  cardTail: css`
    flex: none;
    white-space: nowrap;
  `,
  /** The dot closes the first part, so a wrapped second part starts clean on its own line instead of with a stray dot. */
  cardSep: css`
    white-space: nowrap;
  `,
  /**
   * The one footer part that gives way: a single ellipsized line, whole name on hover, icon untouched.
   * Under 300px it is an inline-block in running text, so its cap reserves the leading 「由」 and its space:
   * a long name can never start a new line alone and leave the prefix orphaned on the line above.
   */
  cardParent: css`
    display: inline-block;
    flex: 1 1 auto;
    min-inline-size: 0;
    max-inline-size: calc(100% - 2em);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;

    > span { display: inline; }

    @container (min-width: 300px) {
      max-inline-size: 100%;
    }
  `,
  taskCard: css`
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 6px;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorText};
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;

    &:hover {
      border-color: ${cssVar.colorBorder};
      box-shadow: ${cssVar.boxShadowTertiary};
    }

    &[aria-current='true'] {
      border-color: ${cssVar.colorPrimaryBorder};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 1px;
    }
  `,
  /** Owner and worker side by side in one archive row cell. */
  agentPair: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow: hidden;
    white-space: nowrap;
  `,
  /** Archive drawer: filters above the table. */
  archiveBody: css`
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-block-size: 0;
    gap: 12px;
    min-inline-size: 0;
  `,
  /** The archive table takes the room the drawer leaves under the filters; its virtual body scrolls inside. */
  archiveTable: css`
    flex: 1 1 auto;
    min-block-size: 280px;
    min-inline-size: 0;
    overflow: hidden;

    /** The pager row's margin is not in the height we measure to size the body by, so it pays as padding instead. */
    .lobe-table-pagination-wrapper {
      margin-block: 0;
      padding-block: ${cssVar.marginXS};
    }
  `,
  /** A narrow drawer wraps the pager onto a second right-aligned line rather than letting it overflow the table. */
  archivePager: css`
    flex-wrap: wrap;
    justify-content: flex-end;
    min-inline-size: 0;
  `,
  /** Virtual rows keep one fixed height: long values end in an ellipsis and carry the full text as a tooltip. */
  archiveCell: css`
    display: block;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  archiveDirectory: css`
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    overflow-wrap: normal;
    word-break: normal;
  `,
  /** An archived row opens the full record: whole-row click, so it reads and looks clickable. */
  archiveRow: css`
    cursor: pointer;

    &[aria-current='true'] td {
      background: ${cssVar.colorFillQuaternary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: -2px;
    }
  `,
  /** 置顶区 header inside a lane: Pin icon + 「置顶 · N」, a step quieter than a workspace heading. */
  pinnedHeading: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-inline-size: 0;
    margin: 4px 0;
    color: ${cssVar.colorText};
    font-size: ${cssVar.fontSizeSM};
    font-weight: 500;
    > svg { flex: none; color: ${cssVar.colorPrimary}; }
  `,
  /** Closes the 置顶 zone so a workspace listed in it and again below reads as two sections, not a repeated group. */
  pinnedEnd: css`
    margin: 0 0 12px;
    border: 0;
    border-block-start: 1px dashed ${cssVar.colorBorder};
  `,
  /** Card and its pin action share a shell; the action is a sibling of the card button, never nested inside it. */
  cardShell: css`
    position: relative;
    min-inline-size: 0;

    &:hover [data-pinned='false'], &:focus-within [data-pinned='false'] {
      opacity: 1;
      pointer-events: auto;
    }
  `,
  pinGlyph: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
  `,
  /** The pin action sits in the card's top-right corner, revealed on hover or keyboard focus and permanent once pinned (and always shown where there is no hover). */
  pinButton: css`
    position: absolute;
    inset-block-start: 8px;
    inset-inline-end: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 24px;
    block-size: 24px;
    padding: 0;
    border: 0;
    border-radius: ${cssVar.borderRadiusSM};
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorTextSecondary};
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s, color 0.15s, background 0.15s;

    &:hover { background: ${cssVar.colorFillSecondary}; color: ${cssVar.colorText}; }
    &[data-pinned='true'] { opacity: 1; pointer-events: auto; color: ${cssVar.colorPrimary}; }
    &:focus-visible { outline: 2px solid ${cssVar.colorPrimaryBorder}; outline-offset: 1px; }

    /* Pinned shows a filled Pin in the primary colour; the slashed PinOff replaces it only while hovered or focused (the click unpins). */
    [data-icon='unpin'] { display: none; }
    &[data-pinned='true'] [data-icon='pin'] svg { fill: currentColor; }
    &[data-pinned='true']:hover [data-icon='pin'], &[data-pinned='true']:focus-visible [data-icon='pin'] { display: none; }
    &[data-pinned='true']:hover [data-icon='unpin'], &[data-pinned='true']:focus-visible [data-icon='unpin'] { display: inline-flex; }

    /* No hover to reveal it on touch screens: keep the action reachable, quietly. */
    @media (hover: none) {
      &[data-pinned='false'] { opacity: 0.7; pointer-events: auto; }
    }
  `,
}));
