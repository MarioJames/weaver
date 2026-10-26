import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

export const saveBarStyles = stylex.create({
  bar: {
    position: 'sticky',
    insetBlockEnd: 0,
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
    paddingBlock: 12,
    paddingInline: 16,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: cssVar.colorBorderSecondary,
    backgroundColor: cssVar.colorBgContainer,
  },
  message: {
    minInlineSize: 0,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginInlineStart: 'auto',
  },
});
