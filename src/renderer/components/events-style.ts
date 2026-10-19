import { createStaticStyles } from 'antd-style';

/** Styles for the task timeline (EventsPanel). Layout-only styles still come from ../style. */
export const styles = createStaticStyles(({ css, cssVar }) => ({
  /** The vertical timeline: the connector line and node spacing come from Steps. */
  timeline: css`
    min-inline-size: 0;
  `,
  /** Steps indicator reduced to a bare dot: no ring, color from the node kind. */
  indicator: css`
    &&& {
      inline-size: 10px;
      block-size: 10px;
      margin-block-start: 6px;
      margin-inline: 6px;
      border: 0;
      background: transparent;
    }
  `,
  /** Steps title cell: wraps, no nowrap, no per-state color. */
  nodeTitle: css`
    &&& {
      overflow-wrap: anywhere;
      white-space: normal;
      color: ${cssVar.colorText};
      font-weight: normal;
    }
  `,
  nodeDescription: css`
    &&& {
      min-inline-size: 0;
    }
  `,
  /** Dot of one event kind. */
  dot: css`
    display: block;
    inline-size: 10px;
    block-size: 10px;
    border-radius: 50%;
    background: ${cssVar.colorTextQuaternary};
  `,
  dotLifecycle: css`
    background: ${cssVar.colorPrimary};
  `,
  dotSuccess: css`
    background: ${cssVar.colorSuccess};
  `,
  dotError: css`
    background: ${cssVar.colorError};
  `,
  dotWarning: css`
    background: ${cssVar.colorWarning};
  `,
  dotInfo: css`
    background: ${cssVar.colorInfo};
  `,
  /** Node head: tags and message on the left, relative time pinned right. */
  head: css`
    display: flex;
    gap: ${cssVar.marginXS};
    align-items: flex-start;
    justify-content: space-between;
    min-inline-size: 0;
  `,
  headMain: css`
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    gap: ${cssVar.marginXXS} ${cssVar.marginXS};
    align-items: center;
    min-inline-size: 0;
  `,
  /** Time of a node: right aligned, never wraps. */
  time: css`
    flex: none;
    margin-inline-start: auto;
    color: ${cssVar.colorTextTertiary};
    font-size: ${cssVar.fontSizeSM};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `,
  /** Neutralizes Tag's side margin inside flex rows. */
  tag: css`
    flex: none;
    margin: 0;
  `,
  /** Result / failure card shared shape. */
  card: css`
    display: flex;
    flex-direction: column;
    gap: ${cssVar.marginXS};
    min-inline-size: 0;
    margin-block-start: ${cssVar.marginXS};
    padding: ${cssVar.paddingSM} ${cssVar.padding};
    border: 1px solid transparent;
    border-radius: ${cssVar.borderRadiusLG};
  `,
  resultText: css`
    border: 0;
    border-radius: 0;
    background: transparent;
    > div { padding-inline: 0; }
    > div:first-child { padding-block-start: 0; border-block-end: 0; }
  `,
  cardSuccess: css`
    border-color: ${cssVar.colorSuccessBorder};
    background: ${cssVar.colorSuccessBg};
  `,
  cardError: css`
    border-color: ${cssVar.colorErrorBorder};
    background: ${cssVar.colorErrorBg};
  `,
  cardHead: css`
    display: flex;
    gap: ${cssVar.marginXS};
    align-items: center;
    justify-content: space-between;
  `,
  cardText: css`
    margin: 0;
    color: ${cssVar.colorText};
    font-family: inherit;
    font-size: ${cssVar.fontSize};
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,
  cardClamped: css`
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    overflow: hidden;
  `,
  cardCode: css`
    margin: 0;
    padding: ${cssVar.paddingXS} ${cssVar.paddingSM};
    max-block-size: 160px;
    overflow: auto;
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorTextSecondary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,
  /** Merged tool steps: a button row with the count, per-tool tags and a chevron. */
  stepButton: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${cssVar.marginXXS} ${cssVar.marginXS};
    align-items: center;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
    border-radius: ${cssVar.borderRadius};

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 2px;
    }
  `,
  chevron: css`
    flex: none;
    display: inline-flex;
    align-items: center;
    color: ${cssVar.colorTextTertiary};
    transition: transform 0.15s;

    &[data-expanded='true'] {
      transform: rotate(90deg);
    }
  `,
  /** Compact list of tool calls under a merged node. */
  stepList: css`
    display: flex;
    flex-direction: column;
    margin: ${cssVar.marginXS} 0 0;
    padding: ${cssVar.paddingXXS} ${cssVar.paddingSM};
    min-inline-size: 0;
    list-style: none;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  stepItem: css`
    display: flex;
    gap: ${cssVar.marginXS};
    align-items: center;
    min-inline-size: 0;
    padding-block: 3px;
    color: ${cssVar.colorTextSecondary};
    font-size: ${cssVar.fontSizeSM};
  `,
  stepItemFailed: css`
    color: ${cssVar.colorError};
  `,
  stepName: css`
    flex: none;
    font-weight: 500;
  `,
  stepArg: css`
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${cssVar.colorTextTertiary};
  `,
  stepDuration: css`
    flex: none;
    margin-inline-start: auto;
    font-variant-numeric: tabular-nums;
  `,
  /** All-events mode: one raw row. */
  rawRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: baseline;
    min-inline-size: 0;
  `,
  rawTime: css`
    flex: none;
    color: ${cssVar.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,
}));
