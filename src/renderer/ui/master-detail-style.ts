import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

const WIDE = '@media (min-width: 1440px)';
const NARROW = '@media (max-width: 1023.98px)';

/** Three panes on wide screens, an overlay inspector at laptop widths, and one pane on small screens. */
export const masterDetailStyles = stylex.create({
  root: {
    position: 'relative',
    display: 'flex',
    blockSize: '100%',
    minBlockSize: 0,
    minInlineSize: 0,
    overflow: 'hidden',
    backgroundColor: cssVar.colorBgContainer,
  },
  listWidth: (width: number) => ({
    '--weaver-list-width': `${width}px`,
  }),
  list: (visible: boolean) => ({
    display: { default: 'flex', [NARROW]: visible ? 'flex' : 'none' },
    flexDirection: 'column',
    flexShrink: 0,
    blockSize: '100%',
    minBlockSize: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    scrollbarGutter: 'stable',
    inlineSize: { default: 280, [WIDE]: 'var(--weaver-list-width)', [NARROW]: '100%' },
    borderInlineEndWidth: { default: 1, [NARROW]: 0 },
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: cssVar.colorBorderSecondary,
  }),
  main: (visible: boolean) => ({
    display: { default: 'flex', [NARROW]: visible ? 'flex' : 'none' },
    flex: '1 1 0',
    flexDirection: 'column',
    minBlockSize: 0,
    minInlineSize: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    scrollbarGutter: 'stable',
  }),
  inspector: (open: boolean, overlayOpen: boolean, mobileOpen: boolean) => ({
    display: {
      default: overlayOpen ? 'flex' : 'none',
      [WIDE]: open ? 'flex' : 'none',
      [NARROW]: mobileOpen ? 'flex' : 'none',
    },
    position: {
      default: 'absolute',
      [WIDE]: 'static',
      [NARROW]: 'static',
    },
    zIndex: 2,
    insetBlockStart: 0,
    insetBlockEnd: 0,
    // Laptop widths: the drawer is anchored to the right edge and never wider
    // than the main pane (content width minus the 280px list), so the list
    // stays fully visible and clickable. It is opaque with a leading border.
    insetInlineEnd: { default: 0, [WIDE]: 'auto', [NARROW]: 'auto' },
    flexDirection: 'column',
    flexShrink: 0,
    blockSize: '100%',
    minBlockSize: 0,
    overflow: 'hidden',
    inlineSize: { default: 'min(560px, calc(100% - 280px))', [WIDE]: 480, [NARROW]: '100%' },
    borderInlineStartWidth: { default: 1, [NARROW]: 0 },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: cssVar.colorBorderSecondary,
    backgroundColor: cssVar.colorBgContainer,
  }),
  inspectorBody: {
    flex: '1 1 0',
    minBlockSize: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    scrollbarGutter: 'stable',
  },
});
