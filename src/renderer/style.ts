import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar, responsive }) => ({
  srOnly: css`
    position: absolute;
    overflow: hidden;
    clip-path: inset(50%);
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    white-space: nowrap;
  `,
  shell: css`
    block-size: 100%;
  `,
  brandLockup: css`
    display: block;
    flex-shrink: 0;
    inline-size: 128px;
    block-size: auto;
    object-fit: contain;

    [data-collapsed='true'] & {
      display: none;
    }
  `,
  mark: css`
    display: none;
    flex-shrink: 0;
    inline-size: 24px;
    block-size: 24px;
    object-fit: contain;

    [data-collapsed='true'] & {
      display: block;
    }
  `,
  /** List on the left, the selected record on the right. Collapses to one column on narrow screens. */
  split: css`
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
    min-inline-size: 0;

    ${responsive.laptop} {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  /** The list stays in view while a long record scrolls the workspace. */
  listPane: css`
    position: sticky;
    inset-block-start: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-inline-size: 0;

    ${responsive.laptop} {
      position: static;
    }
  `,
  /** Every row takes the tallest card's height, so all engine cards line up. */
  cards: css`
    display: grid;
    grid-auto-rows: 1fr;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
    min-inline-size: 0;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    block-size: 100%;

    & > :last-child {
      flex: 1;
    }
  `,
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
  /** Settings groups stacked with hairlines between them, full width. */
  settings: css`
    container-type: inline-size;
    display: flex;
    flex-direction: column;
  `,
  /** The group column takes a third (bounded) so long group descriptions wrap to a few lines. */
  settingsGroup: css`
    display: grid;
    grid-template-columns: minmax(280px, 36%) minmax(0, 1fr);
    gap: 8px 48px;
    padding-block: 20px;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }

    /* Collapse on the content width, not the viewport: the sidebar already takes part of the screen. */
    @container (max-width: 860px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  settingsRows: css`
    display: flex;
    flex-direction: column;
    min-inline-size: 0;

    & > :first-child {
      padding-block-start: 0;
    }
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-inline-size: 0;
  `,
  tight: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-inline-size: 0;
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    min-inline-size: 0;
  `,
  spread: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    min-inline-size: 0;
  `,
  grow: css`
    flex: 1;
    min-inline-size: 180px;
  `,
  /** Two fields side by side; one column when the form is narrow. */
  pair: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    min-inline-size: 0;

    @media (max-width: 720px) {
      grid-template-columns: minmax(0, 1fr);
    }
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
  /** Archive drawer: every filter on one row. */
  archiveFilters: css`
    display: flex;
    flex-wrap: nowrap;
    gap: ${cssVar.marginXS};
    align-items: center;
    min-inline-size: 0;

    > * { flex: 1 1 0; min-inline-size: 0; }
  `,
  archiveFilterTrigger: css`
    justify-content: flex-start;
    text-align: start;
    block-size: 32px;
    min-block-size: 32px;
    max-block-size: 32px;
    white-space: nowrap;
    > * { min-inline-size: 0; }
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
  workspaceGroup: css`
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    gap: 8px;
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
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  `,
  cardTag: css`
    margin-inline-end: 4px;
    min-inline-size: 0;
    max-inline-size: 100%;
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
      white-space: nowrap;
    }
  `,
  cardTail: css`
    white-space: nowrap;
  `,
  /** The dot closes the first part, so a wrapped second part starts clean on its own line instead of with a stray dot. */
  cardSep: css`
    white-space: nowrap;
  `,
  cardParent: css`
    display: inline-block;
    max-inline-size: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;

    > span { display: inline; }
    svg { vertical-align: middle; margin-inline-end: 4px; }
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
  /** A list entry: its enable switch, then a button that selects it. No outer frame. */
  roleItem: css`
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 10px;
    align-items: start;
    padding: 8px 10px;
    border-radius: ${cssVar.borderRadius};

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &[aria-current='true'] {
      background: ${cssVar.colorFillSecondary};
    }

    & > [role='switch'] {
      margin-block-start: 2px;
    }
  `,
  roleButton: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 2px;
      border-radius: ${cssVar.borderRadiusSM};
    }
  `,
  /** A list entry's pause: its kind as a tag, then the reason; the reason moves under the tag when the pane is narrow. */
  roleNote: css`
    display: flex;
    flex-wrap: wrap;
    gap: 2px 6px;
    align-items: center;
    min-inline-size: 0;
  `,
  /** Setting label and description on the left, the control on the right. */
  setting: css`
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    min-inline-size: 0;
    padding-block: 12px;

    /* The text wraps; the control keeps its size and stays at the right edge. */
    & > :first-child {
      flex: 1 1 0;
      min-inline-size: 0;
    }

    & > :last-child {
      flex: none;
    }

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }
  `,
  /** Rows of a short editable list: one fixed height, hairline separators, no outer frame. */
  listRows: css`
    display: flex;
    flex-direction: column;
    min-inline-size: 0;

    &:empty {
      display: none;
    }
  `,
  listRow: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    min-block-size: 40px;
    padding-block: 4px;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }
  `,
  quotaWindow: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  `,
  numbers: css`
    font-variant-numeric: tabular-nums;
  `,
  wrap: css`
    overflow-wrap: anywhere;
    min-inline-size: 0;
  `,
  clip: css`
    overflow: auto;
    max-block-size: 280px;
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  /** Engine icon and name share one baseline-aligned inline row. */
  agentLabel: css`
    display: inline-flex;
    gap: 4px;
    align-items: center;
    min-inline-size: 0;
  `,
  /** Owner and worker side by side in one archive row cell. */
  agentPair: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;
    min-inline-size: 0;
  `,
  /** Archive drawer: filters above the table. */
  archiveBody: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-inline-size: 0;
  `,
  archiveDirectory: css`
    display: block;
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
  error: css`
    margin: 0;
    font-size: 12px;
    color: ${cssVar.colorErrorText};
  `,
  /** A form section set off from the fields above it. */
  divided: css`
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  /** A model reply shown as a message card. */
  replyCard: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillQuaternary};

    &[data-ok='true'] {
      border-color: ${cssVar.colorSuccessBorder};
      background: ${cssVar.colorSuccessBg};
    }

    &[data-ok='false'] {
      border-color: ${cssVar.colorErrorBorder};
      background: ${cssVar.colorErrorBg};
    }
  `,
  replyText: css`
    margin: 0;
    font-size: 15px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,
  replyError: css`
    font-size: 13px;
    color: ${cssVar.colorErrorText};
  `,
  warn: css`
    color: ${cssVar.colorWarningText};
  `,
  tab: css`
    margin: 0;
    padding: 4px 8px;
    border: 0;
    border-radius: ${cssVar.borderRadiusSM};
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font: inherit;
    cursor: pointer;

    &[aria-selected='true'] {
      background: ${cssVar.colorFillSecondary};
      color: ${cssVar.colorText};
    }
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
