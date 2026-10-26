import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';

/**
 * The compact peer-metrics strip: label and value share one row per cell so the
 * whole strip stays under ~72px. Meaning matches the tall MetricStrip cards
 * (same labels, values and hints), only the density changes.
 */
export const compactMetricsStyles = stylex.create({
  strip: {
    display: 'flex',
    flexWrap: 'wrap',
    rowGap: 4,
    columnGap: 24,
    alignItems: 'center',
    flexShrink: 0,
    minInlineSize: 0,
    paddingBlock: 8,
    paddingInline: 16,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadiusLG,
    backgroundColor: cssVar.colorBgContainer,
  },
  cell: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minInlineSize: 0,
  },
  button: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minInlineSize: 0,
    paddingBlock: 2,
    paddingInline: 4,
    marginInline: -4,
    borderWidth: 0,
    borderRadius: cssVar.borderRadiusSM,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    ':hover': { backgroundColor: cssVar.colorFillTertiary },
    ':focus-visible': { outlineWidth: 2, outlineStyle: 'solid', outlineColor: cssVar.colorPrimaryBorder, outlineOffset: 1 },
  },
  pressed: {
    backgroundColor: cssVar.colorFillSecondary,
  },
  label: {
    minInlineSize: 0,
    color: cssVar.colorTextSecondary,
    fontSize: cssVar.fontSizeSM,
    lineHeight: 1.5,
    whiteSpace: 'nowrap',
  },
  valueRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    minInlineSize: 0,
  },
  value: {
    minInlineSize: 0,
    color: cssVar.colorText,
    fontSize: 16,
    fontWeight: cssVar.fontWeightStrong,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  },
  valueWarning: {
    color: cssVar.colorWarningText,
  },
  valueDanger: {
    color: cssVar.colorErrorText,
  },
  hint: {
    minInlineSize: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: cssVar.colorTextTertiary,
    fontSize: cssVar.fontSizeSM,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.5,
  },
});
