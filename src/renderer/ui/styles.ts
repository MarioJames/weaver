import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/** Layout and text helpers shared across pages; anything one feature owns lives in that feature's style file. */
export const styles = stylex.create({
  srOnly: {
    position: 'absolute',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    borderWidth: 0,
    whiteSpace: 'nowrap',
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minInlineSize: 0,
  },
  tight: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minInlineSize: 0,
  },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    minInlineSize: 0,
  },
  spread: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'space-between',
    minInlineSize: 0,
  },
  numbers: {
    fontVariantNumeric: 'tabular-nums',
  },
  wrap: {
    overflowWrap: 'anywhere',
    minInlineSize: 0,
  },
  meta: {
    fontSize: 12,
    color: cssVar.colorTextSecondary,
  },
  error: {
    margin: 0,
    fontSize: 12,
    color: cssVar.colorErrorText,
  },
  warn: {
    color: cssVar.colorWarningText,
  },
  /** A form section set off from the fields above it. */
  divided: {
    paddingBlockStart: 12,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: cssVar.colorBorderSecondary,
  },
  /** Keep the brand mark with a single-line, ellipsized name. */
  agentLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxInlineSize: '100%',
    minInlineSize: 0,
  },
  agentName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minInlineSize: 0,
  },
  /** Flex rows that must stay on one line; compose after row/spread so it wins the cascade. */
  nowrap: {
    flexWrap: 'nowrap',
  },
  /** A spread row whose two sides top-align, e.g. a section title beside its action. */
  alignStart: {
    flexWrap: 'nowrap',
    alignItems: 'flex-start',
  },
});
