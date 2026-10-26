import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { compactMetricsStyles } from './compact-metrics-style';

export interface CompactMetricItem {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  valueTone?: 'warning' | 'danger';
  onClick?: () => void;
  /** Filter strips: the currently active option. */
  pressed?: boolean;
}

/**
 * Peer metrics in one compact row: label above, value + hint on one baseline.
 * Same labels, values and hints as the tall MetricStrip cards, packed under
 * ~72px. Cells with `onClick` render as buttons (filters or shortcuts).
 */
export function CompactMetrics({ label, items, loading }: {
  label: string;
  items: CompactMetricItem[];
  loading?: boolean;
}) {
  return <div aria-label={label} aria-busy={loading || undefined} {...stylex.props(compactMetricsStyles.strip)}>
    {items.map(item => {
      const tone = item.valueTone === 'warning'
        ? compactMetricsStyles.valueWarning
        : item.valueTone === 'danger' ? compactMetricsStyles.valueDanger : undefined;
      const body = <>
        <span {...stylex.props(compactMetricsStyles.label)}>{item.label}</span>
        <span {...stylex.props(compactMetricsStyles.valueRow)}>
          <span {...stylex.props(compactMetricsStyles.value, tone)}>{loading ? '—' : item.value}</span>
          {item.hint !== undefined && <span {...stylex.props(compactMetricsStyles.hint)}>{item.hint}</span>}
        </span>
      </>;
      return item.onClick
        ? <button
          key={item.label}
          type="button"
          onClick={item.onClick}
          aria-pressed={item.pressed}
          {...stylex.props(compactMetricsStyles.button, item.pressed && compactMetricsStyles.pressed)}
        >{body}</button>
        : <div key={item.label} {...stylex.props(compactMetricsStyles.cell)}>{body}</div>;
    })}
  </div>;
}
