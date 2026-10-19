import { createStaticStyles } from 'antd-style';

/**
 * One bordered panel with three columns per band: group context, field explanation, control.
 * The fills are the ordered `colorFill` ladder (one step lighter than the raw ladder: Tertiary on the group, Quaternary on the field, none on the control),
 * so the hierarchy reads the same in light and dark without any theme branch.
 * Borders take `colorBorder`, not the softer step: every separator here lands on a shaded fill.
 */
export const settingsStyles = createStaticStyles(({ css, cssVar }) => ({
  surface: css`
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    /* The hidden overflow below drops this item's automatic min-size, so without the no-shrink
       rule the panel shrinks to the viewport and clips its last group instead of scrolling. */
    flex-shrink: 0;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
  /** Group context on the left, its rows on the right; the two bands share the group height. */
  group: css`
    display: grid;
    grid-template-columns: minmax(260px, 32%) minmax(0, 1fr);
    align-items: stretch;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorder};
    }

    /* Collapse on the content width, not the viewport: the sidebar already takes part of the screen. */
    @container (max-width: 860px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  /** The column separator becomes the band separator once the group stacks. */
  groupCell: css`
    justify-content: center;
    padding: 16px 20px;
    background: ${cssVar.colorFillTertiary};
    border-inline-end: 1px solid ${cssVar.colorBorder};

    @container (max-width: 860px) {
      border-block-end: 1px solid ${cssVar.colorBorder};
      border-inline-end: 0;
    }
  `,
  rows: css`
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  `,
  /** Field text and control share one row; the control track is fixed so the separators line up across rows. */
  row: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) 240px;
    flex: 1 1 auto;

    & + & {
      border-block-start: 1px solid ${cssVar.colorBorder};
    }

    @container (max-width: 860px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  fieldCell: css`
    padding: 12px 20px;
    background: ${cssVar.colorFillQuaternary};
    justify-content: center;
  `,
  /** The control keeps its size at the column end; stacked, it starts the band instead. */
  controlCell: css`
    display: flex;
    flex-wrap: nowrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
    padding: 12px 20px;
    border-inline-start: 1px solid ${cssVar.colorBorder};

    @container (max-width: 860px) {
      justify-content: flex-start;
      border-block-start: 1px solid ${cssVar.colorBorder};
      border-inline-start: 0;
    }
  `,
}));
