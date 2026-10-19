import { createStaticStyles } from 'antd-style';

/** Styles for the task timeline (EventsPanel). Layout-only styles still come from ../style. */
export const styles = createStaticStyles(({ css, cssVar }) => ({
  /** One condensed step run: time range, in-progress marker, summary, disclosure chevron. */
  stepRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: center;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 6px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 1px;
    }
  `,
  /** Raw events revealed under one step run. */
  stepBody: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-inline-size: 0;
    padding: 8px 12px;
    border-inline-start: 2px solid ${cssVar.colorBorderSecondary};
    border-start-start-radius: ${cssVar.borderRadius};
  `,
  rawRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: baseline;
    min-inline-size: 0;
  `,
  time: css`
    flex: none;
    color: ${cssVar.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,
  /** Neutralizes Tag's side margin inside flex rows. */
  kindTag: css`
    flex: none;
    margin: 0;
  `,
  kindDanger: css`
    color: ${cssVar.colorErrorText};
    background: ${cssVar.colorErrorBg};
  `,
  tools: css`
    font-variant-numeric: tabular-nums;
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
}));
