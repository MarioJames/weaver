import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  srOnly: css`
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  `,
  app: css`
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    inline-size: 100%;
    block-size: 100%;
    min-inline-size: 0;
    min-block-size: 0;
  `,
  root: css`
    display: flex;
    flex: 1 1 auto;
    flex-direction: row;
    inline-size: 100%;
    block-size: 100%;
    min-inline-size: 0;
    min-block-size: 0;
    background: ${cssVar.colorBgLayout};
    color: ${cssVar.colorText};
  `,
  nav: css`
    display: flex;
    flex: none;
    flex-direction: column;
    inline-size: 208px;
    min-inline-size: 0;
    min-block-size: 0;
    background: ${cssVar.colorBgLayout};
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};

    &[data-collapsed='true'] { inline-size: 56px; }
  `,
  navBody: css`
    flex: 1;
    min-inline-size: 0;
    min-block-size: 0;
    overflow: auto;
  `,
  navTools: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px;
  `,
  brand: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;
    margin: 0;
    padding: 12px;
    border: 0;
    background: transparent;
    color: ${cssVar.colorText};
    font: inherit;
    text-align: start;
    cursor: pointer;
  `,
  main: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    min-block-size: 0;
    overflow: hidden;
    background: ${cssVar.colorBgLayout};
    color: ${cssVar.colorText};
  `,
  skip: css`
    position: absolute;
    z-index: 2;
    padding: 4px 8px;
    background: ${cssVar.colorBgElevated};
    color: ${cssVar.colorText};
    transform: translateY(-150%);

    &:focus { transform: none; }
  `,
  mark: css`
    display: grid;
    flex-shrink: 0;
    place-items: center;
    inline-size: 22px;
    block-size: 22px;
    border-radius: ${cssVar.borderRadiusSM};
    background: ${cssVar.colorPrimaryBg};
    color: ${cssVar.colorPrimaryText};
    font-weight: 650;
  `,
  page: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;
    min-inline-size: 0;
    min-block-size: 0;
    overflow: auto;
    padding: 12px;
  `,
  split: css`
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr);
    flex: 1;
    min-inline-size: 0;
    min-block-size: 0;

    @media (max-width: 720px) {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 12rem) minmax(0, 1fr);
    }
  `,
  column: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-inline-size: 0;
    min-block-size: 0;
    overflow: auto;
    padding: 12px;
  `,
  detail: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) 260px;
    min-inline-size: 0;

    @media (max-width: 1100px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
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
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    min-inline-size: 0;
  `,
  item: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: stretch;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 8px;
    border: 0;
    border-radius: ${cssVar.borderRadius};
    background: transparent;
    color: inherit;
    text-align: start;

    &[aria-current='true'] {
      background: ${cssVar.colorFillSecondary};
    }
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
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  error: css`
    margin: 0;
    color: ${cssVar.colorErrorText};
    font-size: 12px;
  `,
  sync: css`
    padding: 8px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  `,
  engines: css`
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
  `,
  engine: css`
    display: grid;
    grid-template-columns: minmax(120px, 1.1fr) minmax(88px, .7fr) minmax(120px, 1fr) auto;
    gap: 8px;
    align-items: center;
    min-inline-size: 0;
    padding: 10px 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    &:last-child { border-block-end: 0; }

    & > details { grid-column: 1 / -1; }

    @media (max-width: 720px) {
      grid-template-columns: minmax(0, 1fr);
    }
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
}));
