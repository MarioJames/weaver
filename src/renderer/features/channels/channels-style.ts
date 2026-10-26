import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import { media } from '@lobehub/ui/stylex/media.stylex';

/** What only the channels page owns: its row grid, the native-config font and the login link. Page frame, toolbar, list container, row actions and modal shells come from ui/resource-style. */
export const channelStyles = stylex.create({
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(200px, 1.2fr) minmax(200px, 1fr) minmax(200px, 1fr) auto',
      [media.md]: 'minmax(180px, 1fr) minmax(180px, 1fr)',
      [media.sm]: '1fr',
    },
    alignItems: 'start',
    gap: 16,
    padding: { default: 20, [media.sm]: 16 },
    borderBlockStartColor: { default: null, ':not(:first-child)': cssVar.colorBorderSecondary },
    borderBlockStartStyle: { default: null, ':not(:first-child)': 'solid' },
    borderBlockStartWidth: { default: null, ':not(:first-child)': 1 },
  },
  loginLink: {
    color: cssVar.colorLink,
    overflowWrap: 'anywhere',
  },
  native: {
    fontFamily: cssVar.fontFamilyCode,
  },
});
