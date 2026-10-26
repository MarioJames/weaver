import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

const NARROW = '@media (max-width: 767.98px)';

export const settingRowStyles = stylex.create({
  row: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 280px) minmax(0, 1fr)', [NARROW]: 'minmax(0, 1fr)' },
    alignItems: 'start',
    gap: { default: 16, [NARROW]: 8 },
    minInlineSize: 0,
    paddingBlock: 12,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: cssVar.colorBorderSecondary,
  },
  labels: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minInlineSize: 0,
  },
  labelLine: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    minInlineSize: 0,
    color: cssVar.colorText,
    fontSize: cssVar.fontSize,
    lineHeight: 1.4,
  },
  hint: {
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    lineHeight: 1.5,
  },
  control: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: { default: 'flex-end', [NARROW]: 'flex-start' },
    flexWrap: 'wrap',
    gap: 8,
    minInlineSize: 0,
    inlineSize: '100%',
  },
});
