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
}));
